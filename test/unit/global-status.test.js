"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateGlobalStatus,
  calculateGlobalStatusDetailed,
  DEFAULT_THRESHOLDS,
} = require("../../lib/services/dashboard/global-status");
const { calculateProcessOverview } = require("../../lib/services/dashboard/process-overview");

const HEALTHY_SYSTEM = { cpu: 20, mem: { percent: 30 }, disk: { percent: 40 }, temp: { celsius: 45 } };
const HEALTHY_PROCESSES = { total: 3, online: 3, stopped: 0, errored: 0, crashed: 0, restarting: 0 };

test("calculateGlobalStatus() — everything healthy -> HEALTHY", () => {
  const status = calculateGlobalStatus({
    system: HEALTHY_SYSTEM,
    processes: HEALTHY_PROCESSES,
    alerts: [],
    healthChecks: [{ status: "UP", enabled: true }],
  });
  assert.equal(status, "HEALTHY");
});

test("calculateGlobalStatus() — aucune donnée fournie -> HEALTHY (pas de faux positif sur données absentes)", () => {
  assert.equal(calculateGlobalStatus({}), "HEALTHY");
});

test("calculateGlobalStatus() — warning : une alerte warning active -> WARNING", () => {
  const status = calculateGlobalStatus({
    system: HEALTHY_SYSTEM,
    processes: HEALTHY_PROCESSES,
    alerts: [{ state: "active", severity: "warning" }],
    healthChecks: [],
  });
  assert.equal(status, "WARNING");
});

test("calculateGlobalStatus() — warning : health check DEGRADED -> WARNING", () => {
  const status = calculateGlobalStatus({
    system: HEALTHY_SYSTEM,
    processes: HEALTHY_PROCESSES,
    healthChecks: [{ status: "DEGRADED", enabled: true }],
  });
  assert.equal(status, "WARNING");
});

test("calculateGlobalStatus() — warning : process en cours de redémarrage -> WARNING", () => {
  const status = calculateGlobalStatus({
    system: HEALTHY_SYSTEM,
    processes: { total: 2, online: 1, stopped: 0, errored: 0, crashed: 0, restarting: 1 },
  });
  assert.equal(status, "WARNING");
});

test("calculateGlobalStatus() — warning : CPU au-delà du seuil warning mais sous le seuil critique -> WARNING", () => {
  const status = calculateGlobalStatus({
    system: { cpu: DEFAULT_THRESHOLDS.cpu.warning + 5, mem: { percent: 10 }, disk: { percent: 10 } },
    processes: HEALTHY_PROCESSES,
  });
  assert.equal(status, "WARNING");
});

test("calculateGlobalStatus() — critical : une alerte critique active -> CRITICAL", () => {
  const status = calculateGlobalStatus({
    system: HEALTHY_SYSTEM,
    processes: HEALTHY_PROCESSES,
    alerts: [{ state: "active", severity: "critical" }],
  });
  assert.equal(status, "CRITICAL");
});

test("calculateGlobalStatus() — critical : un health check DOWN -> CRITICAL", () => {
  const status = calculateGlobalStatus({
    system: HEALTHY_SYSTEM,
    processes: HEALTHY_PROCESSES,
    healthChecks: [{ status: "DOWN", enabled: true }],
  });
  assert.equal(status, "CRITICAL");
});

test("calculateGlobalStatus() — critical : un process errored/crashed -> CRITICAL", () => {
  const status = calculateGlobalStatus({
    system: HEALTHY_SYSTEM,
    processes: { total: 2, online: 1, stopped: 0, errored: 1, crashed: 1, restarting: 0 },
  });
  assert.equal(status, "CRITICAL");
});

test("calculateGlobalStatus() — critical : RAM au-delà du seuil critique -> CRITICAL", () => {
  const status = calculateGlobalStatus({
    system: { cpu: 10, mem: { percent: DEFAULT_THRESHOLDS.memory.critical + 1 }, disk: { percent: 10 } },
    processes: HEALTHY_PROCESSES,
  });
  assert.equal(status, "CRITICAL");
});

test("calculateGlobalStatus() — critical : température CPU au-delà du seuil critique -> CRITICAL", () => {
  const status = calculateGlobalStatus({
    system: { cpu: 10, mem: { percent: 10 }, disk: { percent: 10 }, temp: { celsius: DEFAULT_THRESHOLDS.temperature.critical + 1 } },
    processes: HEALTHY_PROCESSES,
  });
  assert.equal(status, "CRITICAL");
});

test("calculateGlobalStatus() — multiple conditions : CRITICAL prime toujours sur WARNING", () => {
  const status = calculateGlobalStatus({
    system: { cpu: DEFAULT_THRESHOLDS.cpu.warning + 1, mem: { percent: 10 }, disk: { percent: 10 } }, // warning
    processes: { total: 3, online: 1, stopped: 0, errored: 1, crashed: 1, restarting: 1 }, // errored -> critical, restarting -> warning
    alerts: [
      { state: "active", severity: "warning" },
      { state: "active", severity: "critical" },
    ],
    healthChecks: [{ status: "DEGRADED", enabled: true }],
  });
  assert.equal(status, "CRITICAL");
});

test("calculateGlobalStatusDetailed() — expose les raisons retenues, pas seulement le statut", () => {
  const { status, reasons } = calculateGlobalStatusDetailed({
    system: HEALTHY_SYSTEM,
    processes: HEALTHY_PROCESSES,
    healthChecks: [{ status: "DOWN", enabled: true, name: "api-check" }],
  });
  assert.equal(status, "CRITICAL");
  assert.ok(reasons.length >= 1);
  assert.match(reasons[0], /DOWN/);
});

test("calculateGlobalStatus() — un health check désactivé n'entre pas dans le calcul", () => {
  const status = calculateGlobalStatus({
    system: HEALTHY_SYSTEM,
    processes: HEALTHY_PROCESSES,
    healthChecks: [{ status: "DOWN", enabled: false }],
  });
  assert.equal(status, "HEALTHY");
});

test("calculateGlobalStatus() — une alerte acknowledged compte toujours (ACK = vu, pas résolu)", () => {
  const status = calculateGlobalStatus({
    system: HEALTHY_SYSTEM,
    processes: HEALTHY_PROCESSES,
    alerts: [{ state: "acknowledged", severity: "critical" }],
  });
  assert.equal(status, "CRITICAL");
});

test("calculateGlobalStatus() — une alerte resolved n'entre pas dans le calcul", () => {
  const status = calculateGlobalStatus({
    system: HEALTHY_SYSTEM,
    processes: HEALTHY_PROCESSES,
    alerts: [{ state: "resolved", severity: "critical" }],
  });
  assert.equal(status, "HEALTHY");
});

// --- calculateProcessOverview() (utilisée en entrée de calculateGlobalStatus) ---

test("calculateProcessOverview() — répartit les statuts PM2 dans les 6 catégories attendues", () => {
  const overview = calculateProcessOverview([
    { status: "online" },
    { status: "online" },
    { status: "stopped" },
    { status: "stopping" },
    { status: "errored" },
    { status: "launching" },
  ]);
  assert.deepEqual(overview, { total: 6, online: 2, stopped: 2, errored: 1, crashed: 1, restarting: 1 });
});

test("calculateProcessOverview() — liste vide -> tout à zéro", () => {
  assert.deepEqual(calculateProcessOverview([]), {
    total: 0,
    online: 0,
    stopped: 0,
    errored: 0,
    crashed: 0,
    restarting: 0,
  });
});
