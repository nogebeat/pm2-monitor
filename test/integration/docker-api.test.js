"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Tests d'intégration Phase 22 (Docker Monitoring) — routeur REST
 * (lib/routes/docker.js), même approche que
 * test/integration/health-checks-api.test.js : vrai routeur, vrai serveur
 * HTTP, `req.user` injecté directement pour tester lib/permissions.js sans
 * passer par express-session. Le service Docker tourne pour de vrai contre
 * un faux daemon minimal (socket Unix réel), une seule fois avant les
 * tests : ces tests valident le ROUTAGE/RBAC, pas à nouveau la collecte
 * elle-même (déjà couverte par test/integration/docker-service.test.js).
 */

const SOCKET_PATH = path.join(os.tmpdir(), `pm2-monitor-fake-docker-api-${process.pid}.sock`);
process.env.DOCKER_SOCKET_PATH = SOCKET_PATH;
process.env.DOCKER_MONITORING_ENABLED = "1";
process.env.PM2_MONITOR_DISABLE_AUTH = "0";

function startFakeDockerd() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://docker");
    if (url.pathname === "/_ping") {
      res.writeHead(200);
      return res.end("OK");
    }
    if (url.pathname === "/containers/json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify([
          {
            Id: "abc123456789",
            Names: ["/postgres"],
            Image: "postgres:16",
            State: "running",
            Status: "Up 2 hours",
            Created: 1_700_000_000,
            Ports: [],
            Labels: {},
          },
        ]),
      );
    }
    if (url.pathname === "/containers/abc123456789/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          cpu_stats: { cpu_usage: { total_usage: 1, online_cpus: 1 }, system_cpu_usage: 1 },
          memory_stats: { usage: 1024, limit: 2048 },
        }),
      );
    }
    if (url.pathname === "/containers/abc123456789/json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ Id: "abc123456789", Name: "/postgres", Config: { Image: "postgres:16" } }),
      );
    }
    if (url.pathname === "/containers/abc123456789/logs") {
      const payload = Buffer.from("2026-01-01T00:00:00.000000000Z database is ready\n", "utf8");
      const header = Buffer.alloc(8);
      header.writeUInt8(1, 0);
      header.writeUInt32BE(payload.length, 4);
      res.writeHead(200);
      return res.end(Buffer.concat([header, payload]));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(SOCKET_PATH, () => resolve(server));
  });
}

/** Démarre le vrai routeur Docker sur un serveur HTTP réel, avec un req.user injecté. */
async function startApiServer(userForRequest) {
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/docker")];
  const dockerRouter = require("../../lib/routes/docker");

  const app = express();
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/docker", dockerRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/api/docker` };
}

function stopApiServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
// Mirroir du rôle "auditor" (section RBAC confirmée par l'utilisateur) : lecture, pas les logs.
const READ_ONLY_USER = { id: 3, isAdmin: false, permissions: [{ appName: "*", action: "docker_read" }] };
// Mirroir des rôles "viewer"/"operator" : lecture + logs.
const FULL_USER = {
  id: 4,
  isAdmin: false,
  permissions: [
    { appName: "*", action: "docker_read" },
    { appName: "*", action: "docker_logs" },
  ],
};

let fakeDockerd;
let dockerService;

test.before(async () => {
  if (fsSync.existsSync(SOCKET_PATH)) fsSync.unlinkSync(SOCKET_PATH);
  fakeDockerd = await startFakeDockerd();
  dockerService = require("../../lib/services/docker");
  // Un seul cycle de collecte pour peupler le cache lu par le routeur —
  // les routes REST ne déclenchent elles-mêmes jamais de nouvel appel Docker.
  await new Promise((resolve) => {
    const unsubscribe = dockerService.onSnapshot((snapshot) => {
      unsubscribe();
      resolve(snapshot);
    });
    dockerService.start();
  });
  dockerService.stop();
});

test.after(() => {
  fakeDockerd.close();
  if (fsSync.existsSync(SOCKET_PATH)) fsSync.unlinkSync(SOCKET_PATH);
});

test("GET /status — refusé sans permission docker_read (403)", async () => {
  const { server, baseUrl } = await startApiServer(NO_PERMS_USER);
  const { status } = await getJson(`${baseUrl}/status`);
  assert.equal(status, 403);
  await stopApiServer(server);
});

test("GET /status — autorisé pour un rôle en lecture seule (auditor)", async () => {
  const { server, baseUrl } = await startApiServer(READ_ONLY_USER);
  const { status, body } = await getJson(`${baseUrl}/status`);
  assert.equal(status, 200);
  assert.equal(body.enabled, true);
  assert.equal(body.available, true);
  await stopApiServer(server);
});

test("GET /containers — liste les conteneurs du cache pour un admin", async () => {
  const { server, baseUrl } = await startApiServer(ADMIN);
  const { status, body } = await getJson(`${baseUrl}/containers`);
  assert.equal(status, 200);
  assert.equal(body.containers.length, 1);
  assert.equal(body.containers[0].name, "postgres");
  await stopApiServer(server);
});

test("GET /containers/:id — trouve un conteneur par ID complet ou préfixe court", async () => {
  const { server, baseUrl } = await startApiServer(FULL_USER);
  const full = await getJson(`${baseUrl}/containers/abc123456789`);
  assert.equal(full.status, 200);
  assert.equal(full.body.name, "postgres");

  const short = await getJson(`${baseUrl}/containers/abc123`);
  assert.equal(short.status, 200);
  assert.equal(short.body.id, "abc123456789");
  await stopApiServer(server);
});

test("GET /containers/:id — 404 pour un conteneur inexistant", async () => {
  const { server, baseUrl } = await startApiServer(FULL_USER);
  const { status } = await getJson(`${baseUrl}/containers/does-not-exist`);
  assert.equal(status, 404);
  await stopApiServer(server);
});

test("GET /containers/:id/logs — refusé avec docker_read seul, sans docker_logs (403)", async () => {
  const { server, baseUrl } = await startApiServer(READ_ONLY_USER);
  const { status } = await getJson(`${baseUrl}/containers/abc123456789/logs`);
  assert.equal(status, 403);
  await stopApiServer(server);
});

test("GET /containers/:id/logs — autorisé avec docker_logs, logs démultiplexés", async () => {
  const { server, baseUrl } = await startApiServer(FULL_USER);
  const { status, body } = await getJson(`${baseUrl}/containers/abc123456789/logs`);
  assert.equal(status, 200);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].type, "out");
  assert.equal(body.results[0].text, "database is ready");
  await stopApiServer(server);
});

test("GET /containers/:id/logs — 404 pour un conteneur inexistant", async () => {
  const { server, baseUrl } = await startApiServer(FULL_USER);
  const { status } = await getJson(`${baseUrl}/containers/ghost/logs`);
  assert.equal(status, 404);
  await stopApiServer(server);
});

test("Aucune action de mutation Docker n'est exposée (read-only strict)", () => {
  const dockerRouter = require("../../lib/routes/docker");
  const router = dockerRouter();
  const methods = router.stack.map((layer) => Object.keys(layer.route.methods)[0]);
  assert.ok(
    methods.every((m) => m === "get"),
    `attendu uniquement des routes GET, obtenu : ${methods.join(", ")}`,
  );
});
