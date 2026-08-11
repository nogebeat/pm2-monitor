"use strict";

/**
 * Configuration du service d'historique par process (lib/services/process-history/).
 *
 * `resolveConfig(env)` est une fonction pure (pas de lecture directe de
 * `process.env` ailleurs dans ce service) pour rester testable sans
 * manipuler des variables globales — même approche que
 * `lib/services/alerts/` qui garde toute lecture d'env dans `server.js`.
 *
 * Trois résolutions, chacune avec sa propre rétention :
 *   - raw    : un échantillon brut par tick de collecte (court terme).
 *   - medium : agrégats horaires, calculés à partir des lignes `raw`.
 *   - long   : agrégats journaliers, calculés à partir des lignes `medium`.
 *
 * Toutes les durées sont en millisecondes pour rester cohérentes avec le
 * reste du projet (lib/history-store.js, lib/services/alerts/).
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DEFAULTS = {
  enabled: true,
  collectIntervalMs: 15 * 1000, // aligné par défaut sur ALERTS_EVAL_INTERVAL_MS (server.js)
  maintenanceIntervalMs: 5 * MINUTE,

  shortRetentionMs: 24 * HOUR, // rétention des échantillons `raw`
  mediumBucketMs: HOUR, // taille d'un bucket `medium`
  mediumRetentionMs: 30 * DAY,
  longBucketMs: DAY, // taille d'un bucket `long`
  longRetentionMs: 365 * DAY,

  // Choix automatique de la résolution selon la plage demandée à l'API,
  // quand `resolution` n'est pas fourni explicitement.
  rawMaxSpanMs: 6 * HOUR,
  mediumMaxSpanMs: 30 * DAY,

  maxPoints: 500, // downsampling : jamais plus de points que ça dans une réponse API
};

function numFromEnv(env, key, fallback) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveConfig(env = process.env) {
  return {
    enabled: env.PROCESS_HISTORY_ENABLED !== "0",
    collectIntervalMs: numFromEnv(env, "PROCESS_HISTORY_COLLECT_INTERVAL_MS", DEFAULTS.collectIntervalMs),
    maintenanceIntervalMs: numFromEnv(
      env,
      "PROCESS_HISTORY_MAINTENANCE_INTERVAL_MS",
      DEFAULTS.maintenanceIntervalMs
    ),
    shortRetentionMs: numFromEnv(env, "PROCESS_HISTORY_SHORT_RETENTION_MS", DEFAULTS.shortRetentionMs),
    mediumBucketMs: numFromEnv(env, "PROCESS_HISTORY_MEDIUM_BUCKET_MS", DEFAULTS.mediumBucketMs),
    mediumRetentionMs: numFromEnv(env, "PROCESS_HISTORY_MEDIUM_RETENTION_MS", DEFAULTS.mediumRetentionMs),
    longBucketMs: numFromEnv(env, "PROCESS_HISTORY_LONG_BUCKET_MS", DEFAULTS.longBucketMs),
    longRetentionMs: numFromEnv(env, "PROCESS_HISTORY_LONG_RETENTION_MS", DEFAULTS.longRetentionMs),
    rawMaxSpanMs: numFromEnv(env, "PROCESS_HISTORY_RAW_MAX_SPAN_MS", DEFAULTS.rawMaxSpanMs),
    mediumMaxSpanMs: numFromEnv(env, "PROCESS_HISTORY_MEDIUM_MAX_SPAN_MS", DEFAULTS.mediumMaxSpanMs),
    maxPoints: numFromEnv(env, "PROCESS_HISTORY_MAX_POINTS", DEFAULTS.maxPoints),
  };
}

module.exports = { resolveConfig, DEFAULTS, MINUTE, HOUR, DAY };
