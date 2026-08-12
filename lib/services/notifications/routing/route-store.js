"use strict";

/**
 * CRUD + validation pour le modèle de données du futur routing des
 * notifications (table `notification_routes`). Même style que
 * lib/services/alerts/alert-rules-store.js.
 *
 * IMPORTANT (Phase 5A) : ce module ne fait que persister le modèle décrit
 * dans lib/db/migrations/006_notifications.js — aucun moteur ne lit encore
 * cette table pour décider où router une notification (ce sera fait en
 * Phase 5B/5C, probablement consommateur de lib/services/queue/ comme
 * lib/services/alerts/). Non exposé via lib/routes/notifications.js dans
 * cette phase (voir section 11 de la tâche : API minimale).
 *
 * `conditions` : objet libre { severity?, alertType?, process?, server?, tag? },
 * chacun un tableau de valeurs autorisées (tableau vide ou absent = "toutes").
 * `providerIds` : tableau d'ids de `notification_providers` (pas de FK SQL —
 * mêmes raisons que `alert_rules.target_value` : validation applicative,
 * pas de contrainte qui empêcherait de désactiver un provider sans casser la
 * règle).
 */

const db = require("../../../db");

function rowToRoute(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    conditions: row.conditions ? JSON.parse(row.conditions) : {},
    providerIds: row.provider_ids ? JSON.parse(row.provider_ids) : [],
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
  if (has("conditions") && input.conditions !== null && typeof input.conditions !== "object") {
    errors.push("conditions doit être un objet.");
  }
  if (has("providerIds") && input.providerIds !== null && !Array.isArray(input.providerIds)) {
    errors.push("providerIds doit être un tableau.");
  }

  if (errors.length) throw new Error(errors.join(" "));
}

async function create(input) {
  validate(input, { partial: false });
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO notification_routes (name, enabled, conditions, provider_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      String(input.name).trim(),
      input.enabled === undefined ? 1 : input.enabled ? 1 : 0,
      JSON.stringify(input.conditions || {}),
      JSON.stringify(input.providerIds || []),
      now,
      now,
    ]
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM notification_routes WHERE id = ?", [id]);
  return rowToRoute(row);
}

async function list({ enabledOnly = false } = {}) {
  const rows = enabledOnly
    ? await db.all("SELECT * FROM notification_routes WHERE enabled = 1 ORDER BY name ASC", [])
    : await db.all("SELECT * FROM notification_routes ORDER BY name ASC", []);
  return rows.map(rowToRoute);
}

async function update(id, changes) {
  const existing = await getById(id);
  if (!existing) return null;
  validate(changes, { partial: true });

  const merged = { ...existing, ...changes };
  const now = Date.now();
  await db.run(
    `UPDATE notification_routes SET name = ?, enabled = ?, conditions = ?, provider_ids = ?, updated_at = ?
     WHERE id = ?`,
    [
      String(merged.name).trim(),
      merged.enabled ? 1 : 0,
      JSON.stringify(merged.conditions || {}),
      JSON.stringify(merged.providerIds || []),
      now,
      id,
    ]
  );
  return getById(id);
}

async function remove(id) {
  const result = await db.run("DELETE FROM notification_routes WHERE id = ?", [id]);
  return result.changes > 0;
}

module.exports = { validate, create, getById, list, update, remove };
