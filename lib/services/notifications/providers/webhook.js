"use strict";

/**
 * Provider Webhook générique (Phase 5B) — pour connecter n'importe quel
 * système externe qui accepte une requête HTTP. Champs :
 *   publics  : url, method (POST par défaut), timeout
 *   secrets  : headers (peut contenir un `Authorization`, une clé d'API…)
 *   publics  : payload (gabarit optionnel, voir buildBody())
 *
 * `payload` est un gabarit JSON-sérialisable : toute chaîne contenant
 * `{{title}}`, `{{message}}`, `{{severity}}`, `{{timestamp}}` ou `{{url}}`
 * est substituée (récursivement, pour les tableaux/objets imbriqués) par la
 * valeur correspondante de la notification. Sans `payload`, un corps par
 * défaut `{ title, message, severity, timestamp, url }` est envoyé. Ceci
 * reste un gabarit simple par substitution de chaîne — pas un moteur de
 * templates avancé (hors scope Phase 5B).
 */
const { NotificationProvider } = require("../types");
const {
  successResult,
  failureResult,
  fetchWithTimeout,
  classifyHttpStatus,
  classifyFetchError,
  clampTimeout,
} = require("./shared");

const VALID_METHODS = ["GET", "POST", "PUT", "PATCH"];
const PLACEHOLDER_RE = /\{\{\s*(title|message|severity|timestamp|url)\s*\}\}/g;

function substitute(value, notification) {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER_RE, (_, key) => {
      const v = notification[key];
      return v === undefined || v === null ? "" : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, notification));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, notification);
    return out;
  }
  return value;
}

function buildBody(config, notification) {
  const n = notification || {};
  if (config.payload !== undefined && config.payload !== null) {
    return substitute(config.payload, n);
  }
  return {
    title: n.title || null,
    message: n.message || null,
    severity: n.severity || null,
    timestamp: n.timestamp || null,
    url: n.url || null,
  };
}

class WebhookProvider extends NotificationProvider {
  constructor() {
    super("webhook", "Webhook générique");
    this.secretFields = ["headers"];
  }

  validateConfig(config) {
    const errors = [];
    if (!config.url || !String(config.url).trim()) {
      errors.push("url requis.");
    } else {
      try {
        const parsed = new URL(String(config.url).trim());
        if (!["http:", "https:"].includes(parsed.protocol)) {
          errors.push("url doit utiliser http:// ou https://.");
        }
      } catch {
        errors.push("url invalide.");
      }
    }
    if (config.method && !VALID_METHODS.includes(String(config.method).toUpperCase())) {
      errors.push(`method invalide (attendu : ${VALID_METHODS.join(", ")}).`);
    }
    if (config.headers !== undefined && config.headers !== null && typeof config.headers !== "object") {
      errors.push("headers doit être un objet.");
    }
    if (config.timeout !== undefined && config.timeout !== null) {
      const t = Number(config.timeout);
      if (!Number.isFinite(t) || t <= 0) errors.push("timeout doit être un nombre positif (ms).");
    }
    return errors;
  }

  async send(notification, config) {
    const errors = this.validateConfig(config || {});
    if (errors.length) {
      return failureResult(this.type, { errorCode: "INVALID_CONFIG", safeMessage: errors.join(" ") });
    }

    const method = config.method ? String(config.method).toUpperCase() : "POST";
    const headers = { ...(config.headers || {}) };
    const isBodyMethod = method !== "GET";
    let body;
    if (isBodyMethod) {
      const payload = buildBody(config, notification);
      body = JSON.stringify(payload);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }

    const start = Date.now();
    let response;
    try {
      response = await fetchWithTimeout(
        String(config.url).trim(),
        { method, headers, body },
        clampTimeout(config.timeout),
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
      const data = await response.clone().json();
      const idField = data && (data.id ?? data.messageId ?? data.message_id);
      messageId = idField !== undefined && idField !== null ? String(idField) : null;
    } catch {
      // Corps non-JSON (ou vide) : pas un problème, aucun id disponible.
    }

    return successResult(this.type, { messageId, responseTime });
  }
}

module.exports = new WebhookProvider();
