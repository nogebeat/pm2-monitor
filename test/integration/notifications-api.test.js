"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur de notifications (lib/routes/notifications.js) sur
 * un serveur HTTP réel, DB SQLite temporaire migrée. `req.user` est injecté
 * directement (comme test/integration/events-api.test.js) pour rester
 * focalisé sur les routes, le contrat store <-> DB et
 * lib/auth.js#requirePermission.
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0"; // auth ACTIVÉE : on veut tester les permissions
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/notifications")];
  delete require.cache[require.resolve("../../lib/services/notifications")];
  delete require.cache[require.resolve("../../lib/services/notifications/provider-store")];

  const auth = require("../../lib/auth");
  const notificationsRouter = require("../../lib/routes/notifications");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/notifications", notificationsRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/notifications`;
  return { server, baseUrl };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const NOTIF_USER = { id: 3, isAdmin: false, permissions: [{ appName: "*", action: "notifications_read" }] };

test("API /api/notifications (Phase 5A)", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("utilisateur sans permission notifications_read -> 403", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      assert.equal((await fetch(`${baseUrl}/providers`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/provider-types`)).status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /provider-types : les 5 placeholders, non implémentés", async () => {
    const { server, baseUrl } = await startServer(NOTIF_USER);
    try {
      const res = await fetch(`${baseUrl}/provider-types`);
      assert.equal(res.status, 200);
      const body = await res.json();
      const types = body.map((p) => p.type).sort();
      assert.deepEqual(types, ["discord", "email", "slack", "telegram", "webhook"]);
      assert.ok(body.every((p) => p.implemented === false));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /providers : liste vide au départ -> 200, tableau vide", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/providers`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), []);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /providers?type=bogus (type inconnu du registry) -> 400", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/providers?type=bogus`);
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /providers ne renvoie jamais les secrets, seulement hasSecrets", async () => {
    const providerStore = require("../../lib/services/notifications/provider-store");
    const created = await providerStore.create({
      name: "Discord Production",
      type: "discord",
      configuration: { username: "PM2 Monitor" },
      secrets: { webhookUrl: "https://discord.com/api/webhooks/xxx/yyy" },
    });
    assert.equal(created.hasSecrets, true);
    assert.equal(created.secrets, undefined);

    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/providers`);
      const body = await res.json();
      assert.equal(body.length, 1);
      assert.equal(body[0].name, "Discord Production");
      assert.equal(body[0].hasSecrets, true);
      assert.equal(JSON.stringify(body).includes("discord.com/api/webhooks"), false);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /providers?type=discord filtre par type", async () => {
    const providerStore = require("../../lib/services/notifications/provider-store");
    await providerStore.create({ name: "SMTP Admin", type: "email", configuration: { host: "smtp.example.com" } });

    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/providers?type=discord`);
      const body = await res.json();
      assert.equal(body.length, 1);
      assert.equal(body[0].type, "discord");
    } finally {
      await stopServer(server);
    }
  });

  await cleanupDb(dbCtx);
  delete process.env.PM2_MONITOR_DISABLE_AUTH;
});

test("provider-store (plusieurs configs du même type, secrets chiffrés)", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();
  const providerStore = require("../../lib/services/notifications/provider-store");

  await t.test("plusieurs configurations du même provider (ex: Discord Production + Staging)", async () => {
    const prod = await providerStore.create({ name: "Discord Production", type: "discord" });
    const staging = await providerStore.create({ name: "Discord Staging", type: "discord" });
    assert.notEqual(prod.id, staging.id);

    const discordConfigs = await providerStore.list({ type: "discord" });
    assert.equal(discordConfigs.length, 2);
  });

  await t.test("les secrets sont chiffrés en base (jamais en clair dans la colonne)", async () => {
    const db = require("../../lib/db");
    const created = await providerStore.create({
      name: "SMTP Admin",
      type: "email",
      secrets: { password: "hunter2" },
    });
    const row = await db.get("SELECT secrets FROM notification_providers WHERE id = ?", [created.id]);
    assert.ok(row.secrets);
    assert.ok(!row.secrets.includes("hunter2"));
  });

  await t.test("getDecryptedSecrets() redonne les secrets d'origine (usage interne uniquement)", async () => {
    const created = await providerStore.create({
      name: "Telegram Alerts",
      type: "telegram",
      secrets: { botToken: "123:ABC" },
    });
    const secrets = await providerStore.getDecryptedSecrets(created.id);
    assert.deepEqual(secrets, { botToken: "123:ABC" });
  });

  await t.test("create() rejette une config sans name/type", async () => {
    await assert.rejects(() => providerStore.create({}), /name requis/);
    await assert.rejects(() => providerStore.create({ name: "x" }), /type requis/);
  });

  await t.test("update() partiel ne touche pas les champs non fournis", async () => {
    const created = await providerStore.create({ name: "Slack Prod", type: "slack", enabled: true });
    const updated = await providerStore.update(created.id, { enabled: false });
    assert.equal(updated.name, "Slack Prod");
    assert.equal(updated.enabled, false);
  });

  await t.test("remove() supprime bien la configuration", async () => {
    const created = await providerStore.create({ name: "To Delete", type: "webhook" });
    assert.equal(await providerStore.remove(created.id), true);
    assert.equal(await providerStore.getById(created.id), null);
  });

  await cleanupDb(dbCtx);
});

test("routing/route-store (modèle uniquement, pas de moteur d'évaluation)", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();
  const routeStore = require("../../lib/services/notifications/routing/route-store");

  await t.test("create() puis getById() round-trip sur conditions/providerIds", async () => {
    const route = await routeStore.create({
      name: "Critical alerts to Discord + Telegram",
      conditions: { severity: ["critical"], process: [] },
      providerIds: [1, 2],
    });
    const fetched = await routeStore.getById(route.id);
    assert.deepEqual(fetched.conditions, { severity: ["critical"], process: [] });
    assert.deepEqual(fetched.providerIds, [1, 2]);
  });

  await t.test("list({ enabledOnly: true }) exclut les règles désactivées", async () => {
    await routeStore.create({ name: "Enabled route", enabled: true });
    await routeStore.create({ name: "Disabled route", enabled: false });
    const enabled = await routeStore.list({ enabledOnly: true });
    assert.ok(enabled.every((r) => r.enabled === true));
    assert.ok(enabled.some((r) => r.name === "Enabled route"));
    assert.ok(!enabled.some((r) => r.name === "Disabled route"));
  });

  await cleanupDb(dbCtx);
});

test("history-store (modèle uniquement, pas d'écriture automatique en Phase 5A)", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();
  const historyStore = require("../../lib/services/notifications/history-store");

  await t.test("create() puis list() filtré par status", async () => {
    await historyStore.create({ status: "success", timestamp: 1000 });
    await historyStore.create({ status: "failed", timestamp: 2000, errorCode: "ETIMEDOUT" });

    const failed = await historyStore.list({ status: "failed" });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].errorCode, "ETIMEDOUT");
  });

  await t.test("create() rejette un status invalide", async () => {
    await assert.rejects(() => historyStore.create({ status: "bogus" }), /status requis/);
  });

  await t.test("providerId peut être null (config supprimée depuis) sans planter la lecture", async () => {
    const entry = await historyStore.create({ status: "success", providerId: null, timestamp: 3000 });
    const fetched = await historyStore.getById(entry.id);
    assert.equal(fetched.providerId, null);
  });

  await cleanupDb(dbCtx);
});
