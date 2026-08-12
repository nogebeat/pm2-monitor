"use strict";

/**
 * Provider Slack (Phase 5B) — envoi via Incoming Webhook. Champs :
 *   publics  : channel (optionnel, surcharge celui configuré côté Slack)
 *   secrets  : webhookUrl
 *
 * Slack renvoie systématiquement un statut 200 avec un corps texte : "ok" en
 * cas de succès, un message d'erreur Slack (ex. "invalid_payload",
 * "channel_not_found") sinon — il faut donc inspecter le corps, pas
 * seulement le statut HTTP.
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

const TEXT_MAX_LENGTH = 4000;

class SlackProvider extends NotificationProvider {
  constructor() {
    super("slack", "Slack");
    this.secretFields = ["webhookUrl"];
  }

  validateConfig(config) {
    const errors = [];
    if (!config.webhookUrl || !String(config.webhookUrl).trim()) {
      errors.push("webhookUrl requis.");
    } else if (!/^https:\/\/hooks\.slack\.com\/services\//.test(String(config.webhookUrl).trim())) {
      errors.push("webhookUrl doit être une URL de webhook Slack valide.");
    }
    return errors;
  }

  async send(notification, config) {
    const errors = this.validateConfig(config || {});
    if (errors.length) {
      return failureResult(this.type, { errorCode: "INVALID_CONFIG", safeMessage: errors.join(" ") });
    }

    const body = { text: truncate(formatPlainText(notification), TEXT_MAX_LENGTH) };
    if (config.channel && String(config.channel).trim()) {
      body.channel = String(config.channel).trim();
    }

    const start = Date.now();
    let response;
    try {
      response = await fetchWithTimeout(
        String(config.webhookUrl).trim(),
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

    let text = "";
    try {
      text = await response.text();
    } catch {
      return failureResult(this.type, {
        errorCode: "MALFORMED_RESPONSE",
        safeMessage: "Réponse du fournisseur illisible.",
        responseTime,
      });
    }

    if (!response.ok) {
      const { errorCode, safeMessage } = classifyHttpStatus(response.status);
      return failureResult(this.type, { errorCode, safeMessage, responseTime });
    }

    if (text.trim() !== "ok") {
      // 200 mais corps différent de "ok" : Slack signale une erreur applicative
      // (ex. "channel_not_found", "invalid_payload") sans changer le statut HTTP.
      return failureResult(this.type, {
        errorCode: "PROVIDER_ERROR",
        safeMessage: "Le fournisseur a refusé la notification (configuration invalide côté Slack ?).",
        responseTime,
      });
    }

    return successResult(this.type, { responseTime });
  }
}

module.exports = new SlackProvider();
