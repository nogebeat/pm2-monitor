"use strict";

/**
 * Configuration de l'export Prometheus (lib/services/metrics/, Phase 15).
 *
 * `resolveConfig(env)` est une fonction pure (pas de lecture directe de
 * `process.env` ailleurs dans ce service) — même approche que
 * lib/services/events/config.js / lib/services/audit/config.js.
 *
 * GET /metrics n'est PAS monté sous /api : un scraper Prometheus ne porte
 * jamais le cookie de session du navigateur (voir lib/auth.js#requireAuth,
 * qui ne bloque que les chemins /api/*). Ce module définit donc sa PROPRE
 * politique d'accès, indépendante du système d'auth par session existant :
 *   - METRICS_ENABLED=0 désactive complètement la route (404) ;
 *   - METRICS_TOKEN, si défini, exige `Authorization: Bearer <token>` (une
 *     valeur définie active automatiquement l'exigence de token — pas de
 *     bascule séparée nécessaire) ;
 *   - METRICS_ALLOWED_IPS restreint l'accès à une liste d'IP explicites
 *     (comparaison exacte sur `req.ip`, cohérent avec `app.set("trust
 *     proxy", 1)` déjà en place dans server.js) ;
 *   - si NI l'un NI l'autre n'est défini, on retombe par défaut sur
 *     l'hôte local uniquement (127.0.0.1/::1/::ffff:127.0.0.1) plutôt que
 *     d'exposer l'endpoint à quiconque atteint le port : un opérateur qui
 *     veut scraper depuis une autre machine doit définir explicitement un
 *     token ou une liste d'IP (voir docs/metrics/README.md#sécurité).
 */

const LOOPBACK_IPS = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

function parseList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function resolveConfig(env = process.env) {
  const token = env.METRICS_TOKEN ? String(env.METRICS_TOKEN) : null;
  const allowedIps = parseList(env.METRICS_ALLOWED_IPS);
  return {
    enabled: env.METRICS_ENABLED !== "0",
    token,
    // Restriction d'accès effective : IP explicites si fournies, sinon
    // loopback uniquement tant qu'aucun token n'est défini non plus (voir
    // en-tête). Un token seul (sans IP restreinte) suffit à autoriser
    // n'importe quelle IP : c'est le cas d'usage "Prometheus distant".
    allowedIps: allowedIps.length ? allowedIps : token ? null : LOOPBACK_IPS,
  };
}

module.exports = { resolveConfig, LOOPBACK_IPS };
