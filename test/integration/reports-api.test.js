"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur de rapports (lib/routes/reports.js) sur un serveur
 * HTTP réel — même pattern que test/integration/alerts-api.test.js.
 * `pm2`/`fmtProcess`/`visibleProcesses` sont de simples doublures (aucun
 * PM2 réel dans les tests) : seul `processHistory.pickResolution` doit se
 * comporter comme le vrai service (Phase 11).
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/reports")];

  const reportsRouter = require("../../lib/routes/reports");

  const fakePm2 = { list: (cb) => cb(null, []) };
  const fakeProcessHistory = { pickResolution: () => "raw" };

  const app = express();
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use(
    "/api/reports",
    reportsRouter({
      pm2: fakePm2,
      fmtProcess: (p) => p,
      visibleProcesses: (user, list) => list,
      processHistory: fakeProcessHistory,
    }),
  );

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/api/reports` };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const REPORTS_USER = { id: 3, isAdmin: false, permissions: [{ appName: "*", action: "reports_read" }] };

test("API /api/reports", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("sans permission reports_read -> 403", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      assert.equal((await fetch(`${baseUrl}/`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/export`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/catalog`)).status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("admin : GET / retourne un rapport daily par défaut", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/`);
      assert.equal(res.status, 200);
      const report = await res.json();
      assert.equal(report.period.period, "daily");
      assert.ok(report.summary);
      assert.ok(Array.isArray(report.processes));
      assert.ok(report.ranking);
      assert.ok("capacityPlanning" in report);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("reports_read : filtres period=custom + start/end explicites", async () => {
    const { server, baseUrl } = await startServer(REPORTS_USER);
    try {
      const now = Date.now();
      const res = await fetch(`${baseUrl}/?period=custom&start=${now - 86400000}&end=${now}`);
      assert.equal(res.status, 200);
      const report = await res.json();
      assert.equal(report.period.period, "custom");
      assert.equal(report.period.end, now);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("period invalide -> 400", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/?period=yearly`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /export?format=csv retourne un CSV téléchargeable", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/export?format=csv&period=weekly`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /text\/csv/);
      assert.match(res.headers.get("content-disposition"), /attachment; filename="report\.csv"/);
      const body = await res.text();
      assert.match(body, /^process,server,availability_percent/);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /export?format=json retourne le rapport complet en JSON", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/export?format=json&period=monthly`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /application\/json/);
      const parsed = JSON.parse(await res.text());
      assert.equal(parsed.period.period, "monthly");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /export?format=xml -> 400 (format non supporté)", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/export?format=xml`);
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /catalog liste les périodes/formats/critères disponibles", async () => {
    const { server, baseUrl } = await startServer(REPORTS_USER);
    try {
      const res = await fetch(`${baseUrl}/catalog`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.periods, ["daily", "weekly", "monthly", "custom"]);
      assert.deepEqual(body.formats.sort(), ["csv", "json"]);
    } finally {
      await stopServer(server);
    }
  });

  await cleanupDb(dbCtx);
  delete process.env.PM2_MONITOR_DISABLE_AUTH;
});
