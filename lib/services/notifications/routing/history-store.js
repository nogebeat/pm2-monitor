"use strict";

/**
 * Historique des tentatives d'envoi de notification (table
 * `notification_history`). Phase 5A : uniquement le modèle + un store minimal
 * (create/list/getById) — aucune écriture réelle n'est déclenchée par ce
 * module dans cette phase, ce sera fait par le futur dispatch (Phase 5B/5C)
 * au moment où un provider tentera effectivement un envoi.
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

const VALID_STATUSES = ["pending", "success", "failed"];

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
    ],
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM notification_history WHERE id = ?", [id]);
  return rowToHistoryEntry(row);
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
  const rows = await db.all(`SELECT * FROM notification_history ${where} ORDER BY ts DESC LIMIT ?`, [
    ...params,
    Math.max(1, Math.min(500, Number(limit) || 50)),
  ]);
  return rows.map(rowToHistoryEntry);
}

module.exports = { validate, create, getById, list };
