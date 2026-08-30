"use strict";

/**
 * Registre des plugins découverts (Phase 21). Même pattern que
 * lib/services/notifications/registry.js (ProviderRegistry) : un objet
 * "plat" purement en mémoire (register/get/list/has), aucune connaissance
 * de la persistance (lib/services/plugins/store.js) ni du chargement
 * (lib/services/plugins/loader.js) — ceux-ci utilisent ce registre, il ne
 * les appelle jamais. Ce découplage permet de tester registry.js
 * indépendamment du système de fichiers et de la DB.
 *
 * `register()` valide uniquement la FORME du plugin (voir validate.js) et
 * l'unicité du nom : la compatibilité de pluginApiVersion et l'exécution de
 * init() sont la responsabilité de l'appelant (loader.js), pas de ce
 * registre — un plugin structurellement valide mais incompatible reste
 * "registrable" (utile pour l'afficher dans l'UI avec un statut
 * "incompatible" plutôt que de le faire disparaître silencieusement).
 */

const { validatePluginShape } = require("./validate");

class PluginRegistry {
  constructor() {
    this._plugins = new Map();
  }

  /**
   * @param {object} plugin - voir validate.js pour le contrat.
   * @throws si le plugin est structurellement invalide ou si le nom est déjà pris.
   */
  register(plugin) {
    const errors = validatePluginShape(plugin);
    if (errors.length) {
      throw new Error(`Plugin invalide : ${errors.join(" ")}`);
    }
    if (this._plugins.has(plugin.name)) {
      throw new Error(`Un plugin "${plugin.name}" est déjà enregistré.`);
    }
    this._plugins.set(plugin.name, plugin);
    return plugin;
  }

  /** Retire un plugin du registre (ex: avant un reload() du loader). N'appelle jamais onDisable(). */
  unregister(name) {
    return this._plugins.delete(name);
  }

  get(name) {
    return this._plugins.get(name) || null;
  }

  has(name) {
    return this._plugins.has(name);
  }

  list() {
    return Array.from(this._plugins.values());
  }

  /** Vide le registre (utilisé par les tests / un reload complet). */
  clear() {
    this._plugins.clear();
  }
}

module.exports = { PluginRegistry };
