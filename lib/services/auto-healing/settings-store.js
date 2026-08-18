"use strict";

/**
 * Persistance de la configuration globale Auto-Healing (table
 * `auto_healing_settings`, ligne unique id=1 — créée par la migration
 * 009_auto_healing.js, désactivée par défaut).
 *
 * `backoffSeconds` est stocké en texte CSV ("60,300,900") plutôt qu'en JSON
 * pour rester lisible/éditable à la main en base si besoin ; converti en
 * tableau de nombres côté lecture.
 */

const db = require("../../db");

const MIN_MAX_ATTEMPTS = 1;
const MAX_MAX_ATTEMPTS = 20;

function parseBackoff(csv) {
  return String(csv || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

function serializeBackoff(list) {
  return list.map((n) => Math.max(0, Math.round(Number(n) || 0))).join(",");
}

function rowToSettings(row) {
  if (!row) {
    // Ne devrait jamais arriver (la migration insère la ligne par défaut),
    // mais on retombe sur des valeurs sûres (désactivé) plutôt que de planter.
    return {
      enabled: false,
      maxAttempts: 3,
      backoffSeconds: [60, 300, 900],
      updatedBy: null,
      updatedAt: null,
    };
  }
  return {
    enabled: !!row.enabled,
    maxAttempts: Number(row.max_attempts),
    backoffSeconds: parseBackoff(row.backoff_seconds),
    updatedBy: row.updated_by === undefined ? null : row.updated_by,
    updatedAt: Number(row.updated_at),
  };
}

async function get() {
  const row = await db.get("SELECT * FROM auto_healing_settings WHERE id = 1", []);
  return rowToSettings(row);
}

/**
 * Met à jour un sous-ensemble de champs. `enabled` ne bascule que sur action
 * explicite de l'appelant (voir lib/routes/auto-healing.js, permission
 * authealing.manage) — jamais activé implicitement par ce module.
 */
async function update(changes, { userId } = {}) {
  const current = await get();

  const enabled = changes.enabled !== undefined ? !!changes.enabled : current.enabled;

  let maxAttempts = current.maxAttempts;
  if (changes.maxAttempts !== undefined) {
    const n = Number(changes.maxAttempts);
    if (!Number.isInteger(n) || n < MIN_MAX_ATTEMPTS || n > MAX_MAX_ATTEMPTS) {
      throw new Error(`maxAttempts doit être un entier entre ${MIN_MAX_ATTEMPTS} et ${MAX_MAX_ATTEMPTS}.`);
    }
    maxAttempts = n;
  }

  let backoffSeconds = current.backoffSeconds;
  if (changes.backoffSeconds !== undefined) {
    if (!Array.isArray(changes.backoffSeconds) || !changes.backoffSeconds.length) {
      throw new Error("backoffSeconds doit être un tableau non vide de secondes.");
    }
    if (changes.backoffSeconds.some((n) => !Number.isFinite(Number(n)) || Number(n) < 0)) {
      throw new Error("backoffSeconds ne peut contenir que des nombres positifs.");
    }
    backoffSeconds = changes.backoffSeconds.map(Number);
  }

  await db.run(
    `UPDATE auto_healing_settings SET enabled = ?, max_attempts = ?, backoff_seconds = ?, updated_by = ?, updated_at = ? WHERE id = 1`,
    [enabled ? 1 : 0, maxAttempts, serializeBackoff(backoffSeconds), userId ?? null, Date.now()],
  );

  return get();
}

module.exports = { get, update, MIN_MAX_ATTEMPTS, MAX_MAX_ATTEMPTS };
