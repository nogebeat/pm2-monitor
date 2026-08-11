"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur d'alertes (lib/routes/alerts.js) sur un serveur HTTP
 * réel, avec une DB SQLite temporaire migrée. On injecte `req.user`
 * directement (au lieu de passer par express-session/login complet) pour
 * garder le test rapide et ciblé sur ce qu'il doit couvrir : les routes, le
 * contrat alertsEngine <-> alertStore <-> DB, et lib/auth.js#requirePermission
 * (donc lib/permissions.js) — pas le flow de session.
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0"; // auth ACTIVÉE : on veut tester les permissions
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/alerts")];
  delete require.cache[require.resolve("../../lib/services/alerts")];
  delete require.cache[require.resolve("../../lib/services/alerts/engine")];
  delete require.cache[require.resolve("../../lib/services/alerts/alert-store")];
  delete require.cache[require.resolve("../../lib/services/alerts/alert-rules-store")];

  const alertsRouter = require("../../lib/routes/alerts");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/alerts", alertsRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/alerts`;
  return { server, baseUrl };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const ALERTS_USER = {
  id: 3,
  isAdmin: false,
  permissions: [
    { appName: "*", action: "alerts_read" },
    { appName: "*", action: "alerts_create" },
    { appName: "*", action: "alerts_acknowledge" },
  ],
};

const VALID_RULE = {
  name: "CPU haut",
  targetType: "process",
  targetValue: "*",
  metric: "cpu",
  operator: ">",
  threshold: 80,
  durationSeconds: 300,
  severity: "warning",
  cooldownSeconds: 1800,
};

test("API /api/alerts", async (t) => {
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
      assert.equal(rule.name, "CPU haut");
      assert.ok(rule.id);

      const listed = await fetch(`${baseUrl}/rules`);
      assert.equal(listed.status, 200);
      const rules = await listed.json();
      assert.ok(rules.some((r) => r.id === rule.id));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("payload invalide -> 400", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }), // targetType/metric/operator/threshold manquants
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("utilisateur sans permission alerts_create -> 403", async () => {
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

  await t.test("utilisateur sans permission alerts_read -> 403 sur GET /rules et /active", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      assert.equal((await fetch(`${baseUrl}/rules`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/active`)).status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("utilisateur avec alerts_read uniquement -> 200 en lecture, 403 en update/delete", async () => {
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

    const { server: server2, baseUrl: baseUrl2 } = await startServer(ALERTS_USER);
    try {
      assert.equal((await fetch(`${baseUrl2}/rules`)).status, 200);
      const del = await fetch(`${baseUrl2}/rules/${ruleId}`, { method: "DELETE" });
      assert.equal(del.status, 403, "ALERTS_USER n'a pas alerts_delete");
    } finally {
      await stopServer(server2);
    }
  });

  await t.test("règle inconnue -> 404", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/rules/999999`);
      assert.equal(res.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("catalogue exposé pour construire un formulaire", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/catalog`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.targetTypes.includes("process"));
      assert.ok(body.operators.includes(">"));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("cycle complet : évaluation via l'engine puis ACK via l'API", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    let ruleId;
    try {
      const created = await fetch(`${baseUrl}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...VALID_RULE, durationSeconds: 0 }),
      });
      ruleId = (await created.json()).id;
    } finally {
      await stopServer(server);
    }

    // Simule 2 ticks d'évaluation (trigger, puis active) directement via le service partagé.
    const { engine, ruleStore } = require("../../lib/services/alerts");
    const rule = await ruleStore.getById(ruleId);
    await engine.evaluate(rule, "api", 90);
    await engine.evaluate(rule, "api", 91);

    const { server: server2, baseUrl: baseUrl2 } = await startServer(ALERTS_USER);
    try {
      const activeRes = await fetch(`${baseUrl2}/active`);
      const active = await activeRes.json();
      assert.equal(active.length, 1);
      assert.equal(active[0].state, "active");

      const ackRes = await fetch(`${baseUrl2}/${active[0].id}/acknowledge`, { method: "POST" });
      assert.equal(ackRes.status, 200);
      const acked = await ackRes.json();
      assert.equal(acked.state, "acknowledged");
    } finally {
      await stopServer(server2);
    }
  });

  await cleanupDb(dbCtx);
  delete process.env.PM2_MONITOR_DISABLE_AUTH;
});
