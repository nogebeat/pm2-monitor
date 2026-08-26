"use strict";

/**
 * CRUD + validation pour les règles de détection d'anomalies (table
 * `anomaly_rules`). Même style que lib/services/alerts/alert-rules-store.js :
 * requêtes SQL directes via lib/db, pas d'ORM, conversion row (snake_case)
 * <-> objet JS (camelCase).
 */

const db = require("../../db");
const { METRICS_BY_TARGET_TYPE, DEFAULTS } = require("./config");

const TARGET_TYPES = ["process", "system"];
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
    sensitivity: Number(row.sensitivity),
    windowMs: Number(row.window_ms),
    minSamples: Number(row.min_samples),
    cooldownSeconds: Number(row.cooldown_seconds),
    severity: row.severity,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Valide les champs d'une règle. `partial=true` (update) : seuls les champs fournis sont validés. */
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
      errors.push(
        `metric invalide pour targetType="${targetType}" (attendu : ${allowedMetrics.join(", ")}).`,
      );
    } else if (
      !allowedMetrics &&
      !Object.values(METRICS_BY_TARGET_TYPE).some((list) => list.includes(input.metric))
    ) {
      errors.push("metric invalide.");
    }
  }
  if (has("sensitivity")) {
    if (!Number.isFinite(Number(input.sensitivity)) || Number(input.sensitivity) <= 0) {
      errors.push("sensitivity doit être un nombre > 0 (nombre d'écarts-types).");
    }
  }
  if (has("windowMs")) {
    if (!Number.isFinite(Number(input.windowMs)) || Number(input.windowMs) <= 0) {
      errors.push("windowMs doit être un nombre > 0 (fenêtre historique en millisecondes).");
    }
  }
  if (has("minSamples")) {
    if (!Number.isInteger(Number(input.minSamples)) || Number(input.minSamples) < 1) {
      errors.push("minSamples doit être un entier >= 1.");
    }
  }
  if (has("cooldownSeconds")) {
    if (!Number.isFinite(Number(input.cooldownSeconds)) || Number(input.cooldownSeconds) < 0) {
      errors.push("cooldownSeconds doit être un nombre >= 0.");
    }
  }
  if (has("severity")) {
    if (input.severity !== undefined && !SEVERITIES.includes(input.severity)) {
      errors.push(`severity invalide (attendu : ${SEVERITIES.join(", ")}).`);
    }
  }
  if (input.targetType === "process" && has("targetValue")) {
    if (input.targetValue !== "*" && !String(input.targetValue || "").trim()) {
      errors.push('targetValue requis pour targetType="process" (nom de l\'app, ou "*" pour toutes).');
    }
  }

  if (errors.length) throw new Error(errors.join(" "));
}

async function create(input, { userId } = {}) {
  validate(input, { partial: false });
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO anomaly_rules
      (name, description, enabled, target_type, target_value, metric, sensitivity, window_ms,
       min_samples, cooldown_seconds, severity, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.name).trim(),
      input.description ? String(input.description) : null,
      input.enabled === undefined ? 1 : input.enabled ? 1 : 0,
      input.targetType,
      input.targetType === "system" ? null : input.targetValue || "*",
      input.metric,
      input.sensitivity !== undefined ? Number(input.sensitivity) : DEFAULTS.sensitivity,
      input.windowMs !== undefined ? Number(input.windowMs) : DEFAULTS.windowMs,
      input.minSamples !== undefined ? Number(input.minSamples) : DEFAULTS.minSamples,
      input.cooldownSeconds !== undefined ? Number(input.cooldownSeconds) : DEFAULTS.cooldownSeconds,
      input.severity || DEFAULTS.severity,
      userId || null,
      now,
      now,
    ],
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM anomaly_rules WHERE id = ?", [id]);
  return rowToRule(row);
}

async function list({ enabledOnly = false } = {}) {
  const rows = enabledOnly
    ? await db.all("SELECT * FROM anomaly_rules WHERE enabled = 1 ORDER BY name ASC", [])
    : await db.all("SELECT * FROM anomaly_rules ORDER BY name ASC", []);
  return rows.map(rowToRule);
}

/** Règles actives pour un type de cible donné (utilisé par le scheduler d'évaluation, voir service.js). */
async function listEnabledByTargetType(targetType) {
  const rows = await db.all(
    "SELECT * FROM anomaly_rules WHERE enabled = 1 AND target_type = ? ORDER BY id ASC",
    [targetType],
  );
  return rows.map(rowToRule);
}

async function update(id, changes) {
  const existing = await getById(id);
  if (!existing) return null;

  validate(changes, { partial: true });
  const merged = { ...existing, ...changes };

  const now = Date.now();
  await db.run(
    `UPDATE anomaly_rules SET
      name = ?, description = ?, enabled = ?, target_type = ?, target_value = ?, metric = ?,
      sensitivity = ?, window_ms = ?, min_samples = ?, cooldown_seconds = ?, severity = ?, updated_at = ?
     WHERE id = ?`,
    [
      String(merged.name).trim(),
      merged.description ? String(merged.description) : null,
      merged.enabled ? 1 : 0,
      merged.targetType,
      merged.targetType === "system" ? null : merged.targetValue || "*",
      merged.metric,
      Number(merged.sensitivity) || DEFAULTS.sensitivity,
      Number(merged.windowMs) || DEFAULTS.windowMs,
      Number(merged.minSamples) || DEFAULTS.minSamples,
      Number(merged.cooldownSeconds) || 0,
      merged.severity || DEFAULTS.severity,
      now,
      id,
    ],
  );
  return getById(id);
}

async function setEnabled(id, enabled) {
  const existing = await getById(id);
  if (!existing) return null;
  await db.run("UPDATE anomaly_rules SET enabled = ?, updated_at = ? WHERE id = ?", [
    enabled ? 1 : 0,
    Date.now(),
    id,
  ]);
  return getById(id);
}

async function remove(id) {
  const result = await db.run("DELETE FROM anomaly_rules WHERE id = ?", [id]);
  return result.changes > 0;
}

module.exports = {
  TARGET_TYPES,
  METRICS_BY_TARGET_TYPE,
  SEVERITIES,
  validate,
  create,
  getById,
  list,
  listEnabledByTargetType,
  update,
  setEnabled,
  remove,
};
