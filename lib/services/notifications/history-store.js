"use strict";

/**
 * Historique des tentatives d'envoi de notification (table
 * `notification_history`). Phase 5A : modèle + store minimal
 * (create/list/getById). Phase 5D : écriture par RoutingEngine#dispatch en
 * envoi direct (statuts "success"/"failed"). Phase 5E : le dispatch en file
 * d'attente (voir ../dispatch-queue.js) crée d'abord une entrée "pending"
 * puis la fait évoluer via `update()` (ajouté ici) au fil des tentatives —
 * "retrying" tant que le job sera retenté, "success"/"failed" une fois
 * l'issue connue.
 *
 * IMPORTANT : `metadata` ne doit JAMAIS contenir de credentials. Ce module
 * ne fait aucune détection automatique — c'est à l'appelant (le futur code
 * de dispatch) de ne jamais y placer un secret. Voir
 * lib/services/notifications/provider-store.js pour où vivent les secrets.
 */

const db = require("../../db");

function rowToHistoryEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    providerId: row.provider_id,
    alertId: row.alert_id,
    status: row.status,
    timestamp: Number(row.ts),
    responseTimeMs: row.response_time_ms === null ? null : Number(row.response_time_ms),
    errorCode: row.error_code,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: Number(row.created_at),
  };
}

const VALID_STATUSES = ["pending", "retrying", "success", "failed"];

function validate(input) {
  const errors = [];
  if (!input.status || !VALID_STATUSES.includes(input.status)) {
    errors.push(`status requis (${VALID_STATUSES.join(", ")}).`);
  }
  if (input.metadata !== undefined && input.metadata !== null && typeof input.metadata !== "object") {
    errors.push("metadata doit être un objet.");
  }
  if (errors.length) throw new Error(errors.join(" "));
}

async function create(input) {
  validate(input);
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO notification_history
      (provider_id, alert_id, status, ts, response_time_ms, error_code, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.providerId ?? null,
      input.alertId ?? null,
      input.status,
      input.timestamp ?? now,
      input.responseTimeMs ?? null,
      input.errorCode ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
    ]
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM notification_history WHERE id = ?", [id]);
  return rowToHistoryEntry(row);
}

/**
 * Met à jour une entrée existante (utilisé par le worker de la queue,
 * Phase 5E, pour faire évoluer une entrée "pending" au fil des tentatives).
 * Seuls les champs fournis sont modifiés ; `attempt` est optionnel et vit
 * dans `metadata.attempt` (pas de colonne dédiée, pour ne pas ajouter de
 * migration à cette phase — la table a déjà tout le nécessaire).
 */
async function update(id, patch = {}) {
  if (!id) return null;
  const existing = await getById(id);
  if (!existing) return null;

  const status = patch.status !== undefined ? patch.status : existing.status;
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`status invalide (${VALID_STATUSES.join(", ")}).`);
  }
  const responseTimeMs = patch.responseTimeMs !== undefined ? patch.responseTimeMs : existing.responseTimeMs;
  const errorCode = patch.errorCode !== undefined ? patch.errorCode : existing.errorCode;
  const metadata =
    patch.metadata !== undefined
      ? patch.metadata
      : existing.metadata;

  await db.run(
    `UPDATE notification_history
       SET status = ?, response_time_ms = ?, error_code = ?, metadata = ?
     WHERE id = ?`,
    [status, responseTimeMs ?? null, errorCode ?? null, metadata ? JSON.stringify(metadata) : null, id]
  );
  return getById(id);
}

async function list({ providerId, alertId, status, limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (providerId !== undefined) {
    clauses.push("provider_id = ?");
    params.push(providerId);
  }
  if (alertId !== undefined) {
    clauses.push("alert_id = ?");
    params.push(alertId);
  }
  if (status !== undefined) {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await db.all(
    `SELECT * FROM notification_history ${where} ORDER BY ts DESC LIMIT ?`,
    [...params, Math.max(1, Math.min(500, Number(limit) || 50))]
  );
  return rows.map(rowToHistoryEntry);
}

module.exports = { validate, create, getById, list, update, VALID_STATUSES };