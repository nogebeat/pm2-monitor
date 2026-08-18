"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const migrator = require("../../lib/db/migrator");

/**
 * Monte le vrai routeur (lib/routes/dashboard.js) sur un serveur HTTP réel,
 * avec une vraie DB SQLite migrée — même approche que
 * test/integration/auto-healing-api.test.js. `pm2`/`fmtProcess`/
 * `visibleProcesses`/`getSystemSnapshot` sont des fakes (aucun vrai PM2 ni
 * vraie lecture système ici, seule la composition + les permissions sont
 * testées ; le calcul lui-même est couvert par
 * test/unit/global-status.test.js et test/unit/dashboard-snapshot.test.js).
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/dashboard")];

  const dashboardRouter = require("../../lib/routes/dashboard");
  const alertStore = require("../../lib/services/alerts/alert-store");
  const healthChecksStore = require("../../lib/services/health-checks/store");
  const eventsStore = require("../../lib/services/events/event-store");
  const autoHealingAuditStore = require("../../lib/services/auto-healing/audit-store");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use(
    "/api/dashboard",
    dashboardRouter({
      pm2: {
        list: (cb) =>
          cb(null, [{ pm_id: 0, name: "api", pm2_env: { status: "online" }, monit: { cpu: 1, memory: 2 } }]),
      },
      fmtProcess: (p) => ({ id: p.pm_id, name: p.name, status: p.pm2_env.status }),
      visibleProcesses: (user, list) => list,
      getSystemSnapshot: () => ({ cpu: 5, mem: { percent: 5 }, disk: { percent: 5 } }),
      alertStore,
      healthChecksStore,
      eventsStore,
      autoHealingAuditStore,
    }),
  );

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/api/dashboard` };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const SYSTEM_ONLY_USER = { id: 3, isAdmin: false, permissions: [{ appName: "*", action: "system" }] };
const FULL_USER = {
  id: 4,
  isAdmin: false,
  permissions: [
    { appName: "*", action: "system" },
    { appName: "*", action: "alerts_read" },
    { appName: "*", action: "health_checks_read" },
    { appName: "*", action: "events_read" },
    { appName: "*", action: "authealing_read" },
  ],
};

test("GET /api/dashboard", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test('sans la permission "system" -> 403', async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test(
    'avec seulement "system" -> 200, processes/globalStatus présents, sections annexes à null',
    async () => {
      const { server, baseUrl } = await startServer(SYSTEM_ONLY_USER);
      try {
        const res = await fetch(baseUrl);
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.ok(["HEALTHY", "WARNING", "CRITICAL"].includes(body.globalStatus));
        assert.equal(body.processes.overview.total, 1);
        assert.equal(body.alerts, null);
        assert.equal(body.healthChecks, null);
        assert.deepEqual(body.recentTimeline, []);
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test("avec toutes les permissions annexes -> sections alerts/healthChecks présentes", async () => {
    const { server, baseUrl } = await startServer(FULL_USER);
    try {
      const res = await fetch(baseUrl);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.notEqual(body.alerts, null);
      assert.notEqual(body.healthChecks, null);
    } finally {
      await stopServer(server);
    }
  });

  await t.test(
    "admin -> 200 sans permission explicite (isAdmin bypass, cohérent avec le reste de l'app)",
    async () => {
      const { server, baseUrl } = await startServer(ADMIN);
      try {
        const res = await fetch(baseUrl);
        assert.equal(res.status, 200);
      } finally {
        await stopServer(server);
      }
    },
  );

  await cleanupDb(dbCtx);
});
