"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rankBy, rankByAllCriteria, CRITERIA } = require("../../lib/services/reports/ranking");

const ENTRIES = [
  {
    processName: "api",
    serverKey: "local",
    crashes: 5,
    restarts: 10,
    cpuAvg: 40,
    memoryAvg: 1000,
    downtimeMs: 500,
    alertCount: 2,
  },
  {
    processName: "worker",
    serverKey: "local",
    crashes: 1,
    restarts: 30,
    cpuAvg: 80,
    memoryAvg: 500,
    downtimeMs: 100,
    alertCount: 9,
  },
  {
    processName: "cron",
    serverKey: "local",
    crashes: 0,
    restarts: 0,
    cpuAvg: null,
    memoryAvg: null,
    downtimeMs: 0,
    alertCount: 0,
  },
];

test("rankBy() — trie par ordre décroissant du critère demandé", () => {
  const byCrashes = rankBy(ENTRIES, "crashes", 10);
  assert.deepEqual(
    byCrashes.map((e) => e.processName),
    ["api", "worker", "cron"],
  );

  const byRestarts = rankBy(ENTRIES, "restarts", 10);
  assert.deepEqual(
    byRestarts.map((e) => e.processName),
    ["worker", "api", "cron"],
  );

  const byAlerts = rankBy(ENTRIES, "alertCount", 10);
  assert.deepEqual(
    byAlerts.map((e) => e.processName),
    ["worker", "api", "cron"],
  );
});

test("rankBy() — respecte `limit`", () => {
  const top1 = rankBy(ENTRIES, "restarts", 1);
  assert.equal(top1.length, 1);
  assert.equal(top1[0].processName, "worker");
});

test("rankBy() — exclut les process sans donnée pour un critère numérique (cpu/ram null)", () => {
  const byCpu = rankBy(ENTRIES, "cpu", 10);
  assert.equal(
    byCpu.some((e) => e.processName === "cron"),
    false,
  );
  assert.deepEqual(
    byCpu.map((e) => e.processName),
    ["worker", "api"],
  );
});

test("rankBy() — rejette un critère inconnu", () => {
  assert.throws(() => rankBy(ENTRIES, "unknown_metric"), /Critère de classement invalide/);
});

test("rankByAllCriteria() — retourne un classement pour chaque critère du catalogue", () => {
  const result = rankByAllCriteria(ENTRIES, { limit: 5 });
  assert.deepEqual(Object.keys(result).sort(), [...CRITERIA].sort());
  for (const criterion of CRITERIA) {
    assert.ok(Array.isArray(result[criterion]));
  }
});
