"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Phase 5F — section 4 "Permission Audit" de la tâche : vérifie chaque
 * permission (`notifications.read/create/update/delete/test/history/
 * manage`, ici sous leur nom exact `notifications_*` — voir
 * lib/permissions.js) sur chaque endpoint REST concerné, avec un
 * utilisateur qui n'a QUE cette permission (pour vérifier qu'aucune
 * permission adjacente n'en accorde une autre par erreur) et un
 * utilisateur sans AUCUNE permission (pour vérifier qu'il n'existe pas de
 * chemin non protégé). Complète (sans les dupliquer) les tests déjà
 * présents par endpoint dans test/integration/notifications-api.test.js
 * (Phase 5A/5D) — ici la vérification est faite comme une matrice
 * exhaustive plutôt que dispersée par test.
 */

async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/notifications")];
  delete require.cache[require.resolve("../../lib/services/notifications")];
  delete require.cache[require.resolve("../../lib/services/notifications/provider-store")];

  const auth = require("../../lib/auth");
  const notificationsRouter = require("../../lib/routes/notifications");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/notifications", notificationsRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/notifications`;
  return { server, baseUrl };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function userWithOnly(action) {
  return { id: 42, isAdmin: false, permissions: action ? [{ appName: "*", action }] : [] };
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS = userWithOnly(null);

/**
 * Une entrée par endpoint : méthode, chemin (id/params substitués dans le
 * test), permission requise, et un body minimal valide si la méthode en a
 * besoin (utilisé seulement pour le cas ADMIN, où on veut un 2xx franc et
 * pas juste "pas 403").
 */
const ENDPOINTS = [
  { method: "GET", path: "/provider-types", permission: "notifications_read" },
  { method: "GET", path: "/providers", permission: "notifications_read" },
  { method: "GET", path: "/providers/:providerId", permission: "notifications_read" },
  {
    method: "POST",
    path: "/providers",
    permission: "notifications_create",
    body: () => ({
      name: "P",
      type: "discord",
      fields: { webhookUrl: "https://discord.com/api/webhooks/1/x" },
    }),
  },
  {
    method: "PATCH",
    path: "/providers/:providerId",
    permission: "notifications_update",
    body: () => ({ name: "Renommé" }),
  },
  {
    method: "PUT",
    path: "/providers/:providerId",
    permission: "notifications_update",
    body: () => ({ name: "Renommé", type: "discord", fields: {} }),
  },
  { method: "DELETE", path: "/providers/:providerIdScratch", permission: "notifications_delete" },
  { method: "POST", path: "/providers/:providerId/test", permission: "notifications_test" },
  { method: "GET", path: "/routes", permission: "notifications_read" },
  { method: "GET", path: "/routes/:routeId", permission: "notifications_read" },
  { method: "POST", path: "/routes", permission: "notifications_manage", body: () => ({ name: "R" }) },
  {
    method: "PATCH",
    path: "/routes/:routeId",
    permission: "notifications_manage",
    body: () => ({ name: "Renommée" }),
  },
  {
    method: "PUT",
    path: "/routes/:routeId",
    permission: "notifications_manage",
    body: () => ({ name: "Renommée" }),
  },
  { method: "DELETE", path: "/routes/:routeIdScratch", permission: "notifications_manage" },
  { method: "GET", path: "/history", permission: "notifications_history" },
];

const ALL_PERMISSIONS = [
  "notifications_read",
  "notifications_create",
  "notifications_update",
  "notifications_delete",
  "notifications_test",
  "notifications_history",
  "notifications_manage",
];

test("Phase 5F — Permission Audit : chaque endpoint notifications exige exactement sa permission", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  // Fixtures créées par un admin, réutilisées en lecture/écriture par les
  // requêtes de la matrice (des ids stables évitent 15 x 7 créations).
  const { server: adminServer, baseUrl: adminBaseUrl } = await startServer(ADMIN);
  const provider = await (
    await fetch(`${adminBaseUrl}/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Fixture provider",
        type: "discord",
        fields: { webhookUrl: "https://discord.com/api/webhooks/1/x" },
      }),
    })
  ).json();
  const route = await (
    await fetch(`${adminBaseUrl}/routes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fixture route", providerIds: [provider.id] }),
    })
  ).json();
  await stopServer(adminServer);

  function resolvePath(path) {
    return path
      .replace(":providerId", provider.id)
      .replace(":routeId", route.id)
      .replace(":providerIdScratch", provider.id) // partagé : le DELETE n'est testé qu'avec des permissions insuffisantes, jamais exécuté jusqu'au bout ici
      .replace(":routeIdScratch", route.id);
  }

  for (const endpoint of ENDPOINTS) {
    await t.test(`${endpoint.method} ${endpoint.path} — sans aucune permission -> 403`, async () => {
      const { server, baseUrl } = await startServer(NO_PERMS);
      try {
        const res = await fetch(`${baseUrl}${resolvePath(endpoint.path)}`, {
          method: endpoint.method,
          headers: { "Content-Type": "application/json" },
          body: endpoint.method === "GET" || endpoint.method === "DELETE" ? undefined : JSON.stringify({}),
        });
        assert.equal(
          res.status,
          403,
          `${endpoint.method} ${endpoint.path} doit refuser un utilisateur sans permission`,
        );
      } finally {
        await stopServer(server);
      }
    });

    const otherPermissions = ALL_PERMISSIONS.filter((p) => p !== endpoint.permission);
    for (const wrongPermission of otherPermissions) {
      await t.test(
        `${endpoint.method} ${endpoint.path} — avec seulement '${wrongPermission}' (permission adjacente) -> 403`,
        async () => {
          const { server, baseUrl } = await startServer(userWithOnly(wrongPermission));
          try {
            const res = await fetch(`${baseUrl}${resolvePath(endpoint.path)}`, {
              method: endpoint.method,
              headers: { "Content-Type": "application/json" },
              body:
                endpoint.method === "GET" || endpoint.method === "DELETE" ? undefined : JSON.stringify({}),
            });
            assert.equal(
              res.status,
              403,
              `${endpoint.method} ${endpoint.path} ne doit pas être accessible avec seulement '${wrongPermission}' (attendu '${endpoint.permission}')`,
            );
          } finally {
            await stopServer(server);
          }
        },
      );
    }

    await t.test(
      `${endpoint.method} ${endpoint.path} — avec exactement '${endpoint.permission}' -> pas de 403`,
      async () => {
        const { server, baseUrl } = await startServer(userWithOnly(endpoint.permission));
        try {
          const res = await fetch(`${baseUrl}${resolvePath(endpoint.path)}`, {
            method: endpoint.method,
            headers: { "Content-Type": "application/json" },
            body:
              endpoint.method === "GET" || endpoint.method === "DELETE"
                ? undefined
                : JSON.stringify(endpoint.body ? endpoint.body() : {}),
          });
          assert.notEqual(
            res.status,
            403,
            `${endpoint.method} ${endpoint.path} doit être accessible avec '${endpoint.permission}'`,
          );
        } finally {
          await stopServer(server);
        }
      },
    );
  }

  await t.test(
    "l'ID d'app '*' d'une permission ne donne pas accès à une action non accordée (pas de wildcard implicite sur l'action)",
    async () => {
      // hasPermission() (lib/permissions.js) ne doit matcher que sur l'action
      // exacte, pas "toute action dès qu'il existe une permission '*'".
      const user = { id: 43, isAdmin: false, permissions: [{ appName: "*", action: "notifications_read" }] };
      const { server, baseUrl } = await startServer(user);
      try {
        const res = await fetch(`${baseUrl}/providers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x", type: "discord", fields: {} }),
        });
        assert.equal(res.status, 403);
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test(
    "un utilisateur admin (isAdmin: true) contourne bien requirePermission, mais pas requireAuth (déjà authentifié ici)",
    async () => {
      const { server, baseUrl } = await startServer(ADMIN);
      try {
        const res = await fetch(`${baseUrl}/providers`);
        assert.equal(res.status, 200);
      } finally {
        await stopServer(server);
      }
    },
  );

  await cleanupDb(dbCtx);
});
