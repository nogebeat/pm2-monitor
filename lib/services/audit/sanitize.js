"use strict";

/**
 * lib/services/audit/sanitize.js
 *
 * `sanitizeAuditMetadata()` est le SEUL point d'entrée par lequel une
 * `metadata` peut atteindre `audit-store.js#create()` (voir index.js —
 * `recordEvent()` l'appelle systématiquement, aucun appelant ne peut la
 * contourner). C'est une contrainte ABSOLUE du prompt maître Phase 9,
 * section 3 : ne JAMAIS enregistrer de secret, "même dans metadata" — et
 * section 4 : "ne pas compter uniquement sur les développeurs pour ne
 * jamais ajouter accidentellement un secret".
 *
 * Deux mécanismes complémentaires, tous les deux appliqués :
 *
 *  1. DENYLIST DE CLÉS — toute clé (à n'importe quelle profondeur d'un
 *     objet imbriqué, ou dans un tableau) dont le nom correspond à un motif
 *     connu de secret est entièrement REMPLACÉE par "[REDACTED]", quelle
 *     que soit sa valeur (chaîne, objet, tableau…). Couvre nommément (liste
 *     du prompt maître) : password, JWT, clés API, mot de passe SMTP,
 *     webhook Discord, token Telegram, webhook Slack, secrets
 *     d'environnement, clés privées, en-têtes d'autorisation — et leurs
 *     variantes usuelles (camelCase/snake_case/kebab-case, préfixes
 *     "smtp"/"new"/"old", suffixes "Secret"/"Token"…).
 *
 *  2. DÉTECTION DE FORME — même si une clé n'est reconnue par aucun motif
 *     (ex: un développeur ajoute par erreur `metadata.value` contenant un
 *     JWT ou une clé privée PEM), la *valeur* elle-même est inspectée : les
 *     chaînes qui ressemblent structurellement à un JWT, une clé privée PEM,
 *     ou un header `Authorization: Bearer/Basic …` sont masquées, même sous
 *     une clé au nom anodin. C'est le filet de sécurité qui ne repose pas
 *     sur le nommage — voir section 4 du prompt maître.
 *
 * Toute valeur non JSON-sérialisable, ou dont la sérialisation dépasse une
 * taille raisonnable, est également écartée plutôt que de risquer de
 * stocker un objet non maîtrisé (ex: une instance de classe interne avec un
 * champ caché).
 */

const REDACTED = "[REDACTED]";
const MAX_METADATA_JSON_LENGTH = 8000; // filet de sécurité anti-abus, pas une limite fonctionnelle
const MAX_DEPTH = 8; // évite une récursion infinie sur une structure cyclique/pathologique

// --- 1. Denylist de clés ----------------------------------------------------
//
// Chaque motif est testé sur le nom de clé normalisé (minuscules, séparateurs
// -/_ retirés) : "smtp_password", "SmtpPassword", "smtp-password" matchent
// tous le même motif /smtppassword/. Volontairement large (mieux vaut
// sur-masquer une clé légitime que laisser fuir un secret).
const SENSITIVE_KEY_PATTERNS = [
  /password/, // password, newPassword, smtpPassword, dbPassword…
  /passwd/,
  /secret/, // secret, apiSecret, clientSecret, environmentSecret…
  /token/, // token, jwt, telegramToken, accessToken, refreshToken…
  /jwt/,
  /apikey/, // apiKey, api_key
  /api_?key/,
  /privatekey/, // clé privée (PEM, SSH…)
  /private_?key/,
  /webhook/, // discordWebhook, slackWebhook, webhookUrl — l'URL de webhook EST le secret
  /authorization/, // header Authorization
  /auth_?header/,
  /bearer/,
  /credential/,
  /clientsecret/,
  /sessionsecret/,
  /cookie/, // valeur de cookie de session
  /\bpass\b/,
];

function isSensitiveKey(key) {
  if (typeof key !== "string") return false;
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(normalized));
}

// --- 2. Détection de forme (filet de sécurité, indépendant du nom de clé) --

// JWT : trois segments base64url séparés par des points (header.payload.signature).
const JWT_SHAPE = /^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/;

// Clé privée PEM (RSA/EC/OpenSSH/générique PKCS8).
const PEM_PRIVATE_KEY_SHAPE = /-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;

// En-tête d'autorisation HTTP (Bearer/Basic/Token …).
const AUTH_HEADER_SHAPE = /^(Bearer|Basic|Token|Digest)\s+\S+/i;

// URL de webhook connue (Discord/Slack/Telegram) : l'URL elle-même sert de
// secret d'authentification pour ces providers (voir lib/services/notifications/providers/).
const WEBHOOK_URL_SHAPE = /(discord(app)?\.com\/api\/webhooks|hooks\.slack\.com\/services)/i;

function looksSensitiveValue(value) {
  if (typeof value !== "string") return false;
  return (
    JWT_SHAPE.test(value) ||
    PEM_PRIVATE_KEY_SHAPE.test(value) ||
    AUTH_HEADER_SHAPE.test(value) ||
    WEBHOOK_URL_SHAPE.test(value)
  );
}

/**
 * Sanitise récursivement une valeur (objet/tableau/scalaire) : remplace par
 * `"[REDACTED]"` toute valeur dont la clé matche la denylist, ou dont le
 * contenu (chaîne) matche une forme sensible connue — à n'importe quelle
 * profondeur.
 */
function sanitizeValue(value, depth) {
  if (depth > MAX_DEPTH) return REDACTED; // structure trop profonde : par prudence, pas de risque pris

  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === "object") {
    // Rejette silencieusement les objets non "plain" (Date, Buffer, classes
    // internes…) : on ne connaît pas leur contenu réel, mieux vaut ne rien
    // stocker qu'exposer un champ caché non prévu.
    if (value.constructor && value.constructor !== Object) {
      if (value instanceof Date) return value.toISOString();
      return REDACTED;
    }
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(v, depth + 1);
    }
    return out;
  }

  if (typeof value === "string" && looksSensitiveValue(value)) {
    return REDACTED;
  }

  return value;
}

/**
 * Point d'entrée central. Prend n'importe quelle `metadata` (objet plat ou
 * imbriqué, ou `null`/`undefined`) et retourne une version sûre à stocker.
 *
 * @param {object|null|undefined} metadata
 * @returns {object|null}
 */
function sanitizeAuditMetadata(metadata) {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    // Une metadata doit être un objet (clé -> valeur) : toute autre forme
    // (chaîne brute, nombre…) est encapsulée plutôt que rejetée, pour ne
    // pas perdre silencieusement de l'information de contexte utile.
    return sanitizeValue({ value: metadata }, 0);
  }

  const sanitized = sanitizeValue(metadata, 0);

  // Filet de sécurité anti-abus : une metadata démesurée (ex: un dump
  // accidentel d'objet PM2 complet) est tronquée plutôt que stockée telle
  // quelle — ne concerne pas la sécurité en soi, mais évite qu'un objet
  // volumineux masque, dans la pratique, une revue humaine de son contenu.
  let json;
  try {
    json = JSON.stringify(sanitized);
  } catch (e) {
    return { _sanitizeError: "metadata non sérialisable" };
  }
  if (json.length > MAX_METADATA_JSON_LENGTH) {
    return { _truncated: true, preview: json.slice(0, MAX_METADATA_JSON_LENGTH) };
  }
  return sanitized;
}

module.exports = {
  sanitizeAuditMetadata,
  isSensitiveKey,
  looksSensitiveValue,
  REDACTED,
};
