"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test("process-history rollup", async (t) => {
  let ctx;

  t.beforeEach(async () => {
    ctx = await freshDb();
    const migrator = require("../../lib/db/migrator");
    await migrator.up();
  });

  t.afterEach(async () => {
    await cleanupDb(ctx);
  });

  await t.test("completeBucketsSince() ne retient que les buckets terminés", () => {
    const { completeBucketsSince } = require("../../lib/services/process-history/rollup");
    const now = 3 * HOUR + 30 * 60 * 1000; // milieu du 4e bucket horaire
    const buckets = completeBucketsSince(0, now, HOUR);
    // buckets [0h,1h), [1h,2h), [2h,3h) sont terminés ; [3h,4h) est en cours -> exclu
    assert.deepEqual(buckets, [0, HOUR, 2 * HOUR]);
  });

  await t.test("rollup raw->medium : agrège uniquement les buckets horaires complets", async () => {
    const store = require("../../lib/services/process-history/store");
    const { runMaintenance } = require("../../lib/services/process-history/rollup");

    // 3 échantillons dans le bucket [0h,1h), 2 dans le bucket en cours [1h,2h)
    await store.insertRawBatch([
      { processName: "api", ts: 0, cpu: 10, memory: 100, restartCount: 0, instances: 1 },
      { processName: "api", ts: 10 * 60 * 1000, cpu: 20, memory: 200, restartCount: 0, instances: 1 },
      { processName: "api", ts: 50 * 60 * 1000, cpu: 30, memory: 300, restartCount: 1, instances: 1 },
      { processName: "api", ts: HOUR + 5 * 60 * 1000, cpu: 99, memory: 999, restartCount: 1, instances: 1 },
    ]);

    const now = HOUR + 10 * 60 * 1000; // 10 min dans le 2e bucket -> le 2e n'est pas terminé
    const config = {
      mediumBucketMs: HOUR,
      longBucketMs: DAY,
      shortRetentionMs: 24 * HOUR,
      mediumRetentionMs: 30 * DAY,
      longRetentionMs: 365 * DAY,
    };
    const report = await runMaintenance(config, now);

    assert.equal(report.mediumBucketsWritten, 1, "un seul bucket horaire complet à agréger");

    const rows = await store.queryRollup({
      processName: "api",
      resolution: "medium",
      start: 0,
      end: HOUR - 1,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cpu.avg, 20, "moyenne de 10/20/30");
    assert.equal(rows[0].sampleCount, 3);
    assert.equal(rows[0].restartDelta, 1);

    // Le bucket en cours (contenant l'échantillon à 99) ne doit PAS avoir été agrégé.
    const stillRunning = await store.queryRollup({
      processName: "api",
      resolution: "medium",
      start: HOUR,
      end: 2 * HOUR,
    });
    assert.equal(stillRunning.length, 0, "le bucket en cours n'est pas encore agrégé");
  });

  await t.test("rollup medium->long : agrège des buckets medium en un bucket journalier", async () => {
    const store = require("../../lib/services/process-history/store");
    const { runMaintenance } = require("../../lib/services/process-history/rollup");

    // 24 buckets medium (un par heure) couvrant tout le jour 0, avec des valeurs qui montent.
    for (let h = 0; h < 24; h++) {
      await store.upsertRollup({
        processName: "api",
        resolution: "medium",
        bucketStart: h * HOUR,
        cpu: { avg: h, min: h, max: h, p95: h },
        memory: { avg: h * 10, min: h * 10, max: h * 10, p95: h * 10 },
        instancesAvg: 1,
        restartCountMax: h,
        restartDelta: 1,
        sampleCount: 100,
      });
    }

    const now = DAY + 2 * HOUR; // largement après la fin du jour 0
    const config = {
      mediumBucketMs: HOUR,
      longBucketMs: DAY,
      shortRetentionMs: 24 * HOUR,
      mediumRetentionMs: 30 * DAY,
      longRetentionMs: 365 * DAY,
    };
    const report = await runMaintenance(config, now);
    assert.equal(report.longBucketsWritten, 1);

    const rows = await store.queryRollup({ processName: "api", resolution: "long", start: 0, end: DAY - 1 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cpu.avg, 11.5, "moyenne de 0..23");
    assert.equal(rows[0].cpu.max, 23, "max exact, pas une approximation");
    assert.equal(rows[0].restartCountMax, 23, "compteur monotone -> la valeur la plus haute");
    assert.equal(rows[0].restartDelta, 24, "somme des deltas horaires");
    assert.equal(rows[0].sampleCount, 2400);
  });

  await t.test("purge : respecte la rétention par résolution, tourne même sans rollup à faire", async () => {
    const store = require("../../lib/services/process-history/store");
    const { runMaintenance } = require("../../lib/services/process-history/rollup");

    const now = 10 * DAY;
    await store.insertRawBatch([
      { processName: "api", ts: 0, cpu: 1 }, // très vieux -> doit être purgé (rétention short = 1h ici)
      { processName: "api", ts: now - 1000, cpu: 2 }, // récent -> conservé
    ]);
    await store.upsertRollup({
      processName: "api",
      resolution: "medium",
      bucketStart: 0,
      cpu: { avg: 1, min: 1, max: 1, p95: 1 },
      memory: { avg: 1, min: 1, max: 1, p95: 1 },
      instancesAvg: 1,
      restartCountMax: 0,
      restartDelta: 0,
      sampleCount: 1,
    });

    const config = {
      mediumBucketMs: HOUR,
      longBucketMs: DAY,
      shortRetentionMs: HOUR, // très courte rétention pour forcer la purge du point ts=0
      mediumRetentionMs: HOUR, // idem pour le bucket medium à bucket_start=0
      longRetentionMs: 365 * DAY,
    };
    const report = await runMaintenance(config, now);

    assert.ok(report.rawPurged >= 1, "l'échantillon très ancien doit être purgé");
    assert.ok(report.mediumPurged >= 1, "le bucket medium très ancien doit être purgé");

    const remainingRaw = await store.queryRaw({ processName: "api", start: 0, end: now });
    assert.deepEqual(
      remainingRaw.map((r) => r.ts),
      [now - 1000],
      "seul l'échantillon récent survit",
    );
  });
});
