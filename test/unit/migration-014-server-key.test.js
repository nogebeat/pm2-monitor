"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * 014_process_metrics_server_key reconstruit process_metrics_rollup (SQLite
 * ne sait pas modifier une contrainte UNIQUE en place) pour y ajouter
 * server_key. Ce test vérifie que la reconstruction ne perd ni ne corrompt
 * les lignes déjà écrites par un ancien schéma (004, avant Phase 11 et
 * multi-serveur) — le risque principal d'une migration "table rebuild".
 */
test("014_process_metrics_server_key : reconstruction de process_metrics_rollup", async (t) => {
  const ctx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  const db = require("../../lib/db");

  await t.test("les lignes écrites avant 014 survivent à la migration, avec server_key='local'", async () => {
    // Simule un déploiement existant : jusqu'à 013 inclus (donc process_metrics_rollup
    // au schéma 004, sans server_key), avec une ligne déjà présente.
    await migrator.up({ to: "013_process_metrics_analytics" });

    const now = Date.now();
    await db.run(
      `INSERT INTO process_metrics_rollup
        (process_name, resolution, bucket_start, cpu_avg, cpu_min, cpu_max, cpu_p95,
         memory_avg, memory_min, memory_max, memory_p95, instances_avg,
         restart_count_max, restart_delta, sample_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["legacy-app", "medium", 3_600_000, 12.5, 1, 30, 28, 1000, 500, 2000, 1900, 1, 3, 1, 240, now, now],
    );

    await migrator.up(); // applique 014

    const store = require("../../lib/services/process-history/store");
    const rows = await store.queryRollup({
      processName: "legacy-app",
      serverKey: "local",
      resolution: "medium",
      start: 0,
      end: 10_000_000,
    });
    assert.equal(rows.length, 1, "la ligne pré-existante n'a pas disparu pendant la reconstruction");
    assert.equal(rows[0].cpu.avg, 12.5);
    assert.equal(rows[0].memory.max, 2000);
    assert.equal(rows[0].restartCountMax, 3);
    assert.equal(rows[0].sampleCount, 240);
  });

  await cleanupDb(ctx);
});

test("014_process_metrics_server_key : la contrainte d'unicité inclut désormais server_key", async (t) => {
  const ctx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  const store = require("../../lib/services/process-history/store");

  await t.test("upsertRollup() pour deux serveurs différents ne collisionne pas même bucket/process", async () => {
    await store.upsertRollup({
      processName: "api",
      serverKey: "local",
      resolution: "medium",
      bucketStart: 1_800_000,
      cpu: { avg: 5, min: 5, max: 5, p95: 5 },
      memory: { avg: 10, min: 10, max: 10, p95: 10 },
      instancesAvg: 1,
      restartCountMax: 0,
      restartDelta: 0,
      sampleCount: 1,
    });
    await store.upsertRollup({
      processName: "api",
      serverKey: "srv-x",
      resolution: "medium",
      bucketStart: 1_800_000,
      cpu: { avg: 50, min: 50, max: 50, p95: 50 },
      memory: { avg: 100, min: 100, max: 100, p95: 100 },
      instancesAvg: 1,
      restartCountMax: 0,
      restartDelta: 0,
      sampleCount: 1,
    });

    const local = await store.queryRollup({
      processName: "api",
      serverKey: "local",
      resolution: "medium",
      start: 0,
      end: 5_000_000,
    });
    const remote = await store.queryRollup({
      processName: "api",
      serverKey: "srv-x",
      resolution: "medium",
      start: 0,
      end: 5_000_000,
    });
    assert.equal(local.length, 1);
    assert.equal(remote.length, 1);
    assert.equal(local[0].cpu.avg, 5);
    assert.equal(remote[0].cpu.avg, 50);
  });

  await cleanupDb(ctx);
});
