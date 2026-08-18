"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSnapshot } = require("../../lib/services/dashboard");

test("buildSnapshot() — agrège processes/system/alerts/health-checks et calcule le statut global", async () => {
  const snapshot = await buildSnapshot({
    listProcesses: async () => [
      { name: "api", status: "online" },
      { name: "worker", status: "errored" },
    ],
    getSystemSnapshot: () => ({ cpu: 10, mem: { percent: 20 }, disk: { percent: 30 } }),
    alertStore: {
      listActive: async () => [{ severity: "critical", state: "active", triggeredAt: 1, lastSeenAt: 1 }],
      listHistory: async () => [],
    },
    healthChecksStore: { list: async () => [{ status: "UP", enabled: true }] },
    eventsStore: {
      list: async () => ({ items: [{ timestamp: 5, process: "api", type: "started", severity: "info" }] }),
    },
    autoHealingAuditStore: { list: async () => [] },
  });

  assert.equal(snapshot.globalStatus, "CRITICAL"); // process errored + alerte critique
  assert.equal(snapshot.processes.overview.total, 2);
  assert.equal(snapshot.processes.overview.errored, 1);
  assert.equal(snapshot.alerts.active, 1);
  assert.equal(snapshot.alerts.critical, 1);
  assert.equal(snapshot.healthChecks.up, 1);
  assert.ok(snapshot.recentTimeline.length >= 1);
});

test("buildSnapshot() — sections omises (permission absente) restent null sans faire planter le calcul", async () => {
  const snapshot = await buildSnapshot({
    listProcesses: async () => [{ name: "api", status: "online" }],
    getSystemSnapshot: () => ({ cpu: 5, mem: { percent: 5 }, disk: { percent: 5 } }),
  });

  assert.equal(snapshot.globalStatus, "HEALTHY");
  assert.equal(snapshot.alerts, null);
  assert.equal(snapshot.healthChecks, null);
  assert.deepEqual(snapshot.recentTimeline, []);
});
