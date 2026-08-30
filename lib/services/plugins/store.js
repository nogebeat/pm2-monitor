"use strict";

/**
 * Persistance de l'état ADMINISTRATIF d'un plugin (table `plugins`,
 * migration 022) : activé/désactivé + sa propre configuration (JSON libre,
 * définie par le plugin — jamais interprétée ici). Même style que
 * lib/services/service-dependencies/store.js : requêtes SQL directes via
 * lib/db, pas d'ORM, conversion row (snake_case) <-> objet JS (camelCase).
 *
 * Ne connaît jamais le CODE d'un plugin (ça, c'est loader.js) : ce module
 * ne fait que lire/écrire des lignes le concernant.
 */

const db = require("../../db");

function rowToRecord(row) {
  if (!row) return null;
  return {
    name: row.name,
    enabled: !!row.enabled,
    config: row.config ? JSON.parse(row.config) : {},
    installedAt: Number(row.installed_at),
    updatedAt: Number(row.updated_at),
  };
}

async function getByName(name) {
  const row = await db.get("SELECT * FROM plugins WHERE name = ?", [name]);
  return rowToRecord(row);
}

async function list() {
  const rows = await db.all("SELECT * FROM plugins ORDER BY name ASC", []);
  return rows.map(rowToRecord);
}

/**
 * Crée la ligne d'un plugin nouvellement découvert si elle n'existe pas
 * déjà (idempotent — voir lib/services/process-organization/store.js#ensureDefaults
 * pour la même convention). N'écrase jamais un choix déjà fait par l'admin
 * (enabled/config) si la ligne existe.
 *
 * @param {boolean} defaultEnabled - état initial à la première découverte.
 */
async function ensureRow(name, { defaultEnabled = true } = {}) {
  const existing = await getByName(name);
  if (existing) return existing;

  const now = Date.now();
  await db.run(
    "INSERT INTO plugins (name, enabled, config, installed_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [name, defaultEnabled ? 1 : 0, JSON.stringify({}), now, now],
  );
  return getByName(name);
}

async function setEnabled(name, enabled) {
  const existing = await getByName(name);
  if (!existing) return null;
  await db.run("UPDATE plugins SET enabled = ?, updated_at = ? WHERE name = ?", [
    enabled ? 1 : 0,
    Date.now(),
    name,
  ]);
  return getByName(name);
}

/** Remplace intégralement la configuration d'un plugin (objet JSON-sérialisable). */
async function setConfig(name, config) {
  if (config !== null && typeof config !== "object") {
    throw new Error("config doit être un objet (ou null).");
  }
  const existing = await getByName(name);
  if (!existing) return null;
  await db.run("UPDATE plugins SET config = ?, updated_at = ? WHERE name = ?", [
    JSON.stringify(config || {}),
    Date.now(),
    name,
  ]);
  return getByName(name);
}

/** Supprime la ligne d'un plugin (ex: retiré définitivement du dossier plugins/ et de l'UI). */
async function remove(name) {
  const result = await db.run("DELETE FROM plugins WHERE name = ?", [name]);
  return result.changes > 0;
}

module.exports = { getByName, list, ensureRow, setEnabled, setConfig, remove };
