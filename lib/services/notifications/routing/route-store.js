"use strict";

/**
 * CRUD + validation pour le modèle de données du routing des notifications
 * (table `notification_routes`). Même style que
 * lib/services/alerts/alert-rules-store.js.
 *
 * Phase 5A a posé le modèle seul (aucun moteur ne lisait cette table).
 * Phase 5D branche le moteur d'évaluation (routing/engine.js) sur l'Alert
 * Engine : ce store reste uniquement responsable de la persistance/
 * validation, l'engine décide qui matche et route/dispatcher.js décide quoi
 * envoyer et à qui.
 *
 * `conditions` : objet libre
 * { severity?, alertType?, process?, server?, tag?, environment?, group? },
 * chacun un tableau de valeurs autorisées (tableau vide ou absent = "toutes").
 * Voir routing/engine.js#routeMatches pour la sémantique exacte de chaque
 * clé. `server` n'a pas d'équivalent dans le modèle d'alerte actuel
 * (moniteur mono-hôte côté Alert Engine) : un filtre `server` non vide ne
 * matche que les alertes "system". `tag`/`environment`/`group` (Phase 13 —
 * Tags, Environments & Process Groups) sont résolus dynamiquement pour une
 * alerte "process" via lib/services/process-organization/store.js — voir
 * routing/engine.js#_resolveProcessOrg.
 *
 * `providerIds` : tableau d'ids de `notification_providers` (pas de FK SQL —
 * mêmes raisons que `alert_rules.target_value` : validation applicative,
 * pas de contrainte qui empêcherait de désactiver un provider sans casser la
 * règle).
 *
 * `titleTemplate` / `messageTemplate` (Phase 5D, 007_notification_routing_
 * templates.js) : gabarits `{{placeholder}}` optionnels — voir
 * routing/templates.js. `null`/absent = gabarit par défaut.
 *
 * `notifyOnResolve` (Phase 5D) : par défaut une règle ne notifie qu'au
 * déclenchement de l'alerte ; ce flag ajoute une notification à la
 * résolution.
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
    titleTemplate: row.title_template === undefined ? null : row.title_template,
    messageTemplate: row.message_template === undefined ? null : row.message_template,
    notifyOnResolve: !!row.notify_on_resolve,
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
  if (has("titleTemplate") && input.titleTemplate !== null && typeof input.titleTemplate !== "string") {
    errors.push("titleTemplate doit être une chaîne (ou null).");
  }
  if (has("messageTemplate") && input.messageTemplate !== null && typeof input.messageTemplate !== "string") {
    errors.push("messageTemplate doit être une chaîne (ou null).");
  }

  if (errors.length) throw new Error(errors.join(" "));
}

async function create(input) {
  validate(input, { partial: false });
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO notification_routes
      (name, enabled, conditions, provider_ids, title_template, message_template, notify_on_resolve, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.name).trim(),
      input.enabled === undefined ? 1 : input.enabled ? 1 : 0,
      JSON.stringify(input.conditions || {}),
      JSON.stringify(input.providerIds || []),
      input.titleTemplate || null,
      input.messageTemplate || null,
      input.notifyOnResolve ? 1 : 0,
      now,
      now,
    ],
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
    `UPDATE notification_routes SET
      name = ?, enabled = ?, conditions = ?, provider_ids = ?,
      title_template = ?, message_template = ?, notify_on_resolve = ?, updated_at = ?
     WHERE id = ?`,
    [
      String(merged.name).trim(),
      merged.enabled ? 1 : 0,
      JSON.stringify(merged.conditions || {}),
      JSON.stringify(merged.providerIds || []),
      merged.titleTemplate || null,
      merged.messageTemplate || null,
      merged.notifyOnResolve ? 1 : 0,
      now,
      id,
    ],
  );
  return getById(id);
}

async function remove(id) {
  const result = await db.run("DELETE FROM notification_routes WHERE id = ?", [id]);
  return result.changes > 0;
}

module.exports = { validate, create, getById, list, update, remove };
