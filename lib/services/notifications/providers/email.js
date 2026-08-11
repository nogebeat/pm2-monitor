"use strict";

/**
 * Placeholder — SMTP non implémenté en Phase 5A (voir types.js#send).
 * Champs attendus (indicatif, affiné en Phase 5C) :
 *   publics : host, port, from, secure
 *   secrets : user, password
 */
const { NotificationProvider } = require("../types");

class EmailProvider extends NotificationProvider {
  constructor() {
    super("email", "Email (SMTP)");
  }

  validateConfig(config) {
    const errors = [];
    if (!config.host || !String(config.host).trim()) errors.push("host requis.");
    if (!config.port || !Number.isFinite(Number(config.port))) errors.push("port requis (nombre).");
    if (!config.from || !String(config.from).trim()) errors.push("from requis (adresse d'expédition).");
    return errors;
  }
}

module.exports = new EmailProvider();