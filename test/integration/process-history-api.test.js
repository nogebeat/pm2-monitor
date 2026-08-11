"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Teste le service ProcessHistoryService de bout en bout contre une vraie DB
 * SQLite temporaire : record() (= ce que server.js appelle à chaque tick
 * pm2.list()) puis query() (= ce que consomme GET /api/processes/:id/metrics,
 * voir server.js). server.js lui-même n'expose pas ses routes comme module
 * testable isolément (contrairement à lib/routes/alerts.js) ; ce test couvre
 * donc le contrat service <-> DB qui alimente cette route, plutôt que le
 * transport HTTP — voir "Problèmes connus" dans le rapport de phase.
 */
test("ProcessHistoryService — record() puis query()", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  const { ProcessHistoryService } = require("../../lib/services/process-history");

  await t.test("record() insère un échantillon par process, query() le retrouve", async () => {
    const svc = new ProcessHistoryService({ PROCESS_HISTORY_ENABLED: "1" });
    const now = 1_000_000;
    const inserted = await svc.record(
      [
        { name: "api", cpu: 42, memory: 100 * 1024 * 1024, restarts: 2, instances: 1, status: "online", uptime: now - 5000 },
        { name: "worker", cpu: 5, memory: 50 * 1024 * 1024, restarts: 0, instances: 2, status: "online", uptime: now - 5000 },
      ],
      now
    );
    assert.equal(inserted, 2);

    const result = await svc.query({ processName: "api", start: now - 60_000, end: now + 1, resolution: "raw" });
    assert.equal(result.points.length, 1);
    assert.equal(result.points[0].cpu, 42);
    assert.equal(result.points[0].memory, 100 * 1024 * 1024);
  });

  await t.test("service désactivé -> record() ne persiste rien", async () => {
    const svc = new ProcessHistoryService({ PROCESS_HISTORY_ENABLED: "0" });
    const n = await svc.record([{ name: "api", cpu: 1 }], Date.now());
    assert.equal(n, 0);
  });

  await t.test("query() rejette un start >= end et une resolution invalide", async () => {
    const svc = new ProcessHistoryService({ PROCESS_HISTORY_ENABLED: "1" });
    await assert.rejects(() => svc.query({ processName: "api", start: 100, end: 50 }), /antérieur/);
    await assert.rejects(
      () => svc.query({ processName: "api", start: 0, end: 100, resolution: "bogus" }),
      /resolution invalide/
    );
  });

  await t.test("query() applique le filtre metrics (ne renvoie que les champs demandés)", async () => {
    const svc = new ProcessHistoryService({ PROCESS_HISTORY_ENABLED: "1" });
    const now = 2_000_000;
    await svc.record([{ name: "api2", cpu: 10, memory: 1000, restarts: 1, status: "online", uptime: now }], now);
    const result = await svc.query({
      processName: "api2",
      start: now - 1000,
      end: now + 1000,
      resolution: "raw",
      metrics: ["cpu"],
    });
    const point = result.points[0];
    assert.ok("cpu" in point);
    assert.ok(!("memory" in point), "memory ne doit pas être renvoyé, non demandé dans metrics");
  });

  await cleanupDb(dbCtx);
});
