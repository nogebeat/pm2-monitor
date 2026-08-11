"use strict";

/**
 * Point d'entrée du notification system — assemble le Provider Registry, le
 * Notification Manager et les stores, et enregistre les providers
 * placeholders (providers/index.js). Instance partagée par
 * lib/routes/notifications.js, même raison qu'un singleton pour
 * lib/services/alerts/ (lib/services/alerts/index.js) : un seul registry en
 * mémoire pour tout le process.
 *
 * Phase 5A uniquement — voir docs/notifications/README.md pour le détail de
 * ce qui est/n'est pas implémenté à ce stade.
 */

const { ProviderRegistry } = require("./registry");
const { NotificationManager } = require("./manager");
const providerPlaceholders = require("./providers");
const providerStore = require("./provider-store");
const routeStore = require("./routing/route-store");
const historyStore = require("./history-store");

const registry = new ProviderRegistry();
for (const provider of providerPlaceholders) {
  registry.registerProvider(provider);
}

const manager = new NotificationManager({ registry });

module.exports = {
  registry,
  manager,
  providerStore,
  routeStore,
  historyStore,
  ProviderRegistry,
  NotificationManager,
};