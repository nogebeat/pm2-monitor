"use strict";

/**
 * Persistance de la table `audit_log` (migration 011_audit_log). Aucune
 * logique de sanitization ici : `create()` fait confiance à l'appelant pour
 * lui fournir une `metadata` déjà passée par `sanitizeAuditMetadata()` (voir
 * index.js#recordEvent, qui est le seul point d'entrée censé appeler
 * `create()` en dehors des tests). Même séparation lecture/écriture que
 * lib/services/events/event-store.js.
 */

const db = require("../../db");

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const STATUSES = ["success", "failed", "denied"];

function rowToEntry(row) {
  if (!row) return null;
  let metadata = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch (e) {
      metadata = null; // metadata corrompue/illisible : ne fait pas échouer la lecture
    }
  }
  return {
    id: row.id,
    timestamp: Number(row.ts),
    userId: row.user_id !== null && row.user_id !== undefined ? Number(row.user_id) : null,
    username: row.username || null,
    action: row.action,
    target: row.target || null,
    targetType: row.target_type || null,
    server: row.server || null,
    status: row.status,
    ip: row.ip || null,
    metadata,
    createdAt: Number(row.created_at),
  };
}

/**
 * @param {object} entry - forme déjà normalisée par index.js#recordEvent
 *   ({ timestamp, userId, username, action, target, targetType, server,
 *      status, ip, metadata }) — `metadata` DOIT déjà être sanitisée.
 */
async function create(entry) {
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO audit_log
      (ts, user_id, username, action, target, target_type, server, status, ip, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.timestamp,
      entry.userId !== undefined && entry.userId !== null ? entry.userId : null,
      entry.username || null,
      entry.action,
      entry.target || null,
      entry.targetType || null,
      entry.server || null,
      entry.status,
      entry.ip || null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      now,
    ],
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM audit_log WHERE id = ?", [id]);
  return rowToEntry(row);
}

function buildWhere({ userId, username, action, status, target, targetType, startTs, endTs }) {
  const clauses = [];
  const params = [];
  if (Number.isFinite(userId)) {
    clauses.push("user_id = ?");
    params.push(userId);
  }
  if (username) {
    clauses.push("username = ?");
    params.push(username);
  }
  if (action) {
    clauses.push("action = ?");
    params.push(action);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (target) {
    clauses.push("target = ?");
    params.push(target);
  }
  if (targetType) {
    clauses.push("target_type = ?");
    params.push(targetType);
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
 * Historique paginé, filtrable par utilisateur/action/statut/cible/date
 * range. Pagination OBLIGATOIRE : `limit` toujours borné (défaut 50, max
 * 200) — même contrat que event-store.js#list.
 *
 * @returns {{ items: object[], total: number, limit: number, offset: number }}
 */
async function list({
  userId,
  username,
  action,
  status,
  target,
  targetType,
  startTs,
  endTs,
  limit = DEFAULT_LIMIT,
  offset = 0,
} = {}) {
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const { where, params } = buildWhere({
    userId,
    username,
    action,
    status,
    target,
    targetType,
    startTs,
    endTs,
  });

  const rows = await db.all(
    `SELECT * FROM audit_log ${where} ORDER BY ts DESC, id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  );
  const countRow = await db.get(`SELECT COUNT(*) AS n FROM audit_log ${where}`, params);

  return {
    items: rows.map(rowToEntry),
    total: countRow ? Number(countRow.n) : 0,
    limit: safeLimit,
    offset: safeOffset,
  };
}

/**
 * Purge les entrées d'audit antérieures à `cutoffTs` (ms epoch). Utilisée
 * par la rétention automatique (voir lib/services/audit/index.js) — aucune
 * route API n'expose de suppression manuelle : la purge par rétention est
 * le seul mécanisme de suppression, volontairement (append-only sinon).
 *
 * @param {number} cutoffTs
 * @returns {Promise<number>} nombre de lignes supprimées
 */
async function purgeOlderThan(cutoffTs) {
  if (!Number.isFinite(cutoffTs)) return 0;
  const result = await db.run("DELETE FROM audit_log WHERE ts < ?", [cutoffTs]);
  return (result && result.changes) || 0;
}

module.exports = {
  MAX_LIMIT,
  DEFAULT_LIMIT,
  STATUSES,
  create,
  getById,
  list,
  purgeOlderThan,
};
