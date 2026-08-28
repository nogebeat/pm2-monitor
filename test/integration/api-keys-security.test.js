"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Tests de sécurité bout-en-bout pour les clés API M2M (Phase 18 — Advanced
 * RBAC & API Keys), demandés explicitement par le prompt de phase : clé
 * invalide / expirée / révoquée / scope insuffisant / scope suffisant /
 * absence du secret dans logs-erreurs-API / permissions utilisateur
 * inchangées.
 *
 * Contrairement aux autres tests d'intégration de ce projet (qui injectent
 * req.user directement), celui-ci monte le VRAI enchaînement de middlewares
 * (lib/auth.js#loadApiKeyAuth -> requireAuth -> requirePermission) pour
 * vérifier le comportement réellement exposé par server.js à une requête
 * `Authorization: Bearer <clé>` — c'est le chemin qui n'existait pas avant
 * cette phase.
 */
async function startServer() {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  for (const mod of [
    "../../lib/auth",
    "../../lib/permissions",
    "../../lib/services/api-keys",
    "../../lib/services/api-keys/store",
    "../../lib/services/audit",
    "../../lib/user-store",
  ]) {
    delete require.cache[require.resolve(mod)];
  }

  const auth = require("../../lib/auth");

  const app = express();
  app.use(express.json());
  // Pas de session ici volontairement : ces tests ne portent que sur le
  // chemin clé API (req.session est toujours absent). Un test séparé
  // ci-dessous vérifie que le chemin session existant reste, lui, inchangé.
  app.use((req, res, next) => {
    req.session = null;
    next();
  });
  app.use(auth.loadApiKeyAuth);
  app.use(auth.requireAuth);

  // Route "metrics:read" (mappée depuis l'action globale "system", voir
  // lib/permissions.js#ACTION_TO_API_KEY_SCOPE) — même action que
  // lib/routes/system.js.
  app.get("/api/system", auth.requirePermission("system"), (req, res) => res.json({ ok: true }));

  // Route par app ("processes:read", action "view") — même forme que
  // lib/routes/processes.js#GET /processes/:id/metrics.
  app.get("/api/processes/:id/view", auth.requirePermission("view", (req) => req.params.id), (req, res) =>
    res.json({ ok: true, app: req.params.id }),
  );

  // Action sensible ("alerts:write" / alerts_acknowledge) — doit être auditée
  // à l'usage, pas seulement au refus.
  app.post("/api/alerts/:id/acknowledge", auth.requirePermission("alerts_acknowledge"), (req, res) =>
    res.json({ ok: true }),
  );

  // Action jamais exposée à une clé API, quel que soit le scope détenu
  // (aucune entrée dans ACTION_TO_API_KEY_SCOPE pour "manage_users").
  app.get("/api/users", auth.requirePermission("manage_users"), (req, res) => res.json({ ok: true }));

  // "processes:restart" (Phase 18 suite) — seule action de mutation process
  // exposée à une clé API, mappée depuis l'action "restart".
  app.post("/api/processes/:id/restart", auth.requirePermission("restart", (req) => req.params.id), (req, res) =>
    res.json({ ok: true }),
  );

  // "servers:read" (Phase 18 suite) — action globale + requireServerAccess
  // (deux middlewares chaînés, même forme que lib/routes/servers.js#GET /:key/status).
  app.get(
    "/api/servers/:key/status",
    auth.requirePermission("servers_read"),
    auth.requireServerAccess((req) => req.params.key),
    (req, res) => res.json({ ok: true }),
  );

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function authHeader(key) {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

test("Clés API M2M — enforcement de scope bout-en-bout", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();
  const apiKeysStore = require("../../lib/services/api-keys/store");
  const auditStore = require("../../lib/services/audit/audit-store");

  await t.test("aucune clé fournie -> 401 (route protégée)", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/system`);
      assert.equal(res.status, 401);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("clé invalide (inconnue) -> 401", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/system`, {
        headers: authHeader("pmk_" + "0".repeat(48)),
      });
      assert.equal(res.status, 401);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("clé expirée -> 401", async () => {
    const { secret } = await apiKeysStore.create({
      name: "Expirée",
      scopes: ["metrics:read"],
      expiresAt: Date.now() - 1000,
    });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/system`, { headers: authHeader(secret) });
      assert.equal(res.status, 401);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("clé révoquée -> 401", async () => {
    const { apiKey, secret } = await apiKeysStore.create({ name: "Révoquée", scopes: ["metrics:read"] });
    await apiKeysStore.revoke(apiKey.id);
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/system`, { headers: authHeader(secret) });
      assert.equal(res.status, 401);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("scope insuffisant -> 403", async () => {
    const { secret } = await apiKeysStore.create({ name: "Logs uniquement", scopes: ["logs:read"] });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/system`, { headers: authHeader(secret) });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("scope suffisant -> 200", async () => {
    const { secret } = await apiKeysStore.create({ name: "Metrics OK", scopes: ["metrics:read"] });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/system`, { headers: authHeader(secret) });
      assert.equal(res.status, 200);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("scope de ressource process : restreint l'accès à l'app autorisée", async () => {
    const { secret } = await apiKeysStore.create({
      name: "Scoped process",
      scopes: ["processes:read"],
      resourceScopes: { processes: ["api-prod"] },
    });
    const { server, baseUrl } = await startServer();
    try {
      const ok = await fetch(`${baseUrl}/api/processes/api-prod/view`, { headers: authHeader(secret) });
      assert.equal(ok.status, 200);
      const denied = await fetch(`${baseUrl}/api/processes/api-staging/view`, { headers: authHeader(secret) });
      assert.equal(denied.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("scope processes:restart (Phase 18 suite) : seule mutation exposée, auditée à l'usage", async () => {
    const { secret } = await apiKeysStore.create({ name: "Restart only", scopes: ["processes:restart"] });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/processes/api-prod/restart`, {
        method: "POST",
        headers: authHeader(secret),
      });
      assert.equal(res.status, 200);

      const { items } = await auditStore.list({ action: "api_key.sensitive_use" });
      assert.ok(items.some((i) => i.target === "restart"));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("processes:restart n'autorise pas stop/reload/delete (aucun mapping de scope)", async () => {
    const { secret } = await apiKeysStore.create({ name: "Restart only 2", scopes: ["processes:restart"] });
    const { server, baseUrl } = await startServer();
    try {
      // Le scope processes:restart ne donne accès qu'à l'action "restart" —
      // vérifié indirectement ici : "view" (processes:read) reste refusé.
      const res = await fetch(`${baseUrl}/api/processes/api-prod/view`, { headers: authHeader(secret) });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("scope servers:read (Phase 18 suite) : scope + accès serveur (requireServerAccess) suffisant -> 200", async () => {
    const { secret } = await apiKeysStore.create({ name: "Servers OK", scopes: ["servers:read"] });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/servers/srv-1/status`, { headers: authHeader(secret) });
      assert.equal(res.status, 200);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("resourceScopes.servers (Phase 18 suite) : restreint l'accès au serveur autorisé", async () => {
    const { secret } = await apiKeysStore.create({
      name: "Scoped server",
      scopes: ["servers:read"],
      resourceScopes: { servers: ["srv-1"] },
    });
    const { server, baseUrl } = await startServer();
    try {
      const ok = await fetch(`${baseUrl}/api/servers/srv-1/status`, { headers: authHeader(secret) });
      assert.equal(ok.status, 200);
      const denied = await fetch(`${baseUrl}/api/servers/srv-2/status`, { headers: authHeader(secret) });
      assert.equal(denied.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("scope servers:read manquant -> 403 avant même de vérifier requireServerAccess", async () => {
    const { secret } = await apiKeysStore.create({ name: "Sans servers:read", scopes: ["metrics:read"] });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/servers/srv-1/status`, { headers: authHeader(secret) });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("action jamais exposée à une clé API (manage_users) -> 403 même avec tous les scopes", async () => {
    const { secret } = await apiKeysStore.create({
      name: "Tous les scopes",
      scopes: ["metrics:read", "processes:read", "logs:read", "alerts:read", "alerts:write", "notifications:test"],
    });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/users`, { headers: authHeader(secret) });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("utilisation d'un scope sensible (alerts:write) : autorisée ET auditée", async () => {
    const { secret } = await apiKeysStore.create({ name: "Ack", scopes: ["alerts:write"] });
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/alerts/42/acknowledge`, {
        method: "POST",
        headers: authHeader(secret),
      });
      assert.equal(res.status, 200);

      const { items } = await auditStore.list({ action: "api_key.sensitive_use" });
      assert.ok(items.length >= 1);
      assert.equal(items[items.length - 1].status, "success");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("le secret n'apparaît jamais dans une réponse d'erreur (401/403)", async () => {
    const { secret } = await apiKeysStore.create({ name: "Sans fuite", scopes: ["logs:read"] });
    const { server, baseUrl } = await startServer();
    try {
      const forbidden = await fetch(`${baseUrl}/api/system`, { headers: authHeader(secret) });
      const forbiddenBody = await forbidden.text();
      assert.equal(forbiddenBody.includes(secret), false);

      const unauthorized = await fetch(`${baseUrl}/api/system`, {
        headers: authHeader("pmk_" + "1".repeat(48)),
      });
      const unauthorizedBody = await unauthorized.text();
      assert.equal(unauthorizedBody.includes(secret), false);
    } finally {
      await stopServer(server);
    }
  });

  await cleanupDb(dbCtx);
});

test("Clés API M2M — les permissions utilisateur (session) restent inchangées", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("un utilisateur avec session continue de fonctionner exactement comme avant (aucune clé API impliquée)", async () => {
    process.env.PM2_MONITOR_DISABLE_AUTH = "0";
    delete require.cache[require.resolve("../../lib/auth")];
    const auth = require("../../lib/auth");

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 1, isAdmin: false, permissions: [{ appName: "*", action: "system" }] };
      next();
    });
    app.get("/api/system", auth.requirePermission("system"), (req, res) => res.json({ ok: true }));
    app.get("/api/other", auth.requirePermission("manage_users"), (req, res) => res.json({ ok: true }));

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const allowed = await fetch(`${baseUrl}/api/system`);
      assert.equal(allowed.status, 200);
      const denied = await fetch(`${baseUrl}/api/other`);
      assert.equal(denied.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await cleanupDb(dbCtx);
});
