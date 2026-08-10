"use strict";

/**
 * Persistance des occurrences d'alerte (table `alerts`). Ne contient aucune
 * logique métier (pas de notion de seuil, durée, cooldown ici) : c'est
 * `engine.js` qui orchestre les transitions, ce module ne fait que lire/
 * écrire des lignes. Même séparation que persistent-queue.js (stockage) vs
 * le futur consommateur métier.
 */

const db = require("../../db");

const OPEN_STATES = ["trigger", "active", "acknowledged"];

function rowToAlert(row) {
  if (!row) return null;
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    dedupKey: row.dedup_key,
    targetType: row.target_type,
    targetValue: row.target_value,
    metric: row.metric,
    operator: row.operator,
    threshold: row.threshold,
    severity: row.severity,
    state: row.state,
    value: row.value,
    conditionMetAt: row.condition_met_at !== null ? Number(row.condition_met_at) : null,
    triggeredAt: row.triggered_at !== null ? Number(row.triggered_at) : null,
    resolvedAt: row.resolved_at !== null ? Number(row.resolved_at) : null,
    acknowledgedAt: row.acknowledged_at !== null ? Number(row.acknowledged_at) : null,
    acknowledgedBy: row.acknowledged_by,
    cooldownUntil: row.cooldown_until !== null ? Number(row.cooldown_until) : null,
    lastSeenAt: Number(row.last_seen_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function buildDedupKey(ruleId, targetType, targetValue, metric) {
  return `${ruleId}:${targetType}:${targetValue || "system"}:${metric}`;
}

async function create(fields) {
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO alerts
      (rule_id, rule_name, dedup_key, target_type, target_value, metric, operator, threshold,
       severity, state, value, condition_met_at, triggered_at, resolved_at, acknowledged_at,
       acknowledged_by, cooldown_until, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.ruleId,
      fields.ruleName,
      fields.dedupKey,
      fields.targetType,
      fields.targetValue || null,
      fields.metric,
      fields.operator,
      String(fields.threshold),
      fields.severity,
      fields.state,
      fields.value !== undefined ? String(fields.value) : null,
      fields.conditionMetAt || now,
      fields.triggeredAt || null,
      fields.resolvedAt || null,
      fields.acknowledgedAt || null,
      fields.acknowledgedBy || null,
      fields.cooldownUntil || null,
      fields.lastSeenAt || now,
      now,
      now,
    ]
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM alerts WHERE id = ?", [id]);
  return rowToAlert(row);
}

/** L'occurrence "ouverte" (trigger/active/acknowledged) pour une clé de déduplication, ou null. */
async function findOpenByDedupKey(dedupKey) {
  const placeholders = OPEN_STATES.map(() => "?").join(", ");
  const row = await db.get(
    `SELECT * FROM alerts WHERE dedup_key = ? AND state IN (${placeholders}) ORDER BY id DESC LIMIT 1`,
    [dedupKey, ...OPEN_STATES]
  );
  return rowToAlert(row);
}

/** La dernière occurrence *résolue* pour une clé (sert au calcul du cooldown avant re-déclenchement). */
async function findLastResolvedByDedupKey(dedupKey) {
  const row = await db.get(
    `SELECT * FROM alerts WHERE dedup_key = ? AND state = 'resolved' ORDER BY resolved_at DESC LIMIT 1`,
    [dedupKey]
  );
  return rowToAlert(row);
}

/** Met à jour un sous-ensemble de champs (transitions d'état, valeur observée…). */
async function update(id, changes) {
  const fieldMap = {
    state: "state",
    value: "value",
    conditionMetAt: "condition_met_at",
    triggeredAt: "triggered_at",
    resolvedAt: "resolved_at",
    acknowledgedAt: "acknowledged_at",
    acknowledgedBy: "acknowledged_by",
    cooldownUntil: "cooldown_until",
    lastSeenAt: "last_seen_at",
  };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(fieldMap)) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      sets.push(`${column} = ?`);
      params.push(changes[key]);
    }
  }
  if (!sets.length) return getById(id);

  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);

  await db.run(`UPDATE alerts SET ${sets.join(", ")} WHERE id = ?`, params);
  return getById(id);
}

/** Alias sémantique de update() pour "on a revu la même condition vraie, sans changer d'état". */
function touch(id, changes) {
  return update(id, changes);
}

async function remove(id) {
  const result = await db.run("DELETE FROM alerts WHERE id = ?", [id]);
  return result.changes > 0;
}

/** Alertes actuellement "vivantes". includeTrigger=true inclut aussi celles en attente de durée. */
async function listActive({ includeTrigger = false } = {}) {
  const states = includeTrigger ? OPEN_STATES : ["active", "acknowledged"];
  const placeholders = states.map(() => "?").join(", ");
  const rows = await db.all(
    `SELECT * FROM alerts WHERE state IN (${placeholders}) ORDER BY
       CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END ASC,
       triggered_at DESC, id DESC`,
    states
  );
  return rows.map(rowToAlert);
}

/** Historique paginé, filtrable par état/sévérité/règle. */
async function listHistory({ state, severity, ruleId, limit = 100, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (state) {
    clauses.push("state = ?");
    params.push(state);
  }
  if (severity) {
    clauses.push("severity = ?");
    params.push(severity);
  }
  if (ruleId) {
    clauses.push("rule_id = ?");
    params.push(ruleId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const rows = await db.all(
    `SELECT * FROM alerts ${where} ORDER BY id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params
  );
  return rows.map(rowToAlert);
}

module.exports = {
  OPEN_STATES,
  buildDedupKey,
  create,
  getById,
  findOpenByDedupKey,
  findLastResolvedByDedupKey,
  update,
  touch,
  remove,
  listActive,
  listHistory,
};
