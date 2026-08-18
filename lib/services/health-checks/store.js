"use strict";

/**
 * CRUD + validation pour les health checks (table `health_checks`).
 * Même style que lib/services/alerts/alert-rules-store.js : requêtes SQL
 * directes via lib/db, pas d'ORM, conversion row (snake_case) <-> objet JS
 * (camelCase). Les colonnes d'état (status, consecutive_*, last_*) ne sont
 * jamais acceptées en entrée de create()/update() : elles ne sont écrites
 * que par lib/services/health-checks/engine.js (recordResult()).
 */

const db = require("../../db");

const TYPES = ["http", "tcp", "command"];
const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"];
const STATUSES = ["UP", "DOWN", "DEGRADED", "UNKNOWN"];

function rowToCheck(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: !!row.enabled,
    // Nom du process PM2 que ce check surveille, si renseigné explicitement
    // (voir migration 010_health_checks_process_name.js). Utilisé par
    // Auto-Healing pour résoudre check -> process sans supposer que
    // check.name == nom de process (voir docs/auto-healing/README.md).
    processName: row.process_name || null,

    url: row.url || null,
    method: row.method || "GET",
    expectedStatus: row.expected_status || "200-299",
    expectedContent: row.expected_content || null,

    host: row.host || null,
    port: row.port === null || row.port === undefined ? null : Number(row.port),

    command: row.command || null,
    commandArgs: row.command_args ? JSON.parse(row.command_args) : [],
    expectedExitCode:
      row.expected_exit_code === null || row.expected_exit_code === undefined
        ? 0
        : Number(row.expected_exit_code),

    timeoutMs: Number(row.timeout_ms),
    intervalSeconds: Number(row.interval_seconds),
    degradedThresholdMs:
      row.degraded_threshold_ms === null || row.degraded_threshold_ms === undefined
        ? null
        : Number(row.degraded_threshold_ms),

    status: row.status || "UNKNOWN",
    consecutiveFailures: Number(row.consecutive_failures) || 0,
    consecutiveSuccesses: Number(row.consecutive_successes) || 0,
    lastCheckAt:
      row.last_check_at === null || row.last_check_at === undefined ? null : Number(row.last_check_at),
    lastResponseTimeMs:
      row.last_response_time_ms === null || row.last_response_time_ms === undefined
        ? null
        : Number(row.last_response_time_ms),
    lastStatusCode: row.last_status_code || null,
    lastError: row.last_error || null,
    lastFailureAt:
      row.last_failure_at === null || row.last_failure_at === undefined ? null : Number(row.last_failure_at),

    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Valide les champs d'un health check. `partial=true` (update) : seuls les champs fournis sont validés. */
function validate(input, { partial = false } = {}) {
  const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;

  if (!partial || has("name")) {
    if (!input.name || !String(input.name).trim()) errors.push("name requis.");
  }
  if (has("processName") && input.processName !== null && !String(input.processName).trim()) {
    errors.push("processName ne peut pas être une chaîne vide (null pour l'effacer).");
  }
  if (!partial || has("type")) {
    if (!TYPES.includes(input.type)) errors.push(`type invalide (attendu : ${TYPES.join(", ")}).`);
  }
  if (has("method")) {
    if (!METHODS.includes(String(input.method).toUpperCase())) {
      errors.push(`method invalide (attendu : ${METHODS.join(", ")}).`);
    }
  }
  if (has("timeoutMs")) {
    if (!Number.isFinite(Number(input.timeoutMs)) || Number(input.timeoutMs) <= 0) {
      errors.push("timeoutMs doit être un nombre > 0.");
    }
  }
  if (has("intervalSeconds")) {
    if (!Number.isFinite(Number(input.intervalSeconds)) || Number(input.intervalSeconds) <= 0) {
      errors.push("intervalSeconds doit être un nombre > 0.");
    }
  }
  if (has("degradedThresholdMs") && input.degradedThresholdMs !== null) {
    if (!Number.isFinite(Number(input.degradedThresholdMs)) || Number(input.degradedThresholdMs) <= 0) {
      errors.push("degradedThresholdMs doit être un nombre > 0 (ou null pour désactiver).");
    }
  }

  const type = input.type;
  if (type === "http" || (partial && has("url"))) {
    if ((!partial || has("url")) && type !== undefined) {
      if (!input.url || !String(input.url).trim()) errors.push('url requis pour type="http".');
      else {
        try {
          const u = new URL(input.url);
          if (!["http:", "https:"].includes(u.protocol)) errors.push("url doit être http:// ou https://.");
        } catch (e) {
          errors.push("url invalide.");
        }
      }
    }
  }
  if (type === "tcp") {
    if (!partial || has("host")) {
      if (!input.host || !String(input.host).trim()) errors.push('host requis pour type="tcp".');
    }
    if (!partial || has("port")) {
      const port = Number(input.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) errors.push("port invalide (1-65535).");
    }
  }
  if (type === "command") {
    if (!partial || has("command")) {
      if (!input.command || !String(input.command).trim()) errors.push('command requis pour type="command".');
    }
    if (has("commandArgs") && input.commandArgs !== undefined && input.commandArgs !== null) {
      if (!Array.isArray(input.commandArgs) || !input.commandArgs.every((a) => typeof a === "string")) {
        errors.push("commandArgs doit être un tableau de chaînes.");
      }
    }
    if (has("expectedExitCode")) {
      if (!Number.isInteger(Number(input.expectedExitCode)))
        errors.push("expectedExitCode doit être un entier.");
    }
  }

  if (errors.length) throw new Error(errors.join(" "));
}

async function create(input, { userId } = {}) {
  validate(input, { partial: false });
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO health_checks
      (name, process_name, type, enabled, url, method, expected_status, expected_content, host, port,
       command, command_args, expected_exit_code, timeout_ms, interval_seconds, degraded_threshold_ms,
       status, consecutive_failures, consecutive_successes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.name).trim(),
      input.processName ? String(input.processName).trim() : null,
      input.type,
      input.enabled === undefined ? 1 : input.enabled ? 1 : 0,
      input.url || null,
      input.method ? String(input.method).toUpperCase() : "GET",
      input.expectedStatus || "200-299",
      input.expectedContent || null,
      input.host || null,
      input.port !== undefined && input.port !== null ? Number(input.port) : null,
      input.command || null,
      input.commandArgs ? JSON.stringify(input.commandArgs) : null,
      input.expectedExitCode !== undefined ? Number(input.expectedExitCode) : 0,
      input.timeoutMs !== undefined ? Number(input.timeoutMs) : 5000,
      input.intervalSeconds !== undefined ? Number(input.intervalSeconds) : 60,
      input.degradedThresholdMs !== undefined && input.degradedThresholdMs !== null
        ? Number(input.degradedThresholdMs)
        : null,
      "UNKNOWN",
      0,
      0,
      userId || null,
      now,
      now,
    ],
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM health_checks WHERE id = ?", [id]);
  return rowToCheck(row);
}

async function getByName(name) {
  const row = await db.get("SELECT * FROM health_checks WHERE name = ?", [name]);
  return rowToCheck(row);
}

async function list({ enabledOnly = false } = {}) {
  const rows = enabledOnly
    ? await db.all("SELECT * FROM health_checks WHERE enabled = 1 ORDER BY name ASC", [])
    : await db.all("SELECT * FROM health_checks ORDER BY name ASC", []);
  return rows.map(rowToCheck);
}

async function update(id, changes) {
  const existing = await getById(id);
  if (!existing) return null;

  validate(changes, { partial: true });
  const merged = { ...existing, ...changes };

  const now = Date.now();
  await db.run(
    `UPDATE health_checks SET
      name = ?, process_name = ?, type = ?, enabled = ?, url = ?, method = ?, expected_status = ?, expected_content = ?,
      host = ?, port = ?, command = ?, command_args = ?, expected_exit_code = ?,
      timeout_ms = ?, interval_seconds = ?, degraded_threshold_ms = ?, updated_at = ?
     WHERE id = ?`,
    [
      String(merged.name).trim(),
      merged.processName ? String(merged.processName).trim() : null,
      merged.type,
      merged.enabled ? 1 : 0,
      merged.url || null,
      merged.method ? String(merged.method).toUpperCase() : "GET",
      merged.expectedStatus || "200-299",
      merged.expectedContent || null,
      merged.host || null,
      merged.port !== undefined && merged.port !== null ? Number(merged.port) : null,
      merged.command || null,
      merged.commandArgs ? JSON.stringify(merged.commandArgs) : null,
      merged.expectedExitCode !== undefined ? Number(merged.expectedExitCode) : 0,
      Number(merged.timeoutMs) || 5000,
      Number(merged.intervalSeconds) || 60,
      merged.degradedThresholdMs !== undefined && merged.degradedThresholdMs !== null
        ? Number(merged.degradedThresholdMs)
        : null,
      now,
      id,
    ],
  );
  return getById(id);
}

async function setEnabled(id, enabled) {
  const existing = await getById(id);
  if (!existing) return null;
  await db.run("UPDATE health_checks SET enabled = ?, updated_at = ? WHERE id = ?", [
    enabled ? 1 : 0,
    Date.now(),
    id,
  ]);
  return getById(id);
}

async function remove(id) {
  const result = await db.run("DELETE FROM health_checks WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Écrit le résultat d'une exécution (appelé uniquement par
 * lib/services/health-checks/engine.js). Ne touche à aucun des champs de
 * configuration.
 */
async function recordResult(id, result) {
  const now = Date.now();
  const fields = [
    result.status,
    result.consecutiveFailures,
    result.consecutiveSuccesses,
    now,
    result.responseTimeMs === undefined ? null : result.responseTimeMs,
    result.statusCode === undefined ? null : String(result.statusCode),
    result.error || null,
    now,
  ];
  if (result.status === "DOWN") {
    await db.run(
      `UPDATE health_checks SET
        status = ?, consecutive_failures = ?, consecutive_successes = ?, last_check_at = ?,
        last_response_time_ms = ?, last_status_code = ?, last_error = ?, last_failure_at = ?, updated_at = ?
       WHERE id = ?`,
      [...fields, now, id],
    );
  } else {
    await db.run(
      `UPDATE health_checks SET
        status = ?, consecutive_failures = ?, consecutive_successes = ?, last_check_at = ?,
        last_response_time_ms = ?, last_status_code = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [...fields, id],
    );
  }
  return getById(id);
}

module.exports = {
  TYPES,
  METHODS,
  STATUSES,
  validate,
  create,
  getById,
  getByName,
  list,
  update,
  setEnabled,
  remove,
  recordResult,
};
