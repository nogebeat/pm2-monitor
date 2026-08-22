"use strict";

/**
 * Agrégation de séries de valeurs numériques (échantillons `raw` -> buckets
 * `medium`/`long`). Fonctions pures, aucune dépendance DB ni date système :
 * testables isolément, comme lib/services/alerts/collector.js.
 *
 * p95 n'est pas calculé en SQL ici volontairement : ni SQLite ni MySQL
 * (versions courantes, sans extension) n'ont un PERCENTILE_CONT portable
 * entre les deux drivers du projet. On agrège donc toujours en JS à partir
 * de lignes déjà chargées — acceptable ici car chaque bucket ne couvre
 * jamais plus que quelques milliers d'échantillons bruts (voir rollup.js).
 */

/** Arrondi à 1 décimale, en préservant null/undefined. */
function round1(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

/** Percentile (0-100) par interpolation linéaire sur des valeurs déjà triées. */
function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (p / 100) * (sortedValues.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedValues[lo];
  const frac = rank - lo;
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * frac;
}

/**
 * Statistiques avg/min/max/p95 sur un tableau de valeurs (null/undefined
 * ignorés). Retourne des champs null si aucune valeur exploitable.
 */
function computeStats(values) {
  const nums = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(v)).map(Number);
  if (!nums.length) return { avg: null, min: null, max: null, p95: null };
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    avg: round1(sum / nums.length),
    min: round1(sorted[0]),
    max: round1(sorted[sorted.length - 1]),
    p95: round1(percentile(sorted, 95)),
  };
}

/**
 * Agrège un tableau d'échantillons `raw` (voir store.js: rowToRawPoint) en un
 * seul bucket pour une résolution donnée. `restartCount` est un compteur
 * monotone (pas une mesure instantanée) : on en garde le max (dernière
 * valeur vue dans le bucket, puisque non-décroissant) et le delta
 * (redémarrages survenus pendant le bucket), plutôt qu'une moyenne qui
 * n'aurait pas de sens.
 */
function aggregateSamples(samples) {
  const cpu = computeStats(samples.map((s) => s.cpu));
  const memory = computeStats(samples.map((s) => s.memory));
  // heap/event-loop-lag : best-effort (voir lib/process-helpers.js#readAxmMetrics),
  // souvent absents (null) — computeStats les ignore déjà, pas de traitement spécial.
  const heapUsed = computeStats(samples.map((s) => s.heapUsed));
  const heapTotal = computeStats(samples.map((s) => s.heapTotal));
  const eventLoopLag = computeStats(samples.map((s) => s.eventLoopLag));
  const instancesVals = samples.map((s) => s.instances).filter((v) => v !== null && v !== undefined);
  const restartVals = samples
    .map((s) => s.restartCount)
    .filter((v) => v !== null && v !== undefined)
    .sort((a, b) => a - b);
  // Disponibilité : nombre d'échantillons "online" dans le lot, à comparer à
  // sampleCount (voir 013_process_metrics_analytics.js). `status` null (jamais
  // renseigné) n'est jamais compté comme online.
  const onlineCount = samples.filter((s) => s.status === "online").length;

  return {
    cpu,
    memory,
    heapUsed,
    heapTotal,
    eventLoopLag,
    instancesAvg: instancesVals.length
      ? round1(instancesVals.reduce((a, b) => a + b, 0) / instancesVals.length)
      : null,
    restartCountMax: restartVals.length ? restartVals[restartVals.length - 1] : null,
    restartDelta: restartVals.length
      ? Math.max(0, restartVals[restartVals.length - 1] - restartVals[0])
      : null,
    onlineCount,
    sampleCount: samples.length,
  };
}

/**
 * Ré-agrège des buckets déjà agrégés (ex: buckets `medium` horaires -> un
 * bucket `long` journalier). On n'a plus les échantillons bruts à ce stade
 * (purgés ou simplement hors de portée), donc :
 *   - avg   : moyenne pondérée par sample_count de chaque sous-bucket.
 *   - min/max : min des min / max des max (exacts, pas d'approximation).
 *   - p95   : moyenne pondérée des p95 de chaque sous-bucket — une
 *     approximation standard en l'absence des valeurs brutes (un vrai p95
 *     sur l'union des échantillons demanderait de les conserver, ce que la
 *     rétention `raw` interdit justement). Documenté dans docs/process-history/.
 *   - restart_count_max : max (compteur monotone).
 *   - restart_delta : somme (nombre total de redémarrages sur la période).
 */
function weightedAvg(pairs) {
  // pairs: [{ value, weight }], value/weight nullable
  const usable = pairs.filter((p) => p.value !== null && p.value !== undefined && p.weight);
  if (!usable.length) return null;
  const totalWeight = usable.reduce((a, p) => a + p.weight, 0);
  if (!totalWeight) return null;
  const sum = usable.reduce((a, p) => a + p.value * p.weight, 0);
  return round1(sum / totalWeight);
}

function minMax(values) {
  const nums = values.filter((v) => v !== null && v !== undefined);
  if (!nums.length) return { min: null, max: null };
  return { min: round1(Math.min(...nums)), max: round1(Math.max(...nums)) };
}

/** Ré-agrège avg/min/max/p95 pour une métrique donnée (clé sur chaque bucket), pondéré par sample_count. */
function reaggregateStat(buckets, weights, key) {
  const avg = weightedAvg(buckets.map((b, i) => ({ value: b[key] ? b[key].avg : null, weight: weights[i] })));
  const p95 = weightedAvg(buckets.map((b, i) => ({ value: b[key] ? b[key].p95 : null, weight: weights[i] })));
  const min = minMax(buckets.map((b) => (b[key] ? b[key].min : null))).min;
  const max = minMax(buckets.map((b) => (b[key] ? b[key].max : null))).max;
  return { avg, min, max, p95 };
}

function aggregateRollupBuckets(buckets) {
  const weights = buckets.map((b) => b.sampleCount || 0);

  const cpu = reaggregateStat(buckets, weights, "cpu");
  const memory = reaggregateStat(buckets, weights, "memory");
  // heap/event-loop-lag : peut être totalement absent (aucun process instrumenté
  // sur la période) — reaggregateStat retourne alors des null partout, propagés
  // tels quels (jamais de 0 par défaut, voir aggregateSamples()).
  const heapUsed = reaggregateStat(buckets, weights, "heapUsed");
  const heapTotal = reaggregateStat(buckets, weights, "heapTotal");
  const eventLoopLag = reaggregateStat(buckets, weights, "eventLoopLag");

  const instancesAvg = weightedAvg(buckets.map((b, i) => ({ value: b.instancesAvg, weight: weights[i] })));

  const restartCountVals = buckets.map((b) => b.restartCountMax).filter((v) => v !== null && v !== undefined);
  const restartDeltaVals = buckets.map((b) => b.restartDelta).filter((v) => v !== null && v !== undefined);
  const onlineCountVals = buckets.map((b) => b.onlineCount).filter((v) => v !== null && v !== undefined);

  return {
    cpu,
    memory,
    heapUsed,
    heapTotal,
    eventLoopLag,
    instancesAvg,
    restartCountMax: restartCountVals.length ? Math.max(...restartCountVals) : null,
    restartDelta: restartDeltaVals.length ? restartDeltaVals.reduce((a, b) => a + b, 0) : null,
    // Somme (pas moyenne pondérée) : c'est un compte d'échantillons "online"
    // sur la période fusionnée, même traitement que sampleCount ci-dessous.
    onlineCount: onlineCountVals.length ? onlineCountVals.reduce((a, b) => a + b, 0) : null,
    sampleCount: buckets.reduce((a, b) => a + (b.sampleCount || 0), 0),
  };
}

module.exports = { round1, percentile, computeStats, aggregateSamples, aggregateRollupBuckets };
