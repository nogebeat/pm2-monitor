"use strict";

/**
 * Configuration du service de timeline d'événements (lib/services/events/).
 *
 * `resolveConfig(env)` est une fonction pure (pas de lecture directe de
 * `process.env` ailleurs dans ce service) — même approche que
 * lib/services/process-history/config.js.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const DEFAULTS = {
  enabled: true,
  retentionMs: 90 * DAY, // durée de conservation des événements avant purge automatique
  maintenanceIntervalMs: HOUR, // fréquence du cycle de purge
};

function numFromEnv(env, key, fallback) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveConfig(env = process.env) {
  return {
    enabled: env.EVENTS_ENABLED !== "0",
    retentionMs: numFromEnv(env, "EVENTS_RETENTION_MS", DEFAULTS.retentionMs),
    maintenanceIntervalMs: numFromEnv(env, "EVENTS_MAINTENANCE_INTERVAL_MS", DEFAULTS.maintenanceIntervalMs),
  };
}

module.exports = { resolveConfig, DEFAULTS, HOUR, DAY };
