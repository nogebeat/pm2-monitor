"use strict";

/**
 * Traduit un snapshot système (lib/system-stats.js) ou un process PM2
 * formaté (server.js: fmtProcess()) en valeur numérique/texte pour une
 * métrique de règle d'alerte. Aucune dépendance à PM2 ni à Express ici :
 * juste des fonctions pures sur les objets déjà produits ailleurs, pour
 * rester testable sans process réel ni PM2 lancé.
 *
 * Retourne `null` quand la métrique n'est pas disponible sur cette
 * plateforme/ce process (ex: température hors Linux) : le moteur ignore
 * alors l'évaluation plutôt que de considérer la condition comme fausse.
 */

/** @param {object} snapshot - retour de lib/system-stats.js snapshot() */
function readSystemMetric(snapshot, metric) {
  if (!snapshot) return null;
  switch (metric) {
    case "cpu":
      return typeof snapshot.cpu === "number" ? snapshot.cpu : null;
    case "memory":
      return snapshot.mem ? snapshot.mem.percent : null;
    case "disk":
      return snapshot.disk ? snapshot.disk.percent : null;
    case "temperature":
      return snapshot.temp ? snapshot.temp.celsius : null;
    default:
      return null;
  }
}

/**
 * @param {object} proc - process formaté façon fmtProcess() (server.js) :
 *   { name, status, restarts, cpu, memory (octets), ... }
 */
function readProcessMetric(proc, metric) {
  if (!proc) return null;
  switch (metric) {
    case "cpu":
      return typeof proc.cpu === "number" ? proc.cpu : null;
    case "memory":
      // Un process n'a pas de "total" de référence (contrairement à la RAM
      // système) : le seuil s'exprime donc en Mo absolus, pas en pourcentage.
      return typeof proc.memory === "number" ? proc.memory / (1024 * 1024) : null;
    case "restart_count":
      return typeof proc.restarts === "number" ? proc.restarts : null;
    case "status":
      return proc.status || null;
    default:
      return null;
  }
}

module.exports = { readSystemMetric, readProcessMetric };
