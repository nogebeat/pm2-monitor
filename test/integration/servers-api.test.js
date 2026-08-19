"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur (lib/routes/servers.js) sur un serveur HTTP réel,
 * avec la vraie DB SQLite (migration 012) — même approche que
 * test/integration/health-checks-api.test.js. `req.user` est injecté
 * directement pour tester permissions/scope sans passer par express-session.
 *
 * Le hub d'agents (lib/realtime/agent-hub.js) est remplacé par un double
 * minimal : ce fichier teste l'API REST (routes/servers.js), pas le socket
 * lui-même (voir test/integration/agent-hub.test.js pour ça). Le double
 * n'a besoin d'implémenter que ce que routes/servers.js consomme :
 * isOnline(), sockets (Map), sendRemoteAction().
 */
function fakeAgentHub() {
  const online = new Set();
  const remoteCalls = [];
  return {
    sockets: new Map(),
    isOnline: (serverKey) => online.has(serverKey),
    setOnline(serverKey, value) {
      if (value) online.add(serverKey);
      else online.delete(serverKey);
    },
    async sendRemoteAction(serverKey, action, processName) {
      remoteCalls.push({ serverKey, action, processName });
      if (!online.has(serverKey)) throw new Error("Agent hors ligne : impossible d'envoyer l'action.");
      return { ok: true };
    },
    remoteCalls,
  };
}

async function startServer(userForRequest, agentHub) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/servers")];
  delete require.cache[require.resolve("../../lib/services/servers")];
  delete require.cache[require.resolve("../../lib/services/servers/store")];
  delete require.cache[require.resolve("../../lib/services/servers/user-scope")];
  delete require.cache[require.resolve("../../lib/services/audit")];
  delete require.cache[require.resolve("../../lib/services/audit/audit-store")];

  const serversRouter = require("../../lib/routes/servers");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/servers", serversRouter({ agentHub }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/api/servers` };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [], allowedServerKeys: [] };
const SERVERS_USER = {
  id: 3,
  isAdmin: false,
  permissions: [
    { appName: "*", action: "servers_read" },
    { appName: "*", action: "servers_manage" },
    { appName: "*", action: "restart" },
  ],
  allowedServerKeys: [],
};

test("API /api/servers", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  let agentHub;
  t.beforeEach(() => {
    agentHub = fakeAgentHub();
  });

  await t.test("sans permission servers_read -> 403 sur GET /", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER, agentHub);
    try {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("sans permission servers_manage -> 403 sur POST /", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER, agentHub);
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      });
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  let serverKey;
  let agentToken;

  await t.test(
    "admin : enregistre un nouveau serveur agent (201), reçoit un token une seule fois",
    async () => {
      const { server, baseUrl } = await startServer(ADMIN, agentHub);
      try {
        const res = await fetch(baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Prod EU", hostname: "eu.example.com", environment: "production" }),
        });
        assert.equal(res.status, 201);
        const body = await res.json();
        assert.ok(body.server.serverKey.startsWith("srv_"));
        assert.equal(body.server.status, "PENDING");
        assert.ok(body.token);
        serverKey = body.server.serverKey;
        agentToken = body.token;
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test("GET / liste le serveur local (auto-enregistré) et l'agent créé", async () => {
    const { store } = require("../../lib/services/servers");
    await store.ensureLocalServer();

    const { server, baseUrl } = await startServer(ADMIN, agentHub);
    try {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 200);
      const list = await res.json();
      const keys = list.map((s) => s.serverKey);
      assert.ok(keys.includes("local"));
      assert.ok(keys.includes(serverKey));
    } finally {
      await stopServer(server);
    }
  });

  await t.test(
    "GET /:key/status reflète isOnline() du hub même si le statut persisté est PENDING",
    async () => {
      agentHub.setOnline(serverKey, true);
      const { server, baseUrl } = await startServer(ADMIN, agentHub);
      try {
        const res = await fetch(`${baseUrl}/${serverKey}/status`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status, "ONLINE");
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test("PUT /:key met à jour le nom", async () => {
    const { server, baseUrl } = await startServer(ADMIN, agentHub);
    try {
      const res = await fetch(`${baseUrl}/${serverKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Prod EU (renommé)" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.name, "Prod EU (renommé)");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("POST /:key/disable puis /:key/enable", async () => {
    const { server, baseUrl } = await startServer(ADMIN, agentHub);
    try {
      const disabled = await fetch(`${baseUrl}/${serverKey}/disable`, { method: "POST" });
      assert.equal(disabled.status, 200);
      assert.equal((await disabled.json()).enabled, false);

      const enabled = await fetch(`${baseUrl}/${serverKey}/enable`, { method: "POST" });
      assert.equal(enabled.status, 200);
      assert.equal((await enabled.json()).enabled, true);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("le serveur local ne peut pas être désactivé via l'API (400, message clair)", async () => {
    const { server, baseUrl } = await startServer(ADMIN, agentHub);
    try {
      const res = await fetch(`${baseUrl}/local/disable`, { method: "POST" });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("POST /:key/regenerate-token renvoie un nouveau token, différent de l'ancien", async () => {
    const { server, baseUrl } = await startServer(ADMIN, agentHub);
    try {
      const res = await fetch(`${baseUrl}/${serverKey}/regenerate-token`, { method: "POST" });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.notEqual(body.token, agentToken);
      agentToken = body.token;
    } finally {
      await stopServer(server);
    }
  });

  await t.test(
    "scoping : un utilisateur restreint à d'autres serveurs reçoit 403 sur ce serveur",
    async () => {
      const scoped = { ...SERVERS_USER, allowedServerKeys: ["srv_un_autre"] };
      const { server, baseUrl } = await startServer(scoped, agentHub);
      try {
        const res = await fetch(`${baseUrl}/${serverKey}/status`);
        assert.equal(res.status, 403);
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test(
    "scoping : GET / ne renvoie que les serveurs autorisés pour un utilisateur restreint",
    async () => {
      const scoped = { ...SERVERS_USER, allowedServerKeys: [serverKey] };
      const { server, baseUrl } = await startServer(scoped, agentHub);
      try {
        const res = await fetch(baseUrl);
        const list = await res.json();
        assert.deepEqual(
          list.map((s) => s.serverKey),
          [serverKey],
        );
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test("action distante : agent hors ligne -> 400", async () => {
    agentHub.setOnline(serverKey, false);
    const { server, baseUrl } = await startServer(ADMIN, agentHub);
    try {
      const res = await fetch(`${baseUrl}/${serverKey}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart", processName: "api" }),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("action distante : agent en ligne -> relayée au hub (200)", async () => {
    agentHub.setOnline(serverKey, true);
    const { server, baseUrl } = await startServer(ADMIN, agentHub);
    try {
      const res = await fetch(`${baseUrl}/${serverKey}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart", processName: "api" }),
      });
      assert.equal(res.status, 200);
      assert.equal(agentHub.remoteCalls.at(-1).action, "restart");
    } finally {
      await stopServer(server);
    }
  });

  await t.test(
    "action distante : refusée si l'utilisateur n'a pas la permission sur l'app ciblée",
    async () => {
      agentHub.setOnline(serverKey, true);
      const noRestart = {
        ...SERVERS_USER,
        permissions: [{ appName: "*", action: "servers_read" }],
      };
      const { server, baseUrl } = await startServer(noRestart, agentHub);
      try {
        const res = await fetch(`${baseUrl}/${serverKey}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "restart", processName: "api" }),
        });
        assert.equal(res.status, 403);
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test(
    "action distante : refusée sur le serveur local (doit passer par /api/processes)",
    async () => {
      const { server, baseUrl } = await startServer(ADMIN, agentHub);
      try {
        const res = await fetch(`${baseUrl}/local/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "restart", processName: "api" }),
        });
        assert.equal(res.status, 400);
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test("DELETE /:key supprime le serveur ; il n'apparaît plus dans la liste", async () => {
    const { server, baseUrl } = await startServer(ADMIN, agentHub);
    try {
      const res = await fetch(`${baseUrl}/${serverKey}`, { method: "DELETE" });
      assert.equal(res.status, 200);

      const list = await (await fetch(baseUrl)).json();
      assert.ok(!list.map((s) => s.serverKey).includes(serverKey));
    } finally {
      await stopServer(server);
    }
  });

  await t.test("le serveur local ne peut pas être supprimé via l'API (400)", async () => {
    const { server, baseUrl } = await startServer(ADMIN, agentHub);
    try {
      const res = await fetch(`${baseUrl}/local`, { method: "DELETE" });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  await cleanupDb(dbCtx);
});
