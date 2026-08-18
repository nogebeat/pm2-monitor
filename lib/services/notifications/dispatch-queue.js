"use strict";

/**
 * NotificationDispatchQueue — Phase 5E.
 *
 * Objectif de cette phase : la fiabilité de livraison, sans jamais bloquer
 * le monitoring. RoutingEngine#dispatch (Phase 5D) reste responsable du
 * *routing* (quelle règle matche, quel template) ; ce module reprend le
 * relais pour *l'envoi* : au lieu d'appeler `provider.send()` en direct et
 * d'attendre le résultat (ce que fait toujours RoutingEngine quand on ne
 * lui fournit pas de dispatchQueue — voir routing/engine.js), on empile un
 * job sur la file d'attente persistante déjà existante
 * (lib/services/queue/, Phase 1) et on laisse un worker s'en charger de
 * façon asynchrone, avec retry + backoff exponentiel (déjà fournis par
 * PersistentQueue, voir persistent-queue.js#_markFailedOrRetry — aucune
 * réimplémentation ici), rate limiting et déduplication (ajoutés par ce
 * module).
 *
 * Ce qui vit ici et pas dans PersistentQueue (générique, sans logique
 * métier) :
 *   - la clé de déduplication (provider + alerte + événement)
 *   - le rate limiter par provider (fenêtre glissante en mémoire)
 *   - la traduction résultat provider -> statut notification_history
 *     ("pending" -> "retrying" tant qu'il reste des tentatives -> "success"
 *     ou "failed" à l'issue finale)
 *
 * Le job ne contient jamais de secret : `providerId` référence la
 * configuration (lib/services/notifications/provider-store.js), les
 * secrets déchiffrés ne sont récupérés qu'au moment de l'envoi, dans le
 * worker, jamais persistés dans la table `jobs`.
 */

const { createQueue } = require("../queue");

const DEFAULT_QUEUE_NAME = "notifications-dispatch";
const DEFAULT_MAX_ATTEMPTS = 4; // ex. 1s, 5s, 30s puis échec définitif (backoff ci-dessous)
const DEFAULT_BACKOFF_MS = 5000; // combiné à PersistentQueue : délai = backoffMs * tentative
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX = 60; // par provider, par fenêtre
const DEFAULT_DEDUP_WINDOW_MS = 5 * 60 * 1000;

class NotificationDispatchQueue {
  /**
   * @param {{
   *   registry: import("./registry").ProviderRegistry,
   *   providerStore: import("./provider-store"),
   *   historyStore: import("./history-store"),
   *   queue?: import("../queue/persistent-queue").PersistentQueue,
   *   now?: () => number,
   *   rateLimit?: { windowMs: number, max: number },
   *   dedupWindowMs?: number,
   * }} deps
   */
  constructor({ registry, providerStore, historyStore, queue, now, rateLimit, dedupWindowMs } = {}) {
    if (!registry) throw new Error("NotificationDispatchQueue : registry requis.");
    if (!providerStore) throw new Error("NotificationDispatchQueue : providerStore requis.");
    if (!historyStore) throw new Error("NotificationDispatchQueue : historyStore requis.");

    this.registry = registry;
    this.providerStore = providerStore;
    this.historyStore = historyStore;
    this.now = now || (() => Date.now());
    this.rateLimit = {
      windowMs: (rateLimit && rateLimit.windowMs) || DEFAULT_RATE_LIMIT_WINDOW_MS,
      max: (rateLimit && rateLimit.max) || DEFAULT_RATE_LIMIT_MAX,
    };
    this.dedupWindowMs = dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    this.queue =
      queue ||
      createQueue(DEFAULT_QUEUE_NAME, { maxAttempts: DEFAULT_MAX_ATTEMPTS, backoffMs: DEFAULT_BACKOFF_MS });

    // État en mémoire uniquement (rate limiting / dedup) : perdu à un
    // redémarrage, ce qui est acceptable ici — contrairement aux jobs
    // eux-mêmes (persistés en base), un compteur de rate limit ou une
    // fenêtre de dédoublonnage remise à zéro au redémarrage n'entraîne
    // qu'un sur-envoi ponctuel dans un cas déjà rare (process qui redémarre
    // pile pendant une avalanche d'alertes), jamais une perte de données.
    this._rateBuckets = new Map(); // providerId -> timestamps[]
    this._dedupCache = new Map(); // dedupKey -> expiresAt
  }

  /** Clé de déduplication : même provider, même alerte, même transition. */
  buildDedupKey({ providerId, alertId, event }) {
    return `${providerId}:${alertId ?? "none"}:${event || "triggered"}`;
  }

  _isDuplicate(dedupKey) {
    const expiresAt = this._dedupCache.get(dedupKey);
    if (expiresAt === undefined) return false;
    if (this.now() >= expiresAt) {
      this._dedupCache.delete(dedupKey);
      return false;
    }
    return true;
  }

  _markSeen(dedupKey) {
    this._dedupCache.set(dedupKey, this.now() + this.dedupWindowMs);
  }

  _isRateLimited(providerId) {
    const now = this.now();
    const bucket = (this._rateBuckets.get(providerId) || []).filter(
      (ts) => now - ts < this.rateLimit.windowMs,
    );
    this._rateBuckets.set(providerId, bucket);
    return bucket.length >= this.rateLimit.max;
  }

  _recordRateUsage(providerId) {
    const bucket = this._rateBuckets.get(providerId) || [];
    bucket.push(this.now());
    this._rateBuckets.set(providerId, bucket);
  }

  /**
   * Empile une notification à envoyer. Ne lance jamais (même contrat que
   * RoutingEngine#dispatch : appelé depuis la boucle de monitoring
   * principale, qui ne doit jamais être bloquée/interrompue par le système
   * de notifications).
   *
   * @returns {Promise<{status: "queued"|"deduplicated"|"rate_limited", providerId: number, alertId: any, historyEntry: object|null, jobId?: number}>}
   */
  async enqueue({ providerId, notification, alertId, event }) {
    try {
      const dedupKey = this.buildDedupKey({ providerId, alertId, event });
      if (this._isDuplicate(dedupKey)) {
        return { status: "deduplicated", providerId, alertId, historyEntry: null };
      }

      if (this._isRateLimited(providerId)) {
        const historyEntry = await this._safeCreateHistory({
          providerId,
          alertId,
          status: "failed",
          errorCode: "RATE_LIMITED",
        });
        return { status: "rate_limited", providerId, alertId, historyEntry };
      }

      // Marqué vu / consommé dès l'admission en file : une déduplication ou
      // un rate limiting doivent porter sur les *tentatives d'envoi*, pas
      // seulement les envois réussis (sinon un provider en échec permanent
      // ne serait jamais rate-limité).
      this._markSeen(dedupKey);
      this._recordRateUsage(providerId);

      const historyEntry = await this._safeCreateHistory({ providerId, alertId, status: "pending" });

      const jobId = await this.queue.add({
        providerId,
        alertId,
        notification,
        historyId: historyEntry ? historyEntry.id : null,
      });

      return { status: "queued", providerId, alertId, jobId, historyEntry };
    } catch (e) {
      console.error("Erreur lors de la mise en file d'une notification :", e.message);
      return { status: "rate_limited", providerId, alertId, historyEntry: null, error: e.message };
    }
  }

  async _safeCreateHistory(entry) {
    try {
      return await this.historyStore.create(entry);
    } catch (e) {
      console.error("Erreur d'écriture de l'historique de notification (queue) :", e.message);
      return null;
    }
  }

  async _safeUpdateHistory(id, patch) {
    if (!id) return null;
    try {
      return await this.historyStore.update(id, patch);
    } catch (e) {
      console.error("Erreur de mise à jour de l'historique de notification :", e.message);
      return null;
    }
  }

  /**
   * Traite un job de la file : résout le provider, envoie, met à jour
   * l'historique. Lance volontairement en cas d'échec récupérable pour que
   * PersistentQueue applique son retry + backoff — c'est PersistentQueue,
   * pas ce module, qui décide qu'un job a épuisé ses tentatives (voir
   * persistent-queue.js#_markFailedOrRetry).
   */
  async handleJob(payload, job) {
    const { providerId, alertId, notification, historyId } = payload;
    const startedAt = this.now();
    const attemptNumber = (job && job.attempts !== undefined ? job.attempts : 0) + 1;
    const maxAttempts = (job && job.maxAttempts) || this.queue.maxAttempts;
    const isLastAttempt = attemptNumber >= maxAttempts;

    const provider = await this.providerStore.getById(providerId);
    if (!provider || !provider.enabled) {
      // Condition permanente (provider supprimé/désactivé) : inutile de
      // retenter, on marque directement "failed" et on ne relance pas.
      await this._safeUpdateHistory(historyId, {
        status: "failed",
        errorCode: provider ? "PROVIDER_DISABLED" : "PROVIDER_NOT_FOUND",
        metadata: { attempt: attemptNumber },
      });
      return;
    }

    const implementation = this.registry.getProvider(provider.type);
    if (!implementation) {
      await this._safeUpdateHistory(historyId, {
        status: "failed",
        errorCode: "UNKNOWN_PROVIDER_TYPE",
        metadata: { attempt: attemptNumber },
      });
      return;
    }

    let result;
    try {
      const secrets = (await this.providerStore.getDecryptedSecrets(providerId)) || {};
      const config = { ...provider.configuration, ...secrets };
      result = await implementation.send(notification, config);
    } catch (e) {
      result = { success: false, errorCode: "INTERNAL_ERROR" };
    }

    const responseTimeMs =
      result && result.responseTime != null ? result.responseTime : this.now() - startedAt;

    if (result && result.success) {
      await this._safeUpdateHistory(historyId, {
        status: "success",
        responseTimeMs,
        errorCode: null,
        metadata: { attempt: attemptNumber },
      });
      return;
    }

    await this._safeUpdateHistory(historyId, {
      status: isLastAttempt ? "failed" : "retrying",
      responseTimeMs,
      errorCode: (result && result.errorCode) || "SEND_FAILED",
      metadata: { attempt: attemptNumber },
    });

    if (!isLastAttempt) {
      // Fait retenter PersistentQueue (delay = backoffMs * attemptNumber).
      throw new Error((result && result.errorCode) || "SEND_FAILED");
    }
    // Dernière tentative épuisée : on absorbe l'erreur ici (déjà tracée
    // "failed" ci-dessus) pour que PersistentQueue supprime le job au lieu
    // de le remettre en pending (voir processOne : throw => retry/fail,
    // pas de throw => job supprimé). L'historique fait foi pour l'échec.
  }

  /** Démarre le worker (polling, voir PersistentQueue#start). Idempotent. */
  async start() {
    await this.queue.recoverStaleActiveJobs();
    this.queue.start((payload, job) => this.handleJob(payload, job));
  }

  stop() {
    this.queue.stop();
  }

  /** Traite au plus un job — utilitaire pour les tests (pas de polling). */
  async processOne() {
    return this.queue.processOne((payload, job) => this.handleJob(payload, job));
  }
}

module.exports = { NotificationDispatchQueue };
