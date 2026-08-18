"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

const { AlertEngine } = require("../../lib/services/alerts/engine");
const ruleStore = require("../../lib/services/alerts/alert-rules-store");
const alertStore = require("../../lib/services/alerts/alert-store");

const { ProviderRegistry } = require("../../lib/services/notifications/registry");
const providerStore = require("../../lib/services/notifications/provider-store");
const routeStore = require("../../lib/services/notifications/routing/route-store");
const historyStore = require("../../lib/services/notifications/history-store");
const { RoutingEngine } = require("../../lib/services/notifications/routing/engine");
const { NotificationDispatchQueue } = require("../../lib/services/notifications/dispatch-queue");
const { createQueue } = require("../../lib/services/queue");
const { NotificationProvider } = require("../../lib/services/notifications/types");

/**
 * Phase 5F — section 2 "End-to-end" de la tâche :
 *
 *   metric exceeds threshold -> alert triggered -> routing matched ->
 *   notification created -> queue -> provider -> notification sent -> history
 *
 * Rejoue le pipeline complet avec de vrais stores/moteurs sur une DB SQLite
 * réelle. Le seul composant simulé est le *provider* lui-même (un provider
 * "fake" enregistré sur un registry dédié à ce test) — jamais d'appel réseau
 * réel dans la CI (section 7 de la tâche), conformément à ce qui est déjà
 * fait dans test/unit/notifications-providers.test.js (Phase 5B).
 */

function makeRegistryWithFakeProvider(sendImpl) {
  const registry = new ProviderRegistry();
  const provider = new NotificationProvider("fake", "Fake");
  provider.send = sendImpl;
  provider.validateConfig = () => {};
  registry.registerProvider(provider);
  return registry;
}

test("Phase 5F — end-to-end : seuil dépassé -> alerte -> routing -> queue -> provider -> historique", async (t) => {
  let ctx;

  t.beforeEach(async () => {
    ctx = await freshDb();
    await migrator.up();
  });

  t.afterEach(async () => {
    await cleanupDb(ctx);
  });

  await t.test("CPU > seuil pendant la durée requise -> notification envoyée et historisée", async () => {
    const sentPayloads = [];
    const registry = makeRegistryWithFakeProvider(async (notification, config) => {
      sentPayloads.push({ notification, config });
      return { success: true, responseTime: 3 };
    });

    const provider = await providerStore.create({
      name: "Webhook interne",
      type: "fake",
      configuration: { url: "https://internal" },
    });
    await routeStore.create({
      name: "CPU critique -> fake",
      conditions: { severity: ["critical"] },
      providerIds: [provider.id],
    });

    const rule = await ruleStore.create({
      name: "CPU trop haut",
      targetType: "process",
      targetValue: "api",
      metric: "cpu",
      operator: ">",
      threshold: 90,
      durationSeconds: 0,
      cooldownSeconds: 60,
      severity: "critical",
    });

    const dispatchQueue = new NotificationDispatchQueue({
      registry,
      providerStore,
      historyStore,
      queue: createQueue("e2e-test-queue", { maxAttempts: 3, backoffMs: 0 }),
    });
    const routingEngine = new RoutingEngine({
      routeStore,
      providerStore,
      registry,
      historyStore,
      dispatchQueue,
    });
    const alertEngine = new AlertEngine({ ruleStore, alertStore });

    // Tick 1 : la métrique dépasse le seuil -> occurrence "trigger" (voir
    // engine.js#_handleConditionMet : la toute première évaluation crée
    // toujours l'occurrence en "trigger", même avec durationSeconds=0).
    const first = await alertEngine.evaluate(rule, "api", 95);
    assert.equal(first.state, "trigger");
    // Tick 2 : durationSeconds=0 déjà écoulée -> passage à "active".
    const result = await alertEngine.evaluate(rule, "api", 95);
    assert.equal(result.state, "active");

    // server.js détecte la transition ainsi (voir server.js#dispatchAlertTransition) :
    assert.equal(result.triggeredAt, result.lastSeenAt);
    const dispatchResults = await routingEngine.dispatch(result, "triggered");

    assert.equal(dispatchResults.length, 1);
    assert.equal(dispatchResults[0].status, "queued");

    // Le provider n'est pas encore appelé : c'est le worker de la queue qui le fait.
    assert.equal(sentPayloads.length, 0);
    assert.equal((await historyStore.getById(dispatchResults[0].historyEntry.id)).status, "pending");

    await dispatchQueue.processOne();

    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0].config.url, "https://internal");
    const finalHistory = await historyStore.getById(dispatchResults[0].historyEntry.id);
    assert.equal(finalHistory.status, "success");
    assert.equal(finalHistory.providerId, provider.id);
    assert.equal(finalHistory.alertId, result.id);
  });

  await t.test("résolution de l'alerte : notification envoyée seulement si notifyOnResolve", async () => {
    const sentEvents = [];
    const registry = makeRegistryWithFakeProvider(async (notification) => {
      sentEvents.push(notification);
      return { success: true };
    });

    const provider = await providerStore.create({ name: "P", type: "fake", configuration: {} });
    const route = await routeStore.create({
      name: "route sans notifyOnResolve",
      conditions: {},
      providerIds: [provider.id],
      notifyOnResolve: false,
    });

    const rule = await ruleStore.create({
      name: "Mémoire",
      targetType: "system",
      metric: "memory",
      operator: ">",
      threshold: 80,
      durationSeconds: 0,
      cooldownSeconds: 0,
      severity: "warning",
    });

    const dispatchQueue = new NotificationDispatchQueue({
      registry,
      providerStore,
      historyStore,
      queue: createQueue("e2e-test-queue-resolve", { maxAttempts: 3, backoffMs: 0 }),
    });
    const routingEngine = new RoutingEngine({
      routeStore,
      providerStore,
      registry,
      historyStore,
      dispatchQueue,
    });
    const alertEngine = new AlertEngine({ ruleStore, alertStore });

    const activeFirst = await alertEngine.evaluate(rule, "system", 90);
    assert.equal(activeFirst.state, "trigger");
    const active = await alertEngine.evaluate(rule, "system", 90);
    assert.equal(active.state, "active");
    await routingEngine.dispatch(active, "triggered");
    await dispatchQueue.processOne();
    assert.equal(sentEvents.length, 1);

    const resolved = await alertEngine.evaluate(rule, "system", 10); // condition redevient fausse
    assert.equal(resolved.state, "resolved");
    const resolveDispatch = await routingEngine.dispatch(resolved, "resolved");
    assert.equal(resolveDispatch.length, 0); // notifyOnResolve=false : aucune règle matchée pour "resolved"
    assert.equal(sentEvents.length, 1); // toujours un seul envoi

    // Avec notifyOnResolve=true, la résolution notifie aussi.
    await routeStore.update(route.id, { notifyOnResolve: true });
    const resolveDispatch2 = await routingEngine.dispatch(resolved, "resolved");
    assert.equal(resolveDispatch2.length, 1);
    await dispatchQueue.processOne();
    assert.equal(sentEvents.length, 2);
  });

  await t.test(
    "provider en panne (échecs répétés) : historique 'failed', mais le pipeline continue de fonctionner",
    async () => {
      const registry = makeRegistryWithFakeProvider(async () => ({ success: false, errorCode: "SMTP_DOWN" }));

      const provider = await providerStore.create({ name: "SMTP en panne", type: "fake", configuration: {} });
      await routeStore.create({ name: "route", conditions: {}, providerIds: [provider.id] });

      const rule = await ruleStore.create({
        name: "Disque",
        targetType: "system",
        metric: "disk",
        operator: ">",
        threshold: 90,
        durationSeconds: 0,
        cooldownSeconds: 0,
        severity: "critical",
      });

      const dispatchQueue = new NotificationDispatchQueue({
        registry,
        providerStore,
        historyStore,
        queue: createQueue("e2e-test-queue-fail", { maxAttempts: 2, backoffMs: 0 }),
      });
      const routingEngine = new RoutingEngine({
        routeStore,
        providerStore,
        registry,
        historyStore,
        dispatchQueue,
      });
      const alertEngine = new AlertEngine({ ruleStore, alertStore });

      const activeFirst2 = await alertEngine.evaluate(rule, "system", 95);
      assert.equal(activeFirst2.state, "trigger");
      const active = await alertEngine.evaluate(rule, "system", 95);
      assert.equal(active.state, "active");
      const dispatched = await routingEngine.dispatch(active, "triggered");

      await dispatchQueue.processOne(); // tentative 1/2
      await dispatchQueue.processOne(); // tentative 2/2 : épuisée -> failed

      const entry = await historyStore.getById(dispatched[0].historyEntry.id);
      assert.equal(entry.status, "failed");
      assert.equal(entry.errorCode, "SMTP_DOWN");

      // Le moteur d'alertes lui-même n'a jamais été affecté : une nouvelle
      // évaluation sur une autre cible fonctionne normalement.
      const anotherRule = await ruleStore.create({
        name: "CPU",
        targetType: "system",
        metric: "cpu",
        operator: ">",
        threshold: 50,
        durationSeconds: 0,
        cooldownSeconds: 0,
        severity: "warning",
      });
      const anotherFirst = await alertEngine.evaluate(anotherRule, "system", 99);
      assert.equal(anotherFirst.state, "trigger");
      const anotherResult = await alertEngine.evaluate(anotherRule, "system", 99);
      assert.equal(anotherResult.state, "active");
    },
  );
});
