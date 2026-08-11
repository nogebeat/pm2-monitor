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
  const instancesVals = samples.map((s) => s.instances).filter((v) => v !== null && v !== undefined);
  const restartVals = samples
    .map((s) => s.restartCount)
    .filter((v) => v !== null && v !== undefined)
    .sort((a, b) => a - b);

  return {
    cpu,
    memory,
    instancesAvg: instancesVals.length ? round1(instancesVals.reduce((a, b) => a + b, 0) / instancesVals.length) : null,
    restartCountMax: restartVals.length ? restartVals[restartVals.length - 1] : null,
    restartDelta: restartVals.length ? Math.max(0, restartVals[restartVals.length - 1] - restartVals[0]) : null,
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

function aggregateRollupBuckets(buckets) {
  const weights = buckets.map((b) => b.sampleCount || 0);

  const cpuAvg = weightedAvg(buckets.map((b, i) => ({ value: b.cpu.avg, weight: weights[i] })));
  const cpuP95 = weightedAvg(buckets.map((b, i) => ({ value: b.cpu.p95, weight: weights[i] })));
  const cpuMinMax = minMax(buckets.map((b) => b.cpu.min));
  const cpuMax = minMax(buckets.map((b) => b.cpu.max)).max;

  const memAvg = weightedAvg(buckets.map((b, i) => ({ value: b.memory.avg, weight: weights[i] })));
  const memP95 = weightedAvg(buckets.map((b, i) => ({ value: b.memory.p95, weight: weights[i] })));
  const memMinMax = minMax(buckets.map((b) => b.memory.min));
  const memMax = minMax(buckets.map((b) => b.memory.max)).max;

  const instancesAvg = weightedAvg(buckets.map((b, i) => ({ value: b.instancesAvg, weight: weights[i] })));

  const restartCountVals = buckets.map((b) => b.restartCountMax).filter((v) => v !== null && v !== undefined);
  const restartDeltaVals = buckets.map((b) => b.restartDelta).filter((v) => v !== null && v !== undefined);

  return {
    cpu: { avg: cpuAvg, min: cpuMinMax.min, max: cpuMax, p95: cpuP95 },
    memory: { avg: memAvg, min: memMinMax.min, max: memMax, p95: memP95 },
    instancesAvg,
    restartCountMax: restartCountVals.length ? Math.max(...restartCountVals) : null,
    restartDelta: restartDeltaVals.length ? restartDeltaVals.reduce((a, b) => a + b, 0) : null,
    sampleCount: buckets.reduce((a, b) => a + (b.sampleCount || 0), 0),
  };
}

module.exports = { round1, percentile, computeStats, aggregateSamples, aggregateRollupBuckets };
