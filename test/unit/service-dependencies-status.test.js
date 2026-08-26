"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const store = require("../../lib/services/service-dependencies/store");
const healthChecksStore = require("../../lib/services/health-checks/store");
const {
  buildGraphSnapshot,
  computeImpact,
  worstStatus,
} = require("../../lib/services/service-dependencies/status");

/**
 * Tests unitaires du calcul de statut/impact (Phase 17). DB SQLite
 * temporaire (comme service-dependencies-store.test.js) : le statut est
 * dérivé en lecture depuis les health checks réellement enregistrés, pas de
 * mock du store (voir commentaire de tête de status.js — tout est recalculé
 * à partir de store.list() + healthChecksStore.list()).
 */

async function makeCheck(name) {
  return healthChecksStore.create({ name, type: "tcp", host: "127.0.0.1", port: 6379 });
}

async function setCheckStatus(id, checkStatus) {
  return healthChecksStore.recordResult(id, {
    status: checkStatus,
    responseTimeMs: 5,
    consecutiveFailures: checkStatus === "DOWN" ? 1 : 0,
    consecutiveSuccesses: checkStatus === "DOWN" ? 0 : 1,
  });
}

test("service-dependencies/status — worstStatus()", async (t) => {
  await t.test("DOWN > DEGRADED > UNKNOWN > UP", () => {
    assert.equal(worstStatus("UP", "DOWN"), "DOWN");
    assert.equal(worstStatus("DOWN", "UP"), "DOWN");
    assert.equal(worstStatus("UNKNOWN", "DEGRADED"), "DEGRADED");
    assert.equal(worstStatus("UP", "UP"), "UP");
  });
});

test("service-dependencies/status — buildGraphSnapshot()", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("dépendance sans health check lié -> statut UNKNOWN", async () => {
    await store.create({ source: "API", target: "PostgreSQL", type: "DATABASE" });
    const snapshot = await buildGraphSnapshot();
    const edge = snapshot.edges.find((e) => e.source === "API" && e.target === "PostgreSQL");
    assert.equal(edge.status, "UNKNOWN");
    const node = snapshot.nodes.find((n) => n.name === "API");
    assert.equal(node.status, "UNKNOWN");
  });

  await t.test("statut reflète le health check lié, propagé au nœud", async () => {
    const check = await makeCheck("redis-check");
    await store.create({ source: "Worker", target: "Redis", type: "REDIS", healthCheckId: check.id });

    await setCheckStatus(check.id, "DOWN");
    let snapshot = await buildGraphSnapshot();
    let edge = snapshot.edges.find((e) => e.source === "Worker" && e.target === "Redis");
    assert.equal(edge.status, "DOWN");
    assert.equal(snapshot.nodes.find((n) => n.name === "Worker").status, "DOWN");
    assert.equal(snapshot.nodes.find((n) => n.name === "Redis").status, "DOWN");

    await setCheckStatus(check.id, "UP");
    snapshot = await buildGraphSnapshot();
    edge = snapshot.edges.find((e) => e.source === "Worker" && e.target === "Redis");
    assert.equal(edge.status, "UP");
  });

  await t.test("une dépendance désactivée reste UNKNOWN même avec un check DOWN lié", async () => {
    const check = await makeCheck("disabled-link-check");
    const dep = await store.create({
      source: "Legacy",
      target: "OldService",
      type: "CUSTOM",
      healthCheckId: check.id,
    });
    await setCheckStatus(check.id, "DOWN");
    await store.setEnabled(dep.id, false);

    const snapshot = await buildGraphSnapshot();
    const edge = snapshot.edges.find((e) => e.id === dep.id);
    assert.equal(edge.status, "UNKNOWN");
  });

  t.after(() => cleanupDb(dbCtx));
});

test("service-dependencies/status — computeImpact()", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("service UP (ou sans check) : aucun impact, pas de calcul forcé", async () => {
    await store.create({ source: "API", target: "PostgreSQL", type: "DATABASE" });
    const impact = await computeImpact("PostgreSQL");
    assert.equal(impact.status, "UNKNOWN");
    assert.deepEqual(impact.potentiallyAffected, []);
  });

  await t.test("service DOWN : liste les dépendants directs et transitifs", async () => {
    const check = await makeCheck("postgres-check");
    await store.create({ source: "Frontend2", target: "API2", type: "HTTP" });
    await store.create({ source: "API2", target: "PostgreSQL2", type: "DATABASE", healthCheckId: check.id });
    await setCheckStatus(check.id, "DOWN");

    const impact = await computeImpact("PostgreSQL2");
    assert.equal(impact.status, "DOWN");
    const names = impact.potentiallyAffected.map((a) => a.name).sort();
    assert.deepEqual(names, ["API2", "Frontend2"]);
    const byName = Object.fromEntries(impact.potentiallyAffected.map((a) => [a.name, a]));
    assert.equal(byName.API2.distance, 1);
    assert.equal(byName.Frontend2.distance, 2);
  });

  await t.test("assumeDown:true force le calcul même sans check DOWN réel", async () => {
    await store.create({ source: "Consumer", target: "QueueBroker", type: "CUSTOM" });
    const impact = await computeImpact("QueueBroker", { assumeDown: true });
    assert.equal(impact.status, "DOWN");
    assert.deepEqual(
      impact.potentiallyAffected.map((a) => a.name),
      ["Consumer"],
    );
  });

  await t.test("une dépendance désactivée ne propage pas l'impact", async () => {
    const check = await makeCheck("redis-check-2");
    const dep = await store.create({
      source: "Disabled-Consumer",
      target: "RedisX",
      type: "REDIS",
      healthCheckId: check.id,
    });
    await setCheckStatus(check.id, "DOWN");
    await store.setEnabled(dep.id, false);

    const impact = await computeImpact("RedisX", { assumeDown: true });
    assert.deepEqual(impact.potentiallyAffected, []);
  });

  t.after(() => cleanupDb(dbCtx));
});

test("service-dependencies/status — dépendances de type PROCESS (statut PM2 réel)", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  // `listProcessStatuses` est injecté (voir buildGraphSnapshot()/computeImpact()
  // dans status.js) : aucun de ces tests ne touche un vrai daemon PM2 —
  // voir process-status.js pour pourquoi listLocalProcessStatuses() elle-même
  // n'est pas appelée ici.
  const fakeProcessStatuses = (map) => async () => new Map(Object.entries(map));

  await t.test("PROCESS sans health check lié : statut dérivé du process PM2", async () => {
    await store.create({ source: "Frontend3", target: "api-worker", type: "PROCESS" });
    const snapshot = await buildGraphSnapshot({
      listProcessStatuses: fakeProcessStatuses({ "api-worker": "DOWN" }),
    });
    const edge = snapshot.edges.find((e) => e.source === "Frontend3" && e.target === "api-worker");
    assert.equal(edge.status, "DOWN");
    assert.equal(snapshot.nodes.find((n) => n.name === "Frontend3").status, "DOWN");
  });

  await t.test("PROCESS avec health check lié : le health check reste prioritaire", async () => {
    const check = await makeCheck("api-worker-check");
    await store.create({
      source: "Frontend4",
      target: "api-worker-2",
      type: "PROCESS",
      healthCheckId: check.id,
    });
    await setCheckStatus(check.id, "UP");

    // Le process PM2 serait DOWN, mais le health check lié (UP) l'emporte.
    const snapshot = await buildGraphSnapshot({
      listProcessStatuses: fakeProcessStatuses({ "api-worker-2": "DOWN" }),
    });
    const edge = snapshot.edges.find((e) => e.source === "Frontend4" && e.target === "api-worker-2");
    assert.equal(edge.status, "UP");
  });

  await t.test("process introuvable dans la liste PM2 -> UNKNOWN", async () => {
    await store.create({ source: "Frontend5", target: "ghost-process", type: "PROCESS" });
    const snapshot = await buildGraphSnapshot({ listProcessStatuses: fakeProcessStatuses({}) });
    const edge = snapshot.edges.find((e) => e.source === "Frontend5" && e.target === "ghost-process");
    assert.equal(edge.status, "UNKNOWN");
  });

  await t.test("computeImpact() sur une dépendance PROCESS DOWN liste les dépendants", async () => {
    await store.create({ source: "Frontend7", target: "worker-x", type: "PROCESS" });
    const impact = await computeImpact("worker-x", {
      listProcessStatuses: fakeProcessStatuses({ "worker-x": "DOWN" }),
    });
    assert.equal(impact.status, "DOWN");
    assert.deepEqual(
      impact.potentiallyAffected.map((a) => a.name),
      ["Frontend7"],
    );
  });

  t.after(() => cleanupDb(dbCtx));
});

test("service-dependencies/status — listProcessStatuses n'est appelée que si nécessaire", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test(
    "aucune dépendance PROCESS sans health check : listProcessStatuses jamais appelée",
    async () => {
      await store.create({ source: "Frontend6", target: "PostgreSQL6", type: "DATABASE" });
      let called = false;
      await buildGraphSnapshot({
        listProcessStatuses: async () => {
          called = true;
          return new Map();
        },
      });
      assert.equal(called, false);
    },
  );

  t.after(() => cleanupDb(dbCtx));
});
