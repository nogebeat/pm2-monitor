"use strict";

/**
 * Orchestration du rollup multi-résolution + purge, appelée périodiquement
 * (voir index.js: startMaintenanceLoop). N'agrège jamais que des buckets
 * *complets* (bucket_start + taille <= now) : un bucket en cours ne serait
 * agrégé qu'à partir d'échantillons partiels, et serait recalculé à chaque
 * tick jusqu'à sa complétion — travail inutile, upsertRollup() est déjà
 * idempotent donc ça ne casserait rien, mais autant l'éviter.
 *
 * Non-bloquant vis-à-vis de la collecte : ce module ne partage aucun état
 * avec collector.js/index.js au-delà de la base de données elle-même, et
 * s'exécute sur son propre intervalle (voir index.js). Le volume par tick
 * reste borné (au plus quelques dizaines de buckets par process, voir
 * commentaire de floorTo ci-dessous), donc chaque exécution est courte —
 * important puisque better-sqlite3 est synchrone (une requête bloque
 * l'event loop le temps de son exécution).
 */

const store = require("./store");
const { aggregateSamples, aggregateRollupBuckets } = require("./aggregator");

function floorTo(ts, bucketMs) {
  return Math.floor(ts / bucketMs) * bucketMs;
}

/** Liste les bucket_start *complets* entre minTs et now, taille bucketMs. */
function completeBucketsSince(minTs, now, bucketMs) {
  const firstBucket = floorTo(minTs, bucketMs);
  const lastCompleteBucket = floorTo(now, bucketMs) - bucketMs; // le bucket en cours est exclu
  const buckets = [];
  for (let b = firstBucket; b <= lastCompleteBucket; b += bucketMs) {
    buckets.push(b);
  }
  return buckets;
}

/** raw -> medium (buckets horaires par défaut) pour un process/serveur donné. */
async function rollupRawToMedium(processName, serverKey, bucketMs, now) {
  const range = await store.rawTimeRange(processName, serverKey);
  if (!range) return 0;

  const buckets = completeBucketsSince(range.minTs, now, bucketMs);
  let written = 0;
  for (const bucketStart of buckets) {
    const samples = await store.queryRaw({
      processName,
      serverKey,
      start: bucketStart,
      end: bucketStart + bucketMs - 1,
    });
    if (!samples.length) continue;
    const agg = aggregateSamples(samples);
    await store.upsertRollup({ processName, serverKey, resolution: "medium", bucketStart, ...agg });
    written += 1;
  }
  return written;
}

/** medium -> long (buckets journaliers par défaut) pour un process/serveur donné. */
async function rollupMediumToLong(processName, serverKey, bucketMs, now) {
  const range = await store.rollupTimeRange(processName, serverKey, "medium");
  if (!range) return 0;

  const buckets = completeBucketsSince(range.minTs, now, bucketMs);
  let written = 0;
  for (const bucketStart of buckets) {
    const rows = await store.rollupRowsInRange({
      processName,
      serverKey,
      resolution: "medium",
      start: bucketStart,
      end: bucketStart + bucketMs,
    });
    if (!rows.length) continue;
    const points = rows.map((r) => ({
      cpu: { avg: r.cpu_avg, min: r.cpu_min, max: r.cpu_max, p95: r.cpu_p95 },
      memory: { avg: r.memory_avg, min: r.memory_min, max: r.memory_max, p95: r.memory_p95 },
      // Colonnes ajoutées en 013_process_metrics_analytics.js : undefined sur
      // des buckets "medium" écrits avant cette migration, traité comme
      // "absent" par aggregateRollupBuckets() (voir reaggregateStat()).
      heapUsed: { avg: r.heap_used_avg, min: r.heap_used_min, max: r.heap_used_max, p95: r.heap_used_p95 },
      heapTotal: {
        avg: r.heap_total_avg,
        min: r.heap_total_min,
        max: r.heap_total_max,
        p95: r.heap_total_p95,
      },
      eventLoopLag: {
        avg: r.event_loop_lag_avg,
        min: r.event_loop_lag_min,
        max: r.event_loop_lag_max,
        p95: r.event_loop_lag_p95,
      },
      instancesAvg: r.instances_avg,
      restartCountMax: r.restart_count_max,
      restartDelta: r.restart_delta,
      onlineCount: r.online_count,
      sampleCount: r.sample_count,
    }));
    const agg = aggregateRollupBuckets(points);
    await store.upsertRollup({ processName, serverKey, resolution: "long", bucketStart, ...agg });
    written += 1;
  }
  return written;
}

/**
 * Exécute un cycle complet : rollup raw->medium->long puis purge des trois
 * résolutions selon `config`. Retourne un petit rapport (utile pour les
 * tests et les logs). `now` est injectable pour les tests.
 */
async function runMaintenance(config, now = Date.now()) {
  const report = {
    mediumBucketsWritten: 0,
    longBucketsWritten: 0,
    rawPurged: 0,
    mediumPurged: 0,
    longPurged: 0,
  };

  // (process_name, server_key) : depuis la migration 014, deux serveurs
  // peuvent avoir un process de même nom sans que leur historique se
  // mélange — voir 014_process_metrics_server_key.js.
  const rawKeys = await store.listRawProcessKeys();
  for (const { processName, serverKey } of rawKeys) {
    report.mediumBucketsWritten += await rollupRawToMedium(
      processName,
      serverKey,
      config.mediumBucketMs,
      now,
    );
  }

  const mediumKeys = await store.listRollupProcessKeys("medium");
  for (const { processName, serverKey } of mediumKeys) {
    report.longBucketsWritten += await rollupMediumToLong(processName, serverKey, config.longBucketMs, now);
  }

  report.rawPurged = await store.purgeRawOlderThan(now - config.shortRetentionMs);
  report.mediumPurged = await store.purgeRollupOlderThan("medium", now - config.mediumRetentionMs);
  report.longPurged = await store.purgeRollupOlderThan("long", now - config.longRetentionMs);

  return report;
}

module.exports = { runMaintenance, completeBucketsSince, floorTo };
