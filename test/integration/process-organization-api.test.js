"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur (lib/routes/process-organization.js) sur un serveur
 * HTTP réel, avec la vraie DB SQLite (migration 015) — même approche que
 * test/integration/servers-api.test.js. `req.user` est injecté directement
 * pour tester permissions/CRUD/associations sans passer par express-session.
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/process-organization")];
  delete require.cache[require.resolve("../../lib/services/process-organization")];
  delete require.cache[require.resolve("../../lib/services/process-organization/store")];
  delete require.cache[require.resolve("../../lib/services/audit")];
  delete require.cache[require.resolve("../../lib/services/audit/audit-store")];

  const processOrganizationRouter = require("../../lib/routes/process-organization");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/process-organization", processOrganizationRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/api/process-organization` };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const READ_ONLY_USER = {
  id: 3,
  isAdmin: false,
  permissions: [{ appName: "*", action: "process_org_read" }],
};
const MANAGE_USER = {
  id: 4,
  isAdmin: false,
  permissions: [
    { appName: "*", action: "process_org_read" },
    { appName: "*", action: "process_org_manage" },
  ],
};

test("API /api/process-organization", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("sans permission process_org_read -> 403 sur GET /tags", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      const res = await fetch(`${baseUrl}/tags`);
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("process_org_read seul -> lecture OK, écriture 403", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      const list = await fetch(`${baseUrl}/tags`);
      assert.equal(list.status, 200);

      const create = await fetch(`${baseUrl}/tags`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "production" }),
      });
      assert.equal(create.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("CRUD tags (admin)", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const create = await fetch(`${baseUrl}/tags`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "critical", color: "#ff0000" }),
      });
      assert.equal(create.status, 201);
      const tag = await create.json();
      assert.equal(tag.name, "critical");

      const dup = await fetch(`${baseUrl}/tags`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "critical" }),
      });
      assert.equal(dup.status, 400);

      const update = await fetch(`${baseUrl}/tags/${tag.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ color: "#00ff00" }),
      });
      assert.equal(update.status, 200);
      assert.equal((await update.json()).color, "#00ff00");

      const del = await fetch(`${baseUrl}/tags/${tag.id}`, { method: "DELETE" });
      assert.equal(del.status, 200);

      const delAgain = await fetch(`${baseUrl}/tags/${tag.id}`, { method: "DELETE" });
      assert.equal(delAgain.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("CRUD environnements (admin)", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const create = await fetch(`${baseUrl}/environments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "qa" }),
      });
      assert.equal(create.status, 201);
      const env = await create.json();

      const list = await fetch(`${baseUrl}/environments`);
      const all = await list.json();
      assert.ok(all.some((e) => e.id === env.id));

      const del = await fetch(`${baseUrl}/environments/${env.id}`, { method: "DELETE" });
      assert.equal(del.status, 200);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("CRUD groupes (admin)", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const create = await fetch(`${baseUrl}/groups`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "E-commerce", description: "Stack e-commerce" }),
      });
      assert.equal(create.status, 201);
      const group = await create.json();
      assert.equal(group.description, "Stack e-commerce");

      const update = await fetch(`${baseUrl}/groups/${group.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "E-commerce (EU)" }),
      });
      assert.equal((await update.json()).name, "E-commerce (EU)");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("assignation d'un process : tags + environnement + groupes en un appel", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const tag = await (
        await fetch(`${baseUrl}/tags`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "payments-tag" }),
        })
      ).json();
      const env = await (
        await fetch(`${baseUrl}/environments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "payments-env" }),
        })
      ).json();
      const group = await (
        await fetch(`${baseUrl}/groups`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "payments-group" }),
        })
      ).json();

      const assign = await fetch(`${baseUrl}/assignments/payments-api`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagIds: [tag.id], environmentId: env.id, groups: [group.id] }),
      });
      assert.equal(assign.status, 200);
      const result = await assign.json();
      assert.deepEqual(result.tags, ["payments-tag"]);
      assert.equal(result.environment, "payments-env");
      assert.deepEqual(result.groups, ["payments-group"]);

      const fetched = await (await fetch(`${baseUrl}/assignments/payments-api`)).json();
      assert.deepEqual(fetched, result);

      const all = await (await fetch(`${baseUrl}/assignments`)).json();
      const entry = all.find((a) => a.processName === "payments-api");
      assert.ok(entry);
      assert.equal(entry.tags[0].name, "payments-tag");

      const clear = await fetch(`${baseUrl}/assignments/payments-api`, { method: "DELETE" });
      assert.equal(clear.status, 200);
      const afterClear = await (await fetch(`${baseUrl}/assignments/payments-api`)).json();
      assert.deepEqual(afterClear, { tags: [], environment: null, groups: [] });
    } finally {
      await stopServer(server);
    }
  });

  await t.test("process_org_manage requis pour assigner (lecture seule -> 403)", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      const res = await fetch(`${baseUrl}/assignments/some-process`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagIds: [] }),
      });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("MANAGE_USER (permissions explicites, pas admin) peut créer un tag", async () => {
    const { server, baseUrl } = await startServer(MANAGE_USER);
    try {
      const create = await fetch(`${baseUrl}/tags`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "frontend" }),
      });
      assert.equal(create.status, 201);
    } finally {
      await stopServer(server);
    }
  });

  t.after(() => cleanupDb(dbCtx));
});
