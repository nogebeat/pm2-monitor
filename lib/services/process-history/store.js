"use strict";

/**
 * Persistance de l'historique par process (tables process_metrics_raw /
 * process_metrics_rollup, migration 004_process_metrics). Pas de logique
 * d'agrégation ici (voir aggregator.js) ni d'orchestration de rollup/purge
 * (voir rollup.js) : uniquement des lectures/écritures, même séparation que
 * lib/services/alerts/alert-store.js.
 */

const db = require("../../db");

// --- raw ---------------------------------------------------------------

async function insertRaw(sample) {
  const result = await db.run(
    `INSERT INTO process_metrics_raw
      (process_name, ts, cpu, memory, restart_count, instances, status, uptime_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sample.processName,
      sample.ts,
      sample.cpu ?? null,
      sample.memory ?? null,
      sample.restartCount ?? null,
      sample.instances ?? null,
      sample.status ?? null,
      sample.uptimeMs ?? null,
    ]
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
    cpu: row.cpu !== null ? Number(row.cpu) : null,
    memory: row.memory !== null ? Number(row.memory) : null,
    restartCount: row.restart_count !== null ? Number(row.restart_count) : null,
    instances: row.instances !== null ? Number(row.instances) : null,
    status: row.status,
    uptimeMs: row.uptime_ms !== null ? Number(row.uptime_ms) : null,
  };
}

async function queryRaw({ processName, start, end }) {
  const rows = await db.all(
    `SELECT * FROM process_metrics_raw
     WHERE process_name = ? AND ts >= ? AND ts <= ?
     ORDER BY ts ASC`,
    [processName, start, end]
  );
  return rows.map(rowToRawPoint);
}

/** Toutes les valeurs distinctes de process_name ayant au moins une ligne raw. */
async function listRawProcessNames() {
  const rows = await db.all("SELECT DISTINCT process_name FROM process_metrics_raw", []);
  return rows.map((r) => r.process_name);
}

async function rawTimeRange(processName) {
  const row = await db.get(
    "SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM process_metrics_raw WHERE process_name = ?",
    [processName]
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
    instancesAvg: row.instances_avg !== null ? Number(row.instances_avg) : null,
    restartCountMax: row.restart_count_max !== null ? Number(row.restart_count_max) : null,
    restartDelta: row.restart_delta !== null ? Number(row.restart_delta) : null,
    sampleCount: Number(row.sample_count),
  };
}

/**
 * Crée ou remplace le bucket (process_name, resolution, bucket_start).
 * Portable sqlite/mysql : pas de syntaxe d'upsert spécifique à un driver
 * (ON CONFLICT vs ON DUPLICATE KEY), juste un SELECT puis INSERT/UPDATE —
 * cohérent avec le reste du projet, qui n'utilise nulle part de syntaxe
 * d'upsert native. Le volume ici est faible (voir rollup.js : quelques
 * dizaines de buckets par process et par tick de maintenance au plus).
 */
async function upsertRollup(bucket) {
  const now = Date.now();
  const existing = await db.get(
    "SELECT id FROM process_metrics_rollup WHERE process_name = ? AND resolution = ? AND bucket_start = ?",
    [bucket.processName, bucket.resolution, bucket.bucketStart]
  );

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
  ];

  if (existing) {
    await db.run(
      `UPDATE process_metrics_rollup SET
         cpu_avg = ?, cpu_min = ?, cpu_max = ?, cpu_p95 = ?,
         memory_avg = ?, memory_min = ?, memory_max = ?, memory_p95 = ?,
         instances_avg = ?, restart_count_max = ?, restart_delta = ?, sample_count = ?,
         updated_at = ?
       WHERE id = ?`,
      [...fields, now, existing.id]
    );
    return existing.id;
  }

  const result = await db.run(
    `INSERT INTO process_metrics_rollup
      (process_name, resolution, bucket_start,
       cpu_avg, cpu_min, cpu_max, cpu_p95,
       memory_avg, memory_min, memory_max, memory_p95,
       instances_avg, restart_count_max, restart_delta, sample_count,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bucket.processName, bucket.resolution, bucket.bucketStart, ...fields, now, now]
  );
  return result.lastID;
}

async function queryRollup({ processName, resolution, start, end }) {
  const rows = await db.all(
    `SELECT * FROM process_metrics_rollup
     WHERE process_name = ? AND resolution = ? AND bucket_start >= ? AND bucket_start <= ?
     ORDER BY bucket_start ASC`,
    [processName, resolution, start, end]
  );
  return rows.map(rowToRollupPoint);
}

/** Lit les buckets `resolution` bruts (pas rowToRollupPoint) pour un ré-agrégat vers la résolution suivante. */
async function rollupRowsInRange({ processName, resolution, start, end }) {
  return db.all(
    `SELECT * FROM process_metrics_rollup
     WHERE process_name = ? AND resolution = ? AND bucket_start >= ? AND bucket_start < ?
     ORDER BY bucket_start ASC`,
    [processName, resolution, start, end]
  );
}

async function listRollupProcessNames(resolution) {
  const rows = await db.all("SELECT DISTINCT process_name FROM process_metrics_rollup WHERE resolution = ?", [
    resolution,
  ]);
  return rows.map((r) => r.process_name);
}

async function rollupTimeRange(processName, resolution) {
  const row = await db.get(
    "SELECT MIN(bucket_start) AS min_ts, MAX(bucket_start) AS max_ts FROM process_metrics_rollup WHERE process_name = ? AND resolution = ?",
    [processName, resolution]
  );
  if (!row || row.min_ts === null || row.min_ts === undefined) return null;
  return { minTs: Number(row.min_ts), maxTs: Number(row.max_ts) };
}

async function purgeRollupOlderThan(resolution, cutoff) {
  const result = await db.run("DELETE FROM process_metrics_rollup WHERE resolution = ? AND bucket_start < ?", [
    resolution,
    cutoff,
  ]);
  return result.changes;
}

module.exports = {
  insertRaw,
  insertRawBatch,
  queryRaw,
  listRawProcessNames,
  rawTimeRange,
  purgeRawOlderThan,
  upsertRollup,
  queryRollup,
  rollupRowsInRange,
  listRollupProcessNames,
  rollupTimeRange,
  purgeRollupOlderThan,
};
