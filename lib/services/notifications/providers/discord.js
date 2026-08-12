"use strict";

/**
 * Provider Discord (Phase 5B) — envoi via Webhook URL uniquement (pas de
 * bot). Champs :
 *   publics  : username (nom affiché du bot, optionnel)
 *   secrets  : webhookUrl
 *
 * Sécurité : le webhook URL contient un token d'accès complet (quiconque le
 * connaît peut poster sur le salon) — jamais loggé, jamais renvoyé dans une
 * erreur. Toutes les erreurs sont catégorisées via shared.js (jamais le
 * message brut d'une erreur fetch(), qui peut contenir l'URL appelée).
 */
const { NotificationProvider } = require("../types");
const {
  successResult,
  failureResult,
  formatPlainText,
  truncate,
  fetchWithTimeout,
  classifyHttpStatus,
  classifyFetchError,
  clampTimeout,
} = require("./shared");

const CONTENT_MAX_LENGTH = 2000; // limite Discord

class DiscordProvider extends NotificationProvider {
  constructor() {
    super("discord", "Discord");
    // Champs secrets (jamais renvoyés en clair par l'API — voir Phase 5C,
    // lib/routes/notifications.js#splitFields) vs. champs publics
    // (configuration). Utilisé pour scinder le formulaire d'admin en
    // configuration/secrets sans dupliquer cette connaissance par provider.
    this.secretFields = ["webhookUrl"];
  }

  validateConfig(config) {
    const errors = [];
    if (!config.webhookUrl || !String(config.webhookUrl).trim()) {
      errors.push("webhookUrl requis.");
    } else if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(String(config.webhookUrl).trim())) {
      errors.push("webhookUrl doit être une URL de webhook Discord valide.");
    }
    return errors;
  }

  async send(notification, config) {
    const errors = this.validateConfig(config || {});
    if (errors.length) {
      return failureResult(this.type, { errorCode: "INVALID_CONFIG", safeMessage: errors.join(" ") });
    }

    const webhookUrl = String(config.webhookUrl).trim();
    const content = truncate(formatPlainText(notification), CONTENT_MAX_LENGTH);
    const body = { content };
    if (config.username && String(config.username).trim()) {
      body.username = String(config.username).trim();
    }

    const start = Date.now();
    let response;
    try {
      // ?wait=true : Discord renvoie le message créé (sinon 204 sans corps),
      // ce qui permet d'exposer un messageId dans le résultat normalisé.
      response = await fetchWithTimeout(
        `${webhookUrl}${webhookUrl.includes("?") ? "&" : "?"}wait=true`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        clampTimeout(config.timeout)
      );
    } catch (err) {
      const { errorCode, safeMessage } = classifyFetchError(err);
      return failureResult(this.type, { errorCode, safeMessage, responseTime: Date.now() - start });
    }
    const responseTime = Date.now() - start;

    if (!response.ok) {
      const { errorCode, safeMessage } = classifyHttpStatus(response.status);
      return failureResult(this.type, { errorCode, safeMessage, responseTime });
    }

    let messageId = null;
    try {
      const data = await response.json();
      messageId = data && data.id ? String(data.id) : null;
    } catch {
      // Réponse 204 (pas de ?wait) ou corps non-JSON : pas d'id disponible,
      // ce n'est pas une erreur.
    }

    return successResult(this.type, { messageId, responseTime });
  }

  /** GET sur le webhook : renvoie les métadonnées (nom, salon) sans poster de message. */
  async healthCheck(config) {
    const errors = this.validateConfig(config || {});
    if (errors.length) {
      return failureResult(this.type, { errorCode: "INVALID_CONFIG", safeMessage: errors.join(" ") });
    }
    const start = Date.now();
    let response;
    try {
      response = await fetchWithTimeout(String(config.webhookUrl).trim(), { method: "GET" }, clampTimeout(config.timeout));
    } catch (err) {
      const { errorCode, safeMessage } = classifyFetchError(err);
      return failureResult(this.type, { errorCode, safeMessage, responseTime: Date.now() - start });
    }
    const responseTime = Date.now() - start;
    if (!response.ok) {
      const { errorCode, safeMessage } = classifyHttpStatus(response.status);
      return failureResult(this.type, { errorCode, safeMessage, responseTime });
    }
    return successResult(this.type, { responseTime });
  }
}

module.exports = new DiscordProvider();
