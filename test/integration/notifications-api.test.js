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

test("API /api/notifications (fondations Phase 5A + providers Phase 5B)", async (t) => {
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

  await t.test("GET /provider-types : les 5 providers réels, implémentés (Phase 5B)", async () => {
    const { server, baseUrl } = await startServer(NOTIF_USER);
    try {
      const res = await fetch(`${baseUrl}/provider-types`);
      assert.equal(res.status, 200);
      const body = await res.json();
      const types = body.map((p) => p.type).sort();
      assert.deepEqual(types, ["discord", "email", "slack", "telegram", "webhook"]);
      assert.ok(body.every((p) => p.implemented === true));
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
    await providerStore.create({
      name: "SMTP Admin",
      type: "email",
      configuration: { host: "smtp.example.com" },
    });

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

const NOTIF_ADMIN = {
  id: 4,
  isAdmin: false,
  permissions: [
    { appName: "*", action: "notifications_read" },
    { appName: "*", action: "notifications_create" },
    { appName: "*", action: "notifications_update" },
    { appName: "*", action: "notifications_delete" },
    { appName: "*", action: "notifications_test" },
  ],
};

test("API /api/notifications — CRUD providers (Phase 5C)", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("POST /providers crée une configuration valide et scinde secrets/configuration", async () => {
    const { server, baseUrl } = await startServer(NOTIF_ADMIN);
    try {
      const res = await fetch(`${baseUrl}/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Discord Production",
          type: "discord",
          fields: { webhookUrl: "https://discord.com/api/webhooks/123/abc", username: "PM2 Monitor" },
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.name, "Discord Production");
      assert.equal(body.hasSecrets, true);
      assert.equal(body.configuration.username, "PM2 Monitor");
      assert.equal(body.secrets, undefined);

      const db = require("../../lib/db");
      const row = await db.get("SELECT configuration, secrets FROM notification_providers WHERE id = ?", [
        body.id,
      ]);
      assert.equal(JSON.parse(row.configuration).webhookUrl, undefined);
      assert.ok(!row.secrets.includes("discord.com/api/webhooks"));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("POST /providers rejette une configuration invalide (validation backend)", async () => {
    const { server, baseUrl } = await startServer(NOTIF_ADMIN);
    try {
      const res = await fetch(`${baseUrl}/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bad Discord", type: "discord", fields: { webhookUrl: "not-a-url" } }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /webhook Discord valide/);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("POST /providers rejette un type inconnu", async () => {
    const { server, baseUrl } = await startServer(NOTIF_ADMIN);
    try {
      const res = await fetch(`${baseUrl}/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", type: "bogus", fields: {} }),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("POST /providers -> 403 sans permission notifications_create", async () => {
    const { server, baseUrl } = await startServer(NOTIF_USER); // notifications_read seulement
    try {
      const res = await fetch(`${baseUrl}/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "x",
          type: "slack",
          fields: { webhookUrl: "https://hooks.slack.com/services/x" },
        }),
      });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  let slackId;
  await t.test("PATCH /providers/:id modifie un champ public sans toucher aux secrets", async () => {
    const providerStore = require("../../lib/services/notifications/provider-store");
    const created = await providerStore.create({
      name: "Slack Prod",
      type: "slack",
      configuration: { channel: "#ops" },
      secrets: { webhookUrl: "https://hooks.slack.com/services/aaa/bbb/ccc" },
    });
    slackId = created.id;

    const { server, baseUrl } = await startServer(NOTIF_ADMIN);
    try {
      const res = await fetch(`${baseUrl}/providers/${slackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { channel: "#alerts" } }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.configuration.channel, "#alerts");

      const secrets = await providerStore.getDecryptedSecrets(slackId);
      assert.equal(secrets.webhookUrl, "https://hooks.slack.com/services/aaa/bbb/ccc"); // conservé ("keep existing")
    } finally {
      await stopServer(server);
    }
  });

  await t.test("PATCH /providers/:id refuse de changer le type", async () => {
    const { server, baseUrl } = await startServer(NOTIF_ADMIN);
    try {
      const res = await fetch(`${baseUrl}/providers/${slackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "discord" }),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("PATCH /providers/:id sur un id inconnu -> 404", async () => {
    const { server, baseUrl } = await startServer(NOTIF_ADMIN);
    try {
      const res = await fetch(`${baseUrl}/providers/999999`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(res.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("DELETE /providers/:id -> 403 sans permission notifications_delete", async () => {
    const { server, baseUrl } = await startServer(NOTIF_USER);
    try {
      const res = await fetch(`${baseUrl}/providers/${slackId}`, { method: "DELETE" });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("DELETE /providers/:id supprime bien la configuration", async () => {
    const { server, baseUrl } = await startServer(NOTIF_ADMIN);
    try {
      const res = await fetch(`${baseUrl}/providers/${slackId}`, { method: "DELETE" });
      assert.equal(res.status, 200);
      const providerStore = require("../../lib/services/notifications/provider-store");
      assert.equal(await providerStore.getById(slackId), null);
    } finally {
      await stopServer(server);
    }
  });

  await t.test(
    "POST /providers/:id/test appelle réellement le provider et ne renvoie jamais de secret",
    async () => {
      const providerStore = require("../../lib/services/notifications/provider-store");
      const created = await providerStore.create({
        name: "Discord Test",
        type: "discord",
        secrets: { webhookUrl: "https://discord.com/api/webhooks/000/does-not-exist" },
      });

      const { server, baseUrl } = await startServer(NOTIF_ADMIN);
      try {
        const res = await fetch(`${baseUrl}/providers/${created.id}/test`, { method: "POST" });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.provider, "discord");
        assert.equal(typeof body.success, "boolean");
        assert.equal(JSON.stringify(body).includes("discord.com/api/webhooks/000"), false);
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test("POST /providers/:id/test -> 403 sans permission notifications_test", async () => {
    const providerStore = require("../../lib/services/notifications/provider-store");
    const created = await providerStore.create({ name: "Discord Test 2", type: "discord" });

    const { server, baseUrl } = await startServer(NOTIF_USER);
    try {
      const res = await fetch(`${baseUrl}/providers/${created.id}/test`, { method: "POST" });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("POST /providers/:id/test sur un id inconnu -> 404", async () => {
    const { server, baseUrl } = await startServer(NOTIF_ADMIN);
    try {
      const res = await fetch(`${baseUrl}/providers/999999/test`, { method: "POST" });
      assert.equal(res.status, 404);
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

const NOTIF_MANAGER = {
  id: 5,
  isAdmin: false,
  permissions: [
    { appName: "*", action: "notifications_read" },
    { appName: "*", action: "notifications_manage" },
    { appName: "*", action: "notifications_history" },
  ],
};

test("API /api/notifications — routing + historique (Phase 5D)", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("notifications_read seul -> GET /routes et /history OK, écriture refusée (403)", async () => {
    const { server, baseUrl } = await startServer(NOTIF_USER); // notifications_read uniquement
    try {
      assert.equal((await fetch(`${baseUrl}/routes`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/history`)).status, 403); // notifications_history requis
      const res = await fetch(`${baseUrl}/routes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      assert.equal(res.status, 403); // notifications_manage requis
    } finally {
      await stopServer(server);
    }
  });

  await t.test("aucune permission -> /routes et /history en 403", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      assert.equal((await fetch(`${baseUrl}/routes`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/history`)).status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("POST /routes crée une règle (conditions/providerIds/templates/notifyOnResolve)", async () => {
    const { server, baseUrl } = await startServer(NOTIF_MANAGER);
    try {
      const res = await fetch(`${baseUrl}/routes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Critical CPU to Discord",
          conditions: { severity: ["critical"], alertType: ["cpu"] },
          providerIds: [1],
          titleTemplate: "[{{severity}}] {{ruleName}}",
          messageTemplate: "{{metric}} = {{value}}",
          notifyOnResolve: true,
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.name, "Critical CPU to Discord");
      assert.deepEqual(body.providerIds, [1]);
      assert.equal(body.titleTemplate, "[{{severity}}] {{ruleName}}");
      assert.equal(body.notifyOnResolve, true);
      assert.equal(body.enabled, true);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("POST /routes sans name -> 400", async () => {
    const { server, baseUrl } = await startServer(NOTIF_MANAGER);
    try {
      const res = await fetch(`${baseUrl}/routes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /routes/:id sur un id inconnu -> 404", async () => {
    const { server, baseUrl } = await startServer(NOTIF_MANAGER);
    try {
      const res = await fetch(`${baseUrl}/routes/999999`);
      assert.equal(res.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("PATCH /routes/:id modifie partiellement (ex: enabled seul)", async () => {
    const { server, baseUrl } = await startServer(NOTIF_MANAGER);
    try {
      const created = await (
        await fetch(`${baseUrl}/routes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "To disable", enabled: true }),
        })
      ).json();

      const res = await fetch(`${baseUrl}/routes/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(res.status, 200);
      const updated = await res.json();
      assert.equal(updated.enabled, false);
      assert.equal(updated.name, "To disable"); // non touché
    } finally {
      await stopServer(server);
    }
  });

  await t.test("DELETE /routes/:id supprime, puis 404 sur un second appel", async () => {
    const { server, baseUrl } = await startServer(NOTIF_MANAGER);
    try {
      const created = await (
        await fetch(`${baseUrl}/routes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "To delete" }),
        })
      ).json();

      assert.equal((await fetch(`${baseUrl}/routes/${created.id}`, { method: "DELETE" })).status, 200);
      assert.equal((await fetch(`${baseUrl}/routes/${created.id}`, { method: "DELETE" })).status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await t.test(
    "GET /history renvoie l'historique écrit par routing/engine.js, jamais de secret",
    async () => {
      const historyStore = require("../../lib/services/notifications/history-store");
      const providerStore = require("../../lib/services/notifications/provider-store");
      // FK réelle sur notification_history.provider_id (voir 006_notifications.js) :
      // il faut un provider existant, pas un id arbitraire.
      const provider = await providerStore.create({
        name: "Fixture history",
        type: "webhook",
        configuration: {},
      });
      await historyStore.create({
        providerId: provider.id,
        alertId: null, // FK sur alerts(id) : pas d'alerte réelle créée dans ce test, null reste valide (voir history-store.js)
        status: "success",
        responseTimeMs: 12,
      });
      await historyStore.create({
        providerId: provider.id,
        alertId: null,
        status: "failed",
        errorCode: "NETWORK_ERROR",
      });

      const { server, baseUrl } = await startServer(NOTIF_MANAGER);
      try {
        const res = await fetch(`${baseUrl}/history?status=failed`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.length, 1);
        assert.equal(body[0].errorCode, "NETWORK_ERROR");
        assert.equal(body[0].providerId, provider.id);
      } finally {
        await stopServer(server);
      }
    },
  );

  await cleanupDb(dbCtx);
  delete process.env.PM2_MONITOR_DISABLE_AUTH;
});

test("routing/route-store — modèle + templates/notifyOnResolve (Phase 5A + 5D)", async (t) => {
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

  await t.test(
    "titleTemplate/messageTemplate/notifyOnResolve : round-trip et défauts (Phase 5D)",
    async () => {
      const withTemplate = await routeStore.create({
        name: "With template",
        titleTemplate: "[{{severity}}] {{ruleName}}",
        messageTemplate: "{{metric}} {{operator}} {{threshold}}",
        notifyOnResolve: true,
      });
      const fetched = await routeStore.getById(withTemplate.id);
      assert.equal(fetched.titleTemplate, "[{{severity}}] {{ruleName}}");
      assert.equal(fetched.messageTemplate, "{{metric}} {{operator}} {{threshold}}");
      assert.equal(fetched.notifyOnResolve, true);

      const withoutTemplate = await routeStore.create({ name: "No template" });
      assert.equal(withoutTemplate.titleTemplate, null);
      assert.equal(withoutTemplate.messageTemplate, null);
      assert.equal(withoutTemplate.notifyOnResolve, false);
    },
  );

  await t.test("update() peut modifier uniquement notifyOnResolve sans toucher aux templates", async () => {
    const route = await routeStore.create({
      name: "Toggle resolve",
      titleTemplate: "Custom title",
      notifyOnResolve: false,
    });
    const updated = await routeStore.update(route.id, { notifyOnResolve: true });
    assert.equal(updated.notifyOnResolve, true);
    assert.equal(updated.titleTemplate, "Custom title");
  });

  await cleanupDb(dbCtx);
});

test("history-store (modèle + écriture par routing/engine.js depuis la Phase 5D)", async (t) => {
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
