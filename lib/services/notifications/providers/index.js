"use strict";

/**
 * Liste des providers (placeholders en Phase 5A) à enregistrer dans le
 * Provider Registry au démarrage — voir lib/services/notifications/index.js.
 * Ajouter un provider = ajouter un fichier ici + le require ci-dessous, sans
 * toucher au registry, au manager ni aux routes.
 */
module.exports = [
  require("./email"),
  require("./discord"),
  require("./telegram"),
  require("./slack"),
  require("./webhook"),
];