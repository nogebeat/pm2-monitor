"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur de détection d'anomalies (lib/routes/anomaly-detection.js)
 * sur un serveur HTTP réel, avec une DB SQLite temporaire migrée — même
 * approche que test/integration/alerts-api.test.js.
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/anomaly-detection")];
  delete require.cache[require.resolve("../../lib/services/anomaly-detection")];
  delete require.cache[require.resolve("../../lib/services/anomaly-detection/rules-store")];
  delete require.cache[require.resolve("../../lib/services/anomaly-detection/detections-store")];

  const anomalyRouter = require("../../lib/routes/anomaly-detection");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/anomaly-detection", anomalyRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/anomaly-detection`;
  return { server, baseUrl };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const READ_ONLY_USER = {
  id: 3,
  isAdmin: false,
  permissions: [{ appName: "*", action: "anomaly_read" }],
};

const VALID_RULE = {
  name: "CPU anormal",
  targetType: "process",
  targetValue: "*",
  metric: "cpu",
  sensitivity: 3,
  windowMs: 24 * 60 * 60 * 1000,
  minSamples: 10,
  cooldownSeconds: 900,
  severity: "warning",
};

test("API /api/anomaly-detection", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("admin : crée une règle (201) puis la liste (200)", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const created = await fetch(`${baseUrl}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_RULE),
      });
      assert.equal(created.status, 201);
      const rule = await created.json();
      assert.equal(rule.name, "CPU anormal");
      assert.ok(rule.id);
      assert.equal(rule.sensitivity, 3);

      const listed = await fetch(`${baseUrl}/rules`);
      assert.equal(listed.status, 200);
      const rules = await listed.json();
      assert.ok(rules.some((r) => r.id === rule.id));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("payload invalide (métrique interdite pour ce targetType) -> 400", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...VALID_RULE, targetType: "system", metric: "restart_rate" }),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("utilisateur sans permission anomaly_create -> 403", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      const res = await fetch(`${baseUrl}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_RULE),
      });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("utilisateur sans permission anomaly_read -> 403 sur GET /rules et /catalog", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      assert.equal((await fetch(`${baseUrl}/rules`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/catalog`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/detections`)).status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /catalog expose les métriques valides par type de cible", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/catalog`);
      assert.equal(res.status, 200);
      const catalog = await res.json();
      assert.deepEqual(catalog.targetTypes.sort(), ["process", "system"]);
      assert.ok(catalog.metricsByTargetType.process.includes("cpu"));
      assert.ok(catalog.metricsByTargetType.system.includes("cpu"));
      assert.ok(!catalog.metricsByTargetType.system.includes("restart_rate"));
    } finally {
      await stopServer(server);
    }
  });

  await t.test(
    "utilisateur avec anomaly_read uniquement -> 200 en lecture, 403 en update/delete",
    async () => {
      const { server, baseUrl } = await startServer(ADMIN);
      let ruleId;
      try {
        const created = await fetch(`${baseUrl}/rules`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(VALID_RULE),
        });
        ruleId = (await created.json()).id;
      } finally {
        await stopServer(server);
      }

      const { server: server2, baseUrl: baseUrl2 } = await startServer(READ_ONLY_USER);
      try {
        assert.equal((await fetch(`${baseUrl2}/rules`)).status, 200);
        const del = await fetch(`${baseUrl2}/rules/${ruleId}`, { method: "DELETE" });
        assert.equal(del.status, 403, "READ_ONLY_USER n'a pas anomaly_delete");
        const disable = await fetch(`${baseUrl2}/rules/${ruleId}/disable`, { method: "POST" });
        assert.equal(disable.status, 403, "READ_ONLY_USER n'a pas anomaly_update");
      } finally {
        await stopServer(server2);
      }
    },
  );

  await t.test("admin : enable/disable une règle", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const created = await fetch(`${baseUrl}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_RULE),
      });
      const { id } = await created.json();

      const disabled = await fetch(`${baseUrl}/rules/${id}/disable`, { method: "POST" });
      assert.equal(disabled.status, 200);
      assert.equal((await disabled.json()).enabled, false);

      const enabled = await fetch(`${baseUrl}/rules/${id}/enable`, { method: "POST" });
      assert.equal(enabled.status, 200);
      assert.equal((await enabled.json()).enabled, true);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("admin : supprime une règle -> 404 ensuite", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const created = await fetch(`${baseUrl}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_RULE),
      });
      const { id } = await created.json();

      const del = await fetch(`${baseUrl}/rules/${id}`, { method: "DELETE" });
      assert.equal(del.status, 200);

      const getAfter = await fetch(`${baseUrl}/rules/${id}`);
      assert.equal(getAfter.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /detections -> liste paginée vide sur une base neuve", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/detections`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.items, []);
      assert.equal(body.total, 0);
    } finally {
      await stopServer(server);
    }
  });

  t.after(async () => {
    await cleanupDb(dbCtx);
  });
});
