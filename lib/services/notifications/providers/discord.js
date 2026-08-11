"use strict";

/**
 * Placeholder — envoi Discord non implémenté en Phase 5A (voir types.js#send).
 * Champs attendus (indicatif, affiné en Phase 5C) :
 *   publics : username (nom affiché du bot, optionnel)
 *   secrets : webhookUrl
 */
const { NotificationProvider } = require("../types");

class DiscordProvider extends NotificationProvider {
  constructor() {
    super("discord", "Discord");
  }

  validateConfig(config) {
    const errors = [];
    if (!config.webhookUrl || !String(config.webhookUrl).trim()) {
      errors.push("webhookUrl requis.");
    }
    return errors;
  }
}

module.exports = new DiscordProvider();