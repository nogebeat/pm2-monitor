"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { HealthCheckEngine } = require("../../lib/services/health-checks/engine");

/**
 * Fake store en mémoire, même contrat que
 * lib/services/health-checks/store.js (create/getById/list/recordResult),
 * pour tester HealthCheckEngine sans DB réelle — la couverture "avec vraie
 * DB + API" est dans test/integration/health-checks-api.test.js.
 */
function fakeStore() {
  let nextId = 1;
  const rows = new Map();
  return {
    async create(fields) {
      const row = {
        id: nextId++,
        enabled: true,
        status: "UNKNOWN",
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastCheckAt: null,
        intervalSeconds: 60,
        ...fields,
      };
      rows.set(row.id, row);
      return { ...row };
    },
    async getById(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async list({ enabledOnly } = {}) {
      const all = [...rows.values()];
      return (enabledOnly ? all.filter((r) => r.enabled) : all).map((r) => ({ ...r }));
    },
    async recordResult(id, result) {
      const row = rows.get(id);
      if (!row) return null;
      Object.assign(row, {
        status: result.status,
        consecutiveFailures: result.consecutiveFailures,
        consecutiveSuccesses: result.consecutiveSuccesses,
        lastResponseTimeMs: result.responseTimeMs,
        lastStatusCode: result.statusCode,
        lastError: result.error,
        lastCheckAt: Date.now(),
      });
      return { ...row };
    },
    _all: () => [...rows.values()],
  };
}

/** Fake AlertEngine : capture juste les appels evaluate() pour vérifier le câblage. */
function fakeAlertEngine() {
  const calls = [];
  return {
    calls,
    async evaluate(rule, targetValue, value) {
      calls.push({ rule, targetValue, value });
      return { state: "trigger", ruleId: rule.id, targetValue };
    },
  };
}

function fakeRuleStore(rules) {
  return {
    async listEnabledByTargetType(targetType) {
      return rules.filter((r) => r.enabled !== false).map((r) => ({ ...r, targetType }));
    },
  };
}

test("HealthCheckEngine.run() — sonde OK -> UP, compteurs remis à zéro", async () => {
  const store = fakeStore();
  const check = await store.create({ name: "api", type: "http", enabled: true, intervalSeconds: 60 });
  const engine = new HealthCheckEngine({
    store,
    ruleStore: fakeRuleStore([]),
    alertEngine: fakeAlertEngine(),
  });

  const impls = {
    httpRequestImpl: async () => ({ ok: true, statusCode: 200, responseTimeMs: 10, body: "" }),
  };
  const updated = await engine.run(check.id, impls);
  assert.equal(updated.status, "UP");
  assert.equal(updated.consecutiveFailures, 0);
  assert.equal(updated.consecutiveSuccesses, 1);
});

test("HealthCheckEngine.run() — échecs consécutifs -> compteur incrémente, succès le remet à zéro", async () => {
  const store = fakeStore();
  const check = await store.create({ name: "api", type: "http", enabled: true, intervalSeconds: 60 });
  const engine = new HealthCheckEngine({
    store,
    ruleStore: fakeRuleStore([]),
    alertEngine: fakeAlertEngine(),
  });

  const down = { httpRequestImpl: async () => ({ ok: false, error: "ECONNREFUSED" }) };
  const up = { httpRequestImpl: async () => ({ ok: true, statusCode: 200, responseTimeMs: 5, body: "" }) };

  let r = await engine.run(check.id, down);
  assert.equal(r.status, "DOWN");
  assert.equal(r.consecutiveFailures, 1);

  r = await engine.run(check.id, down);
  assert.equal(r.consecutiveFailures, 2);

  r = await engine.run(check.id, down);
  assert.equal(r.consecutiveFailures, 3);

  r = await engine.run(check.id, up);
  assert.equal(r.status, "UP");
  assert.equal(r.consecutiveFailures, 0);
  assert.equal(r.consecutiveSuccesses, 1);
});

test("HealthCheckEngine.run() — check désactivé -> ne s'exécute pas (null)", async () => {
  const store = fakeStore();
  const check = await store.create({ name: "api", type: "http", enabled: false, intervalSeconds: 60 });
  const engine = new HealthCheckEngine({
    store,
    ruleStore: fakeRuleStore([]),
    alertEngine: fakeAlertEngine(),
  });
  const result = await engine.run(check.id, {});
  assert.equal(result, null);
});

test("HealthCheckEngine.run() — check introuvable -> throw", async () => {
  const store = fakeStore();
  const engine = new HealthCheckEngine({
    store,
    ruleStore: fakeRuleStore([]),
    alertEngine: fakeAlertEngine(),
  });
  await assert.rejects(() => engine.run(999, {}), /introuvable/i);
});

test("HealthCheckEngine — 3 DOWN consécutifs alimentent l'Alert Engine (evaluate appelé, pas de 2e système d'alerte)", async () => {
  const store = fakeStore();
  const check = await store.create({ name: "api", type: "http", enabled: true, intervalSeconds: 60 });
  const alertEngine = fakeAlertEngine();
  const ruleStore = fakeRuleStore([
    { id: 1, enabled: true, targetType: "health_check", targetValue: "*", metric: "status" },
  ]);
  const engine = new HealthCheckEngine({ store, ruleStore, alertEngine });
  const down = { httpRequestImpl: async () => ({ ok: false, error: "timeout" }) };

  await engine.run(check.id, down);
  await engine.run(check.id, down);
  await engine.run(check.id, down);

  assert.equal(
    alertEngine.calls.length,
    3,
    "evaluate() appelé à chaque exécution (feed continu, comme les autres sources)",
  );
  assert.equal(alertEngine.calls[2].targetValue, "api");
  assert.equal(alertEngine.calls[2].value, "DOWN");
});

test("HealthCheckEngine — règle avec targetValue ciblant un autre check -> pas d'appel evaluate()", async () => {
  const store = fakeStore();
  const check = await store.create({ name: "api", type: "http", enabled: true, intervalSeconds: 60 });
  const alertEngine = fakeAlertEngine();
  const ruleStore = fakeRuleStore([
    { id: 1, enabled: true, targetType: "health_check", targetValue: "worker", metric: "status" },
  ]);
  const engine = new HealthCheckEngine({ store, ruleStore, alertEngine });
  await engine.run(check.id, { httpRequestImpl: async () => ({ ok: false, error: "timeout" }) });
  assert.equal(alertEngine.calls.length, 0);
});

test("HealthCheckEngine.runDueChecks() — n'exécute que les checks dus (interval écoulé)", async () => {
  const store = fakeStore();
  const fresh = await store.create({
    name: "fresh",
    type: "http",
    enabled: true,
    intervalSeconds: 60,
    lastCheckAt: 2000,
  });
  const due = await store.create({
    name: "due",
    type: "http",
    enabled: true,
    intervalSeconds: 60,
    lastCheckAt: 0,
  });
  const neverRun = await store.create({
    name: "never",
    type: "http",
    enabled: true,
    intervalSeconds: 60,
    lastCheckAt: null,
  });

  const engine = new HealthCheckEngine({
    store,
    ruleStore: fakeRuleStore([]),
    alertEngine: fakeAlertEngine(),
    now: () => 61000,
  });
  // runDueChecks() n'accepte que `now` en paramètre (voir engine.js) et exécute donc
  // le runner par défaut ; ces checks n'ont pas d'`url`, donc runHttp() échoue dès le
  // parsing (new URL(undefined)) sans jamais toucher au réseau — safe pour la CI, et
  // suffisant ici puisqu'on ne teste que la sélection des checks dus, pas le résultat.
  await engine.runDueChecks(61000);
  const all = await store.list({});
  const byName = Object.fromEntries(all.map((c) => [c.name, c]));
  assert.equal(byName.fresh.lastCheckAt, 2000, "pas encore dû : inchangé");
  assert.notEqual(byName.due.lastCheckAt, 0, "dû (interval écoulé) : exécuté");
  assert.notEqual(byName.never.lastCheckAt, null, "jamais exécuté : toujours dû");
});
