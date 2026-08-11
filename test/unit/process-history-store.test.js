"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

test("process-history store", async (t) => {
  let ctx;

  t.beforeEach(async () => {
    ctx = await freshDb();
    const migrator = require("../../lib/db/migrator");
    await migrator.up();
  });

  t.afterEach(async () => {
    await cleanupDb(ctx);
  });

  await t.test("insertRaw() + queryRaw() : round-trip complet", async () => {
    const store = require("../../lib/services/process-history/store");
    const now = Date.now();
    await store.insertRaw({
      processName: "api",
      ts: now,
      cpu: 12.5,
      memory: 104857600,
      restartCount: 3,
      instances: 2,
      status: "online",
      uptimeMs: 60000,
    });

    const rows = await store.queryRaw({ processName: "api", start: now - 1000, end: now + 1000 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cpu, 12.5);
    assert.equal(rows[0].memory, 104857600);
    assert.equal(rows[0].restartCount, 3);
    assert.equal(rows[0].status, "online");
  });

  await t.test("queryRaw() filtre par process_name et par plage de temps", async () => {
    const store = require("../../lib/services/process-history/store");
    const t0 = 1_000_000;
    await store.insertRawBatch([
      { processName: "api", ts: t0, cpu: 1 },
      { processName: "api", ts: t0 + 10_000, cpu: 2 },
      { processName: "worker", ts: t0 + 5_000, cpu: 99 }, // autre process, ne doit pas apparaître
      { processName: "api", ts: t0 + 100_000, cpu: 3 }, // hors plage demandée
    ]);

    const rows = await store.queryRaw({ processName: "api", start: t0, end: t0 + 20_000 });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.cpu), [1, 2]);
  });

  await t.test("listRawProcessNames() et rawTimeRange()", async () => {
    const store = require("../../lib/services/process-history/store");
    await store.insertRawBatch([
      { processName: "api", ts: 1000, cpu: 1 },
      { processName: "api", ts: 3000, cpu: 2 },
      { processName: "worker", ts: 2000, cpu: 1 },
    ]);

    const names = await store.listRawProcessNames();
    assert.deepEqual(names.sort(), ["api", "worker"]);

    const range = await store.rawTimeRange("api");
    assert.deepEqual(range, { minTs: 1000, maxTs: 3000 });

    assert.equal(await store.rawTimeRange("inconnu"), null);
  });

  await t.test("purgeRawOlderThan() supprime uniquement ce qui est avant le cutoff", async () => {
    const store = require("../../lib/services/process-history/store");
    await store.insertRawBatch([
      { processName: "api", ts: 1000, cpu: 1 },
      { processName: "api", ts: 5000, cpu: 2 },
      { processName: "api", ts: 9000, cpu: 3 },
    ]);

    const purged = await store.purgeRawOlderThan(5000);
    assert.equal(purged, 1, "seule la ligne ts=1000 est strictement avant le cutoff");

    const remaining = await store.queryRaw({ processName: "api", start: 0, end: 100000 });
    assert.deepEqual(remaining.map((r) => r.ts), [5000, 9000]);
  });

  await t.test("upsertRollup() : crée puis met à jour le même bucket (idempotent)", async () => {
    const store = require("../../lib/services/process-history/store");
    const bucket = {
      processName: "api",
      resolution: "medium",
      bucketStart: 3_600_000,
      cpu: { avg: 10, min: 5, max: 15, p95: 14 },
      memory: { avg: 100, min: 50, max: 150, p95: 140 },
      instancesAvg: 1,
      restartCountMax: 0,
      restartDelta: 0,
      sampleCount: 5,
    };
    await store.upsertRollup(bucket);

    let rows = await store.queryRollup({
      processName: "api",
      resolution: "medium",
      start: 0,
      end: 10_000_000,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cpu.avg, 10);
    assert.equal(rows[0].sampleCount, 5);

    // Ré-agrégation du même bucket (ex: rollup rejoué) : doit remplacer, pas dupliquer.
    await store.upsertRollup({ ...bucket, cpu: { ...bucket.cpu, avg: 20 }, sampleCount: 8 });
    rows = await store.queryRollup({ processName: "api", resolution: "medium", start: 0, end: 10_000_000 });
    assert.equal(rows.length, 1, "toujours un seul bucket, pas un doublon");
    assert.equal(rows[0].cpu.avg, 20);
    assert.equal(rows[0].sampleCount, 8);
  });

  await t.test("upsertRollup() distingue les résolutions pour le même bucket_start", async () => {
    const store = require("../../lib/services/process-history/store");
    const base = {
      processName: "api",
      bucketStart: 0,
      cpu: { avg: 1, min: 1, max: 1, p95: 1 },
      memory: { avg: 1, min: 1, max: 1, p95: 1 },
      instancesAvg: 1,
      restartCountMax: 0,
      restartDelta: 0,
      sampleCount: 1,
    };
    await store.upsertRollup({ ...base, resolution: "medium" });
    await store.upsertRollup({ ...base, resolution: "long" });

    const medium = await store.queryRollup({ processName: "api", resolution: "medium", start: 0, end: 1 });
    const long = await store.queryRollup({ processName: "api", resolution: "long", start: 0, end: 1 });
    assert.equal(medium.length, 1);
    assert.equal(long.length, 1);
  });

  await t.test("purgeRollupOlderThan() ne purge que la résolution demandée", async () => {
    const store = require("../../lib/services/process-history/store");
    const base = {
      processName: "api",
      cpu: { avg: 1, min: 1, max: 1, p95: 1 },
      memory: { avg: 1, min: 1, max: 1, p95: 1 },
      instancesAvg: 1,
      restartCountMax: 0,
      restartDelta: 0,
      sampleCount: 1,
    };
    await store.upsertRollup({ ...base, resolution: "medium", bucketStart: 1000 });
    await store.upsertRollup({ ...base, resolution: "long", bucketStart: 1000 });

    const purged = await store.purgeRollupOlderThan("medium", 5000);
    assert.equal(purged, 1);

    const medium = await store.queryRollup({ processName: "api", resolution: "medium", start: 0, end: 10000 });
    const long = await store.queryRollup({ processName: "api", resolution: "long", start: 0, end: 10000 });
    assert.equal(medium.length, 0, "medium purgé");
    assert.equal(long.length, 1, "long non affecté");
  });
});
