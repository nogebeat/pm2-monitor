"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Teste ProcessHistoryService#analytics() de bout en bout contre une vraie DB
 * SQLite temporaire, dans l'esprit de process-history-api.test.js (record()
 * puis lecture) : ici record() suivi de analytics() plutôt que query().
 * Les crashes réutilisent lib/services/events/event-store — testés via cette
 * même DB, en insérant directement un événement "crashed" (comme le ferait
 * lib/services/events/ à la réception d'un event PM2, hors scope ici).
 */
test("ProcessHistoryService#analytics() (Phase 11)", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  const { ProcessHistoryService } = require("../../lib/services/process-history");
  const eventStore = require("../../lib/services/events/event-store");

  await t.test("période sans données -> stats null, disponibilité null, 0 crash", async () => {
    const svc = new ProcessHistoryService({ PROCESS_HISTORY_ENABLED: "1" });
    const now = 1_000_000_000;
    const result = await svc.analytics({
      processName: "empty-app",
      start: now - 3_600_000,
      end: now,
      resolution: "raw",
      compare: false,
    });
    assert.equal(result.current.cpu.avg, null);
    assert.equal(result.current.availabilityPercent, null);
    assert.equal(result.current.restarts, null);
    assert.equal(result.current.crashes, 0);
    assert.equal(result.current.sampleCount, 0);
  });

  await t.test("agrège cpu/memory/restarts/disponibilité sur des échantillons raw", async () => {
    const svc = new ProcessHistoryService({ PROCESS_HISTORY_ENABLED: "1" });
    const t0 = 2_000_000_000;
    const minute = 60_000;

    // 4 échantillons : 3 online, 1 stopped -> disponibilité 75%.
    await svc.record(
      [{ name: "api", cpu: 10, memory: 1000, restarts: 1, instances: 1, status: "online", uptime: t0 }],
      t0,
    );
    await svc.record(
      [{ name: "api", cpu: 20, memory: 2000, restarts: 1, instances: 1, status: "online", uptime: t0 }],
      t0 + minute,
    );
    await svc.record(
      [{ name: "api", cpu: 30, memory: 3000, restarts: 2, instances: 1, status: "stopped", uptime: t0 }],
      t0 + 2 * minute,
    );
    await svc.record(
      [{ name: "api", cpu: 40, memory: 4000, restarts: 3, instances: 1, status: "online", uptime: t0 }],
      t0 + 3 * minute,
    );

    const result = await svc.analytics({
      processName: "api",
      start: t0 - 1000,
      end: t0 + 4 * minute,
      resolution: "raw",
      compare: false,
    });

    assert.equal(result.current.sampleCount, 4);
    assert.equal(result.current.cpu.avg, 25); // (10+20+30+40)/4
    assert.equal(result.current.cpu.max, 40);
    assert.equal(result.current.cpu.min, 10);
    assert.equal(result.current.memory.avg, 2500);
    assert.equal(result.current.restarts, 2, "restartDelta = max(3) - min(1)");
    assert.equal(result.current.availabilityPercent, 75, "3 online sur 4 échantillons");
  });

  await t.test("compte les crashes (events/event-store) sur la période demandée", async () => {
    const svc = new ProcessHistoryService({ PROCESS_HISTORY_ENABLED: "1" });
    const t0 = 3_000_000_000;

    await svc.record([{ name: "flaky", cpu: 1, status: "online", uptime: t0 }], t0);

    await eventStore.create({ process: "flaky", type: "crashed", severity: "critical", timestamp: t0 + 1000 });
    await eventStore.create({ process: "flaky", type: "crashed", severity: "critical", timestamp: t0 + 2000 });
    // Hors période demandée ci-dessous -> ne doit pas être compté.
    await eventStore.create({ process: "flaky", type: "crashed", severity: "critical", timestamp: t0 - 100_000 });

    const result = await svc.analytics({
      processName: "flaky",
      start: t0,
      end: t0 + 10_000,
      resolution: "raw",
      compare: false,
    });
    assert.equal(result.current.crashes, 2);
  });

  await t.test("compare avec la période précédente de même durée et calcule les deltas", async () => {
    const svc = new ProcessHistoryService({ PROCESS_HISTORY_ENABLED: "1" });
    const hour = 60 * 60 * 1000;
    const t0 = 4_000_000_000;

    // Période précédente [t0-hour, t0) : cpu moyen 10.
    await svc.record([{ name: "cmp", cpu: 10, status: "online", uptime: t0 }], t0 - hour / 2);
    // Période courante [t0, t0+hour) : cpu moyen 20 (+100%).
    await svc.record([{ name: "cmp", cpu: 20, status: "online", uptime: t0 }], t0 + hour / 2);

    const result = await svc.analytics({
      processName: "cmp",
      start: t0,
      end: t0 + hour,
      resolution: "raw",
      compare: true,
    });

    assert.equal(result.previousStart, t0 - hour);
    assert.equal(result.previousEnd, t0);
    assert.equal(result.previous.cpu.avg, 10);
    assert.equal(result.current.cpu.avg, 20);
    assert.equal(result.deltas.cpuAvgPct, 100);
  });

  await t.test("analytics() rejette une resolution invalide et un start >= end", async () => {
    const svc = new ProcessHistoryService({ PROCESS_HISTORY_ENABLED: "1" });
    await assert.rejects(
      () => svc.analytics({ processName: "api", start: 0, end: 100, resolution: "bogus" }),
      /resolution invalide/,
    );
    await assert.rejects(
      () => svc.analytics({ processName: "api", start: 100, end: 50 }),
      /antérieur/,
    );
    await assert.rejects(() => svc.analytics({ start: 0, end: 100 }), /processName requis/);
  });

  await cleanupDb(dbCtx);
});
