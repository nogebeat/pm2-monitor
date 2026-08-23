"use strict";

/**
 * Point d'entrée du notification system — assemble le Provider Registry, le
 * Notification Manager, les stores et (Phase 5D) le RoutingEngine, et
 * enregistre les providers réels (providers/index.js, Phase 5B). Instance
 * partagée par lib/routes/notifications.js et server.js (boucle
 * d'évaluation de l'Alert Engine), même raison qu'un singleton pour
 * lib/services/alerts/ (lib/services/alerts/index.js) : un seul registry en
 * mémoire pour tout le process.
 *
 * Voir docs/notifications/README.md pour le détail de ce qui est/n'est pas
 * implémenté à ce stade (Phase 5D : routing par règles + templates,
 * branchés sur l'Alert Engine ; mise en file d'attente/retry en Phase 5E).
 */

const { ProviderRegistry } = require("./registry");
const { NotificationManager } = require("./manager");
const { RoutingEngine } = require("./routing/engine");
const { NotificationDispatchQueue } = require("./dispatch-queue");
const providerPlaceholders = require("./providers");
const providerStore = require("./provider-store");
const routeStore = require("./routing/route-store");
const historyStore = require("./history-store");
// Phase 13 — Tags, Environments & Process Groups : permet à routeMatches()
// de résoudre tag/environment/group pour une alerte "process" (voir
// routing/engine.js#_resolveProcessOrg). Require direct (pas de dépendance
// circulaire : process-organization ne connaît rien de notifications/).
const processOrgStore = require("../process-organization/store");
// Phase 14 — Incident Management & Alert Silencing : permet à dispatch() de
// vérifier qu'un silence actif ne doit pas supprimer l'envoi (voir
// routing/engine.js#_isSilenced). Require direct (pas de dépendance
// circulaire : lib/services/incidents/ ne connaît rien de notifications/).
const silenceStore = require("../incidents/silence-store");

const registry = new ProviderRegistry();
for (const provider of providerPlaceholders) {
  registry.registerProvider(provider);
}

const manager = new NotificationManager({ registry });

// Phase 5E : file d'attente persistante (retry/backoff, rate limit, dedup —
// voir dispatch-queue.js). Instance partagée par le même raisonnement que
// registry/manager ci-dessus (un seul worker/état de rate-limit en mémoire
// par process). server.js appelle dispatchQueue.start()/stop() au
// démarrage/arrêt propre du process ; les tests unitaires construisent
// leur propre RoutingEngine avec (ou sans) dispatchQueue, indépendamment de
// cette instance partagée.
const dispatchQueue = new NotificationDispatchQueue({ registry, providerStore, historyStore });

const routingEngine = new RoutingEngine({
  routeStore,
  providerStore,
  registry,
  historyStore,
  dispatchQueue,
  processOrgStore,
  silenceStore,
});

module.exports = {
  registry,
  manager,
  routingEngine,
  dispatchQueue,
  providerStore,
  routeStore,
  historyStore,
  ProviderRegistry,
  NotificationManager,
  RoutingEngine,
  NotificationDispatchQueue,
};
