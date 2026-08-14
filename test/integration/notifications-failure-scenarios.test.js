"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

const { ProviderRegistry } = require("../../lib/services/notifications/registry");
const realProviders = require("../../lib/services/notifications/providers");
const providerStore = require("../../lib/services/notifications/provider-store");
const routeStore = require("../../lib/services/notifications/routing/route-store");
const historyStore = require("../../lib/services/notifications/history-store");
const { RoutingEngine } = require("../../lib/services/notifications/routing/engine");
const { NotificationDispatchQueue } = require("../../lib/services/notifications/dispatch-queue");
const { createQueue } = require("../../lib/services/queue");

/**
 * Phase 5F — section 6 "Failure scenarios" de la tâche : SMTP down, Discord
 * down, Telegram timeout, Slack invalid response, Webhook unavailable,
 * Queue restart, Monitor restart, Database unavailable. Le moteur de
 * monitoring principal doit rester fonctionnel autant que possible dans
 * chaque cas.
 *
 * Providers réels (Phase 5B), pas de doubles maison — seul `global.fetch`/
 * `nodemailer` est mocké, exactement comme dans
 * test/unit/notifications-providers.test.js, pour ne jamais faire d'appel
 * réseau réel en CI (section 7 de la tâche).
 */

function withFetch(t, impl) {
  const original = global.fetch;
  global.fetch = impl;
  t.after(() => {
    global.fetch = original;
  });
}

function realRegistry() {
  const registry = new ProviderRegistry();
  for (const p of realProviders) registry.registerProvider(p);
  return registry;
}

async function setupPipeline({ providerType, configuration, secrets, maxAttempts = 1 }) {
  const registry = realRegistry();
  const provider = await providerStore.create({ name: `Test ${providerType}`, type: providerType, configuration, secrets });
  await routeStore.create({ name: `route-${providerType}`, conditions: {}, providerIds: [provider.id] });
  const dispatchQueue = new NotificationDispatchQueue({
    registry,
    providerStore,
    historyStore,
    queue: createQueue(`failure-scenario-${providerType}-${Date.now()}`, { maxAttempts, backoffMs: 0 }),
  });
  const routingEngine = new RoutingEngine({ routeStore, providerStore, registry, historyStore, dispatchQueue });
  return { registry, provider, dispatchQueue, routingEngine };
}

test("Phase 5F — Failure scenarios : chaque panne provider est absorbée, le pipeline reste fonctionnel", async (t) => {
  let ctx;

  t.beforeEach(async () => {
    ctx = await freshDb();
    await migrator.up();
  });

  t.afterEach(async () => {
    await cleanupDb(ctx);
  });

  await t.test("SMTP down (nodemailer rejette) : historique 'failed', pas d'exception propagée", async (t) => {
    const nodemailer = require("nodemailer");
    const original = nodemailer.createTransport;
    nodemailer.createTransport = () => ({
      sendMail: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:587");
      },
      verify: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    t.after(() => {
      nodemailer.createTransport = original;
    });

    const { dispatchQueue, routingEngine, provider } = await setupPipeline({
      providerType: "email",
      configuration: { host: "smtp.example.invalid", port: 587, security: "starttls", fromName: "PM2 Monitor", fromEmail: "a@b.c", to: "c@d.e" },
      secrets: { username: "u", password: "p" },
    });

    const alert = { id: null, severity: "critical", metric: "cpu", targetType: "process", targetValue: "api", state: "active", triggeredAt: 1, lastSeenAt: 1 };
    const [dispatched] = await routingEngine.dispatch(alert, "triggered");
    assert.equal(dispatched.status, "queued");
    await assert.doesNotReject(() => dispatchQueue.processOne());

    const entry = await historyStore.getById(dispatched.historyEntry.id);
    assert.equal(entry.status, "failed");
    assert.equal(entry.providerId, provider.id);
  });

  await t.test("Discord down (fetch rejette : DNS/connexion) : historique 'failed', pas d'exception propagée", async (t) => {
    withFetch(t, async () => {
      throw new Error("getaddrinfo ENOTFOUND discord.com");
    });

    const { dispatchQueue, routingEngine } = await setupPipeline({
      providerType: "discord",
      configuration: {},
      secrets: { webhookUrl: "https://discord.com/api/webhooks/1/x" },
    });

    const alert = { id: null, severity: "critical", metric: "cpu", targetType: "system", targetValue: null, state: "active", triggeredAt: 1, lastSeenAt: 1 };
    const [dispatched] = await routingEngine.dispatch(alert, "triggered");
    await assert.doesNotReject(() => dispatchQueue.processOne());

    const entry = await historyStore.getById(dispatched.historyEntry.id);
    assert.equal(entry.status, "failed");
  });

  await t.test("Telegram timeout (fetch qui n'aboutit jamais / AbortError) : historique 'failed', pas d'exception propagée", async (t) => {
    withFetch(t, async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    const { dispatchQueue, routingEngine } = await setupPipeline({
      providerType: "telegram",
      configuration: {},
      secrets: { botToken: "123:abc", chatId: "456" },
    });

    const alert = { id: null, severity: "warning", metric: "memory", targetType: "system", targetValue: null, state: "active", triggeredAt: 1, lastSeenAt: 1 };
    const [dispatched] = await routingEngine.dispatch(alert, "triggered");
    await assert.doesNotReject(() => dispatchQueue.processOne());

    const entry = await historyStore.getById(dispatched.historyEntry.id);
    assert.equal(entry.status, "failed");
  });

  await t.test("Slack réponse invalide (200 mais corps inattendu) : historique 'failed' ou 'success' selon le contrat provider, jamais d'exception", async (t) => {
    withFetch(t, async () => ({
      ok: true,
      status: 200,
      text: async () => "not-what-slack-usually-returns-<<>>",
      json: async () => {
        throw new Error("invalid json");
      },
      clone() {
        return this;
      },
    }));

    const { dispatchQueue, routingEngine } = await setupPipeline({
      providerType: "slack",
      configuration: {},
      secrets: { webhookUrl: "https://hooks.slack.com/services/x" },
    });

    const alert = { id: null, severity: "info", metric: "disk", targetType: "system", targetValue: null, state: "active", triggeredAt: 1, lastSeenAt: 1 };
    const [dispatched] = await routingEngine.dispatch(alert, "triggered");
    await assert.doesNotReject(() => dispatchQueue.processOne());

    const entry = await historyStore.getById(dispatched.historyEntry.id);
    assert.ok(["success", "failed"].includes(entry.status));
  });

  await t.test("Webhook générique indisponible (connexion refusée) : historique 'failed', pas d'exception propagée", async (t) => {
    withFetch(t, async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const { dispatchQueue, routingEngine } = await setupPipeline({
      providerType: "webhook",
      configuration: { url: "https://internal.example.invalid/hook", method: "POST" },
      secrets: {},
    });

    const alert = { id: null, severity: "critical", metric: "restart_count", targetType: "process", targetValue: "worker", state: "active", triggeredAt: 1, lastSeenAt: 1 };
    const [dispatched] = await routingEngine.dispatch(alert, "triggered");
    await assert.doesNotReject(() => dispatchQueue.processOne());

    const entry = await historyStore.getById(dispatched.historyEntry.id);
    assert.equal(entry.status, "failed");
  });

  await t.test("Queue restart (jobs orphelins 'active' après un arrêt brutal) : repris par recoverStaleActiveJobs()", async () => {
    withGlobalFetchOk();

    const { dispatchQueue } = await setupPipeline({
      providerType: "webhook",
      configuration: { url: "https://internal.example.invalid/hook", method: "POST" },
      secrets: {},
    });

    // Simule un job laissé "active" par un process tué brutalement.
    const jobId = await dispatchQueue.queue.add({ providerId: 1, alertId: null, notification: {}, historyId: null });
    const db = require("../../lib/db");
    await db.run("UPDATE jobs SET status = 'active' WHERE id = ?", [jobId]);

    const before = await dispatchQueue.queue.listByStatus("pending");
    assert.equal(before.length, 0);

    const recovered = await dispatchQueue.queue.recoverStaleActiveJobs();
    assert.ok(recovered >= 1);

    const after = await dispatchQueue.queue.listByStatus("pending");
    assert.equal(after.length, 1);

    restoreGlobalFetch();
  });

  await t.test("Database indisponible pendant l'écriture d'historique : enqueue() n'échoue jamais, juste dégradé", async () => {
    const registry = realRegistry();
    const brokenHistoryStore = {
      create: async () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
      update: async () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    };
    const provider = await providerStore.create({ name: "P", type: "webhook", configuration: { url: "https://internal.example.invalid" }, secrets: {} });
    const brokenProviderStore = {
      getById: async () => ({ id: provider.id, type: "webhook", enabled: true, configuration: { url: "https://internal.example.invalid" } }),
      getDecryptedSecrets: async () => ({}),
    };

    const dq = new NotificationDispatchQueue({
      registry,
      providerStore: brokenProviderStore,
      historyStore: brokenHistoryStore,
      queue: createQueue("failure-scenario-db-down", { maxAttempts: 1, backoffMs: 0 }),
    });

    const result = await dq.enqueue({ providerId: provider.id, notification: { title: "t", message: "m" }, alertId: null, event: "triggered" });
    assert.equal(result.status, "queued"); // dégradé (pas d'historique) mais pas bloqué
    assert.equal(result.historyEntry, null);

    await assert.doesNotReject(() => dq.processOne());
  });
});

let _originalFetch;
function withGlobalFetchOk() {
  _originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => "ok", json: async () => ({}), clone() { return this; } });
}
function restoreGlobalFetch() {
  global.fetch = _originalFetch;
}
