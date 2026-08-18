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
 * Phase 5F — section 5 "Notification Spam" de la tâche : CPU > seuil
 * pendant une longue période ne doit jamais envoyer des centaines de
 * notifications. Deux protections indépendantes, testées ici ensemble
 * comme elles le sont réellement en production :
 *
 *  1. L'Alert Engine (déjà là avant la Phase 5) ne crée/notifie qu'à la
 *     *transition* trigger->active, jamais à chaque tick où la condition
 *     reste vraie (`_handleConditionMet` appelle juste `touch()` sur une
 *     occurrence déjà active) — donc `dispatch()` n'est appelé qu'une
 *     fois par occurrence, pas une fois par évaluation.
 *  2. La déduplication + le rate limiting de `dispatch-queue.js`
 *     (Phase 5E) protègent en plus le cas où plusieurs occurrences
 *     distinctes (ex. plusieurs process, ou une occurrence qui se résout
 *     puis se re-déclenche après cooldown) viseraient le même provider.
 */

function makeCountingRegistry() {
  const calls = [];
  const registry = new ProviderRegistry();
  const provider = new NotificationProvider("fake", "Fake");
  provider.send = async (notification) => {
    calls.push(notification);
    return { success: true };
  };
  provider.validateConfig = () => {};
  registry.registerProvider(provider);
  return { registry, calls };
}

test("Phase 5F — notification spam : CPU > seuil en continu ne déclenche pas une avalanche", async (t) => {
  let ctx;

  t.beforeEach(async () => {
    ctx = await freshDb();
    await migrator.up();
  });

  t.afterEach(async () => {
    await cleanupDb(ctx);
  });

  await t.test(
    "100 évaluations consécutives condition-vraie sur la même occurrence -> une seule notification",
    async () => {
      const { registry, calls } = makeCountingRegistry();
      const provider = await providerStore.create({ name: "P", type: "fake", configuration: {} });
      await routeStore.create({ name: "route", conditions: {}, providerIds: [provider.id] });

      const rule = await ruleStore.create({
        name: "CPU",
        targetType: "process",
        targetValue: "api",
        metric: "cpu",
        operator: ">",
        threshold: 90,
        durationSeconds: 0,
        cooldownSeconds: 300,
        severity: "critical",
      });

      const dispatchQueue = new NotificationDispatchQueue({
        registry,
        providerStore,
        historyStore,
        queue: createQueue("spam-test-queue", { maxAttempts: 1, backoffMs: 0 }),
      });
      const routingEngine = new RoutingEngine({
        routeStore,
        providerStore,
        registry,
        historyStore,
        dispatchQueue,
      });
      const alertEngine = new AlertEngine({ ruleStore, alertStore });

      let dispatchCount = 0;

      // Simule 100 ticks d'évaluation (ex. toutes les 15s pendant 25 minutes,
      // ALERTS_EVAL_INTERVAL_MS) avec la condition constamment vraie.
      for (let i = 0; i < 100; i++) {
        const result = await alertEngine.evaluate(rule, "api", 95);
        // Reproduit exactement la détection de transition de server.js#dispatchAlertTransition :
        // seul le tick où triggeredAt === lastSeenAt (la transition elle-même) dispatch.
        if (result && result.state === "active" && result.triggeredAt === result.lastSeenAt) {
          await routingEngine.dispatch(result, "triggered");
          dispatchCount += 1;
        }
      }

      assert.equal(
        dispatchCount,
        1,
        "une seule transition trigger->active sur 100 ticks à condition constante",
      );

      // Vide la file (un seul job normalement).
      let processed = await dispatchQueue.processOne();
      let total = 0;
      while (processed) {
        total += 1;
        processed = await dispatchQueue.processOne();
      }
      assert.equal(total, 1);
      assert.equal(calls.length, 1, "le provider ne doit avoir été appelé qu'une seule fois");
    },
  );

  await t.test(
    "plusieurs occurrences distinctes visant le même provider dans la fenêtre de dédoublonnage -> une seule mise en file",
    async () => {
      const { registry } = makeCountingRegistry();
      const provider = await providerStore.create({ name: "P", type: "fake", configuration: {} });
      await routeStore.create({ name: "route", conditions: {}, providerIds: [provider.id] });

      const dispatchQueue = new NotificationDispatchQueue({
        registry,
        providerStore,
        historyStore,
        queue: createQueue("spam-test-dedup-queue", { maxAttempts: 1, backoffMs: 0 }),
        dedupWindowMs: 5 * 60 * 1000,
      });
      const routingEngine = new RoutingEngine({
        routeStore,
        providerStore,
        registry,
        historyStore,
        dispatchQueue,
      });

      // Même alertId (ex. re-dispatch accidentel côté appelant) : dédupliqué.
      const alert = {
        id: null,
        severity: "critical",
        metric: "cpu",
        targetType: "process",
        targetValue: "api",
        state: "active",
        triggeredAt: 1,
        lastSeenAt: 1,
      };
      const r1 = await routingEngine.dispatch(alert, "triggered");
      const r2 = await routingEngine.dispatch(alert, "triggered");

      assert.equal(r1[0].status, "queued");
      assert.equal(r2[0].status, "deduplicated");
    },
  );

  await t.test(
    "rate limiting : une avalanche de nombreuses occurrences distinctes sur le même provider est plafonnée",
    async () => {
      const { registry, calls } = makeCountingRegistry();
      const provider = await providerStore.create({ name: "P", type: "fake", configuration: {} });
      await routeStore.create({ name: "route", conditions: {}, providerIds: [provider.id] });

      const dispatchQueue = new NotificationDispatchQueue({
        registry,
        providerStore,
        historyStore,
        queue: createQueue("spam-test-ratelimit-queue", { maxAttempts: 1, backoffMs: 0 }),
        rateLimit: { windowMs: 60000, max: 5 },
        dedupWindowMs: 0, // isole le rate limit de la déduplication pour ce test
      });
      const routingEngine = new RoutingEngine({
        routeStore,
        providerStore,
        registry,
        historyStore,
        dispatchQueue,
      });

      // 1000 occurrences distinctes (ex. 1000 process différents en même
      // temps) visant toutes le même provider — le scénario "1000 alerts × 5
      // providers" cité dans la tâche, réduit ici à 1 provider pour isoler le
      // rate limiter.
      let queued = 0;
      let rateLimited = 0;
      for (let i = 0; i < 1000; i++) {
        const alert = {
          id: null,
          severity: "critical",
          metric: "cpu",
          targetType: "process",
          targetValue: `proc-${i}`,
          state: "active",
          triggeredAt: 1,
          lastSeenAt: 1,
        };
        const [result] = await routingEngine.dispatch(alert, "triggered");
        if (result.status === "queued") queued += 1;
        if (result.status === "rate_limited") rateLimited += 1;
      }

      assert.equal(queued, 5, "seules les 5 premières notifications (max de la fenêtre) sont mises en file");
      assert.equal(rateLimited, 995);

      let processed = await dispatchQueue.processOne();
      let sent = 0;
      while (processed) {
        sent += 1;
        processed = await dispatchQueue.processOne();
      }
      assert.equal(sent, 5);
      assert.equal(calls.length, 5, "jamais 1000 envois réels au provider");
    },
  );
});
