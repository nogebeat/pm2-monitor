"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Tests d'intégration — scope "servers:read" et resourceScopes.servers
 * (Phase 18 suite — résolution du problème connu "scope serveur non
 * enforcé"). Monte le vrai routeur lib/routes/servers.js avec une DB SQLite
 * réelle, comme test/integration/api-keys-api.test.js. agentHub est stubé
 * (pas de socket réel nécessaire pour ces routes) — même esprit que le stub
 * minimal déjà utilisé ailleurs dans ce projet pour les dépendances injectées.
 */
async function startServer() {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  for (const mod of ["../../lib/auth", "../../lib/routes/servers", "../../lib/permissions"]) {
    delete require.cache[require.resolve(mod)];
  }
  const auth = require("../../lib/auth");
  const createServersRouter = require("../../lib/routes/servers");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = null;
    next();
  });
  app.use(auth.loadApiKeyAuth);
  app.use(auth.requireAuth);
  app.use("/api/servers", createServersRouter({ agentHub: { isOnline: () => false } }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/api/servers` };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function authHeader(key) {
  return { Authorization: `Bearer ${key}` };
}

test("Clés API M2M — scope servers:read et resourceScopes.servers", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();
  const apiKeysStore = require("../../lib/services/api-keys/store");
  const serversStore = require("../../lib/services/servers/store");

  const { server: srvA } = await serversStore.create({ name: "srv-a", hostname: "a.example.com" });
  const { server: srvB } = await serversStore.create({ name: "srv-b", hostname: "b.example.com" });

  await t.test("sans scope servers:read -> 403 sur la liste", async () => {
    const { secret } = await apiKeysStore.create({ name: "Sans servers:read", scopes: ["metrics:read"] });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(baseUrl, { headers: authHeader(secret) });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("avec servers:read, sans resourceScopes.servers -> liste tous les serveurs (+ local)", async () => {
    const { secret } = await apiKeysStore.create({ name: "Tous serveurs", scopes: ["servers:read"] });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(baseUrl, { headers: authHeader(secret) });
      assert.equal(res.status, 200);
      const list = await res.json();
      const keys = list.map((s) => s.serverKey);
      assert.ok(keys.includes(srvA.serverKey));
      assert.ok(keys.includes(srvB.serverKey));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("avec resourceScopes.servers : la liste est filtrée", async () => {
    const { secret } = await apiKeysStore.create({
      name: "Un seul serveur",
      scopes: ["servers:read"],
      resourceScopes: { servers: [srvA.serverKey] },
    });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(baseUrl, { headers: authHeader(secret) });
      const list = await res.json();
      const keys = list.map((s) => s.serverKey);
      assert.ok(keys.includes(srvA.serverKey));
      assert.equal(keys.includes(srvB.serverKey), false);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /:key/status : requireServerAccess refuse un serverKey hors resourceScopes.servers", async () => {
    const { secret } = await apiKeysStore.create({
      name: "Scopée srv-a",
      scopes: ["servers:read"],
      resourceScopes: { servers: [srvA.serverKey] },
    });
    const { server, baseUrl } = await startServer();
    try {
      const allowed = await fetch(`${baseUrl}/${srvA.serverKey}/status`, { headers: authHeader(secret) });
      assert.equal(allowed.status, 200);
      const denied = await fetch(`${baseUrl}/${srvB.serverKey}/status`, { headers: authHeader(secret) });
      assert.equal(denied.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("scope insuffisant pour /:key/status (pas de servers:read du tout) -> 403", async () => {
    const { secret } = await apiKeysStore.create({ name: "Logs uniquement", scopes: ["logs:read"] });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/${srvA.serverKey}/status`, { headers: authHeader(secret) });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await cleanupDb(dbCtx);
});
