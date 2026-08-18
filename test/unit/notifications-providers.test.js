"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");

const discord = require("../../lib/services/notifications/providers/discord");
const slack = require("../../lib/services/notifications/providers/slack");
const telegram = require("../../lib/services/notifications/providers/telegram");
const webhook = require("../../lib/services/notifications/providers/webhook");
const email = require("../../lib/services/notifications/providers/email");

const NOTIFICATION = { title: "CPU élevé", message: "process X à 95% CPU", severity: "warning" };

/** Remplace global.fetch pour la durée d'un test, restaure ensuite. */
function withFetch(t, impl) {
  const original = global.fetch;
  global.fetch = impl;
  t.after(() => {
    global.fetch = original;
  });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() {
      return this;
    },
  };
}

function textResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => {
      throw new Error("not json");
    },
  };
}

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------
test("provider discord", async (t) => {
  await t.test("validateConfig rejette une config vide", () => {
    assert.ok(discord.validateConfig({}).length > 0);
  });

  await t.test("validateConfig accepte une config valide", () => {
    assert.deepEqual(discord.validateConfig({ webhookUrl: "https://discord.com/api/webhooks/1/abc" }), []);
  });

  await t.test("send() : succès renvoie un résultat normalisé avec messageId", async (t) => {
    withFetch(t, async (url) => {
      assert.ok(String(url).includes("wait=true"));
      return jsonResponse(200, { id: "999" });
    });
    const result = await discord.send(NOTIFICATION, { webhookUrl: "https://discord.com/api/webhooks/1/abc" });
    assert.equal(result.success, true);
    assert.equal(result.provider, "discord");
    assert.equal(result.messageId, "999");
    assert.equal(typeof result.responseTime, "number");
  });

  await t.test("send() : config invalide -> échec sans appel réseau", async (t) => {
    withFetch(t, async () => {
      throw new Error("ne doit pas être appelé");
    });
    const result = await discord.send(NOTIFICATION, {});
    assert.equal(result.success, false);
    assert.equal(result.errorCode, "INVALID_CONFIG");
  });

  await t.test("send() : erreur réseau -> NETWORK_ERROR, jamais l'URL dans safeMessage", async (t) => {
    withFetch(t, async () => {
      throw new TypeError("fetch failed for https://discord.com/api/webhooks/1/super-secret-token");
    });
    const result = await discord.send(NOTIFICATION, {
      webhookUrl: "https://discord.com/api/webhooks/1/super-secret-token",
    });
    assert.equal(result.success, false);
    assert.equal(result.errorCode, "NETWORK_ERROR");
    assert.ok(!result.safeMessage.includes("super-secret-token"));
  });

  await t.test("send() : timeout -> TIMEOUT", async (t) => {
    withFetch(t, async () => {
      throw abortError();
    });
    const result = await discord.send(NOTIFICATION, { webhookUrl: "https://discord.com/api/webhooks/1/abc" });
    assert.equal(result.errorCode, "TIMEOUT");
  });

  await t.test("send() : erreur fournisseur (5xx) -> PROVIDER_ERROR", async (t) => {
    withFetch(t, async () => jsonResponse(503, {}));
    const result = await discord.send(NOTIFICATION, { webhookUrl: "https://discord.com/api/webhooks/1/abc" });
    assert.equal(result.errorCode, "PROVIDER_ERROR");
  });

  await t.test("send() : webhook invalide (401) -> AUTH_ERROR, jamais de secret exposé", async (t) => {
    withFetch(t, async () => jsonResponse(401, {}));
    const result = await discord.send(NOTIFICATION, { webhookUrl: "https://discord.com/api/webhooks/1/abc" });
    assert.equal(result.errorCode, "AUTH_ERROR");
    assert.ok(!result.safeMessage.includes("abc"));
  });

  await t.test("healthCheck() : GET sur le webhook sans poster de message", async (t) => {
    let calledMethod;
    withFetch(t, async (url, opts) => {
      calledMethod = opts.method;
      return jsonResponse(200, { name: "bot" });
    });
    const result = await discord.healthCheck({ webhookUrl: "https://discord.com/api/webhooks/1/abc" });
    assert.equal(calledMethod, "GET");
    assert.equal(result.success, true);
  });

  await t.test("test() par défaut (types.js) : envoie une notification de test standard", async (t) => {
    let sentBody;
    withFetch(t, async (_url, opts) => {
      sentBody = JSON.parse(opts.body);
      return jsonResponse(200, { id: "1" });
    });
    const result = await discord.test({ webhookUrl: "https://discord.com/api/webhooks/1/abc" });
    assert.equal(result.success, true);
    assert.ok(sentBody.content.includes("Test PM2 Monitor"));
  });
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------
test("provider slack", async (t) => {
  await t.test("validateConfig rejette une config vide", () => {
    assert.ok(slack.validateConfig({}).length > 0);
  });

  await t.test("validateConfig accepte une config valide", () => {
    assert.deepEqual(slack.validateConfig({ webhookUrl: "https://hooks.slack.com/services/T/B/xyz" }), []);
  });

  await t.test("send() : succès (corps 'ok')", async (t) => {
    withFetch(t, async () => textResponse(200, "ok"));
    const result = await slack.send(NOTIFICATION, { webhookUrl: "https://hooks.slack.com/services/T/B/xyz" });
    assert.equal(result.success, true);
    assert.equal(result.provider, "slack");
  });

  await t.test("send() : 200 mais corps d'erreur applicative -> PROVIDER_ERROR", async (t) => {
    withFetch(t, async () => textResponse(200, "channel_not_found"));
    const result = await slack.send(NOTIFICATION, { webhookUrl: "https://hooks.slack.com/services/T/B/xyz" });
    assert.equal(result.success, false);
    assert.equal(result.errorCode, "PROVIDER_ERROR");
  });

  await t.test("send() : erreur réseau -> NETWORK_ERROR", async (t) => {
    withFetch(t, async () => {
      throw new Error("network down");
    });
    const result = await slack.send(NOTIFICATION, { webhookUrl: "https://hooks.slack.com/services/T/B/xyz" });
    assert.equal(result.errorCode, "NETWORK_ERROR");
  });

  await t.test("send() : timeout -> TIMEOUT", async (t) => {
    withFetch(t, async () => {
      throw abortError();
    });
    const result = await slack.send(NOTIFICATION, { webhookUrl: "https://hooks.slack.com/services/T/B/xyz" });
    assert.equal(result.errorCode, "TIMEOUT");
  });

  await t.test("send() : réponse illisible -> MALFORMED_RESPONSE", async (t) => {
    withFetch(t, async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error("stream error");
      },
    }));
    const result = await slack.send(NOTIFICATION, { webhookUrl: "https://hooks.slack.com/services/T/B/xyz" });
    assert.equal(result.errorCode, "MALFORMED_RESPONSE");
  });

  await t.test("send() : config invalide -> échec sans appel réseau", async (t) => {
    withFetch(t, async () => {
      throw new Error("ne doit pas être appelé");
    });
    const result = await slack.send(NOTIFICATION, {});
    assert.equal(result.errorCode, "INVALID_CONFIG");
  });
});

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
test("provider telegram", async (t) => {
  await t.test("validateConfig rejette une config vide", () => {
    assert.ok(telegram.validateConfig({}).length > 0);
  });

  await t.test("validateConfig accepte une config valide", () => {
    assert.deepEqual(telegram.validateConfig({ chatId: "123", botToken: "tok" }), []);
  });

  await t.test("send() : succès renvoie messageId", async (t) => {
    withFetch(t, async () => jsonResponse(200, { ok: true, result: { message_id: 42 } }));
    const result = await telegram.send(NOTIFICATION, { chatId: "123", botToken: "tok" });
    assert.equal(result.success, true);
    assert.equal(result.messageId, "42");
  });

  await t.test("send() : erreur applicative Telegram (ok: false) -> échec normalisé", async (t) => {
    withFetch(t, async () => jsonResponse(400, { ok: false, description: "Bad Request: chat not found" }));
    const result = await telegram.send(NOTIFICATION, { chatId: "123", botToken: "tok" });
    assert.equal(result.success, false);
    assert.ok(!result.safeMessage.includes("tok"));
  });

  await t.test("send() : erreur réseau -> NETWORK_ERROR, jamais le token dans safeMessage", async (t) => {
    withFetch(t, async () => {
      throw new TypeError("fetch failed for https://api.telegram.org/botSECRET-TOKEN/sendMessage");
    });
    const result = await telegram.send(NOTIFICATION, { chatId: "123", botToken: "SECRET-TOKEN" });
    assert.equal(result.errorCode, "NETWORK_ERROR");
    assert.ok(!result.safeMessage.includes("SECRET-TOKEN"));
  });

  await t.test("send() : timeout -> TIMEOUT", async (t) => {
    withFetch(t, async () => {
      throw abortError();
    });
    const result = await telegram.send(NOTIFICATION, { chatId: "123", botToken: "tok" });
    assert.equal(result.errorCode, "TIMEOUT");
  });

  await t.test("send() : réponse JSON malformée -> MALFORMED_RESPONSE", async (t) => {
    withFetch(t, async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    }));
    const result = await telegram.send(NOTIFICATION, { chatId: "123", botToken: "tok" });
    assert.equal(result.errorCode, "MALFORMED_RESPONSE");
  });

  await t.test("healthCheck() : getMe() sans envoyer de message", async (t) => {
    let calledUrl;
    withFetch(t, async (url) => {
      calledUrl = String(url);
      return jsonResponse(200, { ok: true, result: { username: "bot" } });
    });
    const result = await telegram.healthCheck({ botToken: "tok" });
    assert.ok(calledUrl.endsWith("/getMe"));
    assert.equal(result.success, true);
  });
});

// ---------------------------------------------------------------------------
// Webhook générique
// ---------------------------------------------------------------------------
test("provider webhook", async (t) => {
  await t.test("validateConfig rejette une config vide", () => {
    assert.ok(webhook.validateConfig({}).length > 0);
  });

  await t.test("validateConfig rejette une url invalide", () => {
    assert.ok(webhook.validateConfig({ url: "not-a-url" }).length > 0);
  });

  await t.test("validateConfig rejette une method invalide", () => {
    assert.ok(webhook.validateConfig({ url: "https://example.com", method: "DELETE" }).length > 0);
  });

  await t.test("validateConfig accepte une config minimale valide", () => {
    assert.deepEqual(webhook.validateConfig({ url: "https://example.com/hook" }), []);
  });

  await t.test("send() : POST par défaut avec corps JSON par défaut", async (t) => {
    let seen;
    withFetch(t, async (url, opts) => {
      seen = { url: String(url), method: opts.method, body: JSON.parse(opts.body), headers: opts.headers };
      return jsonResponse(200, { id: "abc" });
    });
    const result = await webhook.send(NOTIFICATION, { url: "https://example.com/hook" });
    assert.equal(result.success, true);
    assert.equal(result.messageId, "abc");
    assert.equal(seen.method, "POST");
    assert.equal(seen.body.title, NOTIFICATION.title);
    assert.equal(seen.headers["Content-Type"], "application/json");
  });

  await t.test("send() : gabarit payload avec substitution de placeholders", async (t) => {
    let sentBody;
    withFetch(t, async (_url, opts) => {
      sentBody = JSON.parse(opts.body);
      return jsonResponse(200, {});
    });
    await webhook.send(NOTIFICATION, {
      url: "https://example.com/hook",
      payload: { text: "{{severity}} — {{title}} : {{message}}", extra: { nested: "{{title}}" } },
    });
    assert.equal(sentBody.text, "warning — CPU élevé : process X à 95% CPU");
    assert.equal(sentBody.extra.nested, "CPU élevé");
  });

  await t.test("send() : GET n'envoie pas de corps", async (t) => {
    let seen;
    withFetch(t, async (url, opts) => {
      seen = opts;
      return jsonResponse(200, {});
    });
    await webhook.send(NOTIFICATION, { url: "https://example.com/hook", method: "GET" });
    assert.equal(seen.body, undefined);
  });

  await t.test("send() : headers personnalisés (ex. Authorization) transmis", async (t) => {
    let seenHeaders;
    withFetch(t, async (_url, opts) => {
      seenHeaders = opts.headers;
      return jsonResponse(200, {});
    });
    await webhook.send(NOTIFICATION, {
      url: "https://example.com/hook",
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(seenHeaders.Authorization, "Bearer secret-token");
  });

  await t.test("send() : erreur réseau -> NETWORK_ERROR", async (t) => {
    withFetch(t, async () => {
      throw new Error("boom");
    });
    const result = await webhook.send(NOTIFICATION, { url: "https://example.com/hook" });
    assert.equal(result.errorCode, "NETWORK_ERROR");
  });

  await t.test("send() : timeout -> TIMEOUT", async (t) => {
    withFetch(t, async () => {
      throw abortError();
    });
    const result = await webhook.send(NOTIFICATION, { url: "https://example.com/hook" });
    assert.equal(result.errorCode, "TIMEOUT");
  });

  await t.test("send() : erreur fournisseur (500) -> PROVIDER_ERROR", async (t) => {
    withFetch(t, async () => jsonResponse(500, {}));
    const result = await webhook.send(NOTIFICATION, { url: "https://example.com/hook" });
    assert.equal(result.errorCode, "PROVIDER_ERROR");
  });

  await t.test("send() : réponse non-JSON n'est pas une erreur (messageId null)", async (t) => {
    withFetch(t, async () => ({
      ok: true,
      status: 200,
      clone() {
        return this;
      },
      json: async () => {
        throw new Error("not json");
      },
    }));
    const result = await webhook.send(NOTIFICATION, { url: "https://example.com/hook" });
    assert.equal(result.success, true);
    assert.equal(result.messageId, null);
  });
});

// ---------------------------------------------------------------------------
// Email / SMTP
// ---------------------------------------------------------------------------
test("provider email", async (t) => {
  await t.test("validateConfig rejette une config vide", () => {
    assert.ok(email.validateConfig({}).length > 0);
  });

  await t.test("validateConfig rejette un security invalide", () => {
    const errors = email.validateConfig({
      host: "smtp.example.com",
      port: 587,
      fromEmail: "a@example.com",
      security: "wat",
    });
    assert.ok(errors.some((e) => /security/.test(e)));
  });

  await t.test("validateConfig accepte les 3 valeurs de security supportées", () => {
    for (const security of ["None", "STARTTLS", "SSL/TLS"]) {
      const errors = email.validateConfig({
        host: "smtp.example.com",
        port: 587,
        fromEmail: "a@example.com",
        security,
      });
      assert.deepEqual(errors, [], `security="${security}" devrait être valide`);
    }
  });

  await t.test("validateConfig exige username/password ensemble", () => {
    const errors = email.validateConfig({
      host: "smtp.example.com",
      port: 587,
      fromEmail: "a@example.com",
      username: "u",
    });
    assert.ok(errors.some((e) => /ensemble/.test(e)));
  });

  function mockTransport(t, impl) {
    return t.mock.method(nodemailer, "createTransport", () => impl);
  }

  const CONFIG = {
    host: "smtp.example.com",
    port: 587,
    security: "STARTTLS",
    fromEmail: "alerts@example.com",
    fromName: "PM2 Monitor",
    to: "admin@example.com",
  };

  await t.test("send() : config invalide -> échec sans instancier de transport", async (t) => {
    const mock = mockTransport(t, { sendMail: async () => ({ messageId: "x" }), close: () => {} });
    const result = await email.send(NOTIFICATION, {});
    assert.equal(result.errorCode, "INVALID_CONFIG");
    assert.equal(mock.mock.callCount(), 0);
  });

  await t.test("send() : aucun destinataire -> échec explicite", async (t) => {
    mockTransport(t, { sendMail: async () => ({ messageId: "x" }), close: () => {} });
    const { to, ...withoutTo } = CONFIG;
    const result = await email.send(NOTIFICATION, withoutTo);
    assert.equal(result.success, false);
    assert.match(result.safeMessage, /destinataire/);
  });

  await t.test("send() : succès renvoie le messageId nodemailer", async (t) => {
    mockTransport(t, { sendMail: async () => ({ messageId: "<abc@smtp>" }), close: () => {} });
    const result = await email.send(NOTIFICATION, CONFIG);
    assert.equal(result.success, true);
    assert.equal(result.messageId, "<abc@smtp>");
  });

  await t.test(
    "send() : erreur d'authentification -> AUTH_ERROR, jamais le mot de passe exposé",
    async (t) => {
      mockTransport(t, {
        sendMail: async () => {
          const err = new Error("535 5.7.8 Authentication failed: password=hunter2");
          err.code = "EAUTH";
          throw err;
        },
        close: () => {},
      });
      const result = await email.send(NOTIFICATION, { ...CONFIG, username: "u", password: "hunter2" });
      assert.equal(result.errorCode, "AUTH_ERROR");
      assert.ok(!result.safeMessage.includes("hunter2"));
    },
  );

  await t.test("send() : erreur réseau -> NETWORK_ERROR", async (t) => {
    mockTransport(t, {
      sendMail: async () => {
        const err = new Error("connect failed");
        err.code = "ECONNECTION";
        throw err;
      },
      close: () => {},
    });
    const result = await email.send(NOTIFICATION, CONFIG);
    assert.equal(result.errorCode, "NETWORK_ERROR");
  });

  await t.test("send() : timeout -> TIMEOUT", async (t) => {
    mockTransport(t, {
      sendMail: async () => {
        const err = new Error("timed out");
        err.code = "ETIMEDOUT";
        throw err;
      },
      close: () => {},
    });
    const result = await email.send(NOTIFICATION, CONFIG);
    assert.equal(result.errorCode, "TIMEOUT");
  });

  await t.test("send() : erreur serveur inconnue -> PROVIDER_ERROR (jamais le message brut)", async (t) => {
    mockTransport(t, {
      sendMail: async () => {
        throw new Error("550 mailbox unavailable, internal host db01.internal");
      },
      close: () => {},
    });
    const result = await email.send(NOTIFICATION, CONFIG);
    assert.equal(result.errorCode, "PROVIDER_ERROR");
    assert.ok(!result.safeMessage.includes("db01.internal"));
  });

  await t.test("healthCheck() : verify() sans envoyer d'e-mail", async (t) => {
    let verifyCalled = false;
    let sendCalled = false;
    mockTransport(t, {
      verify: async () => {
        verifyCalled = true;
        return true;
      },
      sendMail: async () => {
        sendCalled = true;
        return { messageId: "x" };
      },
      close: () => {},
    });
    const result = await email.healthCheck(CONFIG);
    assert.equal(result.success, true);
    assert.equal(verifyCalled, true);
    assert.equal(sendCalled, false);
  });
});
