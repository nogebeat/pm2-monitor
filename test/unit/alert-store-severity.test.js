"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

test("alert-store — update() persiste severity (utilisé pour l'escalade de sévérité des anomalies)", async (t) => {
  let ctx;
  t.beforeEach(async () => {
    ctx = await freshDb();
    const migrator = require("../../lib/db/migrator");
    await migrator.up();
  });
  t.afterEach(async () => {
    await cleanupDb(ctx);
  });

  await t.test("severity peut être modifiée après création, round-trip complet en DB", async () => {
    const store = require("../../lib/services/alerts/alert-store");
    const created = await store.create({
      ruleId: null,
      ruleName: "CPU anormal",
      dedupKey: "null:process:api:cpu_anomaly_1",
      targetType: "process",
      targetValue: "api",
      metric: "cpu_anomaly_1",
      operator: ">",
      threshold: 3,
      severity: "warning",
      state: "trigger",
      value: "4.9",
      conditionMetAt: Date.now(),
    });
    assert.equal(created.severity, "warning");

    const escalated = await store.update(created.id, { severity: "critical" });
    assert.equal(escalated.severity, "critical");

    const reloaded = await store.getById(created.id);
    assert.equal(reloaded.severity, "critical", "la mise à jour de severity est bien persistée en DB");
  });

  await t.test("update() sans changer severity ne la touche pas", async () => {
    const store = require("../../lib/services/alerts/alert-store");
    const created = await store.create({
      ruleId: null,
      ruleName: "Mémoire anormale",
      dedupKey: "null:process:worker:memory_anomaly_2",
      targetType: "process",
      targetValue: "worker",
      metric: "memory_anomaly_2",
      operator: ">",
      threshold: 3,
      severity: "critical",
      state: "trigger",
      value: "3.1",
      conditionMetAt: Date.now(),
    });

    const touched = await store.update(created.id, { value: "3.5" });
    assert.equal(touched.severity, "critical", "severity inchangée quand elle n'est pas dans `changes`");
  });
});
