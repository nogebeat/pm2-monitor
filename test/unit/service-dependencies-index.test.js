"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const store = require("../../lib/services/service-dependencies/store");
const healthChecksStore = require("../../lib/services/health-checks/store");
const { handleHealthCheckResult } = require("../../lib/services/service-dependencies/index");

/**
 * Tests du point d'entrée branché sur healthCheckEngine.onCheckResult
 * (server.js, Phase 17). Vérifie que le hook reste un no-op quand aucune
 * dépendance n'est concernée (chemin le plus fréquent, ne doit jamais
 * ralentir la boucle de health checks), et qu'il calcule bien l'impact
 * quand une dépendance liée passe DOWN.
 */

async function makeCheck(name) {
  return healthChecksStore.create({ name, type: "tcp", host: "127.0.0.1", port: 6379 });
}

test("service-dependencies/index — handleHealthCheckResult()", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("check sans dépendance liée -> null (no-op)", async () => {
    const check = await makeCheck("unlinked-check");
    const result = await handleHealthCheckResult({ id: check.id, status: "DOWN" });
    assert.equal(result, null);
  });

  await t.test("check lié, statut réel encore UNKNOWN -> pas d'impact (mais pas null)", async () => {
    const check = await makeCheck("linked-up-check");
    await store.create({ source: "API", target: "Redis", type: "REDIS", healthCheckId: check.id });
    // Statut réel du check encore UNKNOWN (jamais recordResult()) donc
    // computeImpact() renverra un statut "UNKNOWN", pas "DOWN" : impacts filtré à vide.
    const result = await handleHealthCheckResult({ id: check.id, status: "UNKNOWN" });
    assert.ok(result);
    assert.equal(result.checkId, check.id);
    assert.deepEqual(result.impacts, []);
  });

  await t.test("check lié, statut DOWN -> impact calculé pour le(s) target(s)", async () => {
    const check = await makeCheck("linked-down-check");
    await healthChecksStore.recordResult(check.id, {
      status: "DOWN",
      responseTimeMs: 10,
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
    });
    await store.create({ source: "Frontend", target: "API2", type: "HTTP" });
    await store.create({ source: "API2", target: "PostgreSQL2", type: "DATABASE", healthCheckId: check.id });

    const result = await handleHealthCheckResult({ id: check.id, status: "DOWN" });
    assert.ok(result);
    assert.equal(result.checkStatus, "DOWN");
    assert.equal(result.impacts.length, 1);
    assert.equal(result.impacts[0].service, "PostgreSQL2");
    assert.equal(result.impacts[0].status, "DOWN");
    const names = result.impacts[0].potentiallyAffected.map((a) => a.name).sort();
    assert.deepEqual(names, ["API2", "Frontend"]);
  });

  t.after(() => cleanupDb(dbCtx));
});
