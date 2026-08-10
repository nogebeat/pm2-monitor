"use strict";

const { PersistentQueue } = require("./persistent-queue");

/**
 * Crée (ou récupère) une file d'attente persistante nommée `name`.
 * Voir persistent-queue.js pour le détail d'implémentation et le choix
 * d'architecture (pourquoi pas better-queue / bee-queue).
 *
 * Usage typique (dans une phase future qui ajoutera de la logique métier) :
 *
 *   const { createQueue } = require("../lib/services/queue");
 *   const alertsQueue = createQueue("alerts", { maxAttempts: 5 });
 *   await alertsQueue.add({ type: "process-down", app: "api-prod" });
 *   alertsQueue.recoverStaleActiveJobs().then(() => {
 *     alertsQueue.start(async (payload) => { ... envoi de la notification ... });
 *   });
 */
function createQueue(name, opts) {
  return new PersistentQueue(name, opts);
}

module.exports = { createQueue, PersistentQueue };
