"use strict";

/**
 * CRUD + validation pour les configurations de providers de notification
 * (table `notification_providers`). Même style que
 * lib/services/alerts/alert-rules-store.js : requêtes SQL directes via
 * lib/db, pas d'ORM, conversion row (snake_case) <-> objet JS (camelCase).
 *
 * `type` n'est PAS contraint à un provider réellement enregistré dans le
 * Provider Registry (registry.js) — ce store reste indépendant du registry
 * pour éviter une dépendance circulaire store <-> providers/. La validation
 * "ce type existe" est faite plus haut (manager.js / routes), pas ici.
 *
 * Secrets : jamais retournés en clair par ce module en usage normal.
 * `list()`/`getById()` retournent `hasSecrets` (booléen) mais pas leur
 * contenu ; `getDecryptedSecrets()` est fourni séparément pour un usage
 * interne futur (Phase 5B/5C, au moment d'envoyer réellement une
 * notification) — non exposé via lib/routes/notifications.js dans cette
 * phase (voir section 11 de la tâche : CRUD complet reporté en Phase 5C).
 */

const db = require("../../db");
const secretsCrypto = require("./utils/crypto");

function rowToProvider(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: !!row.enabled,
    configuration: row.configuration ? JSON.parse(row.configuration) : {},
    hasSecrets: !!row.secrets,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function validate(input, { partial = false } = {}) {
  const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;

  if (!partial || has("name")) {
    if (!input.name || !String(input.name).trim()) errors.push("name requis.");
  }
  if (!partial || has("type")) {
    if (!input.type || !String(input.type).trim()) errors.push("type requis.");
  }
  if (has("configuration") && input.configuration !== null && typeof input.configuration !== "object") {
    errors.push("configuration doit être un objet.");
  }
  if (has("secrets") && input.secrets !== null && typeof input.secrets !== "object") {
    errors.push("secrets doit être un objet.");
  }

  if (errors.length) throw new Error(errors.join(" "));
}

async function create(input) {
  validate(input, { partial: false });
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO notification_providers
      (name, type, enabled, configuration, secrets, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.name).trim(),
      String(input.type).trim(),
      input.enabled === undefined ? 1 : input.enabled ? 1 : 0,
      JSON.stringify(input.configuration || {}),
      secretsCrypto.encrypt(input.secrets || null),
      now,
      now,
    ]
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM notification_providers WHERE id = ?", [id]);
  return rowToProvider(row);
}

async function list({ type } = {}) {
  const rows = type
    ? await db.all("SELECT * FROM notification_providers WHERE type = ? ORDER BY name ASC", [type])
    : await db.all("SELECT * FROM notification_providers ORDER BY name ASC", []);
  return rows.map(rowToProvider);
}

async function update(id, changes) {
  const existing = await db.get("SELECT * FROM notification_providers WHERE id = ?", [id]);
  if (!existing) return null;
  validate(changes, { partial: true });

  const merged = {
    name: changes.name !== undefined ? changes.name : existing.name,
    type: changes.type !== undefined ? changes.type : existing.type,
    enabled: changes.enabled !== undefined ? (changes.enabled ? 1 : 0) : existing.enabled,
    configuration:
      changes.configuration !== undefined
        ? JSON.stringify(changes.configuration || {})
        : existing.configuration,
    secrets:
      changes.secrets !== undefined ? secretsCrypto.encrypt(changes.secrets) : existing.secrets,
  };

  const now = Date.now();
  await db.run(
    `UPDATE notification_providers SET
      name = ?, type = ?, enabled = ?, configuration = ?, secrets = ?, updated_at = ?
     WHERE id = ?`,
    [String(merged.name).trim(), String(merged.type).trim(), merged.enabled, merged.configuration, merged.secrets, now, id]
  );
  return getById(id);
}

async function remove(id) {
  const result = await db.run("DELETE FROM notification_providers WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Déchiffre et retourne les secrets d'une configuration. Réservé à un usage
 * interne (aucune route ne l'expose en Phase 5A). Retourne null si la
 * configuration n'a pas de secrets stockés.
 */
async function getDecryptedSecrets(id) {
  const row = await db.get("SELECT secrets FROM notification_providers WHERE id = ?", [id]);
  if (!row) return null;
  return secretsCrypto.decrypt(row.secrets);
}

module.exports = {
  validate,
  create,
  getById,
  list,
  update,
  remove,
  getDecryptedSecrets,
};