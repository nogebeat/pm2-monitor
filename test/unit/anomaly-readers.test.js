"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const {
  readSystemSeries,
  readProcessNumericSeries,
  readCountSeries,
} = require("../../lib/services/anomaly-detection/readers");

function makeRule(overrides = {}) {
  return {
    id: 1,
    metric: "cpu",
    windowMs: 60 * 60 * 1000, // 1h
    minSamples: 5,
    ...overrides,
  };
}

test("readSystemSeries() — extrait value + history depuis lib/history-store.js, exclut l'échantillon courant", () => {
  const now = 1_000_000;
  const historyStore = {
    samples: [
      { t: now - 30000, cpu: 10, memPercent: 40 },
      { t: now - 20000, cpu: 12, memPercent: 41 },
      { t: now - 10000, cpu: 11, memPercent: 42 },
      { t: now, cpu: 99, memPercent: 90 }, // échantillon "courant" déjà poussé (voir lib/polling.js)
    ],
  };
  const snapshot = { t: now, cpu: 99, mem: { percent: 90 } };
  const reading = readSystemSeries({ rule: makeRule(), snapshot, historyStore, now });
  assert.ok(reading);
  assert.equal(reading.value, 99);
  assert.deepEqual(
    reading.history,
    [10, 12, 11],
    "l'échantillon au même t que le snapshot est exclu de la baseline",
  );
});

test("readSystemSeries() — pas de historyStore -> null", () => {
  const reading = readSystemSeries({
    rule: makeRule(),
    snapshot: { t: 1, cpu: 5 },
    historyStore: null,
    now: 1,
  });
  assert.equal(reading, null);
});

test("readSystemSeries() — métrique indisponible (ex: pas de mem dans le snapshot) -> null", () => {
  const historyStore = { samples: [] };
  const reading = readSystemSeries({
    rule: makeRule({ metric: "memory" }),
    snapshot: { t: 1, cpu: 5 }, // pas de `mem`
    historyStore,
    now: 1,
  });
  assert.equal(reading, null);
});

test("readProcessNumericSeries() + readCountSeries() — avec DB réelle (SQLite temporaire)", async (t) => {
  let ctx;
  t.beforeEach(async () => {
    ctx = await freshDb();
    const migrator = require("../../lib/db/migrator");
    await migrator.up();
  });
  t.afterEach(async () => {
    await cleanupDb(ctx);
  });

  await t.test("readProcessNumericSeries() — cpu : historique depuis process_metrics_raw", async () => {
    const store = require("../../lib/services/process-history/store");
    const now = 1_000_000_000;
    for (let i = 0; i < 5; i++) {
      await store.insertRaw({ processName: "api", ts: now - (5 - i) * 1000, cpu: 40 + i, memory: 100 });
    }
    const proc = { name: "api", cpu: 90 };
    const reading = await readProcessNumericSeries({
      rule: makeRule({ windowMs: 60000 }),
      proc,
      processHistoryStore: store,
      now,
    });
    assert.ok(reading);
    assert.equal(reading.value, 90);
    assert.equal(reading.history.length, 5);
  });

  await t.test(
    "readProcessNumericSeries() — memory : conversion octets -> Mo cohérente avec collector.js",
    async () => {
      const store = require("../../lib/services/process-history/store");
      const now = 1_000_000_000;
      const bytesPerSample = 50 * 1024 * 1024; // 50 Mo
      await store.insertRaw({ processName: "api", ts: now - 1000, cpu: 1, memory: bytesPerSample });
      const proc = { name: "api", cpu: 1, memory: bytesPerSample };
      const reading = await readProcessNumericSeries({
        rule: makeRule({ metric: "memory", windowMs: 60000, minSamples: 1 }),
        proc,
        processHistoryStore: store,
        now,
      });
      assert.ok(reading);
      assert.equal(reading.value, 50, "collector.js#readProcessMetric convertit déjà proc.memory en Mo");
      assert.equal(reading.history[0], 50, "l'historique doit être converti dans la même unité (Mo)");
    },
  );

  await t.test("readProcessNumericSeries() — pas de store -> null", async () => {
    const reading = await readProcessNumericSeries({
      rule: makeRule(),
      proc: { name: "api", cpu: 1 },
      processHistoryStore: null,
      now: Date.now(),
    });
    assert.equal(reading, null);
  });

  await t.test("readCountSeries() — restart_rate : compte les events 'restarted' par bucket", async () => {
    const eventStore = require("../../lib/services/events/event-store");
    const now = 2_000_000_000_000; // grand nombre : buckets d'1h dans le passé restent >= 0
    // 3 restarts dans le bucket courant (dernière heure)
    for (let i = 0; i < 3; i++) {
      await eventStore.create({
        timestamp: now - i * 1000,
        type: "restarted",
        severity: "warning",
        process: "api",
      });
    }
    // 1 restart il y a 2h (dans une baseline)
    await eventStore.create({
      timestamp: now - 2 * 60 * 60 * 1000,
      type: "restarted",
      severity: "warning",
      process: "api",
    });

    const rule = makeRule({ metric: "restart_rate", windowMs: 24 * 60 * 60 * 1000, minSamples: 1 });
    const reading = await readCountSeries({
      rule,
      targetType: "process",
      targetValue: "api",
      eventStore,
      now,
    });
    assert.ok(reading);
    assert.equal(reading.value, 3, "3 restarts comptés dans le bucket courant (dernière heure)");
    assert.ok(reading.history.length >= 2, "au moins les 2 buckets précédents dans la fenêtre de 24h");
  });

  await t.test("readCountSeries() — pas de eventStore -> null", async () => {
    const reading = await readCountSeries({
      rule: makeRule({ metric: "event_rate" }),
      targetType: "system",
      targetValue: null,
      eventStore: null,
      now: Date.now(),
    });
    assert.equal(reading, null);
  });
});
