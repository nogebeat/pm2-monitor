"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { RoutingEngine } = require("../../lib/services/notifications/routing/engine");

/**
 * Tests unitaires du branchement Silencing (Phase 14) dans
 * RoutingEngine#dispatch — voir lib/services/notifications/routing/engine.js
 * et lib/services/incidents/silence-store.js. Même style de fakes que
 * test/unit/notifications-routing.test.js (routeStore/providerStore/registry/
 * historyStore en mémoire), avec un `silenceStore` fake supplémentaire.
 */

function makeAlert(overrides) {
  return {
    id: 1,
    ruleId: 10,
    ruleName: "CPU élevé",
    targetType: "process",
    targetValue: "api-prod",
    metric: "cpu",
    operator: ">",
    threshold: "80",
    severity: "warning",
    state: "active",
    value: "91",
    triggeredAt: 1000,
    resolvedAt: null,
    lastSeenAt: 1000,
    ...overrides,
  };
}

function makeStores({ routes = [], providers = {}, silenced = false, processOrgStore } = {}) {
  const historyEntries = [];
  const routeStore = { list: async () => routes };
  const providerStore = {
    getById: async (id) => providers[id] || null,
    getDecryptedSecrets: async () => ({}),
  };
  let sendCalled = 0;
  const registry = {
    getProvider: (type) =>
      type === "fake"
        ? {
            send: async () => {
              sendCalled += 1;
              return { success: true, responseTime: 1 };
            },
          }
        : null,
  };
  const historyStore = {
    create: async (entry) => {
      historyEntries.push(entry);
      return { id: historyEntries.length, ...entry };
    },
  };
  const silenceStore = { isSilenced: async () => silenced };
  return {
    routeStore,
    providerStore,
    registry,
    historyStore,
    historyEntries,
    silenceStore,
    processOrgStore,
    getSendCalled: () => sendCalled,
  };
}

test("routing/engine.js — Silencing (Phase 14)", async (t) => {
  await t.test("sans silenceStore injecté : comportement historique inchangé (envoi normal)", async () => {
    const stores = makeStores({
      routes: [{ id: 1, enabled: true, conditions: {}, providerIds: [1] }],
      providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
    });
    const { silenceStore: _silenceStore, ...rest } = stores;
    const engine = new RoutingEngine(rest); // pas de silenceStore
    const results = await engine.dispatch(makeAlert(), "triggered");
    assert.equal(results.length, 1);
    assert.equal(stores.historyEntries[0].status, "success");
    assert.equal(stores.getSendCalled(), 1);
  });

  await t.test("silenceStore présent mais alerte non silencée : envoi normal", async () => {
    const stores = makeStores({
      routes: [{ id: 1, enabled: true, conditions: {}, providerIds: [1] }],
      providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
      silenced: false,
    });
    const engine = new RoutingEngine(stores);
    const results = await engine.dispatch(makeAlert(), "triggered");
    assert.equal(results.length, 1);
    assert.equal(stores.historyEntries[0].status, "success");
    assert.equal(stores.getSendCalled(), 1);
  });

  await t.test("alerte silencée : aucun envoi, historique 'silenced', alerte/route intactes", async () => {
    const stores = makeStores({
      routes: [{ id: 1, enabled: true, conditions: {}, providerIds: [1] }],
      providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
      silenced: true,
    });
    const engine = new RoutingEngine(stores);
    const results = await engine.dispatch(makeAlert(), "triggered");
    assert.equal(results.length, 1);
    assert.equal(stores.getSendCalled(), 0); // le provider n'a jamais été appelé
    assert.equal(stores.historyEntries.length, 1);
    assert.equal(stores.historyEntries[0].status, "silenced");
    assert.equal(stores.historyEntries[0].providerId, 1);
    assert.equal(stores.historyEntries[0].alertId, 1);
  });

  await t.test("silence appliqué à chaque provider matché par la route (plusieurs providers)", async () => {
    const stores = makeStores({
      routes: [{ id: 1, enabled: true, conditions: {}, providerIds: [1, 2] }],
      providers: {
        1: { id: 1, type: "fake", enabled: true, configuration: {} },
        2: { id: 2, type: "fake", enabled: true, configuration: {} },
      },
      silenced: true,
    });
    const engine = new RoutingEngine(stores);
    const results = await engine.dispatch(makeAlert(), "triggered");
    assert.equal(results.length, 2);
    assert.ok(stores.historyEntries.every((h) => h.status === "silenced"));
    assert.equal(stores.getSendCalled(), 0);
  });

  await t.test(
    "silenceStore qui lance une exception : repli sûr (pas silencé), pas d'exception remontée",
    async () => {
      const stores = makeStores({
        routes: [{ id: 1, enabled: true, conditions: {}, providerIds: [1] }],
        providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
      });
      stores.silenceStore.isSilenced = async () => {
        throw new Error("DB indisponible");
      };
      const engine = new RoutingEngine(stores);
      const results = await engine.dispatch(makeAlert(), "triggered");
      assert.equal(results.length, 1);
      assert.equal(stores.historyEntries[0].status, "success"); // repli : notification envoyée quand même
      assert.equal(stores.getSendCalled(), 1);
    },
  );

  await t.test(
    "route non matchée : le silence n'entre même pas en jeu (toujours 0 envoi/historique)",
    async () => {
      const stores = makeStores({
        routes: [{ id: 1, enabled: true, conditions: { severity: ["critical"] }, providerIds: [1] }],
        providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
        silenced: true,
      });
      const engine = new RoutingEngine(stores);
      const results = await engine.dispatch(makeAlert({ severity: "warning" }), "triggered");
      assert.deepEqual(results, []);
      assert.equal(stores.historyEntries.length, 0);
    },
  );
});
