"use strict";

/**
 * Persistance de la table `process_events` (migration 005_process_events).
 * Aucune logique de normalisation ici (voir normalizer.js) : uniquement des
 * lectures/écritures, même séparation que lib/services/alerts/alert-store.js
 * et lib/services/process-history/store.js.
 */

const db = require("../../db");

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

function rowToEvent(row) {
  if (!row) return null;
  let metadata = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch (e) {
      metadata = null; // metadata corrompu/illisible : on ne fait pas échouer la lecture pour autant
    }
  }
  return {
    id: row.id,
    timestamp: Number(row.ts),
    type: row.type,
    severity: row.severity,
    process: row.process_name,
    processId: row.process_id !== null && row.process_id !== undefined ? Number(row.process_id) : null,
    server: row.server,
    status: row.status,
    exitCode: row.exit_code !== null && row.exit_code !== undefined ? Number(row.exit_code) : null,
    signal: row.signal,
    metadata,
    createdAt: Number(row.created_at),
  };
}

/** @param {object} event - forme retournée par normalizer.js#normalizeEvent */
async function create(event) {
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO process_events
      (ts, type, severity, process_name, process_id, server, status, exit_code, signal, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.timestamp,
      event.type,
      event.severity,
      event.process || null,
      event.processId !== undefined && event.processId !== null ? event.processId : null,
      event.server || null,
      event.status || null,
      event.exitCode !== undefined && event.exitCode !== null ? event.exitCode : null,
      event.signal || null,
      event.metadata ? JSON.stringify(event.metadata) : null,
      now,
    ]
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM process_events WHERE id = ?", [id]);
  return rowToEvent(row);
}

function buildWhere({ process, type, severity, startTs, endTs }) {
  const clauses = [];
  const params = [];
  if (process) {
    clauses.push("process_name = ?");
    params.push(process);
  }
  if (type) {
    clauses.push("type = ?");
    params.push(type);
  }
  if (severity) {
    clauses.push("severity = ?");
    params.push(severity);
  }
  if (Number.isFinite(startTs)) {
    clauses.push("ts >= ?");
    params.push(startTs);
  }
  if (Number.isFinite(endTs)) {
    clauses.push("ts <= ?");
    params.push(endTs);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/**
 * Historique paginé, filtrable par process/type/severity/date range.
 * Pagination OBLIGATOIRE : `limit` est toujours borné (défaut 50, max 500),
 * jamais d'historique complet renvoyé en une seule requête.
 *
 * @returns {{ items: object[], total: number, limit: number, offset: number }}
 */
async function list({ process, type, severity, startTs, endTs, limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const { where, params } = buildWhere({ process, type, severity, startTs, endTs });

  const rows = await db.all(
    `SELECT * FROM process_events ${where} ORDER BY ts DESC, id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params
  );
  const countRow = await db.get(`SELECT COUNT(*) AS n FROM process_events ${where}`, params);

  return {
    items: rows.map(rowToEvent),
    total: countRow ? Number(countRow.n) : 0,
    limit: safeLimit,
    offset: safeOffset,
  };
}

async function purgeOlderThan(cutoffTs) {
  const result = await db.run("DELETE FROM process_events WHERE ts < ?", [cutoffTs]);
  return result.changes;
}

module.exports = {
  MAX_LIMIT,
  DEFAULT_LIMIT,
  create,
  getById,
  list,
  purgeOlderThan,
};
