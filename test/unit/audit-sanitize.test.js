"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sanitizeAuditMetadata,
  isSensitiveKey,
  looksSensitiveValue,
  REDACTED,
} = require("../../lib/services/audit/sanitize");

/**
 * Phase 9 — section 4 du prompt maître : `sanitizeAuditMetadata()` est le
 * mécanisme central qui ne repose pas sur les développeurs pour ne jamais
 * laisser fuir un secret. Couvre les deux mécanismes (denylist de clés +
 * détection de forme) et les cas limites (imbrication, tableaux, valeurs
 * non sérialisables, troncature).
 */

test("sanitizeAuditMetadata() — null/undefined passent tels quels", () => {
  assert.equal(sanitizeAuditMetadata(null), null);
  assert.equal(sanitizeAuditMetadata(undefined), null);
});

test("sanitizeAuditMetadata() — denylist de clés : password/token/apiKey/webhook/authorization masqués", () => {
  const out = sanitizeAuditMetadata({
    password: "hunter2",
    newPassword: "hunter3",
    smtpPassword: "s3cr3t",
    jwt: "abc.def.ghi",
    apiKey: "sk-xxx",
    api_key: "sk-yyy",
    telegramToken: "123:ABC",
    discordWebhook: "https://discord.com/api/webhooks/1/2",
    slackWebhookUrl: "https://hooks.slack.com/services/1/2/3",
    authorizationHeader: "Bearer abc",
    privateKey: "-----BEGIN PRIVATE KEY-----",
    sessionSecret: "topsecret",
    userId: 42, // valeur non sensible : conservée
  });
  assert.equal(out.password, REDACTED);
  assert.equal(out.newPassword, REDACTED);
  assert.equal(out.smtpPassword, REDACTED);
  assert.equal(out.jwt, REDACTED);
  assert.equal(out.apiKey, REDACTED);
  assert.equal(out.api_key, REDACTED);
  assert.equal(out.telegramToken, REDACTED);
  assert.equal(out.discordWebhook, REDACTED);
  assert.equal(out.slackWebhookUrl, REDACTED);
  assert.equal(out.authorizationHeader, REDACTED);
  assert.equal(out.privateKey, REDACTED);
  assert.equal(out.sessionSecret, REDACTED);
  assert.equal(out.userId, 42);
});

test("sanitizeAuditMetadata() — denylist appliquée à n'importe quelle profondeur (objets et tableaux imbriqués)", () => {
  const out = sanitizeAuditMetadata({
    op: "update_provider",
    fields: { smtpPassword: "xxx", host: "smtp.example.com" },
    history: [{ webhookUrl: "https://hooks.slack.com/services/x" }, { note: "ok" }],
  });
  assert.equal(out.fields.smtpPassword, REDACTED);
  assert.equal(out.fields.host, "smtp.example.com");
  assert.equal(out.history[0].webhookUrl, REDACTED);
  assert.equal(out.history[1].note, "ok");
});

test("sanitizeAuditMetadata() — détection de forme (filet de sécurité indépendant du nom de clé)", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123DEF_-xyz";
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----";
  const authHeader = "Bearer sk-abcdefgh12345";
  const discordUrl = "https://discord.com/api/webhooks/123/abcDEF";

  const out = sanitizeAuditMetadata({
    value: jwt,
    note: pem,
    context: authHeader,
    unrelatedFieldName: discordUrl,
  });
  assert.equal(out.value, REDACTED);
  assert.equal(out.note, REDACTED);
  assert.equal(out.context, REDACTED);
  assert.equal(out.unrelatedFieldName, REDACTED);
});

test("sanitizeAuditMetadata() — chaîne bénigne non affectée", () => {
  const out = sanitizeAuditMetadata({ name: "Discord audit", host: "smtp.example.com" });
  assert.equal(out.name, "Discord audit");
  assert.equal(out.host, "smtp.example.com");
});

test("sanitizeAuditMetadata() — metadata non-objet encapsulée plutôt que rejetée", () => {
  const out = sanitizeAuditMetadata("juste une string");
  assert.equal(out.value, "juste une string");
});

test("sanitizeAuditMetadata() — Date préservée, instance de classe interne redactée", () => {
  const d = new Date("2024-01-01T00:00:00Z");
  class Weird {
    constructor() {
      this.hidden = "secret-in-class";
    }
  }
  const out = sanitizeAuditMetadata({ when: d, weird: new Weird() });
  assert.equal(out.when, d.toISOString());
  assert.equal(out.weird, REDACTED);
});

test("sanitizeAuditMetadata() — structure trop profonde : redactée par prudence", () => {
  let deep = { leaf: "ok" };
  for (let i = 0; i < 15; i++) deep = { nested: deep };
  const out = sanitizeAuditMetadata(deep);
  // À la profondeur max, la branche est redactée plutôt que de risquer un
  // dépassement de pile / un contenu non contrôlé.
  assert.ok(JSON.stringify(out).includes(REDACTED));
});

test("sanitizeAuditMetadata() — metadata volumineuse tronquée plutôt que stockée telle quelle", () => {
  const big = { blob: "x".repeat(20000) };
  const out = sanitizeAuditMetadata(big);
  assert.equal(out._truncated, true);
  assert.ok(typeof out.preview === "string");
});

test("sanitizeAuditMetadata() — non sérialisable (référence circulaire) : ne throw jamais", () => {
  const circular = { a: 1 };
  circular.self = circular;
  assert.doesNotThrow(() => sanitizeAuditMetadata(circular));
});

test("isSensitiveKey() — variantes camelCase/snake_case/kebab-case", () => {
  assert.equal(isSensitiveKey("smtpPassword"), true);
  assert.equal(isSensitiveKey("smtp_password"), true);
  assert.equal(isSensitiveKey("smtp-password"), true);
  assert.equal(isSensitiveKey("username"), false);
  assert.equal(isSensitiveKey("targetType"), false);
});

test("looksSensitiveValue() — détecte JWT/PEM/Bearer/webhook, ignore le reste", () => {
  assert.equal(looksSensitiveValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"), true);
  assert.equal(looksSensitiveValue("Bearer abcdef"), true);
  assert.equal(looksSensitiveValue("https://discord.com/api/webhooks/1/2"), true);
  assert.equal(looksSensitiveValue("hello world"), false);
  assert.equal(looksSensitiveValue(42), false);
});
