"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const { createQueue } = require("../../lib/services/queue");
const { NotificationDispatchQueue } = require("../../lib/services/notifications/dispatch-queue");
const historyStore = require("../../lib/services/notifications/history-store");
const providerStoreReal = require("../../lib/services/notifications/provider-store");

/**
 * Contrairement à test/unit/notifications-dispatch-queue.test.js (FakeQueue
 * en mémoire, pour tester la logique métier isolément), ce fichier exerce
 * NotificationDispatchQueue avec la vraie PersistentQueue (table `jobs`) et
 * le vrai historyStore (table `notification_history`) : c'est ce qui
 * garantit que le retry/backoff persistant (Phase 5E, sur la queue déjà
 * livrée en Phase 1) et l'écriture d'historique fonctionnent ensemble sur
 * une vraie base, pas seulement avec des doubles de test.
 */

test("NotificationDispatchQueue — intégration avec PersistentQueue + historyStore réels", async (t) => {
  let ctx;

  t.beforeEach(async () => {
    ctx = await freshDb();
    await migrator.up();
  });

  t.afterEach(async () => {
    await cleanupDb(ctx);
  });

  await t.test("envoi réussi : job traité, historique 'success' persistée en base", async () => {
    const created = await providerStoreReal.create({ name: "Fake 1", type: "fake", configuration: {} });
    const providerStore = {
      getById: async () => ({ id: created.id, type: "fake", enabled: true, configuration: {} }),
      getDecryptedSecrets: async () => null,
    };
    const registry = { getProvider: () => ({ send: async () => ({ success: true, responseTime: 7 }) }) };
    const queue = createQueue("notifications-dispatch-test-success", { maxAttempts: 3, backoffMs: 0 });
    const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

    const { historyEntry } = await dq.enqueue({
      providerId: created.id,
      notification: { title: "t", message: "m" },
      alertId: null,
      event: "triggered",
    });
    assert.equal(historyEntry.status, "pending");

    await dq.processOne();

    const stored = await historyStore.getById(historyEntry.id);
    assert.equal(stored.status, "success");
    assert.equal(stored.responseTimeMs, 7);
  });

  await t.test("échecs répétés puis épuisement : historique finit 'failed', job supprimé de la file", async () => {
    const created = await providerStoreReal.create({ name: "Fake 2", type: "fake", configuration: {} });
    const providerStore = {
      getById: async () => ({ id: created.id, type: "fake", enabled: true, configuration: {} }),
      getDecryptedSecrets: async () => null,
    };
    const registry = { getProvider: () => ({ send: async () => ({ success: false, errorCode: "TIMEOUT" }) }) };
    const queue = createQueue("notifications-dispatch-test-fail", { maxAttempts: 2, backoffMs: 0 });
    const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

    const { historyEntry } = await dq.enqueue({
      providerId: created.id,
      notification: {},
      alertId: null,
      event: "triggered",
    });

    await dq.processOne(); // tentative 1/2
    assert.equal((await historyStore.getById(historyEntry.id)).status, "retrying");

    await dq.processOne(); // tentative 2/2 : épuisée
    const finalEntry = await historyStore.getById(historyEntry.id);
    assert.equal(finalEntry.status, "failed");
    assert.equal(finalEntry.errorCode, "TIMEOUT");

    const pending = await queue.listByStatus("pending");
    assert.equal(pending.length, 0); // plus rien à retenter
  });

  await t.test("un job orphelin ('active' suite à un arrêt brutal) est repris après recoverStaleActiveJobs()", async () => {
    const created = await providerStoreReal.create({ name: "Fake 3", type: "fake", configuration: {} });
    const providerStore = {
      getById: async () => ({ id: created.id, type: "fake", enabled: true, configuration: {} }),
      getDecryptedSecrets: async () => null,
    };
    const registry = { getProvider: () => ({ send: async () => ({ success: true }) }) };
    const queue = createQueue("notifications-dispatch-test-restart", { maxAttempts: 3, backoffMs: 0 });
    const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

    const { jobId } = await dq.enqueue({ providerId: created.id, notification: {}, alertId: null, event: "triggered" });

    // Simule un process tué en plein traitement : job resté "active".
    const db = require("../../lib/db");
    await db.run("UPDATE jobs SET status = 'active' WHERE id = ?", [jobId]);

    const before = await queue.listByStatus("pending");
    assert.equal(before.length, 0);

    await dq.start();
    dq.stop(); // on ne veut pas laisser le polling tourner après le test

    const after = await queue.listByStatus("pending");
    assert.equal(after.length, 1); // recoverStaleActiveJobs() l'a remis en pending
  });
});
