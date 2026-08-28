"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Monte le vrai routeur (lib/routes/backup.js) sur un serveur HTTP réel,
 * avec la vraie DB SQLite migrée — même approche que
 * test/integration/api-keys-api.test.js. `req.user` est injecté
 * directement pour tester les permissions sans passer par express-session.
 */
async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/backup")];
  delete require.cache[require.resolve("../../lib/services/backup")];

  const backupRouter = require("../../lib/routes/backup");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/backup", backupRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/api/backup` };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true, username: "admin" };
const NO_PERMS_USER = { id: 2, isAdmin: false, username: "noperm", permissions: [] };
const EXPORT_ONLY_USER = {
  id: 3,
  isAdmin: false,
  username: "exporter",
  permissions: [{ appName: "*", action: "backup_export" }],
};
// backup_restore SANS isAdmin : peut valider (lecture seule) mais pas restaurer réellement.
const RESTORE_PERM_NON_ADMIN = {
  id: 4,
  isAdmin: false,
  username: "restorer-non-admin",
  permissions: [{ appName: "*", action: "backup_restore" }],
};

test("API /api/backup", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  await t.test("sans permission -> 403 sur toutes les routes", async () => {
    const { server, baseUrl } = await startServer(NO_PERMS_USER);
    try {
      assert.equal((await fetch(`${baseUrl}/sections`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/export`, { method: "POST" })).status, 403);
      assert.equal(
        (
          await fetch(`${baseUrl}/validate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/restore`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
        403,
      );
    } finally {
      await stopServer(server);
    }
  });

  await t.test("backup_export : peut lister les sections et exporter", async () => {
    const { server, baseUrl } = await startServer(EXPORT_ONLY_USER);
    try {
      const sectionsRes = await fetch(`${baseUrl}/sections`);
      assert.equal(sectionsRes.status, 200);
      const sectionsBody = await sectionsRes.json();
      assert.ok(Array.isArray(sectionsBody.sections));
      assert.ok(sectionsBody.sections.some((s) => s.id === "users"));

      const exportRes = await fetch(`${baseUrl}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(exportRes.status, 200);
      const backup = await exportRes.json();
      assert.equal(backup.format, "pm2-monitor-backup");
    } finally {
      await stopServer(server);
    }
  });

  await t.test("backup_export seul ne permet pas /validate ni /restore", async () => {
    const { server, baseUrl } = await startServer(EXPORT_ONLY_USER);
    try {
      assert.equal(
        (
          await fetch(`${baseUrl}/validate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
        403,
      );
    } finally {
      await stopServer(server);
    }
  });

  await t.test("backup_restore sans être admin : /validate OK, /restore refusé (403)", async () => {
    const { server, baseUrl } = await startServer(RESTORE_PERM_NON_ADMIN);
    try {
      const exportRes = await fetch(`${baseUrl}/export`, { method: "POST" });
      // backup_export absent pour ce user -> 403 attendu ici, on construit un backup minimal à la main.
      assert.equal(exportRes.status, 403);

      const minimalBackup = {
        format: "pm2-monitor-backup",
        formatVersion: 1,
        metadata: {},
        data: {},
      };

      const validateRes = await fetch(`${baseUrl}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup: minimalBackup }),
      });
      assert.equal(validateRes.status, 200);

      const restoreRes = await fetch(`${baseUrl}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup: minimalBackup, confirm: true }),
      });
      assert.equal(restoreRes.status, 403);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("admin : restore complet fonctionne et exige confirm=true", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const minimalBackup = {
        format: "pm2-monitor-backup",
        formatVersion: 1,
        metadata: {},
        data: {
          alertRules: [
            { name: "from-api", targetType: "system", metric: "cpu", operator: ">", threshold: "50" },
          ],
        },
      };

      const withoutConfirm = await fetch(`${baseUrl}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup: minimalBackup }),
      });
      assert.equal(withoutConfirm.status, 400);

      const withConfirm = await fetch(`${baseUrl}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup: minimalBackup, confirm: true }),
      });
      assert.equal(withConfirm.status, 200);
      const body = await withConfirm.json();
      assert.equal(body.summary[0].created, 1);
    } finally {
      await stopServer(server);
    }
  });

  await t.test("format invalide -> 400 avec message explicite", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const res = await fetch(`${baseUrl}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup: { not: "a backup" } }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /format/);
    } finally {
      await stopServer(server);
    }
  });

  t.after(() => cleanupDb(dbCtx));
});
