"use strict";

/**
 * Persistance des incidents (table `incidents`) et de leur association aux
 * alertes (`incident_alerts`, migration 016). Aucune logique de corrélation
 * ici (voir correlation.js) : ce module ne fait que lire/écrire des lignes,
 * même séparation que lib/services/alerts/alert-store.js vs engine.js.
 */

const db = require("../../db");

const STATES = ["OPEN", "ACKNOWLEDGED", "INVESTIGATING", "MITIGATED", "RESOLVED"];

// Transitions autorisées (état courant -> ensemble d'états cibles acceptés).
// RESOLVED est terminal : un incident résolu ne peut être rouvert par cette
// API (une nouvelle alerte corrélée créera/rattachera un nouvel incident si
// nécessaire, voir correlation.js).
const ALLOWED_TRANSITIONS = {
  OPEN: ["ACKNOWLEDGED", "INVESTIGATING", "MITIGATED", "RESOLVED"],
  ACKNOWLEDGED: ["INVESTIGATING", "MITIGATED", "RESOLVED"],
  INVESTIGATING: ["MITIGATED", "ACKNOWLEDGED", "RESOLVED"],
  MITIGATED: ["RESOLVED", "INVESTIGATING"],
  RESOLVED: [],
};

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

/** Sévérité agrégée la plus haute entre l'existante et une nouvelle alerte. */
function higherSeverity(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ra = SEVERITY_RANK[a] ?? 99;
  const rb = SEVERITY_RANK[b] ?? 99;
  return ra <= rb ? a : b;
}

function rowToIncident(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    severity: row.severity,
    targetType: row.target_type,
    targetValue: row.target_value,
    metric: row.metric,
    correlationKey: row.correlation_key,
    firstAlertId: row.first_alert_id,
    openedAt: Number(row.opened_at),
    acknowledgedAt: row.acknowledged_at !== null ? Number(row.acknowledged_at) : null,
    acknowledgedBy: row.acknowledged_by,
    investigatingAt: row.investigating_at !== null ? Number(row.investigating_at) : null,
    mitigatedAt: row.mitigated_at !== null ? Number(row.mitigated_at) : null,
    resolvedAt: row.resolved_at !== null ? Number(row.resolved_at) : null,
    resolvedBy: row.resolved_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function create({ title, severity, targetType, targetValue, metric, correlationKey, firstAlertId }) {
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO incidents
      (title, status, severity, target_type, target_value, metric, correlation_key, first_alert_id,
       opened_at, created_at, updated_at)
     VALUES (?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [title, severity, targetType, targetValue || null, metric, correlationKey, firstAlertId || null, now, now, now],
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM incidents WHERE id = ?", [id]);
  return rowToIncident(row);
}

/**
 * Incident OUVERT (statut != RESOLVED) le plus récent correspondant à une clé
 * de corrélation, créé/mis à jour dans la fenêtre temporelle donnée — voir
 * correlation.js#findOrCreateIncidentForAlert.
 */
async function findOpenByCorrelationKey(correlationKey, sinceTs) {
  const row = await db.get(
    `SELECT * FROM incidents
     WHERE correlation_key = ? AND status != 'RESOLVED' AND updated_at >= ?
     ORDER BY id DESC LIMIT 1`,
    [correlationKey, sinceTs],
  );
  return rowToIncident(row);
}

/**
 * Incidents ouverts (statut != RESOLVED) pour une métrique et un type de
 * cible donnés, mis à jour dans la fenêtre temporelle — candidats pour la
 * corrélation par GROUPE (voir correlation.js) : contrairement à
 * findOpenByCorrelationKey (clé exacte process+métrique), le rattachement
 * par groupe doit comparer les groupes du process de CHAQUE incident
 * candidat à ceux de la nouvelle alerte, donc on ne peut pas filtrer par une
 * simple égalité de clé en SQL.
 */
async function listOpenCandidatesByMetric(targetType, metric, sinceTs) {
  const rows = await db.all(
    `SELECT * FROM incidents
     WHERE target_type = ? AND metric = ? AND status != 'RESOLVED' AND updated_at >= ?
     ORDER BY updated_at DESC`,
    [targetType, metric, sinceTs],
  );
  return rows.map(rowToIncident);
}

/** Rattache une alerte à un incident (idempotent : une alerte n'appartient qu'à un seul incident). */
async function linkAlert(incidentId, alertId) {
  const now = Date.now();
  try {
    await db.run("INSERT INTO incident_alerts (incident_id, alert_id, created_at) VALUES (?, ?, ?)", [
      incidentId,
      alertId,
      now,
    ]);
  } catch (e) {
    // UNIQUE(alert_id) : l'alerte est déjà rattachée (à cet incident ou, en
    // théorie, à un autre — ne devrait pas arriver via correlation.js, mais
    // on reste tolérant plutôt que de faire planter l'évaluation d'alerte).
    if (!/UNIQUE|constraint/i.test(e.message || "")) throw e;
  }
  await touchUpdatedAt(incidentId);
}

async function touchUpdatedAt(incidentId, extra = {}) {
  const now = Date.now();
  const sets = ["updated_at = ?"];
  const params = [now];
  for (const [col, val] of Object.entries(extra)) {
    sets.push(`${col} = ?`);
    params.push(val);
  }
  params.push(incidentId);
  await db.run(`UPDATE incidents SET ${sets.join(", ")} WHERE id = ?`, params);
  return getById(incidentId);
}

/** Met à jour la sévérité agrégée si la nouvelle alerte est plus sévère que l'incident actuel. */
async function bumpSeverity(incidentId, newSeverity) {
  const incident = await getById(incidentId);
  if (!incident) return null;
  const merged = higherSeverity(incident.severity, newSeverity);
  if (merged === incident.severity) return incident;
  return touchUpdatedAt(incidentId, { severity: merged });
}

async function listAlertIds(incidentId) {
  const rows = await db.all("SELECT alert_id FROM incident_alerts WHERE incident_id = ? ORDER BY id ASC", [
    incidentId,
  ]);
  return rows.map((r) => r.alert_id);
}

/** Transition explicite d'état — valide la machine à états (voir ALLOWED_TRANSITIONS). */
async function transition(incidentId, nextStatus, { userId } = {}) {
  const incident = await getById(incidentId);
  if (!incident) throw new Error("Incident introuvable.");
  if (!STATES.includes(nextStatus)) {
    throw new Error(`État invalide: "${nextStatus}". Attendu: ${STATES.join(", ")}.`);
  }
  if (incident.status === nextStatus) return incident; // idempotent
  const allowed = ALLOWED_TRANSITIONS[incident.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw new Error(
      `Transition invalide: "${incident.status}" -> "${nextStatus}". Autorisé depuis "${incident.status}": ${
        allowed.length ? allowed.join(", ") : "aucune (état terminal)"
      }.`,
    );
  }

  const now = Date.now();
  const extra = { status: nextStatus };
  if (nextStatus === "ACKNOWLEDGED") {
    extra.acknowledged_at = now;
    if (userId !== undefined && userId !== null) extra.acknowledged_by = userId;
  } else if (nextStatus === "INVESTIGATING") {
    extra.investigating_at = now;
  } else if (nextStatus === "MITIGATED") {
    extra.mitigated_at = now;
  } else if (nextStatus === "RESOLVED") {
    extra.resolved_at = now;
    if (userId !== undefined && userId !== null) extra.resolved_by = userId;
  }
  return touchUpdatedAt(incidentId, extra);
}

function buildWhere({ status, severity, targetType, targetValue }) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (severity) {
    clauses.push("severity = ?");
    params.push(severity);
  }
  if (targetType) {
    clauses.push("target_type = ?");
    params.push(targetType);
  }
  if (targetValue) {
    clauses.push("target_value = ?");
    params.push(targetValue);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** Liste paginée, filtrable par statut/sévérité/cible. */
async function list({ status, severity, targetType, targetValue, limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const { where, params } = buildWhere({ status, severity, targetType, targetValue });
  const rows = await db.all(
    `SELECT * FROM incidents ${where} ORDER BY
       CASE status WHEN 'RESOLVED' THEN 1 ELSE 0 END ASC,
       CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END ASC,
       opened_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  );
  const countRow = await db.get(`SELECT COUNT(*) AS n FROM incidents ${where}`, params);
  return {
    items: rows.map(rowToIncident),
    total: countRow ? Number(countRow.n) : 0,
    limit: safeLimit,
    offset: safeOffset,
  };
}

module.exports = {
  STATES,
  ALLOWED_TRANSITIONS,
  higherSeverity,
  create,
  getById,
  findOpenByCorrelationKey,
  listOpenCandidatesByMetric,
  linkAlert,
  bumpSeverity,
  listAlertIds,
  transition,
  list,
};
