"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur (lib/routes/api-keys.js) sur un serveur HTTP réel,
 * avec la vraie DB SQLite (migrée via 020_rbac_api_keys.js) — même approche
 * que test/integration/health-checks-api.test.js. `req.user` est injecté
 * directement pour tester les permissions sans passer par express-session.
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/api-keys")];
  delete require.cache[require.resolve("../../lib/services/api-keys")];
  delete require.cache[require.resolve("../../lib/services/api-keys/store")];

  const apiKeysRouter = require("../../lib/routes/api-keys");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/api-keys", apiKeysRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/api/api-keys` };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const READ_ONLY_USER = {
  id: 3,
  isAdmin: false,
  permissions: [{ appName: "*", action: "api_keys_read" }],
};
const MANAGE_USER = {
  id: 4,
  isAdmin: false,
  permissions: [
    { appName: "*", action: "api_keys_read" },
    { appName: "*", action: "api_keys_manage" },
  ],
};

test("API /api/api-keys", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("sans permission -> 403 sur toutes les routes", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      assert.equal((await fetch(baseUrl)).status, 403);
      assert.equal(
        (
          await fetch(baseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "x", scopes: ["metrics:read"] }),
          })
        ).status,
        403,
      );
    } finally {
      await stopServer(server);
    }
  });

  await t.test("api_keys_read seul : peut lister mais pas créer", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      assert.equal((await fetch(baseUrl)).status, 200);
      assert.equal(
        (
          await fetch(baseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "x", scopes: ["metrics:read"] }),
          })
        ).status,
        403,
      );
    } finally {
      await stopServer(server);
    }
  });

  await t.test("scope inconnu -> 400", async () => {
    const { server, baseUrl } = await startServer(MANAGE_USER);
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "invalide", scopes: ["doesnotexist:read"] }),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("scopes vide -> 400", async () => {
    const { server, baseUrl } = await startServer(MANAGE_USER);
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "sans scope", scopes: [] }),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  let keyId;
  await t.test(
    "admin (api_keys_manage implicite) : crée une clé (201), secret présent une seule fois",
    async () => {
      const { server, baseUrl } = await startServer(ADMIN);
      try {
        const created = await fetch(baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Intégration CI", scopes: ["metrics:read", "logs:read"] }),
        });
        assert.equal(created.status, 201);
        const body = await created.json();
        assert.ok(body.secret.startsWith("pmk_"));
        assert.equal(body.apiKey.name, "Intégration CI");
        assert.deepEqual(body.apiKey.scopes, ["metrics:read", "logs:read"]);
        assert.equal(body.apiKey.hash, undefined);
        assert.equal(body.apiKey.keyHash, undefined);
        keyId = body.apiKey.id;

        const listed = await fetch(baseUrl);
        const list = await listed.json();
        assert.equal(list.length, 1);
        // Le secret ne doit JAMAIS réapparaître dans une réponse de liste (voir
        // lib/services/api-keys/store.js#rowToApiKey).
        assert.equal(JSON.stringify(list).includes(body.secret), false);
        assert.equal(list[0].secret, undefined);
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test("PATCH : modifie les scopes d'une clé existante", async () => {
    const { server, baseUrl } = await startServer(MANAGE_USER);
    try {
      const res = await fetch(`${baseUrl}/${keyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: ["metrics:read"] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.scopes, ["metrics:read"]);
      assert.equal(body.secret, undefined);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("PATCH sur une clé inconnue -> 404", async () => {
    const { server, baseUrl } = await startServer(MANAGE_USER);
    try {
      const res = await fetch(`${baseUrl}/999999`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: ["metrics:read"] }),
      });
      assert.equal(res.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("POST /:id/revoke : révoque une clé, jamais de suppression", async () => {
    const { server, baseUrl } = await startServer(MANAGE_USER);
    try {
      const res = await fetch(`${baseUrl}/${keyId}/revoke`, { method: "POST" });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.revokedAt > 0);

      const listed = await fetch(baseUrl);
      const list = await listed.json();
      assert.equal(list.length, 1, "la clé révoquée reste listée (trace d'audit conservée)");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("GET /scopes : catalogue des scopes disponibles", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      const res = await fetch(`${baseUrl}/scopes`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body["metrics:read"]);
      assert.ok(body["alerts:write"]);
    } finally {
      await stopServer(server);
    }
  });

  await cleanupDb(dbCtx);
});
