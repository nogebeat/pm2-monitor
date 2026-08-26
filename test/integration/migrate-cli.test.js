"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const MIGRATE_BIN = path.join(PROJECT_ROOT, "bin", "migrate.js");

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-cli-test-"));
  return path.join(dir, "monitor.db");
}

async function runMigrate(args, dbPath) {
  return execFileAsync(process.execPath, [MIGRATE_BIN, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DB_SQLITE_PATH: dbPath, DB_DRIVER: "sqlite" },
  });
}

test("bin/migrate.js CLI (process réel, pas juste la lib)", async (t) => {
  await t.test("status sur base neuve liste les migrations en attente", async () => {
    const dbPath = tmpDbPath();
    const { stdout } = await runMigrate(["status"], dbPath);
    assert.match(stdout, /001_initial_schema/);
    assert.match(stdout, /002_job_queue/);
    assert.match(stdout, /003_alert_engine/);
    assert.match(stdout, /004_process_metrics/);
    assert.match(stdout, /005_process_events/);
    assert.match(stdout, /006_notifications/);
    assert.match(stdout, /007_notification_routing_templates/);
    assert.match(stdout, /008_health_checks/);
    assert.match(stdout, /009_auto_healing/);
    assert.match(stdout, /010_health_checks_process_name/);
    assert.match(stdout, /011_audit_log/);
    assert.match(stdout, /012_servers/);
    assert.match(stdout, /013_process_metrics_analytics/);
    assert.match(stdout, /014_process_metrics_server_key/);
    assert.match(stdout, /015_process_organization/);
    assert.match(stdout, /016_incidents/);
    assert.match(stdout, /017_servers_last_processes/);
    assert.match(stdout, /018_anomaly_detection/);
    assert.match(stdout, /en attente \(18\)/);
  });

  await t.test("up puis status reflète la base à jour, ré-exécuter up est un no-op", async () => {
    const dbPath = tmpDbPath();
    const { stdout: upOut } = await runMigrate(["up"], dbPath);
    assert.match(upOut, /001_initial_schema/);
    assert.match(upOut, /002_job_queue/);
    assert.match(upOut, /003_alert_engine/);
    assert.match(upOut, /004_process_metrics/);
    assert.match(upOut, /005_process_events/);
    assert.match(upOut, /006_notifications/);
    assert.match(upOut, /007_notification_routing_templates/);
    assert.match(upOut, /008_health_checks/);
    assert.match(upOut, /009_auto_healing/);
    assert.match(upOut, /010_health_checks_process_name/);
    assert.match(upOut, /011_audit_log/);
    assert.match(upOut, /012_servers/);
    assert.match(upOut, /013_process_metrics_analytics/);
    assert.match(upOut, /014_process_metrics_server_key/);
    assert.match(upOut, /015_process_organization/);
    assert.match(upOut, /016_incidents/);
    assert.match(upOut, /017_servers_last_processes/);
    assert.match(upOut, /018_anomaly_detection/);

    const { stdout: statusOut } = await runMigrate(["status"], dbPath);
    assert.match(statusOut, /appliquées \(18\)/);
    assert.match(statusOut, /en attente \(0\)/);

    const { stdout: secondUpOut } = await runMigrate(["up"], dbPath);
    assert.match(secondUpOut, /déjà à jour/);
  });

  await t.test(
    "installation existante : DB legacy (tables déjà créées, pas de schema_migrations)",
    async () => {
      const dbPath = tmpDbPath();

      // Simule une base créée par une version antérieure du projet (avant le
      // système de migrations), avec un compte admin déjà en place.
      const Database = require("better-sqlite3");
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        app_name TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, app_name, action)
      );
    `);
      legacyDb
        .prepare("INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)")
        .run("admin", "existing-hash", 1, Date.now());
      legacyDb.close();

      // La migration doit passer sans erreur et sans toucher aux données existantes.
      const { stdout } = await runMigrate(["up"], dbPath);
      assert.match(stdout, /001_initial_schema/);
      assert.match(stdout, /002_job_queue/);
      assert.match(stdout, /003_alert_engine/);

      const verifyDb = new Database(dbPath);
      const admin = verifyDb.prepare("SELECT * FROM users WHERE username = 'admin'").get();
      assert.equal(admin.password_hash, "existing-hash", "le compte admin existant ne doit pas être perdu");

      const tables = verifyDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
      assert.ok(tables.includes("jobs"), "la nouvelle table jobs doit avoir été créée par la migration");
      assert.ok(tables.includes("alert_rules"), "la nouvelle table alert_rules doit avoir été créée");
      assert.ok(tables.includes("alerts"), "la nouvelle table alerts doit avoir été créée");
      verifyDb.close();
    },
  );

  await t.test("down annule la dernière migration puis status le reflète", async () => {
    const dbPath = tmpDbPath();
    await runMigrate(["up"], dbPath);
    const { stdout: downOut } = await runMigrate(["down"], dbPath);
    assert.match(downOut, /018_anomaly_detection/);

    const { stdout: statusOut } = await runMigrate(["status"], dbPath);
    assert.match(statusOut, /appliquées \(17\)/);
    assert.match(statusOut, /en attente \(1\)/);
  });
});
