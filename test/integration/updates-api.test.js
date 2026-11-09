"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");

/**
 * Routeur /api/updates : RBAC (updates_read) et forme des réponses, sans
 * réseau (service factice). Même approche que docker-api.test.js : vrai routeur,
 * vrai serveur HTTP, req.user injecté.
 */

process.env.PM2_MONITOR_DISABLE_AUTH = "0";

const STATUS = {
  enabled: true,
  repo: "nogebeat/pm2-monitor",
  checkedAt: 1,
  current: { version: "4.1.2", valid: true },
  updateAvailable: true,
  latest: { tag: "v4.2.0", version: "4.2.0", type: "minor" },
  pending: [],
  error: null,
};

function fakeService() {
  const calls = { check: [], diagnostics: [] };
  return {
    calls,
    getStatus: () => STATUS,
    check: async (opts) => {
      calls.check.push(opts);
      return { ran: true };
    },
    getDiagnostics: async (opts) => {
      calls.diagnostics.push(opts);
      return { canSelfUpdate: true, checks: [], command: "cd '/x' && ./deploy.sh update" };
    },
  };
}

async function startApi(user, updateService) {
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/updates")];
  const updatesRouter = require("../../lib/routes/updates");
  const app = express();
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.use("/api/updates", updatesRouter({ updateService }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/api/updates` };
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS = { id: 2, isAdmin: false, permissions: [] };
// Aucun rôle prédéfini (viewer/operator/auditor) n'inclut updates_read : un autre droit ne suffit pas.
const OPERATOR_LIKE = {
  id: 3,
  isAdmin: false,
  permissions: [
    { appName: "*", action: "view" },
    { appName: "*", action: "docker_read" },
  ],
};
const GRANTED = { id: 4, isAdmin: false, permissions: [{ appName: "*", action: "updates_read" }] };

test("RBAC — les trois routes exigent updates_read", async (t) => {
  for (const user of [NO_PERMS, OPERATOR_LIKE]) {
    await t.test(`refusé (403) pour ${JSON.stringify(user.permissions.map((p) => p.action))}`, async () => {
      const { server, baseUrl } = await startApi(user, fakeService());
      const results = await Promise.all([
        fetch(`${baseUrl}/status`),
        fetch(`${baseUrl}/diagnostics`),
        fetch(`${baseUrl}/check`, { method: "POST" }),
      ]);
      server.close();
      assert.deepEqual(
        results.map((r) => r.status),
        [403, 403, 403],
      );
    });
  }

  await t.test("autorisé pour un admin et pour un droit updates_read accordé", async () => {
    for (const user of [ADMIN, GRANTED]) {
      const { server, baseUrl } = await startApi(user, fakeService());
      const res = await fetch(`${baseUrl}/status`);
      server.close();
      assert.equal(res.status, 200);
    }
  });
});

test("routes", async (t) => {
  await t.test("GET /status renvoie l'état du service", async () => {
    const { server, baseUrl } = await startApi(ADMIN, fakeService());
    const body = await (await fetch(`${baseUrl}/status`)).json();
    server.close();
    assert.equal(body.updateAvailable, true);
    assert.equal(body.latest.tag, "v4.2.0");
  });

  await t.test("POST /check force la vérification et indique si elle a été limitée", async () => {
    const svc = fakeService();
    svc.check = async (opts) => {
      svc.calls.check.push(opts);
      return { ran: false, throttled: true };
    };
    const { server, baseUrl } = await startApi(ADMIN, svc);
    const body = await (await fetch(`${baseUrl}/check`, { method: "POST" })).json();
    server.close();
    assert.deepEqual(svc.calls.check, [{ force: true }]);
    assert.equal(body.throttled, true);
    assert.equal(body.current.version, "4.1.2");
  });

  await t.test("GET /diagnostics ?refresh=1 force le recalcul", async () => {
    const svc = fakeService();
    const { server, baseUrl } = await startApi(ADMIN, svc);
    await fetch(`${baseUrl}/diagnostics`);
    await fetch(`${baseUrl}/diagnostics?refresh=1`);
    server.close();
    assert.deepEqual(svc.calls.diagnostics, [{ force: false }, { force: true }]);
  });

  await t.test("GET /diagnostics : erreur interne sans fuite de détail", async () => {
    const svc = fakeService();
    svc.getDiagnostics = async () => {
      throw new Error("/chemin/secret/introuvable");
    };
    const { server, baseUrl } = await startApi(ADMIN, svc);
    const res = await fetch(`${baseUrl}/diagnostics`);
    const text = await res.text();
    server.close();
    assert.equal(res.status, 500);
    assert.ok(!text.includes("secret"));
  });
});

test("aucune route de mutation autre que la revérification", async () => {
  const router = require("../../lib/routes/updates")({ updateService: fakeService() });
  const routes = router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  assert.deepEqual(routes.sort(), ["GET /diagnostics", "GET /status", "POST /check"]);
});
