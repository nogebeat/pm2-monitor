"use strict";

/**
 * Placeholder — envoi webhook générique non implémenté en Phase 5A (voir
 * types.js#send).
 * Champs attendus (indicatif, affiné en Phase 5C) :
 *   publics : url, method (POST par défaut)
 *   secrets : headers (ex: { Authorization: "Bearer …" })
 */
const { NotificationProvider } = require("../types");

const VALID_METHODS = ["GET", "POST", "PUT", "PATCH"];

class WebhookProvider extends NotificationProvider {
  constructor() {
    super("webhook", "Webhook générique");
  }

  validateConfig(config) {
    const errors = [];
    if (!config.url || !String(config.url).trim()) errors.push("url requis.");
    if (config.method && !VALID_METHODS.includes(String(config.method).toUpperCase())) {
      errors.push(`method invalide (attendu : ${VALID_METHODS.join(", ")}).`);
    }
    return errors;
  }
}

module.exports = new WebhookProvider();
