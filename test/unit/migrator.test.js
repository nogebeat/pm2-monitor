"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

test("migrator", async (t) => {
  let ctx;

  t.beforeEach(async () => {
    ctx = await freshDb();
    // Le migrateur require()-cache lib/db/migrator, mais celui-ci ne garde
    // aucun état propre (il relit toujours process.env via db à chaque
    // appel) : pas besoin de vider le cache require entre les tests.
  });

  t.afterEach(async () => {
    await cleanupDb(ctx);
  });

  await t.test("status: tout est en attente sur une base vierge", async () => {
    const migrator = require("../../lib/db/migrator");
    const { applied, pending } = await migrator.status();
    assert.equal(applied.length, 0);
    assert.ok(pending.length >= 8, "au moins 001_initial_schema à 008_health_checks attendues");
    assert.equal(pending[0].version, "001_initial_schema");
  });

  await t.test("up() applique toutes les migrations en attente, dans l'ordre", async () => {
    const migrator = require("../../lib/db/migrator");
    const applied = await migrator.up();
    assert.deepEqual(applied, [
      "001_initial_schema",
      "002_job_queue",
      "003_alert_engine",
      "004_process_metrics",
      "005_process_events",
      "006_notifications",
      "007_notification_routing_templates",
      "008_health_checks",
      "009_auto_healing",
      "010_health_checks_process_name",
      "011_audit_log",
      "012_servers",
      "013_process_metrics_analytics",
      "014_process_metrics_server_key",
      "015_process_organization",
    ]);

    const status = await migrator.status();
    assert.equal(status.pending.length, 0);
    assert.equal(status.applied.length, 15);
  });

  await t.test("up() est idempotent : rejouer ne fait rien et ne plante pas", async () => {
    const migrator = require("../../lib/db/migrator");
    await migrator.up();
    const secondRun = await migrator.up();
    assert.deepEqual(secondRun, []);
  });

  await t.test("up() crée réellement les tables attendues", async () => {
    const migrator = require("../../lib/db/migrator");
    const db = require("../../lib/db");
    await migrator.up();
    const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'", [])).map(
      (r) => r.name,
    );
    assert.ok(tables.includes("users"));
    assert.ok(tables.includes("permissions"));
    assert.ok(tables.includes("jobs"));
    assert.ok(tables.includes("alert_rules"));
    assert.ok(tables.includes("alerts"));
    assert.ok(tables.includes("notification_providers"));
    assert.ok(tables.includes("notification_routes"));
    assert.ok(tables.includes("notification_history"));
    assert.ok(tables.includes("schema_migrations"));
    assert.ok(tables.includes("health_checks"));
    assert.ok(tables.includes("auto_healing_settings"));
    assert.ok(tables.includes("auto_healing_state"));
    assert.ok(tables.includes("auto_healing_audit"));
    assert.ok(tables.includes("audit_log"));
    assert.ok(tables.includes("servers"));
    assert.ok(tables.includes("user_servers"));
    assert.ok(tables.includes("tags"));
    assert.ok(tables.includes("environments"));
    assert.ok(tables.includes("process_groups"));
    assert.ok(tables.includes("process_tags"));
    assert.ok(tables.includes("process_environment"));
    assert.ok(tables.includes("process_group_members"));
  });

  await t.test(
    "down({ steps: 2 }) annule 015 puis 014 (reconstruction rollup vers le schéma 004)",
    async () => {
      const migrator = require("../../lib/db/migrator");
      const db = require("../../lib/db");
      await migrator.up();

      const reverted = await migrator.down({ steps: 2 });
      assert.deepEqual(reverted, ["015_process_organization", "014_process_metrics_server_key"]);

      const status = await migrator.status();
      assert.deepEqual(
        status.applied.map((m) => m.version),
        [
          "001_initial_schema",
          "002_job_queue",
          "003_alert_engine",
          "004_process_metrics",
          "005_process_events",
          "006_notifications",
          "007_notification_routing_templates",
          "008_health_checks",
          "009_auto_healing",
          "010_health_checks_process_name",
          "011_audit_log",
          "012_servers",
          "013_process_metrics_analytics",
        ],
      );

      // 012 (toujours appliquée ici) garde ses tables ; le rollback de 014
      // reconstruit process_metrics_rollup vers le schéma 004 mais ne touche à
      // aucune autre table. Le rollback de 015 retire ses propres tables.
      const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'", [])).map(
        (r) => r.name,
      );
      assert.ok(
        tables.includes("servers") && tables.includes("user_servers"),
        "servers/user_servers (Phase 10/012) ne sont pas affectées par le rollback de 014/015",
      );
      assert.ok(
        tables.includes("audit_log"),
        "audit_log (Phase 9/011) n'est pas affectée par le rollback de 014/015",
      );
      assert.ok(
        tables.includes("auto_healing_settings"),
        "auto_healing_settings (Phase 7/009) n'est pas affectée par le rollback de 014/015",
      );
      assert.ok(
        tables.includes("health_checks"),
        "health_checks (Phase 6/008) n'est pas affectée par le rollback de 014/015",
      );
      assert.ok(
        tables.includes("notification_providers"),
        "notification_providers (Phase 5A/006) n'est pas affectée par le rollback de 014/015",
      );
      assert.ok(tables.includes("notification_routes"));
      assert.ok(
        tables.includes("process_events"),
        "process_events ne doit pas être affectée par le rollback de 014/015",
      );
      assert.ok(
        !tables.includes("tags") && !tables.includes("process_group_members"),
        "les tables de 015 doivent avoir été supprimées par son rollback",
      );
    },
  );

  await t.test("down({ steps: 4 }) annule les quatre dernières migrations (015 à 012)", async () => {
    const migrator = require("../../lib/db/migrator");
    await migrator.up();
    const reverted = await migrator.down({ steps: 4 });
    assert.deepEqual(reverted, [
      "015_process_organization",
      "014_process_metrics_server_key",
      "013_process_metrics_analytics",
      "012_servers",
    ]);

    const status = await migrator.status();
    assert.equal(status.applied.length, 11);
  });

  await t.test("down() sur une base vierge (rien d'appliqué) ne fait rien", async () => {
    const migrator = require("../../lib/db/migrator");
    const reverted = await migrator.down();
    assert.deepEqual(reverted, []);
  });

  await t.test("rollback en cas d'échec en cours de migration (transaction sqlite)", async () => {
    const migrator = require("../../lib/db/migrator");
    const db = require("../../lib/db");

    // Migration factice qui échoue après avoir créé une table : la
    // transaction doit tout annuler, y compris le CREATE TABLE (DDL
    // transactionnel sous SQLite).
    const failingMigration = {
      version: "999_failing",
      description: "test",
      up: async (dbi) => {
        await dbi.run("CREATE TABLE should_not_survive (id INTEGER PRIMARY KEY)");
        throw new Error("boom");
      },
      down: async () => {},
    };

    await db.beginTransaction().catch(() => {}); // s'assurer qu'on part d'un état propre (no-op ici)
    await db.rollback().catch(() => {});

    await assert.rejects(async () => {
      // Reproduit applyOne() manuellement puisque loadMigrations() lit le disque.
      await db.beginTransaction();
      try {
        await failingMigration.up(db);
        await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
          failingMigration.version,
          Date.now(),
        ]);
        await db.commit();
      } catch (e) {
        await db.rollback();
        throw e;
      }
    }, /boom/);

    const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'", [])).map(
      (r) => r.name,
    );
    assert.ok(!tables.includes("should_not_survive"), "le CREATE TABLE doit avoir été annulé");

    const applied = await migrator.getAppliedVersions();
    assert.ok(!applied.includes("999_failing"));
  });
});
