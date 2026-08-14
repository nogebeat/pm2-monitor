"use strict";

/**
 * CRUD + validation pour les règles d'alerte (table `alert_rules`).
 * Suit le même style que lib/user-store.js : requêtes SQL directes via
 * lib/db, pas d'ORM, conversion row (snake_case) <-> objet JS (camelCase).
 */

const db = require("../../db");

const TARGET_TYPES = ["process", "system", "health_check"];

// Métriques valides par type de cible. Un process a un CPU/mémoire propre,
// un compteur de restarts et un statut ; les métriques système (disque,
// température) n'ont pas de sens par process, et cpu/memory système
// n'ont pas de sens "par process" au sens où le fait de rattacher un rule à
// system agrège la machine entière plutôt qu'un process précis.
//
// "health_check" (Phase 6, lib/services/health-checks/) n'a qu'une seule
// métrique pertinente : son statut (UP/DOWN/DEGRADED/UNKNOWN), comparé en
// chaîne (ex: operator="==", threshold="DOWN") exactement comme
// process.status déjà géré par compare() dans engine.js — aucune nouvelle
// logique de comparaison nécessaire.
const METRICS_BY_TARGET_TYPE = {
  process: ["cpu", "memory", "restart_count", "status"],
  system: ["cpu", "memory", "disk", "temperature"],
  health_check: ["status"],
};

const OPERATORS = [">", ">=", "<", "<=", "==", "!="];
const SEVERITIES = ["info", "warning", "critical"];

function rowToRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    enabled: !!row.enabled,
    targetType: row.target_type,
    targetValue: row.target_value,
    metric: row.metric,
    operator: row.operator,
    threshold: row.threshold,
    durationSeconds: row.duration_seconds,
    severity: row.severity,
    cooldownSeconds: row.cooldown_seconds,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Valide les champs d'une règle. `partial=true` (update) : seuls les champs
 * fournis sont validés, les champs requis absents ne déclenchent pas d'erreur.
 */
function validate(input, { partial = false } = {}) {
  const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;

  if (!partial || has("name")) {
    if (!input.name || !String(input.name).trim()) errors.push("name requis.");
  }
  if (!partial || has("targetType")) {
    if (!TARGET_TYPES.includes(input.targetType)) {
      errors.push(`targetType invalide (attendu : ${TARGET_TYPES.join(", ")}).`);
    }
  }
  if (!partial || has("metric")) {
    const targetType = input.targetType || (partial ? null : undefined);
    const allowedMetrics = targetType ? METRICS_BY_TARGET_TYPE[targetType] : null;
    if (allowedMetrics && !allowedMetrics.includes(input.metric)) {
      errors.push(`metric invalide pour targetType="${targetType}" (attendu : ${allowedMetrics.join(", ")}).`);
    } else if (!allowedMetrics && !Object.values(METRICS_BY_TARGET_TYPE).some((list) => list.includes(input.metric))) {
      errors.push("metric invalide.");
    }
  }
  if (!partial || has("operator")) {
    if (!OPERATORS.includes(input.operator)) errors.push(`operator invalide (attendu : ${OPERATORS.join(", ")}).`);
  }
  if (!partial || has("threshold")) {
    if (input.threshold === undefined || input.threshold === null || String(input.threshold) === "") {
      errors.push("threshold requis.");
    }
  }
  if (has("durationSeconds")) {
    if (!Number.isFinite(Number(input.durationSeconds)) || Number(input.durationSeconds) < 0) {
      errors.push("durationSeconds doit être un nombre >= 0.");
    }
  }
  if (has("cooldownSeconds")) {
    if (!Number.isFinite(Number(input.cooldownSeconds)) || Number(input.cooldownSeconds) < 0) {
      errors.push("cooldownSeconds doit être un nombre >= 0.");
    }
  }
  if (!partial || has("severity")) {
    if (input.severity !== undefined && !SEVERITIES.includes(input.severity)) {
      errors.push(`severity invalide (attendu : ${SEVERITIES.join(", ")}).`);
    }
  }
  if (input.targetType === "process" && has("targetValue")) {
    if (input.targetValue !== "*" && !String(input.targetValue || "").trim()) {
      errors.push("targetValue requis pour targetType=\"process\" (nom de l'app, ou \"*\" pour toutes).");
    }
  }
  if (input.targetType === "health_check" && has("targetValue")) {
    if (input.targetValue !== "*" && !String(input.targetValue || "").trim()) {
      errors.push(
        "targetValue requis pour targetType=\"health_check\" (nom du health check, ou \"*\" pour tous)."
      );
    }
  }

  if (errors.length) throw new Error(errors.join(" "));
}

async function create(input, { userId } = {}) {
  validate(input, { partial: false });
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO alert_rules
      (name, description, enabled, target_type, target_value, metric, operator, threshold,
       duration_seconds, severity, cooldown_seconds, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.name).trim(),
      input.description ? String(input.description) : null,
      input.enabled === undefined ? 1 : input.enabled ? 1 : 0,
      input.targetType,
      input.targetType === "system" ? null : input.targetValue || "*",
      input.metric,
      input.operator,
      String(input.threshold),
      input.durationSeconds !== undefined ? Number(input.durationSeconds) : 0,
      input.severity || "warning",
      input.cooldownSeconds !== undefined ? Number(input.cooldownSeconds) : 0,
      userId || null,
      now,
      now,
    ]
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM alert_rules WHERE id = ?", [id]);
  return rowToRule(row);
}

async function list({ enabledOnly = false } = {}) {
  const rows = enabledOnly
    ? await db.all("SELECT * FROM alert_rules WHERE enabled = 1 ORDER BY name ASC", [])
    : await db.all("SELECT * FROM alert_rules ORDER BY name ASC", []);
  return rows.map(rowToRule);
}

/** Règles actives pour un type de cible donné (utilisé par le scheduler d'évaluation). */
async function listEnabledByTargetType(targetType) {
  const rows = await db.all("SELECT * FROM alert_rules WHERE enabled = 1 AND target_type = ? ORDER BY id ASC", [
    targetType,
  ]);
  return rows.map(rowToRule);
}

async function update(id, changes) {
  const existing = await getById(id);
  if (!existing) return null;

  const merged = { ...existing, ...changes };
  validate(changes, { partial: true });

  const now = Date.now();
  await db.run(
    `UPDATE alert_rules SET
      name = ?, description = ?, enabled = ?, target_type = ?, target_value = ?,
      metric = ?, operator = ?, threshold = ?, duration_seconds = ?, severity = ?,
      cooldown_seconds = ?, updated_at = ?
     WHERE id = ?`,
    [
      String(merged.name).trim(),
      merged.description ? String(merged.description) : null,
      merged.enabled ? 1 : 0,
      merged.targetType,
      merged.targetType === "system" ? null : merged.targetValue || "*",
      merged.metric,
      merged.operator,
      String(merged.threshold),
      Number(merged.durationSeconds) || 0,
      merged.severity || "warning",
      Number(merged.cooldownSeconds) || 0,
      now,
      id,
    ]
  );
  return getById(id);
}

async function remove(id) {
  const result = await db.run("DELETE FROM alert_rules WHERE id = ?", [id]);
  return result.changes > 0;
}

module.exports = {
  TARGET_TYPES,
  METRICS_BY_TARGET_TYPE,
  OPERATORS,
  SEVERITIES,
  validate,
  create,
  getById,
  list,
  listEnabledByTargetType,
  update,
  remove,
};
