"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

test("services/reports/system-history-store", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  const store = require("../../lib/services/reports/system-history-store");
  const DAY = 24 * 60 * 60 * 1000;

  await t.test(
    "recordFromHistoryStore() — écrit un point, puis throttle jusqu'à PERSIST_INTERVAL_MS",
    async () => {
      store._resetThrottleForTests();
      const now = 1_000_000_000_000;
      const wrote1 = await store.recordFromHistoryStore(
        { t: now, cpu: 10, memPercent: 20, diskPercent: 30 },
        now,
      );
      assert.equal(wrote1, true);

      const wrote2 = await store.recordFromHistoryStore(
        { t: now + 1000, cpu: 11, memPercent: 21, diskPercent: 31 },
        now + 1000,
      );
      assert.equal(wrote2, false); // trop tôt

      const wrote3 = await store.recordFromHistoryStore(
        { t: now + store.PERSIST_INTERVAL_MS, cpu: 12, memPercent: 22, diskPercent: 32 },
        now + store.PERSIST_INTERVAL_MS,
      );
      assert.equal(wrote3, true);

      const rows = await store.querySince(now - 1, now + store.PERSIST_INTERVAL_MS + 1);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].cpu_percent, 10);
      assert.equal(rows[1].cpu_percent, 12);
    },
  );

  await t.test("recordFromHistoryStore() — no-op si sample absent", async () => {
    store._resetThrottleForTests();
    const wrote = await store.recordFromHistoryStore(null, Date.now());
    assert.equal(wrote, false);
  });

  await t.test("querySince() — filtre bien sur la plage demandée", async () => {
    store._resetThrottleForTests();
    const db = require("../../lib/db");
    const now = 2_000_000_000_000;
    await db.run(
      `INSERT INTO system_metrics_history (ts, cpu_percent, mem_percent, disk_percent, created_at) VALUES (?, ?, ?, ?, ?)`,
      [now - 10 * DAY, 1, 1, 1, now],
    );
    await db.run(
      `INSERT INTO system_metrics_history (ts, cpu_percent, mem_percent, disk_percent, created_at) VALUES (?, ?, ?, ?, ?)`,
      [now - 1 * DAY, 2, 2, 2, now],
    );
    const rows = await store.querySince(now - 5 * DAY, now);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cpu_percent, 2);
  });

  await t.test("purgeOlderThan() — supprime les points au-delà du cutoff", async () => {
    const db = require("../../lib/db");
    const now = 3_000_000_000_000;
    await db.run(
      `INSERT INTO system_metrics_history (ts, cpu_percent, mem_percent, disk_percent, created_at) VALUES (?, ?, ?, ?, ?)`,
      [now - 500 * DAY, 5, 5, 5, now],
    );
    const deleted = await store.purgeOlderThan(now - 400 * DAY);
    assert.ok(deleted >= 1);
    const remaining = await store.querySince(now - 600 * DAY, now);
    assert.equal(
      remaining.some((r) => r.cpu_percent === 5),
      false,
    );
  });

  await cleanupDb(dbCtx);
});
