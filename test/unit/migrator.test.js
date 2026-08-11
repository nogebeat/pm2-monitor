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
    assert.ok(
      pending.length >= 3,
      "au moins 001_initial_schema, 002_job_queue et 003_alert_engine attendues"
    );
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
    ]);

    const status = await migrator.status();
    assert.equal(status.pending.length, 0);
    assert.equal(status.applied.length, 5);
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
    const tables = (
      await db.all("SELECT name FROM sqlite_master WHERE type = 'table'", [])
    ).map((r) => r.name);
    assert.ok(tables.includes("users"));
    assert.ok(tables.includes("permissions"));
    assert.ok(tables.includes("jobs"));
    assert.ok(tables.includes("alert_rules"));
    assert.ok(tables.includes("alerts"));
    assert.ok(tables.includes("schema_migrations"));
  });

  await t.test("down() annule la dernière migration appliquée", async () => {
    const migrator = require("../../lib/db/migrator");
    const db = require("../../lib/db");
    await migrator.up();

    const reverted = await migrator.down();
    assert.deepEqual(reverted, ["005_process_events"]);

    const status = await migrator.status();
    assert.deepEqual(
      status.applied.map((m) => m.version),
      ["001_initial_schema", "002_job_queue", "003_alert_engine", "004_process_metrics"]
    );

    const tables = (
      await db.all("SELECT name FROM sqlite_master WHERE type = 'table'", [])
    ).map((r) => r.name);
    assert.ok(
      !tables.includes("process_events"),
      "la table process_events doit avoir disparu après down()"
    );
    assert.ok(tables.includes("jobs"), "jobs ne doit pas être affectée par le rollback de 005");
  });

  await t.test("down({ steps: 3 }) annule les trois dernières migrations", async () => {
    const migrator = require("../../lib/db/migrator");
    await migrator.up();
    const reverted = await migrator.down({ steps: 3 });
    assert.deepEqual(reverted, ["005_process_events", "004_process_metrics", "003_alert_engine"]);

    const status = await migrator.status();
    assert.equal(status.applied.length, 2);
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

    const tables = (
      await db.all("SELECT name FROM sqlite_master WHERE type = 'table'", [])
    ).map((r) => r.name);
    assert.ok(!tables.includes("should_not_survive"), "le CREATE TABLE doit avoir été annulé");

    const applied = await migrator.getAppliedVersions();
    assert.ok(!applied.includes("999_failing"));
  });
});
