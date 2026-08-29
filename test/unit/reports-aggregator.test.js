"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Tests DB-backed du domaine reports (scope.js, queries.js, aggregator.js).
 * Même pattern que test/unit/dashboard-snapshot.test.js : DB SQLite
 * temporaire migrée avec le vrai migrator, stores réels utilisés pour
 * peupler les fixtures (pas d'insertion SQL à la main quand un store
 * existant le permet déjà).
 */
test("services/reports — scope, queries, aggregator", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  const processHistoryStore = require("../../lib/services/process-history/store");
  const eventStore = require("../../lib/services/events/event-store");
  const orgStore = require("../../lib/services/process-organization/store");
  const db = require("../../lib/db");

  const NOW = 1_700_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  async function seedProcessSamples(processName, serverKey, { cpu, memory, count = 5 } = {}) {
    const samples = Array.from({ length: count }, (_, i) => ({
      processName,
      serverKey,
      ts: NOW - count * 60_000 + i * 60_000,
      cpu,
      memory,
      restartCount: i,
      instances: 1,
      status: "online",
      uptimeMs: 1000,
      heapUsed: null,
      heapTotal: null,
      eventLoopLag: null,
    }));
    await processHistoryStore.insertRawBatch(samples);
  }

  await t.test("resolveProcessScope() — découvre les process via leur historique, filtre par serveur/process", async () => {
    const { resolveProcessScope } = require("../../lib/services/reports/scope");

    await seedProcessSamples("api", "local", { cpu: 10, memory: 1000 });
    await seedProcessSamples("worker", "local", { cpu: 20, memory: 2000 });

    const all = await resolveProcessScope({});
    assert.ok(all.some((p) => p.processName === "api"));
    assert.ok(all.some((p) => p.processName === "worker"));

    const filtered = await resolveProcessScope({ process: "api" });
    assert.deepEqual(filtered.map((p) => p.processName), ["api"]);

    const byServer = await resolveProcessScope({ serverKey: "local" });
    assert.ok(byServer.length >= 2);
    const byOtherServer = await resolveProcessScope({ serverKey: "does-not-exist" });
    assert.deepEqual(byOtherServer, []);
  });

  await t.test("resolveProcessScope() — filtre par environnement/groupe (process-organization)", async () => {
    const { resolveProcessScope } = require("../../lib/services/reports/scope");

    await seedProcessSamples("staging-app", "local", { cpu: 5, memory: 500 });
    const env = await orgStore.createEnvironment({ name: `staging-${Date.now()}` });
    await orgStore.setProcessEnvironment("staging-app", env.id, "local");

    const group = await orgStore.createGroup({ name: `payments-${Date.now()}` });
    await orgStore.setProcessGroups("staging-app", [group.id], "local");

    const byEnv = await resolveProcessScope({ environment: env.name });
    assert.deepEqual(byEnv.map((p) => p.processName), ["staging-app"]);

    const byGroup = await resolveProcessScope({ group: group.name });
    assert.deepEqual(byGroup.map((p) => p.processName), ["staging-app"]);

    const byWrongEnv = await resolveProcessScope({ environment: "does-not-exist" });
    assert.deepEqual(byWrongEnv, []);
  });

  await t.test("resolveProcessScope() — respecte la visibilité de l'utilisateur (permission 'view')", async () => {
    const { resolveProcessScope } = require("../../lib/services/reports/scope");
    await seedProcessSamples("secret-app", "local", { cpu: 1, memory: 1 });

    const restrictedUser = { id: 99, isAdmin: false, permissions: [{ appName: "api", action: "view" }] };
    const scoped = await resolveProcessScope({}, restrictedUser);
    assert.deepEqual(scoped.map((p) => p.processName).sort(), ["api"]);
  });

  await t.test("queries.js — alertsInPeriod/incidentsInPeriod/notificationsInPeriod/autoHealingInPeriod filtrent par plage et par process", async () => {
    const queries = require("../../lib/services/reports/queries");

    // Une alerte process "api" DANS la période, une autre HORS période.
    await db.run(
      `INSERT INTO alerts (rule_name, dedup_key, target_type, target_value, metric, operator, threshold, severity, state, condition_met_at, triggered_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, 'process', 'api', 'cpu', '>', '80', 'critical', 'active', ?, ?, ?, ?, ?)`,
      ["CPU haut", "dedup-in", NOW - DAY, NOW - DAY, NOW - DAY, NOW - DAY, NOW - DAY],
    );
    const outOfRangeResult = await db.run(
      `INSERT INTO alerts (rule_name, dedup_key, target_type, target_value, metric, operator, threshold, severity, state, condition_met_at, triggered_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, 'process', 'api', 'cpu', '>', '80', 'critical', 'resolved', ?, ?, ?, ?, ?)`,
      ["CPU haut", "dedup-out", NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY],
    );
    // Une alerte "system" (pas de process) DANS la période : jamais exclue par un filtre process.
    await db.run(
      `INSERT INTO alerts (rule_name, dedup_key, target_type, target_value, metric, operator, threshold, severity, state, condition_met_at, triggered_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, 'system', NULL, 'disk', '>', '90', 'warning', 'active', ?, ?, ?, ?, ?)`,
      ["Disque plein", "dedup-system", NOW - DAY, NOW - DAY, NOW - DAY, NOW - DAY, NOW - DAY],
    );

    const alerts = await queries.alertsInPeriod({ start: NOW - 2 * DAY, end: NOW, processNames: ["api"] });
    assert.equal(alerts.length, 2); // l'alerte "api" en période + l'alerte "system"
    assert.ok(alerts.some((a) => a.target_type === "system"));
    assert.ok(!alerts.some((a) => a.dedup_key === "dedup-out"));

    await db.run(
      `INSERT INTO incidents (title, status, severity, target_type, target_value, metric, correlation_key, opened_at, created_at, updated_at)
       VALUES (?, 'OPEN', 'critical', 'process', 'api', 'cpu', 'corr-1', ?, ?, ?)`,
      ["CPU haut sur api", NOW - DAY, NOW - DAY, NOW - DAY],
    );
    const incidents = await queries.incidentsInPeriod({ start: NOW - 2 * DAY, end: NOW, processNames: ["api"] });
    assert.equal(incidents.length, 1);
    const incidentsOtherProcess = await queries.incidentsInPeriod({
      start: NOW - 2 * DAY,
      end: NOW,
      processNames: ["worker"],
    });
    assert.equal(incidentsOtherProcess.length, 0);

    await db.run(
      `INSERT INTO notification_history (alert_id, status, ts, created_at) VALUES (?, 'sent', ?, ?)`,
      [outOfRangeResult.lastID, NOW - DAY, NOW - DAY],
    );
    // notification liée à l'alerte "api" hors période temporellement (dedup-out), mais on
    // interroge sur une fenêtre qui la couvre : elle doit ressortir, filtrée sur processNames=['api'].
    const notifications = await queries.notificationsInPeriod({
      start: NOW - 2 * DAY,
      end: NOW,
      processNames: ["api"],
    });
    assert.equal(notifications.length, 1);

    await db.run(
      `INSERT INTO auto_healing_audit (process_name, source, reason, action, result, created_at)
       VALUES ('api', 'alert', 'CPU haut', 'restart', 'success', ?)`,
      [NOW - DAY],
    );
    const healingInScope = await queries.autoHealingInPeriod({
      start: NOW - 2 * DAY,
      end: NOW,
      processNames: ["api"],
    });
    assert.equal(healingInScope.length, 1);
    const healingOutOfScope = await queries.autoHealingInPeriod({
      start: NOW - 2 * DAY,
      end: NOW,
      processNames: ["worker"],
    });
    assert.equal(healingOutOfScope.length, 0);
  });

  await t.test("aggregator.generateReport() — compose un rapport complet à partir des sources existantes", async () => {
    const { generateReport } = require("../../lib/services/reports/aggregator");
    await eventStore.create({ timestamp: NOW - DAY, type: "crashed", severity: "critical", process: "api" });

    const fakeProcessHistory = { pickResolution: () => "raw" };
    const report = await generateReport(
      { processHistory: fakeProcessHistory },
      { period: "custom", start: NOW - 2 * DAY, end: NOW, process: "api" },
      null,
    );

    assert.equal(report.scope.processCount, 1);
    assert.equal(report.processes[0].processName, "api");
    assert.ok(report.processes[0].crashes >= 1);
    assert.equal(report.summary.incidents, 1);
    assert.ok(report.summary.alerts.total >= 1);
    assert.ok(report.ranking.crashes);
    // includeSystemCapacity non demandé => capacity planning système absent (jamais inventé).
    assert.equal(report.capacityPlanning.system, null);
  });

  await t.test("aggregator.generateReport() — gros volume : beaucoup de process et d'échantillons, reste cohérent", async () => {
    const { generateReport } = require("../../lib/services/reports/aggregator");
    const manyProcesses = Array.from({ length: 30 }, (_, i) => `bulk-${i}`);
    for (const name of manyProcesses) {
      await seedProcessSamples(name, "local", { cpu: Math.random() * 100, memory: 1000 * (1 + Math.random()), count: 20 });
    }

    const fakeProcessHistory = { pickResolution: () => "raw" };
    const report = await generateReport(
      { processHistory: fakeProcessHistory },
      { period: "custom", start: NOW - 2 * DAY, end: NOW + DAY },
      null,
    );

    assert.ok(report.scope.processCount >= manyProcesses.length);
    assert.ok(report.ranking.cpu.length <= 10); // limite par défaut respectée
    assert.ok(Array.isArray(report.processes));
  });

  await t.test("aggregator.generateReport() — Capacity Planning système à partir de l'historique persisté (system-history-store)", async () => {
    const { generateReport } = require("../../lib/services/reports/aggregator");
    const systemHistory = require("../../lib/services/reports/system-history-store");
    systemHistory._resetThrottleForTests();

    // 20 points sur 20 jours, RAM qui monte linéairement de 50% à 88% (dépasse déjà 80%).
    for (let i = 0; i < 20; i++) {
      await db.run(
        `INSERT INTO system_metrics_history (ts, cpu_percent, mem_percent, disk_percent, created_at) VALUES (?, ?, ?, ?, ?)`,
        [NOW - (20 - i) * DAY, 10 + i, 50 + i * 2, 5, NOW],
      );
    }

    const fakeProcessHistory = { pickResolution: () => "raw" };
    const report = await generateReport(
      { processHistory: fakeProcessHistory, includeSystemCapacity: true },
      { period: "monthly", start: NOW - 30 * DAY, end: NOW },
      null,
    );

    assert.ok(report.capacityPlanning.system);
    assert.equal(report.capacityPlanning.system.memory.currentValue, 88);
    assert.ok(report.capacityPlanning.system.memory.dataWindowMs > 0);
    assert.ok(["already_exceeded", "high", "medium", "low"].includes(report.capacityPlanning.system.memory.confidence));
  });

  await cleanupDb(dbCtx);
});
