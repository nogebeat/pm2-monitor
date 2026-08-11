"use strict";

/**
 * Placeholder — envoi Telegram non implémenté en Phase 5A (voir types.js#send).
 * Champs attendus (indicatif, affiné en Phase 5C) :
 *   publics : chatId
 *   secrets : botToken
 */
const { NotificationProvider } = require("../types");

class TelegramProvider extends NotificationProvider {
  constructor() {
    super("telegram", "Telegram");
  }

  validateConfig(config) {
    const errors = [];
    if (!config.chatId || !String(config.chatId).trim()) errors.push("chatId requis.");
    if (!config.botToken || !String(config.botToken).trim()) errors.push("botToken requis.");
    return errors;
  }
}

module.exports = new TelegramProvider();