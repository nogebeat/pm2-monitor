"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur (lib/routes/health-checks.js) sur un serveur HTTP
 * réel, avec la vraie DB SQLite (migrée via la migration 008 existante) —
 * même approche que test/integration/alerts-api.test.js. `req.user` est
 * injecté directement pour tester les permissions (lib/permissions.js) sans
 * passer par express-session.
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/health-checks")];
  delete require.cache[require.resolve("../../lib/services/health-checks")];
  delete require.cache[require.resolve("../../lib/services/health-checks/engine")];
  delete require.cache[require.resolve("../../lib/services/health-checks/store")];
  delete require.cache[require.resolve("../../lib/services/alerts")];
  delete require.cache[require.resolve("../../lib/services/alerts/engine")];
  delete require.cache[require.resolve("../../lib/services/alerts/alert-rules-store")];
  delete require.cache[require.resolve("../../lib/services/alerts/alert-store")];

  const healthChecksRouter = require("../../lib/routes/health-checks");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/health-checks", healthChecksRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/api/health-checks` };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const HC_USER = {
  id: 3,
  isAdmin: false,
  permissions: [
    { appName: "*", action: "health_checks_read" },
    { appName: "*", action: "health_checks_create" },
    { appName: "*", action: "health_checks_update" },
    { appName: "*", action: "health_checks_test" },
  ],
};

const VALID_HTTP_CHECK = {
  name: "API principale",
  type: "http",
  url: "http://127.0.0.1:1/health", // port improbable : connexion refusée rapide, pas de vrai réseau externe
  method: "GET",
  expectedStatus: "200-299",
  timeoutMs: 500,
  intervalSeconds: 30,
};

test("API /api/health-checks", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("admin : crée un health check HTTP (201) puis le liste (200)", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const created = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_HTTP_CHECK),
      });
      assert.equal(created.status, 201);
      const body = await created.json();
      assert.equal(body.name, "API principale");
      assert.equal(body.status, "UNKNOWN", "statut initial avant toute exécution");
      assert.equal(body.type, "http");

      const listed = await fetch(baseUrl);
      assert.equal(listed.status, 200);
      const list = await listed.json();
      assert.equal(list.length, 1);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("validation : type manquant / invalide -> 400", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "sans type" }),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("validation : type tcp sans host/port -> 400", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "tcp incomplet", type: "tcp" }),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("sans permission -> 403 sur toutes les routes", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      const list = await fetch(baseUrl);
      assert.equal(list.status, 403);

      const create = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_HTTP_CHECK),
      });
      assert.equal(create.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  let checkId;
  await t.test("utilisateur avec health_checks_create : crée un check TCP", async () => {
    const { server, baseUrl } = await startServer(HC_USER);
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Base de données",
          type: "tcp",
          host: "127.0.0.1",
          port: 1, // port improbable : DOWN attendu, sans dépendre d'un service externe
          timeoutMs: 300,
          intervalSeconds: 30,
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      checkId = body.id;
    } finally {
      await stopServer(server);
    }
  });

  await t.test("run test (TCP, connexion refusée) -> DOWN, persisté", async () => {
    const { server, baseUrl } = await startServer(HC_USER);
    try {
      const res = await fetch(`${baseUrl}/${checkId}/test`, { method: "POST" });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, "DOWN");
      assert.equal(body.consecutiveFailures, 1);

      const refetch = await fetch(`${baseUrl}/${checkId}`);
      const persisted = await refetch.json();
      assert.equal(persisted.status, "DOWN");
      assert.ok(persisted.lastCheckAt, "lastCheckAt renseigné après exécution");
      assert.ok(persisted.lastFailureAt, "lastFailureAt renseigné après un échec");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("run test sans permission health_checks_test -> 403", async () => {
    const readOnlyUser = {
      id: 4,
      isAdmin: false,
      permissions: [{ appName: "*", action: "health_checks_read" }],
    };
    const { server, baseUrl } = await startServer(readOnlyUser);
    try {
      const res = await fetch(`${baseUrl}/${checkId}/test`, { method: "POST" });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("enable/disable", async () => {
    const { server, baseUrl } = await startServer(HC_USER);
    try {
      const disabled = await fetch(`${baseUrl}/${checkId}/disable`, { method: "POST" });
      assert.equal(disabled.status, 200);
      let body = await disabled.json();
      assert.equal(body.enabled, false);

      const enabled = await fetch(`${baseUrl}/${checkId}/enable`, { method: "POST" });
      body = await enabled.json();
      assert.equal(body.enabled, true);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("run test sur un check désactivé -> 404", async () => {
    const { server, baseUrl } = await startServer(HC_USER);
    try {
      await fetch(`${baseUrl}/${checkId}/disable`, { method: "POST" });
      const res = await fetch(`${baseUrl}/${checkId}/test`, { method: "POST" });
      assert.equal(res.status, 404);
      await fetch(`${baseUrl}/${checkId}/enable`, { method: "POST" });
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /status/summary — vue condensée", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/status/summary`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body));
      assert.ok(body.every((c) => "status" in c && "lastCheckAt" in c && "lastResponseTimeMs" in c));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /catalog — types/méthodes/statuts valides", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/catalog`);
      const body = await res.json();
      assert.deepEqual(body.types, ["http", "tcp", "command"]);
      assert.ok(
        body.statuses.includes("UP") && body.statuses.includes("DOWN") && body.statuses.includes("DEGRADED"),
      );
    } finally {
      await stopServer(server);
    }
  });

  await t.test("update -> 404 si introuvable", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/999999`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      assert.equal(res.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("delete -> 200 puis 404 sur re-suppression", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/${checkId}`, { method: "DELETE" });
      assert.equal(res.status, 200);
      const again = await fetch(`${baseUrl}/${checkId}`, { method: "DELETE" });
      assert.equal(again.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await cleanupDb(dbCtx);
});
