"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur Log Explorer (lib/routes/log-explorer.js) sur un
 * serveur HTTP réel, avec une DB SQLite temporaire migrée (nécessaire :
 * resolveSelectors() lit lib/services/servers/store.js pour connaître les
 * serveurs enregistrés, Phase 10) et un vrai LogStore pointant vers un
 * répertoire de logs temporaire. `req.user` est injecté directement, comme
 * test/integration/events-api.test.js — le routeur ne dépend jamais de pm2
 * (voir la note de fichier dans log-explorer.js), donc aucun mock PM2 requis.
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0"; // auth ACTIVÉE : on veut tester les permissions
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/log-explorer")];
  delete require.cache[require.resolve("../../lib/log-store")];
  delete require.cache[require.resolve("../../lib/services/servers/store")];

  const auth = require("../../lib/auth");
  const createLogExplorerRouter = require("../../lib/routes/log-explorer");
  const { LogStore } = require("../../lib/log-store");
  const serversStore = require("../../lib/services/servers/store");

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-log-explorer-"));
  const logStore = new LogStore(logDir);
  // En production, server.js enregistre toujours l'hôte local avant de
  // démarrer (serversStore.ensureLocalServer(), Phase 10) — reproduit ici
  // pour que resolveSelectors() trouve "local" par défaut, comme en vrai.
  await serversStore.ensureLocalServer();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/logs", createLogExplorerRouter({ logStore }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/logs`;
  return { server, baseUrl, logStore, logDir, auth, serversStore };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const API_LOGS_USER = { id: 3, isAdmin: false, permissions: [{ appName: "api", action: "logs" }] };
const ALL_LOGS_USER = { id: 4, isAdmin: false, permissions: [{ appName: "*", action: "logs" }] };

test("API /api/logs (Log Explorer)", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("paramètre 'process' manquant -> 400", async () => {
    const { server, baseUrl, logDir } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/search`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /process/i);
    } finally {
      await stopServer(server);
      cleanupDir(logDir);
    }
  });

  await t.test(
    "utilisateur sans permission 'logs' sur l'app demandée -> résultat vide (pas 403)",
    async () => {
      const { server, baseUrl, logStore, logDir } = await startServer(NO_PERMS_USER);
      try {
        logStore.appendPacket(1, "api", "out", "ligne secrète\n", Date.now());
        const res = await fetch(`${baseUrl}/search?process=api`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.results, []);
        assert.equal(body.total, 0);
      } finally {
        await stopServer(server);
        cleanupDir(logDir);
      }
    },
  );

  await t.test(
    "utilisateur avec permission 'logs' seulement sur 'api' : 'worker' filtré silencieusement",
    async () => {
      const { server, baseUrl, logStore, logDir } = await startServer(API_LOGS_USER);
      try {
        logStore.appendPacket(1, "api", "out", "api ok\n", 1000);
        logStore.appendPacket(2, "worker", "out", "worker ok\n", 2000);
        const res = await fetch(`${baseUrl}/search?process=api,worker`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.total, 1);
        assert.equal(body.results[0].text, "api ok");
        assert.deepEqual(body.results[0].source, { serverKey: "local", name: "api" });
      } finally {
        await stopServer(server);
        cleanupDir(logDir);
      }
    },
  );

  await t.test(
    "recherche multi-serveur : accessible uniquement sur les serveurs autorisés (hasServerAccess)",
    async () => {
      const { server, baseUrl, logStore, logDir, serversStore } = await startServer({
        id: 5,
        isAdmin: false,
        permissions: [{ appName: "*", action: "logs" }],
        allowedServerKeys: ["local"], // pas d'accès au serveur distant créé ci-dessous
      });
      try {
        await serversStore.ensureLocalServer();
        const { server: remote } = await serversStore.create({ name: "EU-1", hostname: "eu1.example.com" });

        logStore.appendPacket(1, "api", "out", "log local\n", 1000);
        logStore.appendPacket(1, "api", "out", "log distant\n", 2000, remote.serverKey);

        const res = await fetch(`${baseUrl}/search?process=api`); // pas de filtre 'server' explicite -> tous les serveurs connus, puis filtrage permission
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.total, 1);
        assert.equal(body.results[0].text, "log local");
      } finally {
        await stopServer(server);
        cleanupDir(logDir);
      }
    },
  );

  await t.test("recherche multi-serveur : un utilisateur autorisé sur les deux voit les deux", async () => {
    const { server, baseUrl, logStore, logDir, serversStore } = await startServer(ALL_LOGS_USER);
    try {
      await serversStore.ensureLocalServer();
      const { server: remote } = await serversStore.create({ name: "EU-1", hostname: "eu1.example.com" });

      logStore.appendPacket(1, "api", "out", "log local\n", 1000);
      logStore.appendPacket(1, "api", "out", "log distant\n", 2000, remote.serverKey);

      const res = await fetch(`${baseUrl}/search?process=api&sort=asc`);
      const body = await res.json();
      assert.equal(body.total, 2);
      assert.deepEqual(
        body.results.map((r) => r.text),
        ["log local", "log distant"],
      );

      // filtre explicite `server` : ne renvoie que le serveur distant
      const res2 = await fetch(`${baseUrl}/search?process=api&server=${remote.serverKey}`);
      const body2 = await res2.json();
      assert.equal(body2.total, 1);
      assert.equal(body2.results[0].text, "log distant");
    } finally {
      await stopServer(server);
      cleanupDir(logDir);
    }
  });

  await t.test("regex invalide -> 400", async () => {
    const { server, baseUrl, logDir } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/search?process=api&regex=1&q=%28unclosed`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error);
    } finally {
      await stopServer(server);
      cleanupDir(logDir);
    }
  });

  await t.test("regex catastrophique -> 400, jamais évaluée", async () => {
    const { server, baseUrl, logDir } = await startServer(ADMIN);
    try {
      const res = await fetch(
        `${baseUrl}/search?process=api&regex=1&${new URLSearchParams({ q: "(a+)+$" })}`,
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /catastrophique/i);
    } finally {
      await stopServer(server);
      cleanupDir(logDir);
    }
  });

  await t.test("trop de process demandés -> 400", async () => {
    const { server, baseUrl, logDir } = await startServer(ADMIN);
    try {
      const many = Array.from({ length: 20 }, (_, i) => `app${i}`).join(",");
      const res = await fetch(`${baseUrl}/search?process=${many}`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /process/i);
    } finally {
      await stopServer(server);
      cleanupDir(logDir);
    }
  });

  await t.test("gros volume : réponse bornée (truncated=true), jamais d'erreur ni de timeout", async () => {
    const { server, baseUrl, logStore, logDir } = await startServer(ADMIN);
    try {
      for (let i = 0; i < 500; i++) {
        logStore.appendPacket(1, "api", "out", `ligne ${i}\n`, 1000 + i);
      }
      const res = await fetch(`${baseUrl}/search?process=api&limit=10`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.total, 500);
      assert.equal(body.results.length, 10);
    } finally {
      await stopServer(server);
      cleanupDir(logDir);
    }
  });

  await t.test("contexte : lignes avant/après incluses quand demandées", async () => {
    const { server, baseUrl, logStore, logDir } = await startServer(ADMIN);
    try {
      logStore.appendPacket(1, "api", "out", "l0\n", 1000);
      logStore.appendPacket(1, "api", "out", "BOOM\n", 1001);
      logStore.appendPacket(1, "api", "out", "l2\n", 1002);
      const res = await fetch(`${baseUrl}/search?process=api&q=BOOM&context=1`);
      const body = await res.json();
      assert.equal(body.results.length, 1);
      assert.deepEqual(
        body.results[0].before.map((r) => r.text),
        ["l0"],
      );
      assert.deepEqual(
        body.results[0].after.map((r) => r.text),
        ["l2"],
      );
    } finally {
      await stopServer(server);
      cleanupDir(logDir);
    }
  });

  await t.test("export : content-type texte, en-tête de téléchargement, contenu correct", async () => {
    const { server, baseUrl, logStore, logDir } = await startServer(ADMIN);
    try {
      logStore.appendPacket(1, "api", "out", "export moi\n", 1000);
      const res = await fetch(`${baseUrl}/export?process=api`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /text\/plain/);
      assert.match(res.headers.get("content-disposition"), /attachment/);
      const text = await res.text();
      assert.match(text, /export moi/);
      assert.match(text, /\[local\/api]/);
    } finally {
      await stopServer(server);
      cleanupDir(logDir);
    }
  });

  await t.test(
    "export : regex dangereuse refusée AVANT tout envoi (400 JSON, pas de flux texte)",
    async () => {
      const { server, baseUrl, logDir } = await startServer(ADMIN);
      try {
        const res = await fetch(
          `${baseUrl}/export?process=api&regex=1&${new URLSearchParams({ q: "(a+)+$" })}`,
        );
        assert.equal(res.status, 400);
        assert.match(res.headers.get("content-type"), /application\/json/);
        const body = await res.json();
        assert.ok(body.error);
      } finally {
        await stopServer(server);
        cleanupDir(logDir);
      }
    },
  );

  await t.test("export : sans aucun résultat, répond quand même proprement (pas d'exception)", async () => {
    const { server, baseUrl, logDir } = await startServer(NO_PERMS_USER);
    try {
      const res = await fetch(`${baseUrl}/export?process=api`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /aucun résultat/);
    } finally {
      await stopServer(server);
      cleanupDir(logDir);
    }
  });

  t.after(async () => {
    await cleanupDb(dbCtx);
  });
});
