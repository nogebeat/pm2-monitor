"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AnomalyDetectionService } = require("../../lib/services/anomaly-detection/service");
const { AlertEngine } = require("../../lib/services/alerts/engine");

/** Même fake alertStore en mémoire que test/unit/alert-engine.test.js. */
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

function fakeRuleStore(rules) {
  return {
    async listEnabledByTargetType(targetType) {
      return rules.filter((r) => r.enabled && r.targetType === targetType);
    },
  };
}

function fakeDetectionStore() {
  const rows = [];
  return {
    async create(fields) {
      const row = { id: rows.length + 1, ...fields };
      rows.push(row);
      return row;
    },
    _all: () => rows,
  };
}

function makeRule(overrides = {}) {
  return {
    id: 1,
    name: "CPU anormal",
    enabled: true,
    targetType: "process",
    targetValue: "*",
    metric: "cpu",
    sensitivity: 3,
    windowMs: 24 * 60 * 60 * 1000,
    minSamples: 10,
    cooldownSeconds: 900,
    severity: "warning",
    ...overrides,
  };
}

const NORMAL_HISTORY = [48, 50, 52, 49, 51, 50, 47, 53, 50, 49, 51, 48];

function makeService({ rules, now = () => 0 } = {}) {
  const alertStore = fakeAlertStore();
  const alertEngine = new AlertEngine({ alertStore, now });
  const detectionStore = fakeDetectionStore();
  const ruleStore = fakeRuleStore(rules);
  const service = new AnomalyDetectionService({ ruleStore, detectionStore, alertEngine, now });
  return { service, alertStore, detectionStore, alertEngine };
}

test("AnomalyDetectionService — donnée normale -> aucune alerte, aucune détection persistée", async () => {
  const { service, alertStore, detectionStore } = makeService({ rules: [makeRule()] });
  const reading = { value: 51, history: NORMAL_HISTORY, previousPeriodValue: 50 };
  const result = await service._evaluateReading(makeRule(), "api", reading);
  assert.equal(result, null);
  assert.equal(alertStore._all().length, 0);
  assert.equal(detectionStore._all().length, 0);
});

test("AnomalyDetectionService — donnée anormale -> alimente le moteur d'alertes existant (trigger)", async () => {
  const { service, alertStore, detectionStore } = makeService({ rules: [makeRule()] });
  const reading = { value: 150, history: NORMAL_HISTORY, previousPeriodValue: 50 };
  const result = await service._evaluateReading(makeRule(), "api", reading);
  assert.ok(result, "une occurrence d'alerte doit être créée");
  assert.equal(result.state, "trigger");
  assert.equal(alertStore._all().length, 1, "aucun second moteur : l'occurrence vit dans la même table alerts");
  assert.equal(detectionStore._all().length, 1, "l'explication statistique est persistée");
  const detection = detectionStore._all()[0];
  assert.equal(detection.metric, "cpu");
  assert.ok(detection.explanation.length > 10, "toujours une explication");
  assert.equal(detection.alertId, result.id, "la détection est liée à l'alerte créée");
});

test("AnomalyDetectionService — données insuffisantes -> ne déclenche JAMAIS, même avec une valeur extrême", async () => {
  const { service, alertStore, detectionStore } = makeService({ rules: [makeRule()] });
  const reading = { value: 999, history: [50, 51, 49], previousPeriodValue: null }; // 3 échantillons < minSamples
  const result = await service._evaluateReading(makeRule(), "api", reading);
  assert.equal(result, null);
  assert.equal(alertStore._all().length, 0);
  assert.equal(detectionStore._all().length, 0);
});

test("AnomalyDetectionService — absence totale de données (reading null) -> ne déclenche jamais", async () => {
  const { service, alertStore } = makeService({ rules: [makeRule()] });
  const result = await service._evaluateReading(makeRule(), "api", null);
  assert.equal(result, null);
  assert.equal(alertStore._all().length, 0);
});

test("AnomalyDetectionService — l'anomalie se résout quand la valeur revient à la normale", async () => {
  let now = 0;
  const rule = makeRule({ durationSeconds: 0 });
  const { service, alertStore } = makeService({ rules: [rule], now: () => now });

  await service._evaluateReading(rule, "api", { value: 150, history: NORMAL_HISTORY }); // trigger
  const active = await service._evaluateReading(rule, "api", { value: 150, history: NORMAL_HISTORY });
  assert.equal(active.state, "active");

  now = 5000;
  const resolved = await service._evaluateReading(rule, "api", { value: 50, history: NORMAL_HISTORY });
  assert.equal(resolved.state, "resolved");
  assert.equal(alertStore._all().length, 1, "toujours une seule occurrence, résolue");
});

test("AnomalyDetectionService — cooldown : pas de re-déclenchement immédiat après résolution", async () => {
  let now = 0;
  const rule = makeRule({ durationSeconds: 0, cooldownSeconds: 900 });
  const { service } = makeService({ rules: [rule], now: () => now });

  await service._evaluateReading(rule, "api", { value: 150, history: NORMAL_HISTORY }); // trigger
  await service._evaluateReading(rule, "api", { value: 150, history: NORMAL_HISTORY }); // active
  now = 1000;
  await service._evaluateReading(rule, "api", { value: 50, history: NORMAL_HISTORY }); // resolved, cooldown 900s

  now = 5000; // dans le cooldown
  const blocked = await service._evaluateReading(rule, "api", { value: 150, history: NORMAL_HISTORY });
  assert.equal(blocked, null, "cooldown actif : pas de nouvelle alerte malgré une nouvelle anomalie");

  now = 1000 + 900 * 1000 + 1; // cooldown expiré
  const retriggered = await service._evaluateReading(rule, "api", { value: 150, history: NORMAL_HISTORY });
  assert.equal(retriggered.state, "trigger", "cooldown expiré : peut re-détecter");
});

test("AnomalyDetectionService — deux règles distinctes sur la même cible/métrique ne se marchent pas dessus", async () => {
  const ruleA = makeRule({ id: 1, name: "A", sensitivity: 3 });
  const ruleB = makeRule({ id: 2, name: "B", sensitivity: 3 });
  const { service, alertStore } = makeService({ rules: [ruleA, ruleB] });

  await service._evaluateReading(ruleA, "api", { value: 150, history: NORMAL_HISTORY });
  await service._evaluateReading(ruleB, "api", { value: 150, history: NORMAL_HISTORY });

  assert.equal(alertStore._all().length, 2, "deux occurrences distinctes, une par règle (dedup key par rule.id)");
});

test("AnomalyDetectionService — evaluateProcessReadings respecte targetValue (process ciblé vs '*')", async () => {
  const rule = makeRule({ targetValue: "api" }); // ne cible que "api"
  const { service } = makeService({ rules: [rule] });
  service.processHistoryStore = {
    async queryRaw({ processName }) {
      // historique normal pour "api", vide pour "worker" (ne devrait jamais être interrogé)
      if (processName !== "api") throw new Error("ne devrait pas être appelé pour ce process");
      return NORMAL_HISTORY.map((cpu, i) => ({ ts: i, cpu, memory: null }));
    },
  };
  const processes = [
    { name: "api", cpu: 150 },
    { name: "worker", cpu: 150 },
  ];
  const results = await service.evaluateProcessReadings(processes);
  assert.equal(results.length, 1, "seul 'api' est évalué, 'worker' est hors du scope de la règle");
});

test("AnomalyDetectionService — escalade la sévérité (jamais ne rétrograde) quand le z-score s'aggrave", async () => {
  let now = 0;
  const rule = makeRule({ durationSeconds: 0, severity: "warning", sensitivity: 3 });
  const { service, alertStore } = makeService({ rules: [rule], now: () => now });

  const trigger = await service._evaluateReading(rule, "api", { value: 150, history: NORMAL_HISTORY }); // z ~ 40+
  assert.equal(trigger.severity, "critical", "z-score très supérieur à 2x la sensibilité -> critical dès le trigger");

  now = 1000;
  const active = await service._evaluateReading(rule, "api", { value: 150, history: NORMAL_HISTORY });
  assert.equal(active.state, "active");
  assert.equal(active.severity, "critical", "reste critical, jamais rétrogradé automatiquement");
  assert.equal(alertStore._all().length, 1, "une seule occurrence, sévérité mise à jour en place");
});

test("AnomalyDetectionService — sévérité modérée reste au niveau configuré par la règle (pas d'escalade injustifiée)", async () => {
  const rule = makeRule({ durationSeconds: 0, severity: "warning", sensitivity: 3 });
  const { service } = makeService({ rules: [rule] });
  // z-score ~4.9 : au-dessus de la sensibilité (3) mais sous 2x (6) -> reste "warning".
  const trigger = await service._evaluateReading(rule, "api", { value: 58, history: NORMAL_HISTORY });
  assert.equal(trigger.severity, "warning");
});

test("AnomalyDetectionService — filet de sécurité en mémoire quand process-history est insuffisant", async () => {
  const rule = makeRule({ metric: "cpu", minSamples: 5, windowMs: 60 * 60 * 1000 });
  let t = 0;
  const { service, alertStore, detectionStore } = makeService({ rules: [rule], now: () => t });
  // process-history ne renvoie jamais assez d'échantillons (service désactivé/tout juste démarré).
  service.processHistoryStore = {
    async queryRaw() {
      return [];
    },
  };

  // Les premiers ticks alimentent le filet de sécurité, pas assez d'historique pour décider encore.
  for (let i = 0; i < 5; i++) {
    t += 1000;
     
    await service.evaluateProcessReadings([{ name: "api", cpu: 50 + i }]);
  }
  assert.equal(alertStore._all().length, 0, "toujours pas assez d'échantillons dans le filet de sécurité");

  // Un pic après avoir accumulé assez de points en mémoire doit être détecté.
  t += 1000;
  const results = await service.evaluateProcessReadings([{ name: "api", cpu: 900 }]);
  assert.equal(results.length, 1, "le filet de sécurité en mémoire a fini par fournir assez d'échantillons");
  assert.equal(detectionStore._all()[0].method, "zscore_fallback");
});
