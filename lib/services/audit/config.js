"use strict";

/**
 * Configuration de la rétention de l'audit log (lib/services/audit/).
 *
 * Même approche que lib/services/events/config.js /
 * lib/services/process-history/config.js : `resolveConfig(env)` est une
 * fonction pure, pas de lecture directe de `process.env` ailleurs dans ce
 * service.
 *
 * Rétention **désactivée par défaut** (`retentionMs: 0`) : contrairement à
 * la timeline d'événements (purge automatique après 90 jours par défaut),
 * l'audit log est un journal de conformité/sécurité — le choix le plus sûr
 * est de ne rien supprimer tant que l'opérateur n'a pas explicitement
 * défini une politique de rétention (voir docs/audit/README.md#rétention).
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const DEFAULTS = {
  retentionMs: 0, // 0 = purge désactivée (conserve tout, comportement par défaut)
  maintenanceIntervalMs: HOUR, // fréquence du cycle de purge, si activée
};

function numFromEnv(env, key, fallback) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const n = Number(env[key]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function resolveConfig(env = process.env) {
  return {
    retentionMs: numFromEnv(env, "AUDIT_RETENTION_MS", DEFAULTS.retentionMs),
    maintenanceIntervalMs: numFromEnv(env, "AUDIT_MAINTENANCE_INTERVAL_MS", DEFAULTS.maintenanceIntervalMs),
  };
}

module.exports = { resolveConfig, DEFAULTS, HOUR, DAY };
