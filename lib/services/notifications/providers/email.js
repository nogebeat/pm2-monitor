"use strict";

/**
 * Provider Email/SMTP (Phase 5B) — utilise `nodemailer` (seule nouvelle
 * dépendance de cette phase : aucune lib SMTP n'existait déjà dans le
 * projet). Champs :
 *   publics  : host, port, security ("none" | "starttls" | "ssl_tls"),
 *              fromName, fromEmail, to (destinataire(s), voir note ci-dessous)
 *   secrets  : username, password
 *
 * Note sur `to` : hors du périmètre strict de la tâche (host/port/security/
 * username/password/fromName/fromEmail), mais indispensable pour qu'un envoi
 * SMTP soit possible du tout — le routing par règles qui déterminera les
 * destinataires dynamiquement est prévu en Phase 5C. `to` sert de repli
 * (utilisé par `test()`, et par `send()` si la notification ne fournit pas
 * elle-même de destinataire).
 *
 * Sécurité : aucune erreur nodemailer brute n'est jamais renvoyée telle
 * quelle (peut contenir host/port/réponse serveur) — classification par
 * `err.code` uniquement, voir classifySmtpError().
 */
const nodemailer = require("nodemailer");
const { NotificationProvider } = require("../types");
const { successResult, failureResult, formatPlainText, clampTimeout } = require("./shared");

const VALID_SECURITY = ["none", "starttls", "ssl_tls"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeSecurity(value) {
  const v = String(value || "").trim().toLowerCase().replace(/[\s/]+/g, "_");
  if (v === "ssl" || v === "tls" || v === "ssl_tls") return "ssl_tls";
  if (v === "starttls") return "starttls";
  if (v === "" || v === "none") return "none";
  return v; // valeur inconnue, remontée telle quelle par validateConfig()
}

function classifySmtpError(err) {
  const code = err && err.code;
  if (code === "ETIMEDOUT") return { errorCode: "TIMEOUT", safeMessage: "La connexion au serveur SMTP a dépassé le délai imparti." };
  if (code === "EAUTH") return { errorCode: "AUTH_ERROR", safeMessage: "Authentification SMTP refusée (identifiants invalides ?)." };
  if (code === "ECONNECTION" || code === "ESOCKET" || code === "ECONNREFUSED" || code === "EDNS") {
    return { errorCode: "NETWORK_ERROR", safeMessage: "Impossible de joindre le serveur SMTP." };
  }
  if (code === "EENVELOPE") return { errorCode: "HTTP_ERROR", safeMessage: "Expéditeur ou destinataire refusé par le serveur SMTP." };
  return { errorCode: "PROVIDER_ERROR", safeMessage: "Le serveur SMTP a rencontré une erreur." };
}

function buildTransporter(config, timeoutMs) {
  const security = normalizeSecurity(config.security);
  const options = {
    host: String(config.host).trim(),
    port: Number(config.port),
    secure: security === "ssl_tls",
    requireTLS: security === "starttls",
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  };
  if (config.username && config.password) {
    options.auth = { user: String(config.username), pass: String(config.password) };
  }
  return nodemailer.createTransport(options);
}

function resolveRecipients(notification, config) {
  const to = (notification && notification.to) || config.to;
  if (!to) return null;
  return Array.isArray(to) ? to.join(", ") : String(to);
}

class EmailProvider extends NotificationProvider {
  constructor() {
    super("email", "Email (SMTP)");
    this.secretFields = ["username", "password"];
  }

  validateConfig(config) {
    const errors = [];
    if (!config.host || !String(config.host).trim()) errors.push("host requis.");
    const port = Number(config.port);
    if (!config.port || !Number.isFinite(port) || port <= 0 || port > 65535) {
      errors.push("port requis (nombre entre 1 et 65535).");
    }
    if (config.security !== undefined && !VALID_SECURITY.includes(normalizeSecurity(config.security))) {
      errors.push(`security invalide (attendu : None, STARTTLS, SSL/TLS).`);
    }
    if (!config.fromEmail || !EMAIL_RE.test(String(config.fromEmail).trim())) {
      errors.push("fromEmail requis (adresse d'expédition valide).");
    }
    if ((config.username && !config.password) || (!config.username && config.password)) {
      errors.push("username et password doivent être fournis ensemble.");
    }
    return errors;
  }

  async send(notification, config) {
    const errors = this.validateConfig(config || {});
    if (errors.length) {
      return failureResult(this.type, { errorCode: "INVALID_CONFIG", safeMessage: errors.join(" ") });
    }
    const to = resolveRecipients(notification, config);
    if (!to) {
      return failureResult(this.type, { errorCode: "INVALID_CONFIG", safeMessage: "Aucun destinataire (to) fourni." });
    }

    const timeoutMs = clampTimeout(config.timeout);
    const transporter = buildTransporter(config, timeoutMs);
    const from = config.fromName ? `"${String(config.fromName).trim()}" <${String(config.fromEmail).trim()}>` : String(config.fromEmail).trim();
    const n = notification || {};

    const start = Date.now();
    try {
      const info = await transporter.sendMail({
        from,
        to,
        subject: n.title || "Notification PM2 Monitor",
        text: formatPlainText(n),
      });
      return successResult(this.type, { messageId: info.messageId || null, responseTime: Date.now() - start });
    } catch (err) {
      const { errorCode, safeMessage } = classifySmtpError(err);
      return failureResult(this.type, { errorCode, safeMessage, responseTime: Date.now() - start });
    } finally {
      transporter.close();
    }
  }

  /** Vérifie la connexion/authentification SMTP sans envoyer d'e-mail. */
  async healthCheck(config) {
    const errors = this.validateConfig(config || {});
    if (errors.length) {
      return failureResult(this.type, { errorCode: "INVALID_CONFIG", safeMessage: errors.join(" ") });
    }
    const timeoutMs = clampTimeout(config.timeout);
    const transporter = buildTransporter(config, timeoutMs);
    const start = Date.now();
    try {
      await transporter.verify();
      return successResult(this.type, { responseTime: Date.now() - start });
    } catch (err) {
      const { errorCode, safeMessage } = classifySmtpError(err);
      return failureResult(this.type, { errorCode, safeMessage, responseTime: Date.now() - start });
    } finally {
      transporter.close();
    }
  }
}

module.exports = new EmailProvider();
