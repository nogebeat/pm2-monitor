"use strict";

/**
 * Persistance de l'historique par process (tables process_metrics_raw /
 * process_metrics_rollup, migration 004_process_metrics + 014, qui a ajouté
 * `server_key`). Pas de logique d'agrégation ici (voir aggregator.js) ni
 * d'orchestration de rollup/purge (voir rollup.js) : uniquement des
 * lectures/écritures, même séparation que lib/services/alerts/alert-store.js.
 *
 * `serverKey` identifie l'hôte PM2 d'origine (voir
 * lib/services/servers/store.js) : `"local"` pour le hub lui-même,
 * `server_key` d'un agent distant sinon (migration 014 — avant elle, cette
 * table ne distinguait pas les serveurs, ce qui empêchait toute donnée
 * d'agent distant et fusionnait les process de même nom entre serveurs).
 * Toujours par défaut `"local"` dans les signatures ci-dessous : préserve le
 * comportement mono-serveur historique pour tout appelant qui ne le précise
 * pas explicitement.
 */

const db = require("../../db");

const DEFAULT_SERVER_KEY = "local";

// --- raw ---------------------------------------------------------------

async function insertRaw(sample) {
  const result = await db.run(
    `INSERT INTO process_metrics_raw
      (process_name, server_key, ts, cpu, memory, restart_count, instances, status, uptime_ms,
       heap_used, heap_total, event_loop_lag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sample.processName,
      sample.serverKey || DEFAULT_SERVER_KEY,
      sample.ts,
      sample.cpu ?? null,
      sample.memory ?? null,
      sample.restartCount ?? null,
      sample.instances ?? null,
      sample.status ?? null,
      sample.uptimeMs ?? null,
      // Best-effort (Phase 11) : null si le process n'expose pas axm_monitor
      // (voir lib/process-helpers.js#readAxmMetrics) — jamais de valeur inventée.
      sample.heapUsed ?? null,
      sample.heapTotal ?? null,
      sample.eventLoopLag ?? null,
    ],
  );
  return result.lastID;
}

/** Insère plusieurs échantillons (un par process observé au même tick). */
async function insertRawBatch(samples) {
  for (const sample of samples) {
    await insertRaw(sample);
  }
}

function rowToRawPoint(row) {
  return {
    ts: Number(row.ts),
    processName: row.process_name,
    serverKey: row.server_key || DEFAULT_SERVER_KEY,
    cpu: row.cpu !== null ? Number(row.cpu) : null,
    memory: row.memory !== null ? Number(row.memory) : null,
    restartCount: row.restart_count !== null ? Number(row.restart_count) : null,
    instances: row.instances !== null ? Number(row.instances) : null,
    status: row.status,
    uptimeMs: row.uptime_ms !== null ? Number(row.uptime_ms) : null,
    heapUsed: row.heap_used !== null && row.heap_used !== undefined ? Number(row.heap_used) : null,
    heapTotal: row.heap_total !== null && row.heap_total !== undefined ? Number(row.heap_total) : null,
    eventLoopLag:
      row.event_loop_lag !== null && row.event_loop_lag !== undefined ? Number(row.event_loop_lag) : null,
  };
}

async function queryRaw({ processName, serverKey = DEFAULT_SERVER_KEY, start, end }) {
  const rows = await db.all(
    `SELECT * FROM process_metrics_raw
     WHERE process_name = ? AND server_key = ? AND ts >= ? AND ts <= ?
     ORDER BY ts ASC`,
    [processName, serverKey, start, end],
  );
  return rows.map(rowToRawPoint);
}

/** Couples (process_name, server_key) distincts ayant au moins une ligne raw. */
async function listRawProcessKeys() {
  const rows = await db.all("SELECT DISTINCT process_name, server_key FROM process_metrics_raw", []);
  return rows.map((r) => ({ processName: r.process_name, serverKey: r.server_key || DEFAULT_SERVER_KEY }));
}

async function rawTimeRange(processName, serverKey = DEFAULT_SERVER_KEY) {
  const row = await db.get(
    "SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM process_metrics_raw WHERE process_name = ? AND server_key = ?",
    [processName, serverKey],
  );
  if (!row || row.min_ts === null || row.min_ts === undefined) return null;
  return { minTs: Number(row.min_ts), maxTs: Number(row.max_ts) };
}

async function purgeRawOlderThan(cutoff) {
  const result = await db.run("DELETE FROM process_metrics_raw WHERE ts < ?", [cutoff]);
  return result.changes;
}

// --- rollup --------------------------------------------------------------

function rowToRollupPoint(row) {
  return {
    ts: Number(row.bucket_start), // même clé "ts" que rowToRawPoint : le point représente le bucket
    processName: row.process_name,
    serverKey: row.server_key || DEFAULT_SERVER_KEY,
    resolution: row.resolution,
    cpu: {
      avg: row.cpu_avg !== null ? Number(row.cpu_avg) : null,
      min: row.cpu_min !== null ? Number(row.cpu_min) : null,
      max: row.cpu_max !== null ? Number(row.cpu_max) : null,
      p95: row.cpu_p95 !== null ? Number(row.cpu_p95) : null,
    },
    memory: {
      avg: row.memory_avg !== null ? Number(row.memory_avg) : null,
      min: row.memory_min !== null ? Number(row.memory_min) : null,
      max: row.memory_max !== null ? Number(row.memory_max) : null,
      p95: row.memory_p95 !== null ? Number(row.memory_p95) : null,
    },
    heapUsed: {
      avg: row.heap_used_avg !== null && row.heap_used_avg !== undefined ? Number(row.heap_used_avg) : null,
      min: row.heap_used_min !== null && row.heap_used_min !== undefined ? Number(row.heap_used_min) : null,
      max: row.heap_used_max !== null && row.heap_used_max !== undefined ? Number(row.heap_used_max) : null,
      p95: row.heap_used_p95 !== null && row.heap_used_p95 !== undefined ? Number(row.heap_used_p95) : null,
    },
    heapTotal: {
      avg: row.heap_total_avg !== null && row.heap_total_avg !== undefined ? Number(row.heap_total_avg) : null,
      min: row.heap_total_min !== null && row.heap_total_min !== undefined ? Number(row.heap_total_min) : null,
      max: row.heap_total_max !== null && row.heap_total_max !== undefined ? Number(row.heap_total_max) : null,
      p95: row.heap_total_p95 !== null && row.heap_total_p95 !== undefined ? Number(row.heap_total_p95) : null,
    },
    eventLoopLag: {
      avg:
        row.event_loop_lag_avg !== null && row.event_loop_lag_avg !== undefined
          ? Number(row.event_loop_lag_avg)
          : null,
      min:
        row.event_loop_lag_min !== null && row.event_loop_lag_min !== undefined
          ? Number(row.event_loop_lag_min)
          : null,
      max:
        row.event_loop_lag_max !== null && row.event_loop_lag_max !== undefined
          ? Number(row.event_loop_lag_max)
          : null,
      p95:
        row.event_loop_lag_p95 !== null && row.event_loop_lag_p95 !== undefined
          ? Number(row.event_loop_lag_p95)
          : null,
    },
    instancesAvg: row.instances_avg !== null ? Number(row.instances_avg) : null,
    restartCountMax: row.restart_count_max !== null ? Number(row.restart_count_max) : null,
    restartDelta: row.restart_delta !== null ? Number(row.restart_delta) : null,
    onlineCount: row.online_count !== null && row.online_count !== undefined ? Number(row.online_count) : null,
    sampleCount: Number(row.sample_count),
  };
}

/**
 * Crée ou remplace le bucket (process_name, server_key, resolution,
 * bucket_start). Portable sqlite/mysql : pas de syntaxe d'upsert
 * spécifique à un driver (ON CONFLICT vs ON DUPLICATE KEY), juste un
 * SELECT puis INSERT/UPDATE — cohérent avec le reste du projet, qui
 * n'utilise nulle part de syntaxe d'upsert native. Le volume ici est
 * faible (voir rollup.js : quelques dizaines de buckets par process/serveur
 * et par tick de maintenance au plus).
 */
async function upsertRollup(bucket) {
  const now = Date.now();
  const serverKey = bucket.serverKey || DEFAULT_SERVER_KEY;
  const existing = await db.get(
    "SELECT id FROM process_metrics_rollup WHERE process_name = ? AND server_key = ? AND resolution = ? AND bucket_start = ?",
    [bucket.processName, serverKey, bucket.resolution, bucket.bucketStart],
  );

  const heapUsed = bucket.heapUsed || {};
  const heapTotal = bucket.heapTotal || {};
  const eventLoopLag = bucket.eventLoopLag || {};

  const fields = [
    bucket.cpu.avg,
    bucket.cpu.min,
    bucket.cpu.max,
    bucket.cpu.p95,
    bucket.memory.avg,
    bucket.memory.min,
    bucket.memory.max,
    bucket.memory.p95,
    bucket.instancesAvg,
    bucket.restartCountMax,
    bucket.restartDelta,
    bucket.sampleCount,
    heapUsed.avg ?? null,
    heapUsed.min ?? null,
    heapUsed.max ?? null,
    heapUsed.p95 ?? null,
    heapTotal.avg ?? null,
    heapTotal.min ?? null,
    heapTotal.max ?? null,
    heapTotal.p95 ?? null,
    eventLoopLag.avg ?? null,
    eventLoopLag.min ?? null,
    eventLoopLag.max ?? null,
    eventLoopLag.p95 ?? null,
    bucket.onlineCount ?? null,
  ];

  if (existing) {
    await db.run(
      `UPDATE process_metrics_rollup SET
         cpu_avg = ?, cpu_min = ?, cpu_max = ?, cpu_p95 = ?,
         memory_avg = ?, memory_min = ?, memory_max = ?, memory_p95 = ?,
         instances_avg = ?, restart_count_max = ?, restart_delta = ?, sample_count = ?,
         heap_used_avg = ?, heap_used_min = ?, heap_used_max = ?, heap_used_p95 = ?,
         heap_total_avg = ?, heap_total_min = ?, heap_total_max = ?, heap_total_p95 = ?,
         event_loop_lag_avg = ?, event_loop_lag_min = ?, event_loop_lag_max = ?, event_loop_lag_p95 = ?,
         online_count = ?,
         updated_at = ?
       WHERE id = ?`,
      [...fields, now, existing.id],
    );
    return existing.id;
  }

  const result = await db.run(
    `INSERT INTO process_metrics_rollup
      (process_name, server_key, resolution, bucket_start,
       cpu_avg, cpu_min, cpu_max, cpu_p95,
       memory_avg, memory_min, memory_max, memory_p95,
       instances_avg, restart_count_max, restart_delta, sample_count,
       heap_used_avg, heap_used_min, heap_used_max, heap_used_p95,
       heap_total_avg, heap_total_min, heap_total_max, heap_total_p95,
       event_loop_lag_avg, event_loop_lag_min, event_loop_lag_max, event_loop_lag_p95,
       online_count,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bucket.processName, serverKey, bucket.resolution, bucket.bucketStart, ...fields, now, now],
  );
  return result.lastID;
}

async function queryRollup({ processName, serverKey = DEFAULT_SERVER_KEY, resolution, start, end }) {
  const rows = await db.all(
    `SELECT * FROM process_metrics_rollup
     WHERE process_name = ? AND server_key = ? AND resolution = ? AND bucket_start >= ? AND bucket_start <= ?
     ORDER BY bucket_start ASC`,
    [processName, serverKey, resolution, start, end],
  );
  return rows.map(rowToRollupPoint);
}

/** Lit les buckets `resolution` bruts (pas rowToRollupPoint) pour un ré-agrégat vers la résolution suivante. */
async function rollupRowsInRange({ processName, serverKey = DEFAULT_SERVER_KEY, resolution, start, end }) {
  return db.all(
    `SELECT * FROM process_metrics_rollup
     WHERE process_name = ? AND server_key = ? AND resolution = ? AND bucket_start >= ? AND bucket_start < ?
     ORDER BY bucket_start ASC`,
    [processName, serverKey, resolution, start, end],
  );
}

/** Couples (process_name, server_key) distincts ayant au moins un bucket à cette résolution. */
async function listRollupProcessKeys(resolution) {
  const rows = await db.all(
    "SELECT DISTINCT process_name, server_key FROM process_metrics_rollup WHERE resolution = ?",
    [resolution],
  );
  return rows.map((r) => ({ processName: r.process_name, serverKey: r.server_key || DEFAULT_SERVER_KEY }));
}

async function rollupTimeRange(processName, serverKey, resolution) {
  const row = await db.get(
    "SELECT MIN(bucket_start) AS min_ts, MAX(bucket_start) AS max_ts FROM process_metrics_rollup WHERE process_name = ? AND server_key = ? AND resolution = ?",
    [processName, serverKey || DEFAULT_SERVER_KEY, resolution],
  );
  if (!row || row.min_ts === null || row.min_ts === undefined) return null;
  return { minTs: Number(row.min_ts), maxTs: Number(row.max_ts) };
}

async function purgeRollupOlderThan(resolution, cutoff) {
  const result = await db.run(
    "DELETE FROM process_metrics_rollup WHERE resolution = ? AND bucket_start < ?",
    [resolution, cutoff],
  );
  return result.changes;
}

module.exports = {
  DEFAULT_SERVER_KEY,
  insertRaw,
  insertRawBatch,
  queryRaw,
  listRawProcessKeys,
  rawTimeRange,
  purgeRawOlderThan,
  upsertRollup,
  queryRollup,
  rollupRowsInRange,
  listRollupProcessKeys,
  rollupTimeRange,
  purgeRollupOlderThan,
};
