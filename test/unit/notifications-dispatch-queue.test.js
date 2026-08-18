"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { NotificationDispatchQueue } = require("../../lib/services/notifications/dispatch-queue");
const { RoutingEngine } = require("../../lib/services/notifications/routing/engine");

/**
 * Fausse file en mémoire, avec le même contrat que
 * lib/services/queue/persistent-queue.js (add/processOne/recoverStaleActiveJobs/
 * start/stop, retry avec backoff, max attempts) mais sans dépendance à la
 * base de données — suffisant pour tester la logique métier de
 * dispatch-queue.js (elle-même agnostique de l'implémentation de la queue).
 */
class FakeQueue {
  constructor({ maxAttempts = 3, backoffMs = 0 } = {}) {
    this.maxAttempts = maxAttempts;
    this.backoffMs = backoffMs;
    this._jobs = [];
    this._nextId = 1;
  }

  async add(payload) {
    const id = this._nextId++;
    this._jobs.push({ id, payload, status: "pending", attempts: 0, maxAttempts: this.maxAttempts });
    return id;
  }

  async recoverStaleActiveJobs() {
    return 0;
  }

  /** Traite le premier job pending. Retourne le job traité, ou null. */
  async processOne(handler) {
    const job = this._jobs.find((j) => j.status === "pending");
    if (!job) return null;
    job.status = "active";
    try {
      await handler(job.payload, job);
      this._jobs = this._jobs.filter((j) => j.id !== job.id); // "complété" = supprimé, comme PersistentQueue
    } catch (e) {
      job.attempts += 1;
      if (job.attempts >= job.maxAttempts) {
        job.status = "failed";
        job.lastError = e.message;
      } else {
        job.status = "pending"; // reste éligible (pas de vrai délai simulé ici)
      }
    }
    return job;
  }

  listByStatus(status) {
    return this._jobs.filter((j) => j.status === status);
  }

  start() {}
  stop() {}
}

function makeStores({ providers = {}, secrets = {} } = {}) {
  const historyEntries = new Map();
  let nextId = 1;
  const historyStore = {
    create: async (entry) => {
      const id = nextId++;
      const stored = { id, ...entry };
      historyEntries.set(id, stored);
      return stored;
    },
    update: async (id, patch) => {
      const existing = historyEntries.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      historyEntries.set(id, updated);
      return updated;
    },
  };
  const providerStore = {
    getById: async (id) => providers[id] || null,
    getDecryptedSecrets: async (id) => secrets[id] || null,
  };
  return { historyStore, providerStore, historyEntries };
}

test("NotificationDispatchQueue#enqueue", async (t) => {
  await t.test("empile un job et crée une entrée d'historique 'pending'", async () => {
    const { historyStore, providerStore, historyEntries } = makeStores();
    const registry = { getProvider: () => ({ send: async () => ({ success: true }) }) };
    const queue = new FakeQueue();
    const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

    const result = await dq.enqueue({
      providerId: 1,
      notification: { title: "x", message: "y" },
      alertId: 10,
      event: "triggered",
    });

    assert.equal(result.status, "queued");
    assert.equal(historyEntries.get(result.historyEntry.id).status, "pending");
    assert.equal(queue._jobs.length, 1);
  });

  await t.test(
    "déduplique deux enqueue identiques (même provider/alerte/event) dans la fenêtre",
    async () => {
      const { historyStore, providerStore } = makeStores();
      const registry = { getProvider: () => ({ send: async () => ({ success: true }) }) };
      const queue = new FakeQueue();
      const dq = new NotificationDispatchQueue({
        registry,
        providerStore,
        historyStore,
        queue,
        dedupWindowMs: 60000,
      });

      const first = await dq.enqueue({ providerId: 1, notification: {}, alertId: 10, event: "triggered" });
      const second = await dq.enqueue({ providerId: 1, notification: {}, alertId: 10, event: "triggered" });

      assert.equal(first.status, "queued");
      assert.equal(second.status, "deduplicated");
      assert.equal(queue._jobs.length, 1);
    },
  );

  await t.test("un event différent (ex: resolved) n'est pas déduplié avec triggered", async () => {
    const { historyStore, providerStore } = makeStores();
    const registry = { getProvider: () => ({ send: async () => ({ success: true }) }) };
    const queue = new FakeQueue();
    const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

    const triggered = await dq.enqueue({ providerId: 1, notification: {}, alertId: 10, event: "triggered" });
    const resolved = await dq.enqueue({ providerId: 1, notification: {}, alertId: 10, event: "resolved" });

    assert.equal(triggered.status, "queued");
    assert.equal(resolved.status, "queued");
  });

  await t.test(
    "rate limit : au-delà du max par fenêtre, plus de mise en file (historique 'failed'/RATE_LIMITED)",
    async () => {
      const { historyStore, providerStore } = makeStores();
      const registry = { getProvider: () => ({ send: async () => ({ success: true }) }) };
      const queue = new FakeQueue();
      const dq = new NotificationDispatchQueue({
        registry,
        providerStore,
        historyStore,
        queue,
        rateLimit: { windowMs: 60000, max: 2 },
        dedupWindowMs: 0, // pas de dedup ici, on veut isoler le rate limit
      });

      const r1 = await dq.enqueue({ providerId: 1, notification: {}, alertId: 1, event: "triggered" });
      const r2 = await dq.enqueue({ providerId: 1, notification: {}, alertId: 2, event: "triggered" });
      const r3 = await dq.enqueue({ providerId: 1, notification: {}, alertId: 3, event: "triggered" });

      assert.equal(r1.status, "queued");
      assert.equal(r2.status, "queued");
      assert.equal(r3.status, "rate_limited");
      assert.equal(r3.historyEntry.errorCode, "RATE_LIMITED");
      assert.equal(queue._jobs.length, 2);
    },
  );

  await t.test("le rate limit est par provider : un autre provider n'est pas affecté", async () => {
    const { historyStore, providerStore } = makeStores();
    const registry = { getProvider: () => ({ send: async () => ({ success: true }) }) };
    const queue = new FakeQueue();
    const dq = new NotificationDispatchQueue({
      registry,
      providerStore,
      historyStore,
      queue,
      rateLimit: { windowMs: 60000, max: 1 },
      dedupWindowMs: 0,
    });

    const r1 = await dq.enqueue({ providerId: 1, notification: {}, alertId: 1, event: "triggered" });
    const r2 = await dq.enqueue({ providerId: 2, notification: {}, alertId: 1, event: "triggered" });

    assert.equal(r1.status, "queued");
    assert.equal(r2.status, "queued");
  });

  await t.test("n'exige jamais (ne lance jamais), même si historyStore.create() lance", async () => {
    const providerStore = { getById: async () => null, getDecryptedSecrets: async () => null };
    const historyStore = {
      create: async () => {
        throw new Error("db down");
      },
      update: async () => null,
    };
    const registry = { getProvider: () => null };
    const queue = new FakeQueue();
    const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

    const result = await dq.enqueue({ providerId: 1, notification: {}, alertId: 1, event: "triggered" });
    assert.equal(result.status, "queued"); // l'échec d'historique n'empêche pas la mise en file
    assert.equal(result.historyEntry, null);
  });
});

test("NotificationDispatchQueue#handleJob (via processOne)", async (t) => {
  await t.test("succès : historique passe à 'success', job retiré de la file", async () => {
    const { historyStore, providerStore, historyEntries } = makeStores({
      providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
    });
    const registry = { getProvider: () => ({ send: async () => ({ success: true, responseTime: 12 }) }) };
    const queue = new FakeQueue({ maxAttempts: 3 });
    const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

    const { historyEntry } = await dq.enqueue({
      providerId: 1,
      notification: {},
      alertId: 1,
      event: "triggered",
    });
    const job = await dq.processOne();

    assert.ok(job); // job traité et retourné (comme PersistentQueue#processOne)
    assert.equal(historyEntries.get(historyEntry.id).status, "success");
    assert.equal(historyEntries.get(historyEntry.id).responseTimeMs, 12);
  });

  await t.test(
    "échec récupérable avant la dernière tentative : historique 'retrying', job retenté",
    async () => {
      let calls = 0;
      const { historyStore, providerStore, historyEntries } = makeStores({
        providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
      });
      const registry = {
        getProvider: () => ({
          send: async () => {
            calls += 1;
            return calls < 3 ? { success: false, errorCode: "NETWORK_ERROR" } : { success: true };
          },
        }),
      };
      const queue = new FakeQueue({ maxAttempts: 4 });
      const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

      const { historyEntry } = await dq.enqueue({
        providerId: 1,
        notification: {},
        alertId: 1,
        event: "triggered",
      });

      await dq.processOne(); // tentative 1 : échec -> retrying
      assert.equal(historyEntries.get(historyEntry.id).status, "retrying");
      assert.equal(historyEntries.get(historyEntry.id).errorCode, "NETWORK_ERROR");

      await dq.processOne(); // tentative 2 : échec -> retrying
      assert.equal(historyEntries.get(historyEntry.id).status, "retrying");

      await dq.processOne(); // tentative 3 : succès
      assert.equal(historyEntries.get(historyEntry.id).status, "success");
      assert.equal(calls, 3);
    },
  );

  await t.test("épuisement des tentatives : historique 'failed', job non retenté ensuite", async () => {
    const { historyStore, providerStore, historyEntries } = makeStores({
      providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
    });
    const registry = {
      getProvider: () => ({ send: async () => ({ success: false, errorCode: "SMTP_DOWN" }) }),
    };
    const queue = new FakeQueue({ maxAttempts: 2 });
    const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

    const { historyEntry } = await dq.enqueue({
      providerId: 1,
      notification: {},
      alertId: 1,
      event: "triggered",
    });

    await dq.processOne(); // tentative 1/2 : échec -> retrying
    assert.equal(historyEntries.get(historyEntry.id).status, "retrying");

    await dq.processOne(); // tentative 2/2 : échec -> failed (dernière tentative)
    assert.equal(historyEntries.get(historyEntry.id).status, "failed");
    assert.equal(historyEntries.get(historyEntry.id).errorCode, "SMTP_DOWN");

    const again = await dq.processOne(); // plus rien à traiter : job terminal, pas re-proposé
    assert.equal(again, null);
  });

  await t.test(
    "provider désactivé : historique 'failed'/PROVIDER_DISABLED, aucune tentative de renvoi",
    async () => {
      let sendCalled = false;
      const { historyStore, providerStore, historyEntries } = makeStores({
        providers: { 1: { id: 1, type: "fake", enabled: false, configuration: {} } },
      });
      const registry = {
        getProvider: () => ({
          send: async () => {
            sendCalled = true;
            return { success: true };
          },
        }),
      };
      const queue = new FakeQueue({ maxAttempts: 3 });
      const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

      const { historyEntry } = await dq.enqueue({
        providerId: 1,
        notification: {},
        alertId: 1,
        event: "triggered",
      });
      await dq.processOne();

      assert.equal(sendCalled, false);
      assert.equal(historyEntries.get(historyEntry.id).status, "failed");
      assert.equal(historyEntries.get(historyEntry.id).errorCode, "PROVIDER_DISABLED");
      const again = await dq.processOne();
      assert.equal(again, null); // pas de retry pour une condition permanente
    },
  );

  await t.test(
    "provider introuvable (supprimé entre-temps) : historique 'failed'/PROVIDER_NOT_FOUND",
    async () => {
      const { historyStore, providerStore, historyEntries } = makeStores({ providers: {} });
      const registry = { getProvider: () => null };
      const queue = new FakeQueue({ maxAttempts: 3 });
      const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

      const { historyEntry } = await dq.enqueue({
        providerId: 999,
        notification: {},
        alertId: 1,
        event: "triggered",
      });
      await dq.processOne();

      assert.equal(historyEntries.get(historyEntry.id).status, "failed");
      assert.equal(historyEntries.get(historyEntry.id).errorCode, "PROVIDER_NOT_FOUND");
    },
  );

  await t.test(
    "provider qui lance une exception : traité comme un échec récupérable, jamais propagé",
    async () => {
      const { historyStore, providerStore, historyEntries } = makeStores({
        providers: { 1: { id: 1, type: "fake", enabled: true, configuration: {} } },
      });
      const registry = {
        getProvider: () => ({
          send: async () => {
            throw new Error("boom");
          },
        }),
      };
      const queue = new FakeQueue({ maxAttempts: 2 });
      const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

      const { historyEntry } = await dq.enqueue({
        providerId: 1,
        notification: {},
        alertId: 1,
        event: "triggered",
      });
      await assert.doesNotReject(() => dq.processOne());
      assert.equal(historyEntries.get(historyEntry.id).status, "retrying");
    },
  );

  await t.test(
    "secrets déchiffrés fusionnés dans la config transmise à send(), jamais dans l'historique",
    async () => {
      let receivedConfig = null;
      const { historyStore, providerStore, historyEntries } = makeStores({
        providers: { 1: { id: 1, type: "fake", enabled: true, configuration: { url: "https://x" } } },
        secrets: { 1: { webhookToken: "super-secret" } },
      });
      const registry = {
        getProvider: () => ({
          send: async (_n, config) => {
            receivedConfig = config;
            return { success: true };
          },
        }),
      };
      const queue = new FakeQueue({ maxAttempts: 3 });
      const dq = new NotificationDispatchQueue({ registry, providerStore, historyStore, queue });

      const { historyEntry } = await dq.enqueue({
        providerId: 1,
        notification: {},
        alertId: 1,
        event: "triggered",
      });
      await dq.processOne();

      assert.equal(receivedConfig.webhookToken, "super-secret");
      const historyJson = JSON.stringify(historyEntries.get(historyEntry.id));
      assert.ok(!historyJson.includes("super-secret"));
    },
  );
});

test("RoutingEngine + dispatchQueue (Phase 5E)", async (t) => {
  await t.test("dispatch() avec dispatchQueue : empile plutôt que d'envoyer directement", async () => {
    const routes = [{ id: 5, enabled: true, conditions: {}, providerIds: [1, 2] }];
    const routeStore = { list: async () => routes };
    const providerStore = { getById: async () => null, getDecryptedSecrets: async () => null };
    const registry = { getProvider: () => null };
    const historyStore = { create: async () => ({}) };

    const enqueued = [];
    const dispatchQueue = {
      enqueue: async (job) => {
        enqueued.push(job);
        return {
          status: "queued",
          providerId: job.providerId,
          alertId: job.alertId,
          historyEntry: { id: 1, status: "pending" },
        };
      },
    };

    const engine = new RoutingEngine({ routeStore, providerStore, registry, historyStore, dispatchQueue });
    const alert = {
      id: 42,
      severity: "warning",
      metric: "cpu",
      targetType: "process",
      targetValue: "api",
      state: "active",
      triggeredAt: 1,
      lastSeenAt: 1,
    };
    const results = await engine.dispatch(alert, "triggered");

    assert.equal(enqueued.length, 2);
    assert.deepEqual(enqueued.map((j) => j.providerId).sort(), [1, 2]);
    assert.ok(enqueued.every((j) => j.alertId === 42 && j.event === "triggered"));
    assert.ok(results.every((r) => r.status === "queued"));
  });

  await t.test("sans dispatchQueue : comportement synchrone historique (Phase 5D) inchangé", async () => {
    const routes = [{ id: 5, enabled: true, conditions: {}, providerIds: [1] }];
    const routeStore = { list: async () => routes };
    const providerStore = {
      getById: async () => ({ id: 1, type: "fake", enabled: true, configuration: {} }),
      getDecryptedSecrets: async () => null,
    };
    const registry = { getProvider: () => ({ send: async () => ({ success: true, responseTime: 5 }) }) };
    const historyEntries = [];
    const historyStore = {
      create: async (e) => {
        historyEntries.push(e);
        return { id: historyEntries.length, ...e };
      },
    };

    const engine = new RoutingEngine({ routeStore, providerStore, registry, historyStore });
    const alert = {
      id: 1,
      severity: "warning",
      metric: "cpu",
      targetType: "process",
      targetValue: "api",
      state: "active",
      triggeredAt: 1,
      lastSeenAt: 1,
    };
    await engine.dispatch(alert, "triggered");

    assert.equal(historyEntries.length, 1);
    assert.equal(historyEntries[0].status, "success");
  });
});
