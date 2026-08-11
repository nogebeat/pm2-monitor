"use strict";

/**
 * Placeholder — envoi Slack non implémenté en Phase 5A (voir types.js#send).
 * Champs attendus (indicatif, affiné en Phase 5C) :
 *   publics : channel (optionnel, surcharge celui configuré côté Slack)
 *   secrets : webhookUrl
 */
const { NotificationProvider } = require("../types");

class SlackProvider extends NotificationProvider {
  constructor() {
    super("slack", "Slack");
  }

  validateConfig(config) {
    const errors = [];
    if (!config.webhookUrl || !String(config.webhookUrl).trim()) {
      errors.push("webhookUrl requis.");
    }
    return errors;
  }
}

module.exports = new SlackProvider();