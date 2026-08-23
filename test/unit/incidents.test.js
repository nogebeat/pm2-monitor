"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

const alertStore = require("../../lib/services/alerts/alert-store");
const ruleStore = require("../../lib/services/alerts/alert-rules-store");
const incidentStore = require("../../lib/services/incidents/incident-store");
const silenceStore = require("../../lib/services/incidents/silence-store");
const { IncidentCorrelator } = require("../../lib/services/incidents/correlation");

/**
 * Tests unitaires du service Incidents (Phase 14 — Incident Management &
 * Alert Silencing). DB SQLite temporaire par test (comme
 * test/unit/process-organization-store.test.js) : les stores sont appelés
 * directement, sans HTTP — voir test/integration/incidents-api.test.js pour
 * l'API REST.
 */

// alerts.rule_id référence alert_rules(id) (FK, migration 003) : les tests de
// corrélation ont besoin d'une vraie règle en base, pas juste d'un entier
// arbitraire — créée une fois par bloc test via ensureRule().
let sharedRuleId = null;
async function ensureRule() {
  if (sharedRuleId) return sharedRuleId;
  const rule = await ruleStore.create({
    name: "Règle de test (incidents)",
    targetType: "process",
    metric: "cpu",
    operator: ">",
    threshold: 80,
    durationSeconds: 0,
    severity: "warning",
    cooldownSeconds: 0,
  });
  sharedRuleId = rule.id;
  return sharedRuleId;
}

function makeAlertFields(overrides = {}) {
  const now = overrides.now || Date.now();
  return {
    ruleId: sharedRuleId,
    ruleName: "CPU haut",
    dedupKey: `${sharedRuleId}:process:api-prod:cpu:${Math.random()}`,
    targetType: "process",
    targetValue: "api-prod",
    metric: "cpu",
    operator: ">",
    threshold: 80,
    severity: "warning",
    state: "active",
    value: "91",
    conditionMetAt: now,
    triggeredAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

test("incidents/incident-store — CRUD, corrélation, transitions", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("create() puis getById()", async () => {
    const incident = await incidentStore.create({
      title: "CPU haut — api-prod",
      severity: "warning",
      targetType: "process",
      targetValue: "api-prod",
      metric: "cpu",
      correlationKey: "process:api-prod:cpu",
      firstAlertId: 1,
    });
    assert.ok(incident.id);
    assert.equal(incident.status, "OPEN");
    assert.equal(incident.severity, "warning");
    const fetched = await incidentStore.getById(incident.id);
    assert.equal(fetched.title, "CPU haut — api-prod");
  });

  await t.test("findOpenByCorrelationKey() ignore un incident RESOLVED", async () => {
    const incident = await incidentStore.create({
      title: "Mémoire haute — worker",
      severity: "critical",
      targetType: "process",
      targetValue: "worker",
      metric: "memory",
      correlationKey: "process:worker:memory",
      firstAlertId: 2,
    });
    const found = await incidentStore.findOpenByCorrelationKey("process:worker:memory", Date.now() - 60000);
    assert.equal(found.id, incident.id);

    await incidentStore.transition(incident.id, "RESOLVED");
    const afterResolve = await incidentStore.findOpenByCorrelationKey(
      "process:worker:memory",
      Date.now() - 60000,
    );
    assert.equal(afterResolve, null);
  });

  await t.test("findOpenByCorrelationKey() respecte la fenêtre temporelle", async () => {
    const incident = await incidentStore.create({
      title: "Disque plein — db",
      severity: "critical",
      targetType: "process",
      targetValue: "db",
      metric: "disk",
      correlationKey: "process:db:disk",
      firstAlertId: 3,
    });
    // Fenêtre commençant APRÈS la création -> hors fenêtre, ne doit rien trouver.
    const outOfWindow = await incidentStore.findOpenByCorrelationKey("process:db:disk", Date.now() + 1000);
    assert.equal(outOfWindow, null);
    const inWindow = await incidentStore.findOpenByCorrelationKey("process:db:disk", Date.now() - 1000);
    assert.equal(inWindow.id, incident.id);
  });

  await t.test("bumpSeverity() ne redescend jamais la sévérité (critical > warning > info)", async () => {
    const incident = await incidentStore.create({
      title: "Test sévérité",
      severity: "info",
      targetType: "process",
      targetValue: "svc-a",
      metric: "cpu",
      correlationKey: "process:svc-a:cpu",
      firstAlertId: 4,
    });
    const bumped = await incidentStore.bumpSeverity(incident.id, "critical");
    assert.equal(bumped.severity, "critical");
    const notDowngraded = await incidentStore.bumpSeverity(incident.id, "warning");
    assert.equal(notDowngraded.severity, "critical");
  });

  await t.test("linkAlert() est idempotent (une alerte n'appartient qu'à un seul incident)", async () => {
    const incident = await incidentStore.create({
      title: "Test link",
      severity: "warning",
      targetType: "process",
      targetValue: "svc-b",
      metric: "cpu",
      correlationKey: "process:svc-b:cpu",
      firstAlertId: 5,
    });
    await incidentStore.linkAlert(incident.id, 42);
    await incidentStore.linkAlert(incident.id, 42); // ré-appel : ne doit pas lancer
    const ids = await incidentStore.listAlertIds(incident.id);
    assert.deepEqual(ids, [42]);
  });

  await t.test("transition() — machine à états : transitions valides", async () => {
    const incident = await incidentStore.create({
      title: "Cycle de vie",
      severity: "warning",
      targetType: "process",
      targetValue: "svc-c",
      metric: "cpu",
      correlationKey: "process:svc-c:cpu",
      firstAlertId: 6,
    });
    const ack = await incidentStore.transition(incident.id, "ACKNOWLEDGED", { userId: 1 });
    assert.equal(ack.status, "ACKNOWLEDGED");
    assert.ok(ack.acknowledgedAt);
    assert.equal(ack.acknowledgedBy, 1);

    const investigating = await incidentStore.transition(incident.id, "INVESTIGATING");
    assert.equal(investigating.status, "INVESTIGATING");

    const mitigated = await incidentStore.transition(incident.id, "MITIGATED");
    assert.equal(mitigated.status, "MITIGATED");

    const resolved = await incidentStore.transition(incident.id, "RESOLVED", { userId: 2 });
    assert.equal(resolved.status, "RESOLVED");
    assert.ok(resolved.resolvedAt);
    assert.equal(resolved.resolvedBy, 2);
  });

  await t.test("transition() — refuse une transition invalide (RESOLVED est terminal)", async () => {
    const incident = await incidentStore.create({
      title: "Terminal",
      severity: "warning",
      targetType: "process",
      targetValue: "svc-d",
      metric: "cpu",
      correlationKey: "process:svc-d:cpu",
      firstAlertId: 7,
    });
    await incidentStore.transition(incident.id, "RESOLVED");
    await assert.rejects(() => incidentStore.transition(incident.id, "ACKNOWLEDGED"), /Transition invalide/);
  });

  await t.test("transition() — idempotent si l'état cible est déjà l'état courant", async () => {
    const incident = await incidentStore.create({
      title: "Idempotence",
      severity: "warning",
      targetType: "process",
      targetValue: "svc-e",
      metric: "cpu",
      correlationKey: "process:svc-e:cpu",
      firstAlertId: 8,
    });
    const same = await incidentStore.transition(incident.id, "OPEN");
    assert.equal(same.status, "OPEN");
  });

  await t.test("transition() — état invalide rejeté", async () => {
    const incident = await incidentStore.create({
      title: "État invalide",
      severity: "warning",
      targetType: "process",
      targetValue: "svc-f",
      metric: "cpu",
      correlationKey: "process:svc-f:cpu",
      firstAlertId: 9,
    });
    await assert.rejects(() => incidentStore.transition(incident.id, "BOGUS"), /État invalide/);
  });

  await t.test("list() filtre par statut/sévérité et trie (critiques d'abord, RESOLVED en dernier)", async () => {
    const list = await incidentStore.list({ status: "RESOLVED" });
    assert.ok(list.items.every((i) => i.status === "RESOLVED"));
    const all = await incidentStore.list({ limit: 500 });
    const resolvedIdx = all.items.findIndex((i) => i.status === "RESOLVED");
    const openIdx = all.items.findIndex((i) => i.status === "OPEN");
    if (resolvedIdx !== -1 && openIdx !== -1) {
      assert.ok(openIdx < resolvedIdx, "les incidents non résolus doivent apparaître avant les résolus");
    }
  });

  await cleanupDb(dbCtx);
});

test("incidents/correlation — IncidentCorrelator (déterministe, sans IA)", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();
  sharedRuleId = null;
  await ensureRule();

  await t.test("deux alertes du même process + même métrique -> même incident", async () => {
    const correlator = new IncidentCorrelator({});
    const alertA = await alertStore.create(makeAlertFields({ targetValue: "checkout", metric: "cpu" }));
    const { incident: incidentA, created: createdA } = await correlator.attach(alertA);
    assert.equal(createdA, true);

    const alertB = await alertStore.create(makeAlertFields({ targetValue: "checkout", metric: "cpu" }));
    const { incident: incidentB, created: createdB } = await correlator.attach(alertB);
    assert.equal(createdB, false);
    assert.equal(incidentB.id, incidentA.id);

    const alertIds = await incidentStore.listAlertIds(incidentA.id);
    assert.ok(alertIds.includes(alertA.id));
    assert.ok(alertIds.includes(alertB.id));
  });

  await t.test("même process mais métrique différente -> incidents distincts", async () => {
    const correlator = new IncidentCorrelator({});
    const alertA = await alertStore.create(makeAlertFields({ targetValue: "payments", metric: "cpu" }));
    const { incident: incidentA } = await correlator.attach(alertA);

    const alertB = await alertStore.create(makeAlertFields({ targetValue: "payments", metric: "memory" }));
    const { incident: incidentB, created } = await correlator.attach(alertB);
    assert.equal(created, true);
    assert.notEqual(incidentB.id, incidentA.id);
  });

  await t.test("process différent, même métrique -> incidents distincts (sans processOrgStore)", async () => {
    const correlator = new IncidentCorrelator({});
    const alertA = await alertStore.create(makeAlertFields({ targetValue: "svc-x", metric: "disk" }));
    const { incident: incidentA } = await correlator.attach(alertA);

    const alertB = await alertStore.create(makeAlertFields({ targetValue: "svc-y", metric: "disk" }));
    const { incident: incidentB, created } = await correlator.attach(alertB);
    assert.equal(created, true);
    assert.notEqual(incidentB.id, incidentA.id);
  });

  await t.test("processOrgStore injecté : deux process du même groupe + même métrique -> même incident", async () => {
    const fakeProcessOrgStore = {
      getOrganizationForProcess: async (name) => {
        const groupsByProcess = {
          "worker-1": ["ecommerce"],
          "worker-2": ["ecommerce"],
          "worker-3": ["other"],
        };
        return { tags: [], environment: null, groups: groupsByProcess[name] || [] };
      },
    };
    const correlator = new IncidentCorrelator({ processOrgStore: fakeProcessOrgStore });

    const alertA = await alertStore.create(makeAlertFields({ targetValue: "worker-1", metric: "restart_count" }));
    const { incident: incidentA } = await correlator.attach(alertA);

    const alertB = await alertStore.create(makeAlertFields({ targetValue: "worker-2", metric: "restart_count" }));
    const { incident: incidentB, created: createdB } = await correlator.attach(alertB);
    assert.equal(createdB, false);
    assert.equal(incidentB.id, incidentA.id);

    const alertC = await alertStore.create(makeAlertFields({ targetValue: "worker-3", metric: "restart_count" }));
    const { incident: incidentC, created: createdC } = await correlator.attach(alertC);
    assert.equal(createdC, true);
    assert.notEqual(incidentC.id, incidentA.id);
  });

  await t.test("hors fenêtre de corrélation -> nouvel incident même pour le même process/métrique", async () => {
    const correlator = new IncidentCorrelator({ env: { INCIDENTS_CORRELATION_WINDOW_MS: "50" } });
    const alertA = await alertStore.create(makeAlertFields({ targetValue: "svc-window", metric: "cpu" }));
    const { incident: incidentA } = await correlator.attach(alertA);

    await new Promise((resolve) => setTimeout(resolve, 120));

    const alertB = await alertStore.create(makeAlertFields({ targetValue: "svc-window", metric: "cpu" }));
    const { incident: incidentB, created } = await correlator.attach(alertB);
    assert.equal(created, true);
    assert.notEqual(incidentB.id, incidentA.id);
  });

  await cleanupDb(dbCtx);
});

test("incidents/silence-store — CRUD, matching, expiration", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("create() valide scopeType/scopeValue/expiresAt", async () => {
    await assert.rejects(
      () => silenceStore.create({ scopeType: "bogus", scopeValue: "x", expiresAt: Date.now() + 1000 }),
      /scopeType invalide/,
    );
    await assert.rejects(
      () => silenceStore.create({ scopeType: "process", scopeValue: "", expiresAt: Date.now() + 1000 }),
      /scopeValue requis/,
    );
    await assert.rejects(
      () => silenceStore.create({ scopeType: "process", scopeValue: "api", expiresAt: Date.now() - 1000 }),
      /expiresAt/,
    );
  });

  await t.test("create() puis isSilenced() — scope 'process'", async () => {
    await silenceStore.create({
      scopeType: "process",
      scopeValue: "api-prod",
      expiresAt: Date.now() + 60000,
      reason: "maintenance",
    });
    const silencedAlert = { targetType: "process", targetValue: "api-prod", ruleId: 99 };
    const notSilencedAlert = { targetType: "process", targetValue: "other-app", ruleId: 99 };
    assert.equal(await silenceStore.isSilenced(silencedAlert, null), true);
    assert.equal(await silenceStore.isSilenced(notSilencedAlert, null), false);
  });

  await t.test("isSilenced() — scope 'rule'", async () => {
    await silenceStore.create({ scopeType: "rule", scopeValue: "42", expiresAt: Date.now() + 60000 });
    assert.equal(await silenceStore.isSilenced({ ruleId: 42, targetType: "process", targetValue: "x" }, null), true);
    assert.equal(await silenceStore.isSilenced({ ruleId: 43, targetType: "process", targetValue: "x" }, null), false);
  });

  await t.test("isSilenced() — scope 'tag'/'environment'/'group' via processOrg", async () => {
    await silenceStore.create({ scopeType: "tag", scopeValue: "critical-path", expiresAt: Date.now() + 60000 });
    await silenceStore.create({ scopeType: "environment", scopeValue: "staging", expiresAt: Date.now() + 60000 });
    await silenceStore.create({ scopeType: "group", scopeValue: "billing", expiresAt: Date.now() + 60000 });

    const alert = { targetType: "process", targetValue: "svc", ruleId: 1 };
    assert.equal(
      await silenceStore.isSilenced(alert, { tags: ["critical-path"], environment: null, groups: [] }),
      true,
    );
    assert.equal(
      await silenceStore.isSilenced(alert, { tags: [], environment: "staging", groups: [] }),
      true,
    );
    assert.equal(
      await silenceStore.isSilenced(alert, { tags: [], environment: null, groups: ["billing"] }),
      true,
    );
    assert.equal(
      await silenceStore.isSilenced(alert, { tags: ["other"], environment: "production", groups: ["other"] }),
      false,
    );
  });

  await t.test("cancel() annule un silence avant son expiration naturelle", async () => {
    const silence = await silenceStore.create({
      scopeType: "process",
      scopeValue: "to-cancel",
      expiresAt: Date.now() + 60000,
    });
    const alert = { targetType: "process", targetValue: "to-cancel", ruleId: 1 };
    assert.equal(await silenceStore.isSilenced(alert, null), true);

    await silenceStore.cancel(silence.id);
    assert.equal(await silenceStore.isSilenced(alert, null), false);

    const cancelled = await silenceStore.getById(silence.id);
    assert.ok(cancelled.cancelledAt);
    assert.equal(cancelled.active, false);
  });

  await t.test("un silence expiré n'est plus actif (isSilenced -> false)", async () => {
    // Créé "expiré" directement en base (create() refuse un expiresAt passé) :
    // on simule le passage du temps en écrivant via silenceStore.create() avec
    // un futur proche, puis on vérifie que listActive()/isSilenced() l'excluent
    // une fois `expires_at` dépassé, sans dépendre d'un sleep long dans les tests.
    const silence = await silenceStore.create({
      scopeType: "process",
      scopeValue: "expiring-soon",
      expiresAt: Date.now() + 30,
    });
    const alert = { targetType: "process", targetValue: "expiring-soon", ruleId: 1 };
    assert.equal(await silenceStore.isSilenced(alert, null), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(await silenceStore.isSilenced(alert, null), false);
    const fetched = await silenceStore.getById(silence.id);
    assert.equal(fetched.active, false);
  });

  await t.test("list({ activeOnly: true }) exclut les silences annulés/expirés", async () => {
    const before = await silenceStore.list({ activeOnly: true });
    const activeIds = new Set(before.map((s) => s.id));
    const all = await silenceStore.list({});
    const inactiveExists = all.some((s) => !s.active);
    assert.ok(inactiveExists, "précondition du test : au moins un silence inactif doit déjà exister");
    for (const s of all) {
      if (!s.active) assert.equal(activeIds.has(s.id), false);
    }
  });

  await cleanupDb(dbCtx);
});
