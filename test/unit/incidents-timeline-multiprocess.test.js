"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

const alertStore = require("../../lib/services/alerts/alert-store");
const ruleStore = require("../../lib/services/alerts/alert-rules-store");
const incidentStore = require("../../lib/services/incidents/incident-store");
const timelineStore = require("../../lib/services/incidents/timeline-store");
const eventStore = require("../../lib/services/events/event-store");
const autoHealingAuditStore = require("../../lib/services/auto-healing/audit-store");

/**
 * Timeline dérivée (lib/services/incidents/timeline-store.js) : vérifie que
 * les événements PM2 et l'audit Auto-Healing sont résolus pour TOUS les
 * process rattachés à l'incident, pas seulement celui de sa toute première
 * alerte — cas d'une corrélation par GROUPE
 * (lib/services/incidents/correlation.js) qui rattache des alertes portant
 * sur des process différents au même incident.
 */

test("incidents/timeline-store — dérivation multi-process (corrélation par groupe)", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  const rule = await ruleStore.create({
    name: "Règle de test (timeline)",
    targetType: "process",
    metric: "restart_count",
    operator: ">",
    threshold: 3,
    durationSeconds: 0,
    severity: "warning",
    cooldownSeconds: 0,
  });

  const now = Date.now();

  // Incident "principal" ouvert sur worker-1, une alerte sur worker-2 le
  // rejoint ensuite via corrélation de groupe (simulée directement ici,
  // correlation.js étant déjà testé séparément dans incidents.test.js).
  const incident = await incidentStore.create({
    title: "Restarts élevés — groupe ecommerce",
    severity: "warning",
    targetType: "process",
    targetValue: "worker-1",
    metric: "restart_count",
    correlationKey: "process:worker-1:restart_count",
    firstAlertId: null,
  });

  const alertOnWorker1 = await alertStore.create({
    ruleId: rule.id,
    ruleName: rule.name,
    dedupKey: `${rule.id}:process:worker-1:restart_count`,
    targetType: "process",
    targetValue: "worker-1",
    metric: "restart_count",
    operator: ">",
    threshold: 3,
    severity: "warning",
    state: "active",
    value: "5",
    conditionMetAt: now,
    triggeredAt: now,
    lastSeenAt: now,
  });
  const alertOnWorker2 = await alertStore.create({
    ruleId: rule.id,
    ruleName: rule.name,
    dedupKey: `${rule.id}:process:worker-2:restart_count`,
    targetType: "process",
    targetValue: "worker-2",
    metric: "restart_count",
    operator: ">",
    threshold: 3,
    severity: "warning",
    state: "active",
    value: "4",
    conditionMetAt: now,
    triggeredAt: now,
    lastSeenAt: now,
  });
  await incidentStore.linkAlert(incident.id, alertOnWorker1.id);
  await incidentStore.linkAlert(incident.id, alertOnWorker2.id);

  // Un événement PM2 et une tentative d'Auto-Healing sur worker-2 (PAS
  // worker-1, le process "principal" de l'incident) : doivent tout de même
  // apparaître dans la timeline. Horodatage pris via Date.now() (pas
  // "now + décalage arbitraire") pour rester naturellement <= à `endTs`
  // (Date.now() au moment de l'appel à list(), l'incident étant encore OPEN).
  const event = await eventStore.create({
    timestamp: Date.now(),
    type: "restart",
    severity: "warning",
    process: "worker-2",
    processId: 2,
    server: null,
    status: "online",
    exitCode: 1,
    signal: null,
  });
  const healingAttempt = await autoHealingAuditStore.record({
    processName: "worker-2",
    source: "alert",
    reason: "restart_count élevé",
    action: "restart",
    attempt: 1,
    maxAttempts: 3,
    result: "success",
  });

  await t.test("la timeline inclut l'événement PM2 de worker-2", async () => {
    const alertIds = await incidentStore.listAlertIds(incident.id);
    const timeline = await timelineStore.list(incident, alertIds);
    const found = timeline.find((e) => e.type === "process_event" && e.refId === event.id);
    assert.ok(found, "l'événement PM2 sur worker-2 doit apparaître dans la timeline de l'incident");
  });

  await t.test("la timeline inclut la tentative d'Auto-Healing de worker-2", async () => {
    const alertIds = await incidentStore.listAlertIds(incident.id);
    const timeline = await timelineStore.list(incident, alertIds);
    const found = timeline.find((e) => e.type === "auto_healing" && e.refId === healingAttempt.id);
    assert.ok(found, "la tentative Auto-Healing sur worker-2 doit apparaître dans la timeline de l'incident");
  });

  await t.test(
    "la timeline inclut toujours les deux alertes déclenchées (worker-1 et worker-2)",
    async () => {
      const alertIds = await incidentStore.listAlertIds(incident.id);
      const timeline = await timelineStore.list(incident, alertIds);
      assert.ok(timeline.some((e) => e.type === "alert_triggered" && e.refId === alertOnWorker1.id));
      assert.ok(timeline.some((e) => e.type === "alert_triggered" && e.refId === alertOnWorker2.id));
    },
  );

  await t.test("aucune entrée dupliquée même si un process apparaît deux fois (dédoublonnage)", async () => {
    const alertIds = await incidentStore.listAlertIds(incident.id);
    const timeline = await timelineStore.list(incident, alertIds);
    const processEventIds = timeline.filter((e) => e.type === "process_event").map((e) => e.refId);
    assert.equal(processEventIds.length, new Set(processEventIds).size);
  });

  await cleanupDb(dbCtx);
});
