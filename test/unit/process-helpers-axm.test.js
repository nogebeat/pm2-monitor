"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fmtProcess, readAxmMetrics } = require("../../lib/process-helpers");

test("readAxmMetrics()", async (t) => {
  await t.test("pm2_env sans axm_monitor -> tout null (pas d'invention de métrique)", () => {
    const r = readAxmMetrics({});
    assert.deepEqual(r, { heapUsedBytes: null, heapTotalBytes: null, eventLoopLagMs: null });
  });

  await t.test("pm2_env absent -> tout null", () => {
    const r = readAxmMetrics(null);
    assert.deepEqual(r, { heapUsedBytes: null, heapTotalBytes: null, eventLoopLagMs: null });
  });

  await t.test("Used Heap Size (MiB) -> octets", () => {
    const r = readAxmMetrics({
      axm_monitor: { "Used Heap Size": { value: "42.50 MiB" } },
    });
    assert.equal(r.heapUsedBytes, Math.round(42.5 * 1024 * 1024));
  });

  await t.test("Heap Size direct (MiB) -> heapTotalBytes sans dérivation", () => {
    const r = readAxmMetrics({
      axm_monitor: {
        "Used Heap Size": { value: "10.00 MiB" },
        "Heap Size": { value: "64.00 MiB" },
      },
    });
    assert.equal(r.heapTotalBytes, Math.round(64 * 1024 * 1024));
  });

  await t.test("Heap Usage (%) + heap utilisé -> heapTotalBytes dérivé", () => {
    const r = readAxmMetrics({
      axm_monitor: {
        "Used Heap Size": { value: "32.00 MiB" },
        "Heap Usage": { value: "50.00 %" },
      },
    });
    // 32 MiB / (50/100) = 64 MiB
    assert.equal(r.heapTotalBytes, Math.round(64 * 1024 * 1024));
  });

  await t.test("Loop delay (ms) -> eventLoopLagMs", () => {
    const r = readAxmMetrics({ axm_monitor: { "Loop delay": { value: "0.32ms" } } });
    assert.equal(r.eventLoopLagMs, 0.32);
  });

  await t.test("Event Loop Latency (s) -> converti en ms", () => {
    const r = readAxmMetrics({ axm_monitor: { "Event Loop Latency": { value: "0.001s" } } });
    assert.equal(r.eventLoopLagMs, 1);
  });

  await t.test("valeur illisible -> null, ne plante pas", () => {
    const r = readAxmMetrics({ axm_monitor: { "Used Heap Size": { value: "n/a" } } });
    assert.equal(r.heapUsedBytes, null);
  });
});

test("fmtProcess() — champs heap/event-loop-lag (Phase 11)", async (t) => {
  await t.test("process sans axm_monitor -> heapUsedBytes/heapTotalBytes/eventLoopLagMs null", () => {
    const p = fmtProcess({
      pm_id: 0,
      name: "api",
      pid: 123,
      monit: { cpu: 5, memory: 100 * 1024 * 1024 },
      pm2_env: { status: "online", restart_time: 0, instances: 1 },
    });
    assert.equal(p.heapUsedBytes, null);
    assert.equal(p.heapTotalBytes, null);
    assert.equal(p.eventLoopLagMs, null);
    assert.equal(p.memory, 100 * 1024 * 1024, "memory reste le RSS pm2 existant, inchangé");
  });

  await t.test("process avec axm_monitor -> champs peuplés", () => {
    const p = fmtProcess({
      pm_id: 1,
      name: "worker",
      pid: 456,
      monit: { cpu: 12, memory: 50 * 1024 * 1024 },
      pm2_env: {
        status: "online",
        restart_time: 2,
        instances: 1,
        axm_monitor: {
          "Used Heap Size": { value: "20.00 MiB" },
          "Heap Usage": { value: "40.00 %" },
          "Loop delay": { value: "1.20ms" },
        },
      },
    });
    assert.equal(p.heapUsedBytes, Math.round(20 * 1024 * 1024));
    assert.equal(p.heapTotalBytes, Math.round(50 * 1024 * 1024));
    assert.equal(p.eventLoopLagMs, 1.2);
  });
});
