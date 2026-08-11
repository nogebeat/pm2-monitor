"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur d'événements (lib/routes/events.js) sur un serveur
 * HTTP réel, avec une DB SQLite temporaire migrée et un vrai EventsService.
 * `req.user` est injecté directement (au lieu de passer par express-session)
 * pour rester focalisé sur les routes, le contrat service <-> DB, et
 * lib/auth.js#requirePermission — même approche que
 * test/integration/alerts-api.test.js.
 */
async function startServer(userForRequest, envOverrides = {}) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0"; // auth ACTIVÉE : on veut tester les permissions
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/events")];
  delete require.cache[require.resolve("../../lib/services/events")];
  delete require.cache[require.resolve("../../lib/services/events/event-store")];

  const auth = require("../../lib/auth");
  const eventsRouter = require("../../lib/routes/events");
  const { EventsService } = require("../../lib/services/events");
  const eventsService = new EventsService({ EVENTS_ENABLED: "1", ...envOverrides });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/events", eventsRouter(eventsService));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/events`;
  return { server, baseUrl, eventsService, auth };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const EVENTS_USER = { id: 3, isAdmin: false, permissions: [{ appName: "*", action: "events_read" }] };

function packet(event, process = {}) {
  return { event, process: { name: "api", pm_id: 0, status: "online", restart_time: 0, ...process } };
}

test("API /api/events", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("utilisateur sans permission events_read -> 403", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      assert.equal((await fetch(baseUrl)).status, 403);
      assert.equal((await fetch(`${baseUrl}/catalog`)).status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("admin : liste vide au départ -> 200, tableau vide, pagination présente", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.items, []);
      assert.equal(body.total, 0);
      assert.ok(typeof body.limit === "number");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("cycle complet : recordFromPacket() via le service, puis lecture via l'API", async () => {
    const { server, baseUrl, eventsService } = await startServer(EVENTS_USER);
    try {
      await eventsService.recordFromPacket(packet("start", { name: "web" }), 1_000_000);
      await eventsService.recordFromPacket(packet("exit", { name: "web", exit_code: 1 }), 1_000_100);

      const res = await fetch(`${baseUrl}?process=web`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.items.length, 2);
      assert.equal(body.total, 2);
      // Tri du plus récent au plus ancien
      assert.equal(body.items[0].type, "crashed");
      assert.equal(body.items[1].type, "started");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("filtre par type et severity via query string", async () => {
    const { server, baseUrl, eventsService } = await startServer(EVENTS_USER);
    try {
      await eventsService.recordFromPacket(packet("start", { name: "worker" }), 2_000_000);
      await eventsService.recordFromPacket(packet("restart", { name: "worker" }), 2_000_100);

      const byType = await fetch(`${baseUrl}?process=worker&type=restarted`);
      const byTypeBody = await byType.json();
      assert.equal(byTypeBody.items.length, 1);
      assert.equal(byTypeBody.items[0].type, "restarted");

      const bySeverity = await fetch(`${baseUrl}?process=worker&severity=warning`);
      const bySeverityBody = await bySeverity.json();
      assert.equal(bySeverityBody.items.length, 1);
      assert.equal(bySeverityBody.items[0].severity, "warning");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("type invalide -> 400", async () => {
    const { server, baseUrl } = await startServer(EVENTS_USER);
    try {
      const res = await fetch(`${baseUrl}?type=bogus`);
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("severity invalide -> 400", async () => {
    const { server, baseUrl } = await startServer(EVENTS_USER);
    try {
      const res = await fetch(`${baseUrl}?severity=bogus`);
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("catalogue exposé pour construire les filtres côté frontend", async () => {
    const { server, baseUrl } = await startServer(EVENTS_USER);
    try {
      const res = await fetch(`${baseUrl}/catalog`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.types.includes("crashed"));
      assert.ok(body.severities.includes("critical"));
      assert.equal(body.severityByType.crashed, "critical");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("pagination : limit/offset respectés dans la réponse", async () => {
    const { server, baseUrl, eventsService } = await startServer(EVENTS_USER);
    try {
      for (let i = 0; i < 4; i++) {
        await eventsService.recordFromPacket(packet("restart", { name: "paged" }), 3_000_000 + i);
      }
      const res = await fetch(`${baseUrl}?process=paged&limit=2&offset=1`);
      const body = await res.json();
      assert.equal(body.items.length, 2);
      assert.equal(body.total, 4);
      assert.equal(body.limit, 2);
      assert.equal(body.offset, 1);
    } finally {
      await stopServer(server);
    }
  });

  await cleanupDb(dbCtx);
  delete process.env.PM2_MONITOR_DISABLE_AUTH;
});
