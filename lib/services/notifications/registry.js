"use strict";

/**
 * Registre des providers de notification disponibles. Permet d'ajouter un
 * provider (Phase 5B/5C) sans modifier lib/services/notifications/manager.js
 * ni lib/routes/notifications.js : ces deux modules ne connaissent que cette
 * interface (registerProvider/getProvider/listProviders/hasProvider), jamais
 * un provider par son nom en dur.
 */
class ProviderRegistry {
  constructor() {
    this._providers = new Map();
  }

  /** @param {import("./types").NotificationProvider} provider */
  registerProvider(provider) {
    if (!provider || !provider.type) {
      throw new Error("registerProvider() : provider invalide (type manquant).");
    }
    if (this._providers.has(provider.type)) {
      throw new Error(`registerProvider() : un provider "${provider.type}" est déjà enregistré.`);
    }
    this._providers.set(provider.type, provider);
    return provider;
  }

  /** @returns {import("./types").NotificationProvider|null} */
  getProvider(type) {
    return this._providers.get(type) || null;
  }

  /** @returns {import("./types").NotificationProvider[]} */
  listProviders() {
    return Array.from(this._providers.values());
  }

  hasProvider(type) {
    return this._providers.has(type);
  }
}

module.exports = { ProviderRegistry };