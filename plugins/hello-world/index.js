"use strict";

/**
 * Plugin de démonstration (Phase 21) — valide que l'API plugin fonctionne
 * de bout en bout (découverte, init(), logger, config persistée,
 * onDisable()). Voir docs/plugins/README.md#exemple pour le détail.
 *
 * Ce plugin n'est PAS une dépendance du monitor : le désactiver ou
 * supprimer ce dossier n'affecte aucune fonctionnalité du core (voir
 * lib/services/plugins/loader.js — un plugin absent est simplement absent
 * de la liste, rien de plus).
 */

module.exports = {
  name: "hello-world",
  version: "1.0.0",
  pluginApiVersion: "1.0.0",
  description: "Plugin de démonstration : valide l'API plugin (init, logger, config, onDisable).",

  async init(context) {
    const config = await context.config.get();
    const runCount = (config.runCount || 0) + 1;
    await context.config.set({ ...config, runCount, lastInitAt: Date.now() });

    context.logger.info(
      `Bonjour depuis "${context.meta.name}" v${context.meta.version} ! (activation n°${runCount})`,
    );
  },

  async onDisable(context) {
    context.logger.info("Plugin de démo désactivé — à bientôt !");
  },
};
