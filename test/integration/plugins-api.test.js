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
 * Monte le vrai routeur du Plugin System (lib/routes/plugins.js) sur un
 * serveur HTTP réel, avec une DB SQLite temporaire migrée et un dossier de
 * plugins temporaire — même approche que
 * test/integration/service-dependencies-api.test.js.
 */

function writePlugin(dir, name, content) {
  const pluginDir = path.join(dir, name);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.js"), content, "utf8");
}

function clearPluginsCache() {
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/plugins")];
  delete require.cache[require.resolve("../../lib/services/plugins")];
  delete require.cache[require.resolve("../../lib/services/plugins/loader")];
  delete require.cache[require.resolve("../../lib/services/plugins/registry")];
  delete require.cache[require.resolve("../../lib/services/plugins/store")];
  delete require.cache[require.resolve("../../lib/services/plugins/context")];
}

async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  clearPluginsCache();

  const pluginsService = require("../../lib/services/plugins");
  await pluginsService.loadAll();

  const pluginsRouter = require("../../lib/routes/plugins");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/plugins", pluginsRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/plugins`;
  return { server, baseUrl };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true };
const NO_PERMS_USER = { id: 2, isAdmin: false, permissions: [] };
const READ_ONLY_USER = {
  id: 3,
  isAdmin: false,
  permissions: [{ appName: "*", action: "plugins_read" }],
};
const MANAGE_USER = {
  id: 4,
  isAdmin: false,
  permissions: [
    { appName: "*", action: "plugins_read" },
    { appName: "*", action: "plugins_manage" },
  ],
};

test("API /api/plugins", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-plugins-api-"));
  process.env.PM2_MONITOR_PLUGINS_DIR = tmpDir;
  writePlugin(
    tmpDir,
    "sample",
    `module.exports = {
      name: "sample",
      version: "1.0.0",
      pluginApiVersion: "1.0.0",
      init: async () => {},
      onDisable: async () => {},
    };`,
  );

  await t.test("admin : liste les plugins (200)", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 200);
      const list = await res.json();
      const entry = list.find((p) => p.name === "sample");
      assert.ok(entry);
      assert.equal(entry.status, "active");
      assert.equal(entry.enabled, true);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("admin : détail d'un plugin (200) et plugin inconnu (404)", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const found = await fetch(`${baseUrl}/sample`);
      assert.equal(found.status, 200);
      const entry = await found.json();
      assert.equal(entry.name, "sample");

      const missing = await fetch(`${baseUrl}/does-not-exist`);
      assert.equal(missing.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("sans permission : tout refusé (403)", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("plugins_read seul : GET ok, enable/disable/config refusés (403)", async () => {
    const { server, baseUrl } = await startServer(READ_ONLY_USER);
    try {
      const listed = await fetch(baseUrl);
      assert.equal(listed.status, 200);

      const disable = await fetch(`${baseUrl}/sample/disable`, { method: "POST" });
      assert.equal(disable.status, 403);

      const config = await fetch(`${baseUrl}/sample/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      assert.equal(config.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("plugins_manage : disable() puis enable() (200)", async () => {
    const { server, baseUrl } = await startServer(MANAGE_USER);
    try {
      const disabled = await fetch(`${baseUrl}/sample/disable`, { method: "POST" });
      assert.equal(disabled.status, 200);
      let body = await disabled.json();
      assert.equal(body.enabled, false);
      assert.equal(body.status, "disabled");

      const enabled = await fetch(`${baseUrl}/sample/enable`, { method: "POST" });
      assert.equal(enabled.status, 200);
      body = await enabled.json();
      assert.equal(body.enabled, true);
      assert.equal(body.status, "active");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("plugins_manage : enable() sur un plugin inconnu -> 400", async () => {
    const { server, baseUrl } = await startServer(MANAGE_USER);
    try {
      const res = await fetch(`${baseUrl}/ghost/enable`, { method: "POST" });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /introuvable/);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("plugins_manage : PUT config persiste et se reflète dans GET", async () => {
    const { server, baseUrl } = await startServer(MANAGE_USER);
    try {
      const res = await fetch(`${baseUrl}/sample/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: 10 }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.config, { threshold: 10 });

      const fetched = await fetch(`${baseUrl}/sample`);
      const entry = await fetched.json();
      assert.deepEqual(entry.config, { threshold: 10 });
    } finally {
      await stopServer(server);
    }
  });

  t.after(async () => {
    delete process.env.PM2_MONITOR_PLUGINS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await cleanupDb(dbCtx);
  });
});
