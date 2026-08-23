"use strict";

/**
 * Configuration de la corrélation d'incidents (lib/services/incidents/).
 * Même approche que lib/services/audit/config.js : `resolveConfig(env)` pure,
 * pas de lecture directe de `process.env` ailleurs dans ce service.
 */

const MINUTE = 60 * 1000;

const DEFAULTS = {
  // Fenêtre temporelle de corrélation déterministe (voir correlation.js) :
  // deux alertes du même process/groupe/type de problème survenant à moins
  // de `correlationWindowMs` l'une de l'autre sont rattachées au même
  // incident plutôt que d'en ouvrir un nouveau.
  correlationWindowMs: 15 * MINUTE,
};

function numFromEnv(env, key, fallback) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const n = Number(env[key]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function resolveConfig(env = process.env) {
  return {
    correlationWindowMs: numFromEnv(env, "INCIDENTS_CORRELATION_WINDOW_MS", DEFAULTS.correlationWindowMs),
  };
}

module.exports = { resolveConfig, DEFAULTS, MINUTE };
