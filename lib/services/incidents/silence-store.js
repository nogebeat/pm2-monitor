"use strict";

/**
 * Persistance des silences (table `alert_silences`, migration 016).
 *
 * Un silence NE supprime JAMAIS une alerte ni un événement (voir prompt de
 * phase, section Silencing) : il n'affecte QUE le routing des notifications
 * (lib/services/notifications/routing/engine.js#dispatch, voir
 * isSilenced() ci-dessous, appelé depuis là).
 *
 * `scope_type` :
 *  - "rule"        : scope_value = id de la règle d'alerte (alert_rules.id)
 *  - "process"     : scope_value = nom du process (alert.targetValue)
 *  - "tag"         : scope_value = nom du tag (process-organization)
 *  - "environment" : scope_value = nom de l'environnement (process-organization)
 *  - "group"       : scope_value = nom du groupe (process-organization)
 *
 * `silence_type` ("duration" | "until") ne change rien au comportement : les
 * deux se résolvent en `expires_at` (epoch ms) au moment de la création,
 * `silence_type` n'est conservé que pour l'affichage ("silence temporaire"
 * vs "silence jusqu'au 12/09").
 */

const db = require("../../db");

const SCOPE_TYPES = ["rule", "process", "tag", "environment", "group"];
const SILENCE_TYPES = ["duration", "until"];

function rowToSilence(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeValue: row.scope_value,
    silenceType: row.silence_type,
    expiresAt: Number(row.expires_at),
    reason: row.reason,
    createdBy: row.created_by,
    cancelledAt: row.cancelled_at !== null ? Number(row.cancelled_at) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    active: row.cancelled_at === null && Number(row.expires_at) > Date.now(),
  };
}

function validate({ scopeType, scopeValue, expiresAt }) {
  const errors = [];
  if (!SCOPE_TYPES.includes(scopeType)) {
    errors.push(`scopeType invalide: "${scopeType}". Attendu: ${SCOPE_TYPES.join(", ")}.`);
  }
  if (!scopeValue || typeof scopeValue !== "string") {
    errors.push("scopeValue requis (chaîne non vide).");
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    errors.push("expiresAt requis et doit être dans le futur.");
  }
  if (errors.length) throw new Error(errors.join(" "));
}

/**
 * @param {object} fields
 * @param {"rule"|"process"|"tag"|"environment"|"group"} fields.scopeType
 * @param {string} fields.scopeValue
 * @param {"duration"|"until"} [fields.silenceType]
 * @param {number} fields.expiresAt - epoch ms, déjà résolu par l'appelant
 *   (routes/incidents.js) qu'il s'agisse d'une durée ("30 minutes" ->
 *   now + 30*60*1000) ou d'une date explicite ("jusqu'au 2026-09-12").
 * @param {string} [fields.reason]
 * @param {number|null} [fields.createdBy]
 */
async function create(fields) {
  validate(fields);
  const silenceType = SILENCE_TYPES.includes(fields.silenceType) ? fields.silenceType : "duration";
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO alert_silences
      (scope_type, scope_value, silence_type, expires_at, reason, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [fields.scopeType, fields.scopeValue, silenceType, fields.expiresAt, fields.reason || null, fields.createdBy ?? null, now, now],
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM alert_silences WHERE id = ?", [id]);
  return rowToSilence(row);
}

/** Annulation anticipée (avant expiration naturelle) — ne supprime pas la ligne, conserve l'historique. */
async function cancel(id) {
  const now = Date.now();
  await db.run("UPDATE alert_silences SET cancelled_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  return getById(id);
}

/** Liste, optionnellement filtrée aux silences encore actifs (non annulés, non expirés). */
async function list({ activeOnly = false } = {}) {
  const rows = await db.all("SELECT * FROM alert_silences ORDER BY created_at DESC", []);
  const items = rows.map(rowToSilence);
  return activeOnly ? items.filter((s) => s.active) : items;
}

/** Tous les silences actuellement actifs (utilisé par isSilenced ci-dessous). */
async function listActive() {
  const now = Date.now();
  const rows = await db.all(
    "SELECT * FROM alert_silences WHERE cancelled_at IS NULL AND expires_at > ? ORDER BY id DESC",
    [now],
  );
  return rows.map(rowToSilence);
}

/**
 * Une alerte est silencée si au moins un silence actif matche l'un de ses
 * critères. `processOrg` (tags/environment/groups) est optionnel — voir
 * RoutingEngine#_resolveProcessOrg, réutilisé tel quel par l'appelant.
 *
 * @param {object} alert - alert-store.js#rowToAlert (ruleId, targetType, targetValue)
 * @param {{tags: string[], environment: string|null, groups: string[]}|null} processOrg
 * @returns {Promise<boolean>}
 */
async function isSilenced(alert, processOrg) {
  const silences = await listActive();
  if (!silences.length) return false;
  return silences.some((s) => matches(s, alert, processOrg));
}

function matches(silence, alert, processOrg) {
  switch (silence.scopeType) {
    case "rule":
      return alert.ruleId !== undefined && alert.ruleId !== null && String(alert.ruleId) === silence.scopeValue;
    case "process":
      return alert.targetType === "process" && alert.targetValue === silence.scopeValue;
    case "tag":
      return !!processOrg && Array.isArray(processOrg.tags) && processOrg.tags.includes(silence.scopeValue);
    case "environment":
      return !!processOrg && processOrg.environment === silence.scopeValue;
    case "group":
      return !!processOrg && Array.isArray(processOrg.groups) && processOrg.groups.includes(silence.scopeValue);
    default:
      return false;
  }
}

module.exports = {
  SCOPE_TYPES,
  SILENCE_TYPES,
  create,
  getById,
  cancel,
  list,
  listActive,
  isSilenced,
  matches,
};
