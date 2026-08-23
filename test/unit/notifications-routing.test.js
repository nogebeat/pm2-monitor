"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  renderNotification,
  renderString,
  buildVariables,
} = require("../../lib/services/notifications/routing/templates");
const { RoutingEngine, matchesList, matchesAny } = require("../../lib/services/notifications/routing/engine");

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

test("templates.js — buildVariables / renderString", async (t) => {
  await t.test("expose les champs attendus de l'alerte", () => {
    const vars = buildVariables(makeAlert(), "triggered");
    assert.equal(vars.ruleName, "CPU élevé");
    assert.equal(vars.severity, "warning");
    assert.equal(vars.metric, "cpu");
    assert.equal(vars.targetValue, "api-prod");
    assert.equal(vars.event, "triggered");
  });

  await t.test("targetValue retombe sur 'system' si absent (alerte système)", () => {
    const vars = buildVariables(makeAlert({ targetType: "system", targetValue: null }), "triggered");
    assert.equal(vars.targetValue, "system");
  });

  await t.test("renderString remplace les placeholders connus", () => {
    const out = renderString("{{severity}} sur {{targetValue}}", {
      severity: "critical",
      targetValue: "api",
    });
    assert.equal(out, "critical sur api");
  });

  await t.test("renderString laisse un placeholder inconnu tel quel (pas d'exception)", () => {
    const out = renderString("{{doesNotExist}}", { severity: "critical" });
    assert.equal(out, "{{doesNotExist}}");
  });

  await t.test("renderString accepte les espaces autour du nom", () => {
    const out = renderString("{{ severity }}", { severity: "critical" });
    assert.equal(out, "critical");
  });
});

test("templates.js — renderNotification", async (t) => {
  await t.test("sans route (ou sans template) : gabarit par défaut", () => {
    const n = renderNotification(null, makeAlert(), "triggered");
    assert.match(n.title, /WARNING/);
    assert.match(n.title, /CPU élevé/);
    assert.match(n.message, /cpu > 80/);
    assert.match(n.message, /api-prod/);
    assert.equal(n.severity, "warning");
    assert.ok(n.timestamp);
  });

  await t.test("gabarit par défaut à la résolution utilise le verbe 'résolue'", () => {
    const n = renderNotification(null, makeAlert({ state: "resolved" }), "resolved");
    assert.match(n.title, /résolue/);
  });

  await t.test("avec template de route : substitution appliquée", () => {
    const route = {
      titleTemplate: "[{{severity}}] {{ruleName}}",
      messageTemplate: "{{targetValue}} : {{metric}} = {{value}} ({{event}})",
    };
    const n = renderNotification(route, makeAlert(), "triggered");
    assert.equal(n.title, "[warning] CPU élevé");
    assert.equal(n.message, "api-prod : cpu = 91 (triggered)");
  });

  await t.test("titleTemplate seul : le message reste sur le gabarit par défaut", () => {
    const route = { titleTemplate: "Custom" };
    const n = renderNotification(route, makeAlert(), "triggered");
    assert.equal(n.title, "Custom");
    assert.match(n.message, /cpu > 80/);
  });
});

test("routing/engine.js — matchesList", async (t) => {
  await t.test("liste absente/vide = tout passe", () => {
    assert.equal(matchesList(undefined, "warning"), true);
    assert.equal(matchesList([], "warning"), true);
  });

  await t.test("valeur absente ne matche jamais un filtre non vide", () => {
    assert.equal(matchesList(["warning"], undefined), false);
    assert.equal(matchesList(["warning"], null), false);
  });

  await t.test("comparaison en chaîne", () => {
    assert.equal(matchesList(["warning", "critical"], "warning"), true);
    assert.equal(matchesList(["warning"], "critical"), false);
  });
});

test("routing/engine.js — matchesAny", async (t) => {
  await t.test("liste absente/vide = tout passe", () => {
    assert.equal(matchesAny(undefined, ["prod"]), true);
    assert.equal(matchesAny([], ["prod"]), true);
  });

  await t.test("ensemble de valeurs absent/vide ne matche jamais un filtre non vide", () => {
    assert.equal(matchesAny(["prod"], undefined), false);
    assert.equal(matchesAny(["prod"], []), false);
  });

  await t.test("matche dès qu'une valeur est commune (intersection non vide)", () => {
    assert.equal(matchesAny(["prod", "critical"], ["backend", "critical"]), true);
    assert.equal(matchesAny(["prod", "critical"], ["backend", "frontend"]), false);
  });
});

test("routing/engine.js — RoutingEngine#routeMatches", async (t) => {
  function makeEngine() {
    return new RoutingEngine({
      routeStore: { list: async () => [] },
      providerStore: { getById: async () => null, getDecryptedSecrets: async () => null },
      registry: { getProvider: () => null },
      historyStore: { create: async () => ({}) },
    });
  }

  await t.test("route sans conditions matche tout", () => {
    const engine = makeEngine();
    assert.equal(engine.routeMatches({ conditions: {} }, makeAlert()), true);
  });

  await t.test("filtre severity", () => {
    const engine = makeEngine();
    const route = { conditions: { severity: ["critical"] } };
    assert.equal(engine.routeMatches(route, makeAlert({ severity: "warning" })), false);
    assert.equal(engine.routeMatches(route, makeAlert({ severity: "critical" })), true);
  });

  await t.test("filtre alertType (mappé sur alert.metric)", () => {
    const engine = makeEngine();
    const route = { conditions: { alertType: ["memory"] } };
    assert.equal(engine.routeMatches(route, makeAlert({ metric: "cpu" })), false);
    assert.equal(engine.routeMatches(route, makeAlert({ metric: "memory" })), true);
  });

  await t.test("filtre process : ne matche que les alertes 'process' avec ce nom", () => {
    const engine = makeEngine();
    const route = { conditions: { process: ["api-prod"] } };
    assert.equal(
      engine.routeMatches(route, makeAlert({ targetType: "process", targetValue: "api-prod" })),
      true,
    );
    assert.equal(
      engine.routeMatches(route, makeAlert({ targetType: "process", targetValue: "worker" })),
      false,
    );
    assert.equal(engine.routeMatches(route, makeAlert({ targetType: "system", targetValue: null })), false);
  });

  await t.test("filtre server : ne matche que les alertes 'system' (mono-hôte)", () => {
    const engine = makeEngine();
    const route = { conditions: { server: ["local"] } };
    assert.equal(engine.routeMatches(route, makeAlert({ targetType: "system" })), true);
    assert.equal(engine.routeMatches(route, makeAlert({ targetType: "process" })), false);
  });

  await t.test("filtre tag : sans processOrg (aucun processOrgStore injecté), ne matche jamais", () => {
    const engine = makeEngine();
    const route = { conditions: { tag: ["prod"] } };
    assert.equal(engine.routeMatches(route, makeAlert()), false);
  });

  await t.test(
    "filtre tag : matche si l'un des tags de la route est porté par le process (processOrg)",
    () => {
      const engine = makeEngine();
      const route = { conditions: { tag: ["prod", "critical"] } };
      assert.equal(
        engine.routeMatches(route, makeAlert(), { tags: ["backend"], environment: null, groups: [] }),
        false,
      );
      assert.equal(
        engine.routeMatches(route, makeAlert(), {
          tags: ["backend", "critical"],
          environment: null,
          groups: [],
        }),
        true,
      );
    },
  );

  await t.test("filtre tag : une alerte 'system' n'a pas de process, donc pas de tag", () => {
    const engine = makeEngine();
    const route = { conditions: { tag: ["prod"] } };
    assert.equal(engine.routeMatches(route, makeAlert({ targetType: "system", targetValue: null })), false);
  });

  await t.test("filtre environment : matche l'environnement du process (processOrg)", () => {
    const engine = makeEngine();
    const route = { conditions: { environment: ["production"] } };
    assert.equal(
      engine.routeMatches(route, makeAlert(), { tags: [], environment: "staging", groups: [] }),
      false,
    );
    assert.equal(
      engine.routeMatches(route, makeAlert(), { tags: [], environment: "production", groups: [] }),
      true,
    );
    assert.equal(engine.routeMatches(route, makeAlert(), null), false);
  });

  await t.test(
    "filtre group : matche si l'un des groupes de la route est porté par le process (processOrg)",
    () => {
      const engine = makeEngine();
      const route = { conditions: { group: ["ecommerce"] } };
      assert.equal(
        engine.routeMatches(route, makeAlert(), { tags: [], environment: null, groups: ["other"] }),
        false,
      );
      assert.equal(
        engine.routeMatches(route, makeAlert(), { tags: [], environment: null, groups: ["ecommerce"] }),
        true,
      );
    },
  );

  await t.test("tag/environment/group combinés à severity (ET logique)", () => {
    const engine = makeEngine();
    const route = { conditions: { severity: ["critical"], tag: ["prod"], environment: ["production"] } };
    const processOrg = { tags: ["prod"], environment: "production", groups: [] };
    assert.equal(engine.routeMatches(route, makeAlert({ severity: "warning" }), processOrg), false);
    assert.equal(engine.routeMatches(route, makeAlert({ severity: "critical" }), processOrg), true);
  });

  await t.test("plusieurs conditions combinées (ET logique)", () => {
    const engine = makeEngine();
    const route = { conditions: { severity: ["warning"], process: ["api-prod"] } };
    assert.equal(
      engine.routeMatches(
        route,
        makeAlert({ severity: "warning", targetType: "process", targetValue: "api-prod" }),
      ),
      true,
    );
    assert.equal(
      engine.routeMatches(
        route,
        makeAlert({ severity: "critical", targetType: "process", targetValue: "api-prod" }),
      ),
      false,
    );
  });
});

test("routing/engine.js — RoutingEngine#dispatch", async (t) => {
  function makeStores({ routes = [], providers = {}, secrets = {}, sendImpl, processOrgStore } = {}) {
    const historyEntries = [];
    const routeStore = { list: async () => routes };
    const providerStore = {
      getById: async (id) => providers[id] || null,
      getDecryptedSecrets: async (id) => secrets[id] || null,
    };
    const registry = {
      getProvider: (type) => (type === "fake" ? { send: sendImpl } : null),
    };
    const historyStore = {
      create: async (entry) => {
        historyEntries.push(entry);
        return { id: historyEntries.length, ...entry };
      },
    };
    return { routeStore, providerStore, registry, historyStore, historyEntries, processOrgStore };
  }

  await t.test("aucune route ne matche : aucun envoi, tableau vide", async () => {
    const stores = makeStores({
      routes: [{ enabled: true, conditions: { severity: ["critical"] }, providerIds: [1] }],
    });
    const engine = new RoutingEngine(stores);
    const results = await engine.dispatch(makeAlert({ severity: "warning" }), "triggered");
    assert.deepEqual(results, []);
    assert.equal(stores.historyEntries.length, 0);
  });

  await t.test("route sans provider ciblé : ignorée (pas d'entrée d'historique)", async () => {
    const stores = makeStores({ routes: [{ enabled: true, conditions: {}, providerIds: [] }] });
    const engine = new RoutingEngine(stores);
    const results = await engine.dispatch(makeAlert(), "triggered");
    assert.deepEqual(results, []);
  });

  await t.test("route matchée, provider connu et actif : envoi + historique 'success'", async () => {
    const stores = makeStores({
      routes: [{ id: 5, enabled: true, conditions: {}, providerIds: [1] }],
      providers: {
        1: { id: 1, type: "fake", enabled: true, configuration: { url: "https://example.test" } },
      },
      sendImpl: async (notification) => {
        assert.ok(notification.title);
        assert.ok(notification.message);
        return { success: true, provider: "fake", messageId: "abc", responseTime: 42 };
      },
    });
    const engine = new RoutingEngine(stores);
    const results = await engine.dispatch(makeAlert(), "triggered");
    assert.equal(results.length, 1);
    assert.equal(stores.historyEntries.length, 1);
    assert.equal(stores.historyEntries[0].status, "success");
    assert.equal(stores.historyEntries[0].providerId, 1);
    assert.equal(stores.historyEntries[0].responseTimeMs, 42);
  });

  await t.test("provider introuvable : historique 'failed'/PROVIDER_NOT_FOUND, pas d'exception", async () => {
    const stores = makeStores({ routes: [{ id: 5, enabled: true, conditions: {}, providerIds: [999] }] });
    const engine = new RoutingEngine(stores);
    const results = await engine.dispatch(makeAlert(), "triggered");
    assert.equal(results.length, 1);
    assert.equal(stores.historyEntries[0].status, "failed");
    assert.equal(stores.historyEntries[0].errorCode, "PROVIDER_NOT_FOUND");
  });

  await t.test("provider désactivé : historique 'failed'/PROVIDER_DISABLED, aucun envoi tenté", async () => {
    let called = false;
    const stores = makeStores({
      routes: [{ id: 5, enabled: true, conditions: {}, providerIds: [1] }],
      providers: { 1: { id: 1, type: "fake", enabled: false, configuration: {} } },
      sendImpl: async () => {
        called = true;
        return { success: true };
      },
    });
    const engine = new RoutingEngine(stores);
    await engine.dispatch(makeAlert(), "triggered");
    assert.equal(called, false);
    assert.equal(stores.historyEntries[0].errorCode, "PROVIDER_DISABLED");
  });

  await t.test(
    "provider en échec réseau (send() renvoie success:false) : historique 'failed', pas d'exception",
    async () => {
      const stores = makeStores({
        routes: [{ id: 5, enabled: true, conditions: {}, providerIds: [1] }],
        providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
        sendImpl: async () => ({
          success: false,
          provider: "fake",
          errorCode: "NETWORK_ERROR",
          safeMessage: "…",
          responseTime: 10,
        }),
      });
      const engine = new RoutingEngine(stores);
      const results = await engine.dispatch(makeAlert(), "triggered");
      assert.equal(results.length, 1);
      assert.equal(stores.historyEntries[0].status, "failed");
      assert.equal(stores.historyEntries[0].errorCode, "NETWORK_ERROR");
    },
  );

  await t.test(
    "provider qui lance une exception : capturée, historique 'failed'/INTERNAL_ERROR",
    async () => {
      const stores = makeStores({
        routes: [{ id: 5, enabled: true, conditions: {}, providerIds: [1] }],
        providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
        sendImpl: async () => {
          throw new Error("boom");
        },
      });
      const engine = new RoutingEngine(stores);
      const results = await engine.dispatch(makeAlert(), "triggered");
      assert.equal(results.length, 1);
      assert.equal(stores.historyEntries[0].status, "failed");
      assert.equal(stores.historyEntries[0].errorCode, "INTERNAL_ERROR");
    },
  );

  await t.test(
    "route désactivée exclue par routeStore.list({enabledOnly:true}) (contrat, pas re-vérifié ici)",
    async () => {
      // RoutingEngine délègue le filtre enabled/disabled à routeStore.list() —
      // ce test vérifie juste qu'il l'appelle bien avec enabledOnly:true.
      let receivedOpts = null;
      const engine = new RoutingEngine({
        routeStore: {
          list: async (opts) => {
            receivedOpts = opts;
            return [];
          },
        },
        providerStore: { getById: async () => null, getDecryptedSecrets: async () => null },
        registry: { getProvider: () => null },
        historyStore: { create: async () => ({}) },
      });
      await engine.dispatch(makeAlert(), "triggered");
      assert.deepEqual(receivedOpts, { enabledOnly: true });
    },
  );

  await t.test("event 'resolved' : ignoré si notifyOnResolve n'est pas positionné", async () => {
    const stores = makeStores({
      routes: [{ id: 5, enabled: true, conditions: {}, providerIds: [1], notifyOnResolve: false }],
      providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
      sendImpl: async () => ({ success: true }),
    });
    const engine = new RoutingEngine(stores);
    const results = await engine.dispatch(makeAlert({ state: "resolved" }), "resolved");
    assert.deepEqual(results, []);
  });

  await t.test("event 'resolved' : envoyé si notifyOnResolve est activé", async () => {
    const stores = makeStores({
      routes: [{ id: 5, enabled: true, conditions: {}, providerIds: [1], notifyOnResolve: true }],
      providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
      sendImpl: async () => ({ success: true, responseTime: 5 }),
    });
    const engine = new RoutingEngine(stores);
    const results = await engine.dispatch(makeAlert({ state: "resolved" }), "resolved");
    assert.equal(results.length, 1);
    assert.equal(stores.historyEntries[0].status, "success");
  });

  await t.test("event 'triggered' toujours envoyé, indépendamment de notifyOnResolve", async () => {
    const stores = makeStores({
      routes: [{ id: 5, enabled: true, conditions: {}, providerIds: [1], notifyOnResolve: false }],
      providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
      sendImpl: async () => ({ success: true }),
    });
    const engine = new RoutingEngine(stores);
    const results = await engine.dispatch(makeAlert(), "triggered");
    assert.equal(results.length, 1);
  });

  await t.test("plusieurs providers sur une même route : un envoi par provider", async () => {
    const stores = makeStores({
      routes: [{ id: 5, enabled: true, conditions: {}, providerIds: [1, 2] }],
      providers: {
        1: { id: 1, type: "fake", enabled: true, configuration: {} },
        2: { id: 2, type: "fake", enabled: true, configuration: {} },
      },
      sendImpl: async () => ({ success: true }),
    });
    const engine = new RoutingEngine(stores);
    const results = await engine.dispatch(makeAlert(), "triggered");
    assert.equal(results.length, 2);
  });

  await t.test("dispatch() ne lance jamais, même si routeStore.list() lance", async () => {
    const engine = new RoutingEngine({
      routeStore: {
        list: async () => {
          throw new Error("db down");
        },
      },
      providerStore: { getById: async () => null, getDecryptedSecrets: async () => null },
      registry: { getProvider: () => null },
      historyStore: { create: async () => ({}) },
    });
    const results = await engine.dispatch(makeAlert(), "triggered");
    assert.deepEqual(results, []);
  });

  await t.test(
    "processOrgStore injecté : une route conditions.tag matche via l'organisation du process",
    async () => {
      const stores = makeStores({
        routes: [{ id: 5, enabled: true, conditions: { tag: ["prod"] }, providerIds: [1] }],
        providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
        sendImpl: async () => ({ success: true }),
        processOrgStore: {
          getOrganizationForProcess: async (name) =>
            name === "api-prod" ? { tags: ["prod", "backend"], environment: "production", groups: [] } : null,
        },
      });
      const engine = new RoutingEngine({ ...stores, processOrgStore: stores.processOrgStore });
      const results = await engine.dispatch(
        makeAlert({ targetType: "process", targetValue: "api-prod" }),
        "triggered",
      );
      assert.equal(results.length, 1);
      assert.equal(stores.historyEntries[0].status, "success");
    },
  );

  await t.test(
    "processOrgStore injecté : une route conditions.tag ne matche pas si le process n'a pas le tag",
    async () => {
      const stores = makeStores({
        routes: [{ id: 5, enabled: true, conditions: { tag: ["prod"] }, providerIds: [1] }],
        providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
        sendImpl: async () => ({ success: true }),
        processOrgStore: {
          getOrganizationForProcess: async () => ({ tags: ["staging"], environment: "staging", groups: [] }),
        },
      });
      const engine = new RoutingEngine({ ...stores, processOrgStore: stores.processOrgStore });
      const results = await engine.dispatch(
        makeAlert({ targetType: "process", targetValue: "api-prod" }),
        "triggered",
      );
      assert.deepEqual(results, []);
    },
  );

  await t.test(
    "processOrgStore qui lance : n'empêche pas le dispatch (repli sur processOrg=null)",
    async () => {
      const stores = makeStores({
        routes: [{ id: 5, enabled: true, conditions: {}, providerIds: [1] }],
        providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
        sendImpl: async () => ({ success: true }),
        processOrgStore: {
          getOrganizationForProcess: async () => {
            throw new Error("db down");
          },
        },
      });
      const engine = new RoutingEngine({ ...stores, processOrgStore: stores.processOrgStore });
      const results = await engine.dispatch(
        makeAlert({ targetType: "process", targetValue: "api-prod" }),
        "triggered",
      );
      assert.equal(results.length, 1); // route sans conditions.tag/environment/group : matche quand même
    },
  );

  await t.test("dispatch(null) : renvoie [] sans appeler les stores", async () => {
    let called = false;
    const engine = new RoutingEngine({
      routeStore: {
        list: async () => {
          called = true;
          return [];
        },
      },
      providerStore: { getById: async () => null, getDecryptedSecrets: async () => null },
      registry: { getProvider: () => null },
      historyStore: { create: async () => ({}) },
    });
    const results = await engine.dispatch(null, "triggered");
    assert.deepEqual(results, []);
    assert.equal(called, false);
  });

  await t.test(
    "secrets fusionnés dans la config transmise à send() — jamais renvoyés dans le résultat/historique",
    async () => {
      let receivedConfig = null;
      const stores = makeStores({
        routes: [{ id: 5, enabled: true, conditions: {}, providerIds: [1] }],
        providers: { 1: { id: 1, type: "fake", enabled: true, configuration: { url: "https://x" } } },
        secrets: { 1: { webhookToken: "super-secret" } },
        sendImpl: async (_notification, config) => {
          receivedConfig = config;
          return { success: true };
        },
      });
      const engine = new RoutingEngine(stores);
      await engine.dispatch(makeAlert(), "triggered");
      assert.equal(receivedConfig.webhookToken, "super-secret");
      assert.equal(receivedConfig.url, "https://x");
      // Rien dans l'historique ne doit contenir le secret.
      const historyJson = JSON.stringify(stores.historyEntries);
      assert.ok(!historyJson.includes("super-secret"));
    },
  );
});
