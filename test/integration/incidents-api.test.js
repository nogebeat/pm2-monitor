"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur d'incidents (lib/routes/incidents.js) sur un serveur
 * HTTP réel, avec une DB SQLite temporaire migrée — même approche que
 * test/integration/alerts-api.test.js et test/integration/process-organization-api.test.js :
 * `req.user` injecté directement (pas de session complète), pour couvrir les
 * routes, le contrat store <-> DB et lib/auth.js#requirePermission (donc
 * lib/permissions.js) sans dépendre du flow de login.
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0"; // auth ACTIVÉE : on veut tester incidents_read/incidents_manage
  for (const mod of [
    "../../lib/auth",
    "../../lib/routes/incidents",
    "../../lib/services/incidents",
    "../../lib/services/incidents/incident-store",
    "../../lib/services/incidents/silence-store",
    "../../lib/services/incidents/timeline-store",
    "../../lib/services/incidents/correlation",
    "../../lib/services/audit",
  ]) {
    delete require.cache[require.resolve(mod)];
  }

  const incidentsRouter = require("../../lib/routes/incidents");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/incidents", incidentsRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/incidents`;
  return { server, baseUrl };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true, username: "admin" };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const READ_ONLY_USER = {
  id: 3,
  isAdmin: false,
  username: "viewer",
  permissions: [{ appName: "*", action: "incidents_read" }],
};
const MANAGER_USER = {
  id: 4,
  isAdmin: false,
  username: "oncall",
  permissions: [
    { appName: "*", action: "incidents_read" },
    { appName: "*", action: "incidents_manage" },
  ],
};

test("API /api/incidents", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  // Un incident créé directement via le store (pas de dépendance à l'Alert
  // Engine réel dans ce fichier — la corrélation elle-même est déjà testée
  // dans test/unit/incidents.test.js) pour exercer les routes de détail/
  // transition/timeline.
  const incidentStore = require("../../lib/services/incidents/incident-store");
  let incidentId;

  await t.test("sans permission incidents_read : 403", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      const res = await fetch(`${baseUrl}/`);
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("admin : GET /api/incidents liste (200), vide au départ", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.items, []);
      assert.equal(body.total, 0);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /api/incidents/catalog (200) — états et types de scope", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      const res = await fetch(`${baseUrl}/catalog`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.states, ["OPEN", "ACKNOWLEDGED", "INVESTIGATING", "MITIGATED", "RESOLVED"]);
      assert.ok(body.silenceScopeTypes.includes("process"));
      assert.ok(body.silenceTypes.includes("duration"));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("setup : incident créé via le store pour les tests de détail/transition", async () => {
    const incident = await incidentStore.create({
      title: "CPU haut — api-prod",
      severity: "warning",
      targetType: "process",
      targetValue: "api-prod",
      metric: "cpu",
      correlationKey: "process:api-prod:cpu",
      firstAlertId: 1,
    });
    incidentId = incident.id;
    assert.ok(incidentId);
  });

  await t.test("GET /api/incidents/:id (200) inclut alertIds", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      const res = await fetch(`${baseUrl}/${incidentId}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.id, incidentId);
      assert.equal(body.status, "OPEN");
      assert.ok(Array.isArray(body.alertIds));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /api/incidents/:id inconnu -> 404", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      const res = await fetch(`${baseUrl}/999999`);
      assert.equal(res.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /api/incidents/:id/timeline (200) — tableau, même vide", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      const res = await fetch(`${baseUrl}/${incidentId}/timeline`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("lecture seule : POST acknowledge refusé (403)", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      const res = await fetch(`${baseUrl}/${incidentId}/acknowledge`, { method: "POST" });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("manager : POST acknowledge (200) — transition + timeline + audit", async () => {
    const { server, baseUrl } = await startServer(MANAGER_USER);
    try {
      const res = await fetch(`${baseUrl}/${incidentId}/acknowledge`, { method: "POST" });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, "ACKNOWLEDGED");
      assert.ok(body.acknowledgedAt);
      assert.equal(body.acknowledgedBy, MANAGER_USER.id);

      const timelineRes = await fetch(`${baseUrl}/${incidentId}/timeline`);
      const timeline = await timelineRes.json();
      assert.ok(timeline.some((e) => e.type === "acknowledge"));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("manager : transition invalide (OPEN direct après ACKNOWLEDGED) -> 400", async () => {
    const { server, baseUrl } = await startServer(MANAGER_USER);
    try {
      // L'incident est déjà ACKNOWLEDGED : investigate -> mitigate -> resolve est le chemin valide.
      const res = await fetch(`${baseUrl}/${incidentId}/resolve`, { method: "POST" });
      assert.equal(res.status, 200); // ACKNOWLEDGED -> RESOLVED est autorisé (voir ALLOWED_TRANSITIONS)
      const body = await res.json();
      assert.equal(body.status, "RESOLVED");

      // RESOLVED est terminal : nouvelle transition refusée.
      const second = await fetch(`${baseUrl}/${incidentId}/acknowledge`, { method: "POST" });
      assert.equal(second.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  // --- Silences ------------------------------------------------------------

  let silenceId;

  await t.test("manager : POST /silences (durée) -> 201", async () => {
    const { server, baseUrl } = await startServer(MANAGER_USER);
    try {
      const res = await fetch(`${baseUrl}/silences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scopeType: "process",
          scopeValue: "api-prod",
          silenceType: "duration",
          durationMinutes: 30,
          reason: "Maintenance planifiée",
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.ok(body.id);
      assert.equal(body.scopeType, "process");
      assert.equal(body.active, true);
      silenceId = body.id;
    } finally {
      await stopServer(server);
    }
  });

  await t.test("manager : POST /silences (jusqu'à une date) -> 201", async () => {
    const { server, baseUrl } = await startServer(MANAGER_USER);
    try {
      const until = new Date(Date.now() + 3600_000).toISOString();
      const res = await fetch(`${baseUrl}/silences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopeType: "tag", scopeValue: "prod", silenceType: "until", until }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.scopeType, "tag");
      assert.equal(body.silenceType, "until");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("POST /silences invalide (scopeType inconnu) -> 400", async () => {
    const { server, baseUrl } = await startServer(MANAGER_USER);
    try {
      const res = await fetch(`${baseUrl}/silences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopeType: "bogus", scopeValue: "x", durationMinutes: 10 }),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("lecture seule : GET /silences autorisé, POST refusé", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      const list = await fetch(`${baseUrl}/silences`);
      assert.equal(list.status, 200);
      const items = await list.json();
      assert.ok(items.length >= 2);

      const create = await fetch(`${baseUrl}/silences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopeType: "process", scopeValue: "x", durationMinutes: 10 }),
      });
      assert.equal(create.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("manager : DELETE /silences/:id annule (200), n'apparaît plus dans activeOnly", async () => {
    const { server, baseUrl } = await startServer(MANAGER_USER);
    try {
      const del = await fetch(`${baseUrl}/silences/${silenceId}`, { method: "DELETE" });
      assert.equal(del.status, 200);
      const cancelled = await del.json();
      assert.equal(cancelled.active, false);

      const activeList = await fetch(`${baseUrl}/silences?active=1`);
      const active = await activeList.json();
      assert.ok(!active.some((s) => s.id === silenceId));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("DELETE /silences/:id inconnu -> 404", async () => {
    const { server, baseUrl } = await startServer(MANAGER_USER);
    try {
      const res = await fetch(`${baseUrl}/silences/999999`, { method: "DELETE" });
      assert.equal(res.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await cleanupDb(dbCtx);
});
