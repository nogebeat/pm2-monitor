"use strict";

/**
 * File d'attente persistante, adossée à la base de données déjà utilisée par
 * le projet (table `jobs`, migration 002_job_queue) plutôt qu'à un système
 * externe (Redis, etc.).
 *
 * Choix d'architecture (voir docs/ARCHITECTURE.md pour le détail) :
 *   - `bee-queue` impose Redis, ce qui casse la contrainte "self-hosted sans
 *     dépendance SaaS/infra obligatoire" du projet.
 *   - `better-queue` peut persister sur disque, mais via un store séparé
 *     (fichier JSON ou SQLite dédié) : ça créerait un second système de
 *     stockage en parallèle de lib/db, ce que les règles du projet
 *     interdisent explicitement ("ne duplique pas les systèmes déjà
 *     présents").
 *   - Réutiliser lib/db (déjà abstrait sqlite/mysql, déjà migré) donne une
 *     persistance réelle (un redémarrage du process ne perd aucun job) sans
 *     ajouter de dépendance ni de second système de stockage.
 *
 * Cette classe ne connaît aucune logique métier (alertes, notifications…) :
 * c'est une brique générique, branchée dans les phases suivantes.
 */

const db = require("../../db");

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_BACKOFF_MS = 2000; // délai avant retry = backoff * (attempts déjà faites)

class PersistentQueue {
  /**
   * @param {string} queueName - nom logique de la file (plusieurs files peuvent cohabiter dans la même table `jobs`).
   * @param {object} [opts]
   * @param {number} [opts.pollIntervalMs]
   * @param {number} [opts.maxAttempts] - valeur par défaut si non précisée à add().
   * @param {number} [opts.backoffMs]
   */
  constructor(queueName, opts = {}) {
    if (!queueName) throw new Error("PersistentQueue: queueName requis.");
    this.queueName = queueName;
    // Attention à ne pas utiliser `||` ici : un `0` volontaire (ex: backoffMs: 0
    // dans les tests) est une valeur falsy et serait sinon remplacé à tort
    // par le défaut.
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this._handler = null;
    this._timer = null;
    this._processing = false;
  }

  /**
   * Ajoute un job. `payload` doit être sérialisable en JSON.
   * @param {any} payload
   * @param {object} [options]
   * @param {number} [options.maxAttempts]
   * @param {number} [options.delayMs] - délai avant la première exécution (jobs différés).
   * @returns {Promise<number>} l'id du job créé.
   */
  async add(payload, options = {}) {
    const now = Date.now();
    const runAt = now + (options.delayMs || 0);
    const result = await db.run(
      `INSERT INTO jobs (queue_name, payload, status, attempts, max_attempts, run_at, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)`,
      [this.queueName, JSON.stringify(payload), options.maxAttempts ?? this.maxAttempts, runAt, now, now],
    );
    return result.lastID;
  }

  async getJob(id) {
    const row = await db.get("SELECT * FROM jobs WHERE id = ? AND queue_name = ?", [id, this.queueName]);
    return row ? this._rowToJob(row) : null;
  }

  async listByStatus(status) {
    const rows = await db.all("SELECT * FROM jobs WHERE queue_name = ? AND status = ? ORDER BY id ASC", [
      this.queueName,
      status,
    ]);
    return rows.map((r) => this._rowToJob(r));
  }

  _rowToJob(row) {
    return {
      id: row.id,
      queueName: row.queue_name,
      payload: JSON.parse(row.payload),
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error || null,
      runAt: Number(row.run_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * Remet en attente les jobs restés "active" (process arrêté brutalement en
   * cours de traitement) : c'est ce qui garantit qu'un job survit à un
   * redémarrage — sans ça, un job interrompu resterait bloqué à "active" pour
   * toujours puisque personne ne le reconsidère comme du travail à faire.
   */
  async recoverStaleActiveJobs() {
    const result = await db.run(
      "UPDATE jobs SET status = 'pending', updated_at = ? WHERE queue_name = ? AND status = 'active'",
      [Date.now(), this.queueName],
    );
    return result.changes;
  }

  /** Réserve atomiquement le prochain job éligible (pending, run_at <= now), ou null s'il n'y en a pas. */
  async _claimNext() {
    const now = Date.now();
    const candidate = await db.get(
      `SELECT * FROM jobs
       WHERE queue_name = ? AND status = 'pending' AND run_at <= ?
       ORDER BY run_at ASC, id ASC
       LIMIT 1`,
      [this.queueName, now],
    );
    if (!candidate) return null;

    // On ne marque "active" que si le job est toujours "pending" au moment de
    // l'UPDATE (garde-fou simple contre une double réservation si jamais
    // plusieurs pollers tournaient en parallèle).
    const result = await db.run(
      "UPDATE jobs SET status = 'active', updated_at = ? WHERE id = ? AND status = 'pending'",
      [now, candidate.id],
    );
    if (result.changes === 0) return null; // déjà pris entre-temps
    return this._rowToJob({ ...candidate, status: "active" });
  }

  async _markCompleted(jobId) {
    await db.run("DELETE FROM jobs WHERE id = ?", [jobId]);
  }

  async _markFailedOrRetry(job, error) {
    const attempts = job.attempts + 1;
    const now = Date.now();
    if (attempts >= job.maxAttempts) {
      await db.run(
        "UPDATE jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
        [attempts, String((error && error.message) || error), now, job.id],
      );
    } else {
      const nextRunAt = now + this.backoffMs * attempts;
      await db.run(
        "UPDATE jobs SET status = 'pending', attempts = ?, last_error = ?, run_at = ?, updated_at = ? WHERE id = ?",
        [attempts, String((error && error.message) || error), nextRunAt, now, job.id],
      );
    }
  }

  /** Traite au plus un job disponible. Retourne le job traité (ou null si la file était vide). Utile pour les tests. */
  async processOne(handler) {
    const job = await this._claimNext();
    if (!job) return null;
    try {
      await handler(job.payload, job);
      await this._markCompleted(job.id);
    } catch (e) {
      await this._markFailedOrRetry(job, e);
    }
    return job;
  }

  /**
   * Démarre le traitement en continu (polling). À appeler une fois au
   * démarrage du process après avoir récupéré les jobs "active" orphelins.
   */
  start(handler) {
    if (this._timer) return; // déjà démarrée
    this._handler = handler;
    this._timer = setInterval(() => this._tick(), this.pollIntervalMs);
    if (this._timer.unref) this._timer.unref(); // ne bloque pas l'arrêt propre du process
  }

  async _tick() {
    if (this._processing) return; // évite le chevauchement si un job prend plus longtemps que l'intervalle
    this._processing = true;
    try {
      // Traite tous les jobs immédiatement éligibles avant d'attendre le prochain tick.
      let job;
      do {
        job = await this.processOne(this._handler);
      } while (job);
    } finally {
      this._processing = false;
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._handler = null;
  }
}

module.exports = { PersistentQueue };
