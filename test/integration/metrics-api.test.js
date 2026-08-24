"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");

const metricsRouter = require("../../lib/routes/metrics");
const { fmtProcess } = require("../../lib/process-helpers");

/**
 * Monte lib/routes/metrics.js sur un vrai serveur HTTP, avec des doubles
 * minimaux pour pm2/serversStore/alertStore/healthChecksStore/agentHub —
 * même approche que test/integration/servers-api.test.js. Pas besoin d'une
 * vraie DB : ce fichier teste le routeur (format, auth, activation), pas
 * les stores eux-mêmes (déjà couverts ailleurs, ex: test/unit/servers-store.test.js).
 */
function fakePm2(processes) {
  return {
    list: (cb) => cb(null, processes),
  };
}

async function startServer({ processes = [], servers = [], alerts = [], healthChecks = [] } = {}) {
  const app = express();
  app.use(
    "/metrics",
    metricsRouter({
      pm2: fakePm2(processes),
      fmtProcess,
      getSystemSnapshot: () => ({
        cpu: 15,
        mem: { used: 100, total: 200, percent: 50 },
        disk: { used: 10, total: 100, percent: 10 },
      }),
      alertStore: { listActive: async () => alerts },
      healthChecksStore: { list: async () => healthChecks },
      serversStore: { list: async () => servers },
      agentHub: { isOnline: () => false },
    }),
  );

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/metrics` };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function pm2Process({ name = "api", status = "online", restartTime = 0, env = {} } = {}) {
  return {
    pm_id: 0,
    name,
    pid: 1234,
    monit: { cpu: 7.5, memory: 51200000 },
    pm2_env: {
      status,
      restart_time: restartTime,
      pm_uptime: Date.now() - 10_000,
      instances: 1,
      exec_mode: "fork",
      version: "1.0.0",
      watch: false,
      pm_exec_path: "/srv/app/index.js",
      args: [],
      pm_cwd: "/srv/app",
      env,
    },
  };
}

const LOCAL_SERVER = { serverKey: "local", name: "Serveur local", environment: "production", kind: "local" };

test("GET /metrics", async (t) => {
  const envBackup = { ...process.env };
  t.afterEach(() => {
    process.env = { ...envBackup };
  });

  await t.test(
    "expose le format Prometheus par défaut (accès loopback autorisé sans config explicite)",
    async () => {
      delete process.env.METRICS_ENABLED;
      delete process.env.METRICS_TOKEN;
      delete process.env.METRICS_ALLOWED_IPS;

      const { server, baseUrl } = await startServer({
        processes: [pm2Process({ name: "api", restartTime: 4 })],
        servers: [LOCAL_SERVER],
      });
      try {
        const res = await fetch(baseUrl);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") || "", /text\/plain/);
        assert.equal(res.headers.get("cache-control"), "no-store");
        const body = await res.text();
        assert.match(body, /^# HELP pm2_monitor_up/m);
        assert.match(
          body,
          /pm2_monitor_process_status\{process="api",server="local",environment="production",status="online"\} 1/,
        );
        assert.match(body, /pm2_monitor_process_restarts_total\{[^}]+\} 4/);
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test("METRICS_ENABLED=0 désactive complètement l'endpoint (404)", async () => {
    process.env.METRICS_ENABLED = "0";
    const { server, baseUrl } = await startServer({ processes: [], servers: [LOCAL_SERVER] });
    try {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await t.test(
    "METRICS_TOKEN défini : requête sans token -> 401, avec mauvais token -> 401, avec bon token -> 200",
    async () => {
      process.env.METRICS_TOKEN = "s3cret-token";
      delete process.env.METRICS_ALLOWED_IPS;
      const { server, baseUrl } = await startServer({ processes: [], servers: [LOCAL_SERVER] });
      try {
        const noAuth = await fetch(baseUrl);
        assert.equal(noAuth.status, 401);

        const badAuth = await fetch(baseUrl, { headers: { Authorization: "Bearer wrong" } });
        assert.equal(badAuth.status, 401);

        const goodAuth = await fetch(baseUrl, { headers: { Authorization: "Bearer s3cret-token" } });
        assert.equal(goodAuth.status, 200);
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test("METRICS_ALLOWED_IPS restreint l'accès : IP non listée -> 403", async () => {
    process.env.METRICS_ALLOWED_IPS = "10.0.0.5";
    delete process.env.METRICS_TOKEN;
    const { server, baseUrl } = await startServer({ processes: [], servers: [LOCAL_SERVER] });
    try {
      // La requête de test vient de 127.0.0.1, absente de la liste autorisée.
      const res = await fetch(baseUrl);
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("METRICS_ALLOWED_IPS incluant l'IP de test -> 200", async () => {
    process.env.METRICS_ALLOWED_IPS = "127.0.0.1,10.0.0.5";
    delete process.env.METRICS_TOKEN;
    const { server, baseUrl } = await startServer({ processes: [], servers: [LOCAL_SERVER] });
    try {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 200);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("n'expose jamais les variables d'environnement d'un process (secrets)", async () => {
    delete process.env.METRICS_ENABLED;
    delete process.env.METRICS_TOKEN;
    delete process.env.METRICS_ALLOWED_IPS;
    const { server, baseUrl } = await startServer({
      processes: [pm2Process({ name: "api", env: { DB_PASSWORD: "hunter2", STRIPE_KEY: "sk_live_xxx" } })],
      servers: [LOCAL_SERVER],
    });
    try {
      const res = await fetch(baseUrl);
      const body = await res.text();
      assert.ok(!body.includes("hunter2"));
      assert.ok(!body.includes("sk_live_xxx"));
      assert.ok(!body.includes("DB_PASSWORD"));
    } finally {
      await stopServer(server);
    }
  });

  await t.test(
    "cardinalité raisonnable : une ligne de statut par process, pas une par état PM2 possible",
    async () => {
      delete process.env.METRICS_ENABLED;
      delete process.env.METRICS_TOKEN;
      delete process.env.METRICS_ALLOWED_IPS;
      const { server, baseUrl } = await startServer({
        processes: [pm2Process({ name: "api" }), pm2Process({ name: "worker", status: "stopped" })],
        servers: [LOCAL_SERVER],
      });
      try {
        const res = await fetch(baseUrl);
        const body = await res.text();
        const statusLines = body.split("\n").filter((l) => l.startsWith("pm2_monitor_process_status{"));
        assert.equal(statusLines.length, 2);
      } finally {
        await stopServer(server);
      }
    },
  );
});
