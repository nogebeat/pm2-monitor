"use strict";

/**
 * Utilitaires partagés par tous les providers réels (Phase 5B) — email,
 * discord, telegram, slack, webhook. Objectifs :
 *
 *  - Résultats normalisés (voir docs/notifications/README.md) :
 *      succès : { success: true, provider, messageId, responseTime }
 *      échec  : { success: false, provider, errorCode, safeMessage, responseTime }
 *  - `safeMessage` n'est JAMAIS construit à partir du message d'erreur brut
 *    d'une lib HTTP/SMTP : ces messages peuvent contenir l'URL appelée (donc
 *    un token de webhook), le host SMTP, etc. On catégorise uniquement par
 *    code d'erreur/statut HTTP connu → message générique fixe.
 *  - Timeout systématique sur les appels HTTP (AbortController), pour éviter
 *    qu'un provider externe indisponible ne bloque indéfiniment un envoi.
 */

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 60000;

function successResult(provider, { messageId = null, responseTime = null } = {}) {
  return { success: true, provider, messageId, responseTime };
}

function failureResult(provider, { errorCode, safeMessage, responseTime = null }) {
  return { success: false, provider, errorCode, safeMessage, responseTime };
}

/** Notification par défaut utilisée par NotificationProvider#test() (types.js). */
function buildTestNotification(label) {
  return {
    title: `Test PM2 Monitor — ${label}`,
    message: `Ceci est une notification de test envoyée depuis PM2 Monitor pour vérifier la configuration du provider "${label}".`,
    severity: "info",
    timestamp: new Date().toISOString(),
  };
}

/** Formate une notification en texte brut (utilisé par la plupart des providers). */
function formatPlainText(notification) {
  const n = notification || {};
  const severity = n.severity ? `[${String(n.severity).toUpperCase()}] ` : "";
  const title = n.title ? `${severity}${n.title}` : `${severity}Notification PM2 Monitor`;
  const parts = [title];
  if (n.message) parts.push(n.message);
  if (n.url) parts.push(n.url);
  return parts.join("\n");
}

function truncate(text, maxLength) {
  if (typeof text !== "string" || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

/** fetch() avec timeout obligatoire — jamais d'appel réseau sans limite de temps. */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Classe un statut HTTP en (errorCode, safeMessage) — jamais le corps de la réponse. */
function classifyHttpStatus(status) {
  if (status === 401 || status === 403) {
    return { errorCode: "AUTH_ERROR", safeMessage: "Authentification refusée par le fournisseur." };
  }
  if (status === 404) {
    return { errorCode: "NOT_FOUND", safeMessage: "Endpoint introuable (URL/identifiant invalide ?)." };
  }
  if (status === 429) {
    return { errorCode: "RATE_LIMITED", safeMessage: "Trop de requêtes envoyées à ce fournisseur, réessaie plus tard." };
  }
  if (status >= 500) {
    return { errorCode: "PROVIDER_ERROR", safeMessage: "Le service distant a rencontré une erreur." };
  }
  return { errorCode: "HTTP_ERROR", safeMessage: `Requête refusée par le fournisseur (HTTP ${status}).` };
}

/** Classe une erreur fetch() (réseau, timeout) — jamais err.message brut (peut contenir l'URL). */
function classifyFetchError(err) {
  if (err && err.name === "AbortError") {
    return { errorCode: "TIMEOUT", safeMessage: "La requête a dépassé le délai imparti." };
  }
  return { errorCode: "NETWORK_ERROR", safeMessage: "Erreur réseau lors de l'envoi (fournisseur injoignable ?)." };
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, MAX_TIMEOUT_MS);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  successResult,
  failureResult,
  buildTestNotification,
  formatPlainText,
  truncate,
  fetchWithTimeout,
  classifyHttpStatus,
  classifyFetchError,
  clampTimeout,
};
