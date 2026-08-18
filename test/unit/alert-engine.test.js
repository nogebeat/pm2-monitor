"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AlertEngine, compare, buildDedupKey } = require("../../lib/services/alerts/engine");

/**
 * Fake alertStore en mémoire : reproduit fidèlement le contrat de
 * lib/services/alerts/alert-store.js (mêmes noms de méthode, mêmes
 * transitions), sans toucher à la DB. Volontairement minimal — l'objectif
 * ici est de tester la logique de AlertEngine de façon isolée et rapide ;
 * la couverture "avec vraie DB + API + permissions" est dans
 * test/integration/alerts-api.test.js.
 */
function fakeAlertStore() {
  let nextId = 1;
  const rows = new Map();
  return {
    async create(fields) {
      const row = { id: nextId++, ...fields };
      rows.set(row.id, row);
      return { ...row };
    },
    async getById(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async findOpenByDedupKey(dedupKey) {
      for (const row of rows.values()) {
        if (row.dedupKey === dedupKey && ["trigger", "active", "acknowledged"].includes(row.state)) {
          return { ...row };
        }
      }
      return null;
    },
    async findLastResolvedByDedupKey(dedupKey) {
      let best = null;
      for (const row of rows.values()) {
        if (row.dedupKey === dedupKey && row.state === "resolved") {
          if (!best || row.resolvedAt > best.resolvedAt) best = row;
        }
      }
      return best ? { ...best } : null;
    },
    async update(id, changes) {
      const row = rows.get(id);
      if (!row) throw new Error("Alerte introuvable.");
      Object.assign(row, changes);
      return { ...row };
    },
    touch(id, changes) {
      return this.update(id, changes);
    },
    async remove(id) {
      return rows.delete(id);
    },
    _all: () => [...rows.values()],
  };
}

function makeRule(overrides = {}) {
  return {
    id: 1,
    name: "CPU haut",
    enabled: true,
    targetType: "process",
    targetValue: "*",
    metric: "cpu",
    operator: ">",
    threshold: 80,
    durationSeconds: 300,
    severity: "warning",
    cooldownSeconds: 1800,
    ...overrides,
  };
}

test("compare() — tous les opérateurs", () => {
  assert.equal(compare(81, ">", 80), true);
  assert.equal(compare(79, ">", 80), false);
  assert.equal(compare(80, ">=", 80), true);
  assert.equal(compare(79, "<", 80), true);
  assert.equal(compare(80, "<=", 80), true);
  assert.equal(compare("stopped", "==", "stopped"), true);
  assert.equal(compare("online", "!=", "stopped"), true);
  assert.throws(() => compare(1, "~=", 1), /Opérateur invalide/);
});

test("buildDedupKey() — même clé pour rule+target+metric identiques", () => {
  assert.equal(buildDedupKey(1, "process", "api", "cpu"), buildDedupKey(1, "process", "api", "cpu"));
  assert.notEqual(buildDedupKey(1, "process", "api", "cpu"), buildDedupKey(1, "process", "worker", "cpu"));
});

test("AlertEngine — cycle de vie complet", async (t) => {
  await t.test("CPU sous le seuil -> aucune alerte", async () => {
    const store = fakeAlertStore();
    const engine = new AlertEngine({ alertStore: store, now: () => 0 });
    const result = await engine.evaluate(makeRule(), "api", 79);
    assert.equal(result, null);
    assert.equal(store._all().length, 0);
  });

  await t.test("CPU dépasse le seuil -> état trigger, pas encore active", async () => {
    const store = fakeAlertStore();
    let now = 0;
    const engine = new AlertEngine({ alertStore: store, now: () => now });
    const result = await engine.evaluate(makeRule(), "api", 81);
    assert.equal(result.state, "trigger");
  });

  await t.test("condition reste vraie durant duration_seconds -> passe active", async () => {
    const store = fakeAlertStore();
    let now = 0;
    const engine = new AlertEngine({ alertStore: store, now: () => now });
    const rule = makeRule({ durationSeconds: 300 });

    await engine.evaluate(rule, "api", 81); // trigger à t=0
    now = 100 * 1000; // 100s : pas encore écoulé
    let r = await engine.evaluate(rule, "api", 81);
    assert.equal(r.state, "trigger");

    now = 300 * 1000; // 300s : durée atteinte
    r = await engine.evaluate(rule, "api", 82);
    assert.equal(r.state, "active");
  });

  await t.test(
    "condition redevient fausse avant la fin de duration -> pas d'alerte, ligne supprimée",
    async () => {
      const store = fakeAlertStore();
      let now = 0;
      const engine = new AlertEngine({ alertStore: store, now: () => now });
      const rule = makeRule({ durationSeconds: 300 });

      await engine.evaluate(rule, "api", 81); // trigger
      now = 100 * 1000;
      const cleared = await engine.evaluate(rule, "api", 50); // redescend avant l'échéance
      assert.equal(cleared, null);
      assert.equal(store._all().length, 0, "aucune trace : ce n'était jamais une vraie alerte");
    },
  );

  await t.test("active -> resolved quand la condition redevient fausse", async () => {
    const store = fakeAlertStore();
    let now = 0;
    const engine = new AlertEngine({ alertStore: store, now: () => now });
    const rule = makeRule({ durationSeconds: 0, cooldownSeconds: 1800 });

    await engine.evaluate(rule, "api", 81); // trigger (durationSeconds=0 : la transition active se fait au tick suivant)
    const active = await engine.evaluate(rule, "api", 81);
    assert.equal(active.state, "active");

    now = 10_000;
    const resolved = await engine.evaluate(rule, "api", 50);
    assert.equal(resolved.state, "resolved");
    assert.equal(resolved.cooldownUntil, now + 1800 * 1000);
  });

  await t.test(
    "anti-spam : condition qui reste vraie -> une seule alerte active (touch, pas de doublon)",
    async () => {
      const store = fakeAlertStore();
      let now = 0;
      const engine = new AlertEngine({ alertStore: store, now: () => now });
      const rule = makeRule({ durationSeconds: 0 });

      await engine.evaluate(rule, "api", 81); // trigger
      await engine.evaluate(rule, "api", 81); // -> active
      for (let i = 1; i <= 5; i++) {
        now = i * 1000;
        await engine.evaluate(rule, "api", 81 + i);
      }
      const activeRows = store._all().filter((r) => r.state === "active");
      assert.equal(activeRows.length, 1, "une seule occurrence active malgré 6 évaluations vraies");
    },
  );

  await t.test("cooldown : pas de re-déclenchement immédiat après resolve", async () => {
    const store = fakeAlertStore();
    let now = 0;
    const engine = new AlertEngine({ alertStore: store, now: () => now });
    const rule = makeRule({ durationSeconds: 0, cooldownSeconds: 1800 });

    await engine.evaluate(rule, "api", 81); // trigger
    await engine.evaluate(rule, "api", 81); // active
    now = 1000;
    await engine.evaluate(rule, "api", 50); // resolved, cooldown_until = 1000 + 1800000

    now = 5000; // toujours dans le cooldown
    const blocked = await engine.evaluate(rule, "api", 90);
    assert.equal(blocked, null, "cooldown actif : pas de nouvelle alerte");

    now = 1000 + 1800 * 1000 + 1; // cooldown expiré
    const retriggered = await engine.evaluate(rule, "api", 90);
    assert.equal(retriggered.state, "trigger", "cooldown expiré : peut re-déclencher");
  });

  await t.test("acknowledge : active -> acknowledged, idempotent, rejette hors 'active'", async () => {
    const store = fakeAlertStore();
    const engine = new AlertEngine({ alertStore: store, now: () => 0 });
    const rule = makeRule({ durationSeconds: 0 });
    await engine.evaluate(rule, "api", 90); // trigger
    const active = await engine.evaluate(rule, "api", 90); // active

    const ack1 = await engine.acknowledge(active.id, { id: 42 });
    assert.equal(ack1.state, "acknowledged");
    assert.equal(ack1.acknowledgedBy, 42);

    const ack2 = await engine.acknowledge(active.id, { id: 42 }); // idempotent
    assert.equal(ack2.state, "acknowledged");

    await assert.rejects(() => engine.acknowledge(999, {}), /introuvable/i);
  });

  await t.test(
    "acknowledged : condition qui reste vraie ne spamme pas, redevient resolved si fausse",
    async () => {
      const store = fakeAlertStore();
      let now = 0;
      const engine = new AlertEngine({ alertStore: store, now: () => now });
      const rule = makeRule({ durationSeconds: 0 });

      await engine.evaluate(rule, "api", 90); // trigger
      const active = await engine.evaluate(rule, "api", 90); // active
      await engine.acknowledge(active.id, { id: 1 });

      now = 1000;
      const stillOpen = await engine.evaluate(rule, "api", 91);
      assert.equal(stillOpen.state, "acknowledged", "reste acknowledged, pas de nouvelle occurrence");

      now = 2000;
      const resolved = await engine.evaluate(rule, "api", 10);
      assert.equal(resolved.state, "resolved");
    },
  );

  await t.test("règle désactivée -> evaluate() ne fait rien", async () => {
    const store = fakeAlertStore();
    const engine = new AlertEngine({ alertStore: store, now: () => 0 });
    const result = await engine.evaluate(makeRule({ enabled: false }), "api", 999);
    assert.equal(result, null);
    assert.equal(store._all().length, 0);
  });

  await t.test("plusieurs cibles (process) pour une même règle -> alertes indépendantes", async () => {
    const store = fakeAlertStore();
    const engine = new AlertEngine({ alertStore: store, now: () => 0 });
    const rule = makeRule({ durationSeconds: 0, targetValue: "*" });

    const a = await engine.evaluate(rule, "api", 90); // trigger (cible différente : dedupKey différent, indépendant de "b")
    const b = await engine.evaluate(rule, "worker", 95); // trigger
    assert.notEqual(a.dedupKey, b.dedupKey);
    assert.equal(store._all().length, 2);
  });

  await t.test(
    "plusieurs règles sur la même cible -> alertes indépendantes (clé de dédup différente)",
    async () => {
      const store = fakeAlertStore();
      const engine = new AlertEngine({ alertStore: store, now: () => 0 });
      const cpuRule = makeRule({ id: 1, metric: "cpu", durationSeconds: 0 });
      const memRule = makeRule({ id: 2, metric: "memory", durationSeconds: 0, threshold: 500 });

      const a = await engine.evaluate(cpuRule, "api", 90);
      const b = await engine.evaluate(memRule, "api", 600);
      assert.notEqual(a.dedupKey, b.dedupKey);
      assert.equal(store._all().length, 2);
    },
  );
});

test("evaluateProcessReadings() — filtre par targetValue et ignore les métriques indisponibles", async () => {
  const rules = [
    makeRule({ id: 1, targetValue: "api", durationSeconds: 0 }),
    makeRule({ id: 2, metric: "restart_count", targetValue: "*", threshold: 3, durationSeconds: 0 }),
  ];
  const ruleStore = { listEnabledByTargetType: async () => rules };
  const store = fakeAlertStore();
  const engine = new AlertEngine({ ruleStore, alertStore: store, now: () => 0 });

  const processes = [
    { name: "api", cpu: 90, memory: 0, restarts: 1, status: "online" },
    { name: "worker", cpu: 10, memory: 0, restarts: 5, status: "online" },
  ];
  const results = await engine.evaluateProcessReadings(processes);
  const created = results.filter(Boolean);
  // rule 1 (cpu>80) ne cible que "api" -> 1 alerte ; rule 2 (restart_count>3, target "*") -> déclenche pour "worker" seulement
  assert.equal(created.length, 2);
  assert.ok(created.some((r) => r.targetValue === "api" && r.metric === "cpu"));
  assert.ok(created.some((r) => r.targetValue === "worker" && r.metric === "restart_count"));
});
