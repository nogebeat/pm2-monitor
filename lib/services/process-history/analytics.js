"use strict";

/**
 * Couche "analytics" de lib/services/process-history/ (Phase 11 — Advanced
 * Metrics & Analytics). N'introduit aucun nouveau stockage : agrège les
 * lignes déjà persistées par store.js (process_metrics_raw/rollup) via les
 * fonctions pures existantes d'aggregator.js — même principe que
 * index.js#query(), décliné pour produire des statistiques de période
 * (avg/min/max/p95, restarts, crashes, disponibilité) plutôt qu'une série de
 * points à tracer.
 *
 * Les crashes réutilisent lib/services/events/ (process_events, Phase 4) au
 * lieu de dupliquer un compteur : process-history ne connaît que des
 * échantillons périodiques (statut à l'instant T), pas les transitions
 * event-driven qui définissent un "crash" (voir events/normalizer.js) —
 * aucune des deux tables n'a vocation à couvrir l'autre.
 */

const store = require("./store");
const { aggregateSamples, aggregateRollupBuckets } = require("./aggregator");
const eventStore = require("../events/event-store");

/** Stats vides — même forme que la sortie normale, tout à null (période sans données). */
function emptyPeriodStats(start, end) {
  const emptyStat = { avg: null, min: null, max: null, p95: null };
  return {
    start,
    end,
    cpu: emptyStat,
    memory: emptyStat,
    heapUsed: emptyStat,
    heapTotal: emptyStat,
    eventLoopLag: emptyStat,
    instancesAvg: null,
    restarts: null,
    restartFrequencyPerHour: null,
    crashes: 0,
    availabilityPercent: null,
    sampleCount: 0,
  };
}

/**
 * Statistiques agrégées d'un process sur [start, end[.
 * @param {object} opts
 * @param {string} opts.processName
 * @param {number} opts.start
 * @param {number} opts.end
 * @param {string} opts.resolution - "raw" | "medium" | "long"
 */
async function computePeriodStats({ processName, serverKey, start, end, resolution }) {
  if (!(end > start)) return emptyPeriodStats(start, end);

  let agg;
  if (resolution === "raw") {
    const rows = await store.queryRaw({ processName, serverKey, start, end });
    agg = aggregateSamples(rows);
  } else {
    const rows = await store.queryRollup({ processName, serverKey, resolution, start, end });
    agg = aggregateRollupBuckets(rows);
  }

  // Crashes : lib/services/events/ (process_events) n'a pas encore de notion
  // de serveur (contrairement à process_metrics_raw/rollup depuis la
  // migration 014) — un crash "flaky" sur un serveur distant et un crash
  // "flaky" local se mélangeraient ici en cas de nom de process identique
  // entre deux serveurs. Limite connue, documentée dans
  // docs/process-history/README.md ; corriger events/ est hors périmètre
  // de ce correctif (nécessiterait sa propre migration + Phase dédiée).
  const crashResult = await eventStore.list({
    process: processName,
    type: "crashed",
    startTs: start,
    endTs: end,
    limit: 1,
  });

  const availabilityPercent =
    agg.sampleCount && agg.onlineCount !== null && agg.onlineCount !== undefined
      ? Math.round((agg.onlineCount / agg.sampleCount) * 1000) / 10
      : null;

  const hours = (end - start) / (60 * 60 * 1000);
  const restartFrequencyPerHour =
    agg.restartDelta !== null && agg.restartDelta !== undefined && hours > 0
      ? Math.round((agg.restartDelta / hours) * 100) / 100
      : null;

  return {
    start,
    end,
    cpu: agg.cpu,
    memory: agg.memory,
    heapUsed: agg.heapUsed,
    heapTotal: agg.heapTotal,
    eventLoopLag: agg.eventLoopLag,
    instancesAvg: agg.instancesAvg,
    restarts: agg.restartDelta ?? null,
    restartFrequencyPerHour,
    crashes: crashResult.total,
    availabilityPercent,
    sampleCount: agg.sampleCount,
  };
}

/** Variation en % entre deux valeurs, null-safe. `prev === 0` : évite une division par zéro/infini. */
function pctChange(curr, prev) {
  if (curr === null || curr === undefined || prev === null || prev === undefined) return null;
  if (prev === 0) return curr === 0 ? 0 : null;
  return Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10;
}

function computeDeltas(current, previous) {
  return {
    cpuAvgPct: pctChange(current.cpu.avg, previous.cpu.avg),
    memoryAvgPct: pctChange(current.memory.avg, previous.memory.avg),
    restartsPct: pctChange(current.restarts, previous.restarts),
    crashesPct: pctChange(current.crashes, previous.crashes),
    availabilityPct: pctChange(current.availabilityPercent, previous.availabilityPercent),
  };
}

/**
 * Stats de la période [start, end[ + (optionnel) comparaison avec la
 * période précédente de même durée immédiatement avant `start`.
 * @param {object} opts
 * @param {string} opts.processName
 * @param {number} opts.start
 * @param {number} opts.end
 * @param {string} opts.resolution
 * @param {boolean} [opts.compare] - défaut true
 */
async function computeAnalytics({ processName, serverKey, start, end, resolution, compare = true }) {
  const current = await computePeriodStats({ processName, serverKey, start, end, resolution });

  if (!compare) {
    return { current, previous: null, previousStart: null, previousEnd: null, deltas: null };
  }

  const spanMs = end - start;
  const previousEnd = start;
  const previousStart = start - spanMs;
  const previous = await computePeriodStats({
    processName,
    serverKey,
    start: previousStart,
    end: previousEnd,
    resolution,
  });

  return {
    current,
    previous,
    previousStart,
    previousEnd,
    deltas: computeDeltas(current, previous),
  };
}

module.exports = { computePeriodStats, computeAnalytics, pctChange, computeDeltas };
