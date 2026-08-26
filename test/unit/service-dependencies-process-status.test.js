"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mapPm2StatusToDependencyStatus } = require("../../lib/services/service-dependencies/process-status");

/**
 * Test de la seule partie pure de process-status.js — aucune connexion PM2
 * ici (voir service-dependencies-status.test.js pour l'intégration avec
 * `listProcessStatuses` injecté, et le commentaire de tête de
 * process-status.js pour pourquoi listLocalProcessStatuses() elle-même
 * n'est pas testée directement : elle nécessiterait un vrai daemon PM2).
 */

test("service-dependencies/process-status — mapPm2StatusToDependencyStatus()", async (t) => {
  await t.test("online -> UP", () => {
    assert.equal(mapPm2StatusToDependencyStatus("online"), "UP");
  });

  await t.test("stopped / errored -> DOWN", () => {
    assert.equal(mapPm2StatusToDependencyStatus("stopped"), "DOWN");
    assert.equal(mapPm2StatusToDependencyStatus("errored"), "DOWN");
  });

  await t.test("stopping / launching / one-launch-status -> DEGRADED (transitoire)", () => {
    assert.equal(mapPm2StatusToDependencyStatus("stopping"), "DEGRADED");
    assert.equal(mapPm2StatusToDependencyStatus("launching"), "DEGRADED");
    assert.equal(mapPm2StatusToDependencyStatus("one-launch-status"), "DEGRADED");
  });

  await t.test("statut inconnu / absent -> UNKNOWN", () => {
    assert.equal(mapPm2StatusToDependencyStatus("something-new"), "UNKNOWN");
    assert.equal(mapPm2StatusToDependencyStatus(undefined), "UNKNOWN");
    assert.equal(mapPm2StatusToDependencyStatus(null), "UNKNOWN");
  });
});
