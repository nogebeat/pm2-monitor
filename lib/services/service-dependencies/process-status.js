"use strict";

/**
 * Dérive le statut d'une dépendance de type PROCESS à partir de l'état PM2
 * réel du process local, quand aucun health check n'est lié (voir
 * status.js#dependencyStatus — un health check lié reste toujours
 * prioritaire, il est explicitement configuré par l'utilisateur et donc
 * plus précis que le statut brut du process).
 *
 * Séparé en deux parties, même découpage que readers.js/detector.js dans
 * lib/services/anomaly-detection/ :
 * - mapPm2StatusToDependencyStatus() : pure, testable sans PM2.
 * - listLocalProcessStatuses() : I/O (pm2.list()), jamais appelée si aucune
 *   dépendance PROCESS sans health check n'existe (voir status.js), et ne
 *   lève jamais — un daemon PM2 absent/indisponible ne doit jamais casser
 *   la lecture du graphe, juste laisser ces dépendances en "UNKNOWN".
 */

const pm2 = require("pm2");

/** env.status (pm2_env.status) -> statut de dépendance. Pure, sans I/O. */
function mapPm2StatusToDependencyStatus(pm2Status) {
  switch (pm2Status) {
    case "online":
      return "UP";
    case "stopped":
    case "errored":
      return "DOWN";
    case "stopping":
    case "launching":
    case "one-launch-status":
      return "DEGRADED";
    default:
      return "UNKNOWN";
  }
}

/**
 * `Map(nom_process -> statut)` pour tous les process PM2 locaux visibles
 * (hôte local uniquement — voir "Limites connues" dans docs/service-
 * dependencies/README.md pour les process d'agents distants).
 * Ne rejette jamais : PM2 indisponible/non connecté -> Map vide.
 */
function listLocalProcessStatuses() {
  return new Promise((resolve) => {
    pm2.connect((connectErr) => {
      if (connectErr) return resolve(new Map());
      pm2.list((listErr, list) => {
        if (listErr || !Array.isArray(list)) return resolve(new Map());
        const byName = new Map();
        for (const p of list) {
          const status = mapPm2StatusToDependencyStatus((p.pm2_env || {}).status);
          // Plusieurs instances (cluster mode) peuvent partager un même nom :
          // le pire statut l'emporte (une instance DOWN doit rester visible).
          const existing = byName.get(p.name);
          if (!existing || rank(status) > rank(existing)) byName.set(p.name, status);
        }
        resolve(byName);
      });
    });
  });
}

function rank(status) {
  return { UP: 0, UNKNOWN: 1, DEGRADED: 2, DOWN: 3 }[status] ?? 1;
}

module.exports = { mapPm2StatusToDependencyStatus, listLocalProcessStatuses };
