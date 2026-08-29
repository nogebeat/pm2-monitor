"use strict";

/**
 * lib/services/reports/system-history-store.js — Phase 20 (suite).
 *
 * Persistance downsamplée des métriques système (CPU/RAM/disque) pour que
 * le Capacity Planning d'un rapport `weekly`/`monthly`/`custom` dispose
 * d'un historique réel, au-delà des 24h en mémoire de
 * lib/history-store.js#HistoryStore (voir migration
 * 021_system_metrics_history.js pour le détail du raisonnement).
 *
 * `recordFromHistoryStore()` est appelée périodiquement par server.js, au
 * même endroit que `historyStore.push()` — elle ne calcule RIEN de
 * nouveau : elle persiste simplement le dernier échantillon déjà poussé
 * dans HistoryStore, au maximum une fois toutes les PERSIST_INTERVAL_MS.
 */

const db = require("../../db");

const PERSIST_INTERVAL_MS = 5 * 60 * 1000; // un point toutes les 5 minutes (~288/jour)
const RETENTION_MS = 400 * 24 * 60 * 60 * 1000; // un peu plus d'un an, pour couvrir un rapport "monthly" avec de la marge

let lastPersistedAt = 0;

/**
 * À appeler après chaque `historyStore.push()` (voir server.js). N'écrit
 * en base qu'au maximum une fois par PERSIST_INTERVAL_MS — pas d'I/O
 * supplémentaire sur la boucle 5s existante en dehors de cette fenêtre.
 *
 * @param {{t: number, cpu: number|null, memPercent: number|null, diskPercent: number|null}} sample
 *   Un échantillon tel que produit par lib/history-store.js#HistoryStore.push (mêmes clés).
 * @param {number} [now]
 */
async function recordFromHistoryStore(sample, now = Date.now()) {
  if (!sample || now - lastPersistedAt < PERSIST_INTERVAL_MS) return false;
  lastPersistedAt = now;
  await db.run(
    `INSERT INTO system_metrics_history (ts, cpu_percent, mem_percent, disk_percent, created_at) VALUES (?, ?, ?, ?, ?)`,
    [sample.t, sample.cpu ?? null, sample.memPercent ?? null, sample.diskPercent ?? null, now],
  );
  return true;
}

/** Points persistés dans [start, end], ordonnés chronologiquement. */
async function querySince(start, end = Date.now()) {
  return db.all(
    `SELECT ts, cpu_percent, mem_percent, disk_percent FROM system_metrics_history WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`,
    [start, end],
  );
}

/** Purge des points au-delà de la rétention — à appeler périodiquement (voir server.js). */
async function purgeOlderThan(cutoff = Date.now() - RETENTION_MS) {
  const result = await db.run(`DELETE FROM system_metrics_history WHERE ts < ?`, [cutoff]);
  return result.changes || 0;
}

/** Réinitialise le throttle interne — usage tests uniquement. */
function _resetThrottleForTests() {
  lastPersistedAt = 0;
}

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // une purge par jour suffit largement (rétention en jours)
let _purgeTimer = null;

/**
 * Démarre la purge périodique (voir server.js, appelée une fois au
 * démarrage — même principe que ProcessHistoryService qui gère son propre
 * timer de maintenance interne, lib/services/process-history/index.js).
 * Idempotent : un second appel ne crée pas de second timer.
 */
function startPurgeLoop(intervalMs = PURGE_INTERVAL_MS) {
  if (_purgeTimer) return _purgeTimer;
  _purgeTimer = setInterval(() => {
    purgeOlderThan().catch((e) => {
      console.error("Erreur de purge de l'historique système (reports) :", e.message);
    });
  }, intervalMs);
  _purgeTimer.unref?.();
  return _purgeTimer;
}

module.exports = {
  PERSIST_INTERVAL_MS,
  RETENTION_MS,
  PURGE_INTERVAL_MS,
  recordFromHistoryStore,
  querySince,
  purgeOlderThan,
  startPurgeLoop,
  _resetThrottleForTests,
};
