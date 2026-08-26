"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur de la carte de dépendances
 * (lib/routes/service-dependencies.js) sur un serveur HTTP réel, avec une DB
 * SQLite temporaire migrée — même approche que
 * test/integration/anomaly-detection-api.test.js.
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/service-dependencies")];
  delete require.cache[require.resolve("../../lib/services/service-dependencies")];
  delete require.cache[require.resolve("../../lib/services/service-dependencies/store")];
  delete require.cache[require.resolve("../../lib/services/service-dependencies/status")];
  delete require.cache[require.resolve("../../lib/services/service-dependencies/graph")];

  const depsRouter = require("../../lib/routes/service-dependencies");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/service-dependencies", depsRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/service-dependencies`;
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
  permissions: [{ appName: "*", action: "dependencies_read" }],
};

test("API /api/service-dependencies", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("admin : crée une dépendance (201) puis la liste (200)", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const created = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "API", target: "PostgreSQL", type: "DATABASE" }),
      });
      assert.equal(created.status, 201);
      const dep = await created.json();
      assert.equal(dep.source, "API");
      assert.ok(dep.id);

      const listed = await fetch(baseUrl);
      assert.equal(listed.status, 200);
      const items = await listed.json();
      assert.ok(items.some((d) => d.id === dep.id));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("création : validation rejetée avec 400 (type invalide)", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "A", target: "B", type: "FTP" }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /type invalide/);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("création : cycle rejeté avec 400", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "Frontend", target: "API3", type: "HTTP" }),
      });
      await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "API3", target: "PostgreSQL3", type: "DATABASE" }),
      });
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "PostgreSQL3", target: "Frontend", type: "CUSTOM" }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /cycle/);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("lecture seule : accès GET ok, POST refusé (403)", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      const listed = await fetch(baseUrl);
      assert.equal(listed.status, 200);

      const created = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "X", target: "Y", type: "CUSTOM" }),
      });
      assert.equal(created.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("sans permission : GET aussi refusé (403)", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("update()/enable()/disable()/delete() : cycle complet", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const created = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "Svc1", target: "Svc2", type: "CUSTOM" }),
      });
      const dep = await created.json();

      const updated = await fetch(`${baseUrl}/${dep.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "lien important" }),
      });
      assert.equal(updated.status, 200);
      assert.equal((await updated.json()).description, "lien important");

      const disabled = await fetch(`${baseUrl}/${dep.id}/disable`, { method: "POST" });
      assert.equal((await disabled.json()).enabled, false);

      const enabled = await fetch(`${baseUrl}/${dep.id}/enable`, { method: "POST" });
      assert.equal((await enabled.json()).enabled, true);

      const deleted = await fetch(`${baseUrl}/${dep.id}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);

      const gone = await fetch(`${baseUrl}/${dep.id}`);
      assert.equal(gone.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /catalog renvoie la liste des types", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/catalog`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.types.includes("HTTP"));
      assert.ok(body.types.includes("DATABASE"));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /graph renvoie nœuds + arêtes avec statut", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "GraphA", target: "GraphB", type: "CUSTOM" }),
      });
      const res = await fetch(`${baseUrl}/graph`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.nodes.some((n) => n.name === "GraphA"));
      assert.ok(body.edges.some((e) => e.source === "GraphA" && e.target === "GraphB"));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /impact/:service avec assumeDown=1 liste les dépendants", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "ImpactConsumer", target: "ImpactTarget", type: "CUSTOM" }),
      });
      const res = await fetch(`${baseUrl}/impact/ImpactTarget?assumeDown=1`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, "DOWN");
      assert.deepEqual(
        body.potentiallyAffected.map((a) => a.name),
        ["ImpactConsumer"],
      );
    } finally {
      await stopServer(server);
    }
  });

  t.after(() => cleanupDb(dbCtx));
});
