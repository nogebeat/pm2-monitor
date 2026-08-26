"use strict";

/**
 * Traduit une règle d'anomalie + une cible (snapshot système ou process
 * PM2 formaté) en `{ value, history, previousPeriodValue }` exploitable par
 * detector.js. AUCUNE nouvelle collecte de données : uniquement de la
 * lecture sur les historiques déjà alimentés par l'existant :
 *  - cpu/memory/disk système -> lib/history-store.js (déjà collecté par
 *    lib/polling.js, en mémoire, 24h glissantes)
 *  - cpu/memory process -> lib/services/process-history/ (DB, déjà collecté
 *    par le même poller process — voir lib/polling.js)
 *  - restart_rate/crash_rate/event_rate -> lib/services/events/ (timeline
 *    d'événements déjà normalisée par lib/services/events/normalizer.js)
 *
 * `value` (la lecture "courante") réutilise systématiquement
 * lib/services/alerts/collector.js#readSystemMetric/readProcessMetric : même
 * lecture que celle utilisée par le moteur d'alertes classique, pour ne pas
 * dupliquer cette logique ni risquer une incohérence d'unité (ex: mémoire
 * process en Mo, pas en octets).
 *
 * Retourne `null` quand la lecture n'est pas possible du tout (métrique
 * indisponible sur cette plateforme, aucun store injecté...) : l'appelant
 * (service.js) doit alors sauter l'évaluation, exactement comme collector.js
 * le fait déjà pour le moteur d'alertes classique.
 */

const { readSystemMetric, readProcessMetric } = require("../alerts/collector");
const { COUNT_METRICS, EVENT_TYPES_BY_METRIC, COUNT_METRIC_BUCKET_MS, MAX_COUNT_BUCKETS } = require("./config");

const SYSTEM_SAMPLE_KEY = { cpu: "cpu", memory: "memPercent", disk: "diskPercent" };

/** cpu/memory/disk système, à partir de lib/history-store.js (échantillons en mémoire). */
function readSystemSeries({ rule, snapshot, historyStore, now = Date.now() }) {
  if (!historyStore || !Array.isArray(historyStore.samples)) return null;
  const value = readSystemMetric(snapshot, rule.metric);
  if (value === null || value === undefined) return null;

  const key = SYSTEM_SAMPLE_KEY[rule.metric];
  if (!key) return null;

  const windowStart = now - rule.windowMs;
  const t = snapshot && snapshot.t ? snapshot.t : now;
  const history = historyStore.samples
    .filter((s) => s.t < t && s.t >= windowStart)
    .map((s) => s[key])
    .filter((v) => typeof v === "number" && !Number.isNaN(v));

  // Comparaison à la période précédente : moyenne de la fenêtre juste avant windowStart.
  const prevWindowStart = windowStart - rule.windowMs;
  const previous = historyStore.samples
    .filter((s) => s.t >= prevWindowStart && s.t < windowStart)
    .map((s) => s[key])
    .filter((v) => typeof v === "number" && !Number.isNaN(v));
  const previousPeriodValue = previous.length ? previous.reduce((a, b) => a + b, 0) / previous.length : null;

  return { value, history, previousPeriodValue };
}

/** cpu/memory process, à partir de lib/services/process-history/ (DB). */
async function readProcessNumericSeries({ rule, proc, processHistoryStore, now = Date.now() }) {
  if (!processHistoryStore) return null;
  const value = readProcessMetric(proc, rule.metric);
  if (value === null || value === undefined) return null;

  const windowStart = now - rule.windowMs;
  const rows = await processHistoryStore.queryRaw({
    processName: proc.name,
    serverKey: "local",
    start: windowStart,
    end: now,
  });

  const toMetricValue = (row) => {
    if (rule.metric === "memory") {
      // process-history stocke la mémoire en octets (voir index.js#record) ;
      // collector.js#readProcessMetric convertit en Mo pour les alertes —
      // même conversion ici pour comparer des valeurs dans la même unité.
      return typeof row.memory === "number" ? row.memory / (1024 * 1024) : null;
    }
    return row.cpu;
  };

  const history = rows.map(toMetricValue).filter((v) => typeof v === "number" && !Number.isNaN(v));

  const prevWindowStart = windowStart - rule.windowMs;
  const prevRows = await processHistoryStore.queryRaw({
    processName: proc.name,
    serverKey: "local",
    start: prevWindowStart,
    end: windowStart,
  });
  const previousValues = prevRows.map(toMetricValue).filter((v) => typeof v === "number" && !Number.isNaN(v));
  const previousPeriodValue = previousValues.length
    ? previousValues.reduce((a, b) => a + b, 0) / previousValues.length
    : null;

  return { value, history, previousPeriodValue };
}

/**
 * restart_rate/crash_rate/event_rate : compte les événements
 * (lib/services/events/event-store.js) par tranches successives d'1h
 * ("buckets"). La tranche la plus récente = valeur courante, les tranches
 * précédentes (dans la fenêtre historique de la règle) = baseline.
 */
async function readCountSeries({ rule, targetType, targetValue, eventStore, now = Date.now() }) {
  if (!eventStore) return null;
  const eventTypes = EVENT_TYPES_BY_METRIC[rule.metric];
  if (eventTypes === undefined) return null;

  const bucketMs = COUNT_METRIC_BUCKET_MS;
  const numBuckets = Math.min(MAX_COUNT_BUCKETS, Math.max(1, Math.floor(rule.windowMs / bucketMs)));

  const countBucket = async (startTs, endTs) => {
    if (!eventTypes) {
      // event_rate : tous types confondus, un seul appel.
      const { total } = await eventStore.list({
        process: targetType === "process" ? targetValue : undefined,
        startTs,
        endTs,
        limit: 1,
      });
      return total;
    }
    // restart_rate/crash_rate : un ou plusieurs types précis, sommés.
    let sum = 0;
    for (const type of eventTypes) {
      const { total } = await eventStore.list({
        process: targetType === "process" ? targetValue : undefined,
        type,
        startTs,
        endTs,
        limit: 1,
      });
      sum += total;
    }
    return sum;
  };

  // Bucket courant : la dernière tranche d'1h (en cours), pas encore complète —
  // sa valeur croît au fil du temps jusqu'à la fin de l'heure, ce qui est
  // acceptable ici (voir service.js, l'engine gère déjà le anti-flapping via
  // duration/cooldown sur les touches répétées).
  const currentStart = now - bucketMs;
  const value = await countBucket(currentStart, now);

  const history = [];
  for (let i = 1; i <= numBuckets; i++) {
    const end = currentStart - (i - 1) * bucketMs;
    const start = end - bucketMs;
     
    history.push(await countBucket(start, end));
  }

  const previousPeriodValue = history.length ? history.reduce((a, b) => a + b, 0) / history.length : null;

  return { value, history, previousPeriodValue };
}

module.exports = {
  readSystemSeries,
  readProcessNumericSeries,
  readCountSeries,
  isCountMetric: (metric) => COUNT_METRICS.includes(metric),
};
