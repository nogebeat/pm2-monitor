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
const providerPlaceholders = require("./providers");
const providerStore = require("./provider-store");
const routeStore = require("./routing/route-store");
const historyStore = require("./history-store");

const registry = new ProviderRegistry();
for (const provider of providerPlaceholders) {
  registry.registerProvider(provider);
}

const manager = new NotificationManager({ registry });

const routingEngine = new RoutingEngine({ routeStore, providerStore, registry, historyStore });

module.exports = {
  registry,
  manager,
  routingEngine,
  providerStore,
  routeStore,
  historyStore,
  ProviderRegistry,
  NotificationManager,
  RoutingEngine,
};
