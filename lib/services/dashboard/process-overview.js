"use strict";

/**
 * calculateProcessOverview() — fonction pure, même esprit que
 * global-status.js : pas d'I/O, uniquement un tableau de process déjà
 * formatés (server.js#fmtProcess ou équivalent). Compte les statuts PM2
 * dans les 6 catégories demandées par la Phase 8.
 *
 * PM2 n'expose que 5 valeurs de `pm2_env.status` : "online", "stopping",
 * "stopped", "launching", "errored" (+ "one-launch-status", cas cron rare
 * ignoré ici). Il n'existe pas de statut "crashed" ou "restarting" distinct
 * côté PM2 — les 6 catégories demandées par le prompt maître sont donc
 * reconstruites explicitement plutôt qu'inventées :
 *
 *   - online     : status === "online"
 *   - stopped    : status === "stopped" ou "stopping"
 *   - errored    : status === "errored"
 *   - crashed    : ALIAS de "errored" — PM2 ne distingue pas un process qui
 *                  a été arrêté volontairement en erreur d'un process qui a
 *                  crashé puis épuisé ses tentatives de redémarrage ; les
 *                  deux se retrouvent avec le même status "errored". Ce
 *                  compteur est donc **identique** à `errored`, exposé
 *                  séparément uniquement parce que le dashboard doit
 *                  afficher les deux libellés (voir docs/dashboard/README.md).
 *                  Ne PAS l'additionner à `errored` dans `total` (ce serait
 *                  compter les mêmes process deux fois).
 *   - restarting : status === "launching" (état transitoire pendant lequel
 *                  PM2 relance le process, y compris via Auto-Healing).
 *   - total      : processes.length (online + stopped + errored + restarting,
 *                  puisque "crashed" est un alias de "errored" et non une
 *                  catégorie disjointe).
 */

function calculateProcessOverview(processes) {
  const list = Array.isArray(processes) ? processes : [];

  const overview = { total: list.length, online: 0, stopped: 0, errored: 0, crashed: 0, restarting: 0 };

  for (const p of list) {
    const status = p && p.status;
    if (status === "online") {
      overview.online += 1;
    } else if (status === "stopped" || status === "stopping") {
      overview.stopped += 1;
    } else if (status === "errored") {
      overview.errored += 1;
      overview.crashed += 1; // alias, voir commentaire d'en-tête
    } else if (status === "launching") {
      overview.restarting += 1;
    }
    // autres valeurs (ex: "one-launch-status") : comptées dans `total` mais
    // dans aucune sous-catégorie, plutôt que d'en forcer une arbitrairement.
  }

  return overview;
}

module.exports = { calculateProcessOverview };
