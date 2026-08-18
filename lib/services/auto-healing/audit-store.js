"use strict";

/**
 * Journal d'audit Auto-Healing (table `auto_healing_audit`), append-only.
 * Chaque tentative — déclenchée, réussie, échouée, ou bloquée par les
 * garde-fous — y est enregistrée (section 8 du prompt maître : "aucune
 * exception, même un échec doit être audité"). Aucune méthode de
 * suppression n'est exposée : l'API ne permet que la lecture.
 */

const db = require("../../db");

const RESULTS = ["success", "failure", "blocked"];

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    processName: row.process_name,
    source: row.source,
    reason: row.reason,
    action: row.action,
    attempt: row.attempt === null || row.attempt === undefined ? null : Number(row.attempt),
    maxAttempts:
      row.max_attempts === null || row.max_attempts === undefined ? null : Number(row.max_attempts),
    result: row.result,
    message: row.message || null,
    createdAt: Number(row.created_at),
  };
}

/**
 * @param {object} entry
 * @param {string} entry.processName
 * @param {string} entry.source - "alert" | "health_check" | "pm2_event" | "manual"
 * @param {string} entry.reason - ex: "process crashed", "health check DOWN"
 * @param {string} entry.action - "restart" | "block" | "unblock"
 * @param {number|null} [entry.attempt]
 * @param {number|null} [entry.maxAttempts]
 * @param {"success"|"failure"|"blocked"} entry.result
 * @param {string} [entry.message]
 */
async function record(entry) {
  if (!RESULTS.includes(entry.result)) {
    throw new Error(`result invalide: "${entry.result}". Attendu: ${RESULTS.join(", ")}.`);
  }
  const now = Date.now();
  const res = await db.run(
    `INSERT INTO auto_healing_audit
      (process_name, source, reason, action, attempt, max_attempts, result, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.processName,
      entry.source,
      entry.reason,
      entry.action,
      entry.attempt ?? null,
      entry.maxAttempts ?? null,
      entry.result,
      entry.message || null,
      now,
    ],
  );
  return getById(res.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM auto_healing_audit WHERE id = ?", [id]);
  return rowToEntry(row);
}

/** Historique paginé, filtrable par process/résultat. */
async function list({ processName, result, limit = 100, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (processName) {
    clauses.push("process_name = ?");
    params.push(processName);
  }
  if (result) {
    clauses.push("result = ?");
    params.push(result);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const rows = await db.all(
    `SELECT * FROM auto_healing_audit ${where} ORDER BY id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  );
  return rows.map(rowToEntry);
}

module.exports = { RESULTS, record, getById, list };
