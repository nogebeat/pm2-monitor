"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const migrator = require("../../lib/db/migrator");

/**
 * Monte le vrai routeur (lib/routes/auto-healing.js) + le vrai
 * AutoHealingService sur un serveur HTTP réel, avec une vraie DB SQLite
 * (migrée via 009_auto_healing.js) — même approche que
 * test/integration/health-checks-api.test.js. `req.user` est injecté
 * directement pour tester les permissions sans passer par express-session.
 * `pm2Actions.restart` est stubbé (aucun vrai process PM2 dans ces tests).
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/auto-healing")];
  delete require.cache[require.resolve("../../lib/services/auto-healing")];
  delete require.cache[require.resolve("../../lib/services/auto-healing/engine")];
  delete require.cache[require.resolve("../../lib/services/auto-healing/settings-store")];
  delete require.cache[require.resolve("../../lib/services/auto-healing/state-store")];
  delete require.cache[require.resolve("../../lib/services/auto-healing/audit-store")];

  const autoHealingRouter = require("../../lib/routes/auto-healing");
  const { AutoHealingService } = require("../../lib/services/auto-healing");

  const service = new AutoHealingService({ restart: async () => {} });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/auto-healing", autoHealingRouter(service));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, service, baseUrl: `http://127.0.0.1:${port}/api/auto-healing` };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true, username: "admin" };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const READ_ONLY_USER = {
  id: 3,
  isAdmin: false,
  permissions: [{ appName: "*", action: "authealing_read" }],
};
const MANAGE_USER = {
  id: 4,
  isAdmin: false,
  permissions: [
    { appName: "*", action: "authealing_read" },
    { appName: "*", action: "authealing_manage" },
  ],
};

test("Auto-Healing API", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("GET /settings — désactivé par défaut (section 7 : AUTO-HEALING = OFF)", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/settings`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.enabled, false);
      assert.equal(body.maxAttempts, 3);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("permissions — sans authealing_read, /settings est refusé (403)", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      const res = await fetch(`${baseUrl}/settings`);
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("permissions — lecture seule ne peut pas activer Auto-Healing (403)", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      const res = await fetch(`${baseUrl}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(res.status, 403);

      // Toujours désactivé après la tentative refusée.
      const check = await fetch(`${baseUrl}/settings`);
      const body = await check.json();
      assert.equal(body.enabled, false);
    } finally {
      await stopServer(server);
    }
  });

  await t.test(
    "PUT /settings — authealing_manage peut activer explicitement (et seulement lui)",
    async () => {
      const { server, baseUrl } = await startServer(MANAGE_USER);
      try {
        const res = await fetch(`${baseUrl}/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true, maxAttempts: 5 }),
        });
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.enabled, true);
        assert.equal(body.maxAttempts, 5);
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test("PUT /settings — maxAttempts invalide est rejeté (400)", async () => {
    const { server, baseUrl } = await startServer(MANAGE_USER);
    try {
      const res = await fetch(`${baseUrl}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxAttempts: 0 }),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("workflow bloqué -> audit -> unblock", async () => {
    const { server, service, baseUrl } = await startServer(MANAGE_USER);
    try {
      await service.settingsStore.update({ enabled: true, maxAttempts: 1, backoffSeconds: [0] });

      await service.trigger({ processName: "api-prod", source: "pm2_event", reason: "process crashed" });
      const blockedResult = await service.trigger({
        processName: "api-prod",
        source: "pm2_event",
        reason: "process crashed",
      });
      assert.equal(blockedResult.action, "block");

      const stateRes = await fetch(`${baseUrl}/state/api-prod`);
      const state = await stateRes.json();
      assert.equal(state.blocked, true);

      const auditRes = await fetch(`${baseUrl}/audit?process=api-prod`);
      const audit = await auditRes.json();
      assert.ok(audit.length >= 2);
      assert.ok(audit.some((e) => e.result === "blocked"));

      // Sans authealing_manage : déblocage refusé.
      const roServer = await startServer(READ_ONLY_USER);
      try {
        const denied = await fetch(`${roServer.baseUrl}/state/api-prod/unblock`, { method: "POST" });
        assert.equal(denied.status, 403);
      } finally {
        await stopServer(roServer.server);
      }

      const unblockRes = await fetch(`${baseUrl}/state/api-prod/unblock`, { method: "POST" });
      const unblocked = await unblockRes.json();
      assert.equal(unblockRes.status, 200);
      assert.equal(unblocked.blocked, false);
      assert.equal(unblocked.attempts, 0);
    } finally {
      await stopServer(server);
    }
  });

  await cleanupDb(dbCtx);
});
