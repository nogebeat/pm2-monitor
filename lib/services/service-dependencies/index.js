"use strict";

/**
 * Point d'entrée du service de carte de dépendances (Phase 17). Même
 * convention que lib/services/health-checks/index.js : un module require()
 * partagé entre le routeur REST (lib/routes/service-dependencies.js) et
 * server.js (câblage sur le résultat des health checks).
 */

const store = require("./store");
const graph = require("./graph");
const status = require("./status");

/**
 * À appeler quand un health check produit un nouveau résultat
 * (healthCheckEngine.onCheckResult, voir server.js). Ne fait rien si aucune
 * dépendance déclarée n'est liée à ce check. Sinon, recalcule l'impact pour
 * chaque service (target) concerné et retourne un résumé prêt à diffuser en
 * websocket — server.js décide du nom d'événement et de la diffusion,
 * ce module reste indépendant de Socket.IO (comme le reste de lib/services/).
 *
 * @returns {Promise<null|{checkId:number, checkStatus:string, impacts: Array}>}
 */
async function handleHealthCheckResult(check) {
  const dependencies = await store.listByHealthCheckId(check.id);
  if (!dependencies.length) return null;

  const targets = [...new Set(dependencies.map((d) => d.target))];
  const impacts = await Promise.all(targets.map((target) => status.computeImpact(target)));

  return {
    checkId: check.id,
    checkStatus: check.status,
    impacts: impacts.filter((i) => i.status === "DOWN" && i.potentiallyAffected.length > 0),
  };
}

module.exports = {
  TYPES: store.TYPES,
  store,
  graph,
  status,
  handleHealthCheckResult,
};
