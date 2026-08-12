"use strict";

/**
 * Provider Telegram (Phase 5B) — envoi via Bot API (`sendMessage`). Champs :
 *   publics  : chatId
 *   secrets  : botToken
 *
 * Le botToken fait partie de l'URL appelée (`api.telegram.org/bot<TOKEN>/…`)
 * — jamais loggé, jamais renvoyé dans une erreur (voir shared.js :
 * classification par code, jamais le message brut d'une erreur fetch()).
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

const TEXT_MAX_LENGTH = 4096; // limite Telegram

function apiUrl(botToken, method) {
  return `https://api.telegram.org/bot${encodeURIComponent(botToken)}/${method}`;
}

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

  async send(notification, config) {
    const errors = this.validateConfig(config || {});
    if (errors.length) {
      return failureResult(this.type, { errorCode: "INVALID_CONFIG", safeMessage: errors.join(" ") });
    }

    const body = {
      chat_id: String(config.chatId).trim(),
      text: truncate(formatPlainText(notification), TEXT_MAX_LENGTH),
    };

    const start = Date.now();
    let response;
    try {
      response = await fetchWithTimeout(
        apiUrl(String(config.botToken).trim(), "sendMessage"),
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

    let data;
    try {
      data = await response.json();
    } catch {
      return failureResult(this.type, {
        errorCode: "MALFORMED_RESPONSE",
        safeMessage: "Réponse du fournisseur illisible.",
        responseTime,
      });
    }

    if (!response.ok || !data || data.ok !== true) {
      const { errorCode, safeMessage } = classifyHttpStatus(response.status);
      return failureResult(this.type, { errorCode, safeMessage, responseTime });
    }

    const messageId =
      data.result && data.result.message_id !== undefined ? String(data.result.message_id) : null;
    return successResult(this.type, { messageId, responseTime });
  }

  /** getMe() : vérifie que le bot token est valide, sans envoyer de message. */
  async healthCheck(config) {
    if (!config || !config.botToken || !String(config.botToken).trim()) {
      return failureResult(this.type, { errorCode: "INVALID_CONFIG", safeMessage: "botToken requis." });
    }
    const start = Date.now();
    let response;
    try {
      response = await fetchWithTimeout(
        apiUrl(String(config.botToken).trim(), "getMe"),
        { method: "GET" },
        clampTimeout(config.timeout)
      );
    } catch (err) {
      const { errorCode, safeMessage } = classifyFetchError(err);
      return failureResult(this.type, { errorCode, safeMessage, responseTime: Date.now() - start });
    }
    const responseTime = Date.now() - start;

    let data;
    try {
      data = await response.json();
    } catch {
      return failureResult(this.type, {
        errorCode: "MALFORMED_RESPONSE",
        safeMessage: "Réponse du fournisseur illisible.",
        responseTime,
      });
    }
    if (!response.ok || !data || data.ok !== true) {
      const { errorCode, safeMessage } = classifyHttpStatus(response.status);
      return failureResult(this.type, { errorCode, safeMessage, responseTime });
    }
    return successResult(this.type, { responseTime });
  }
}

module.exports = new TelegramProvider();
