"use strict";

/**
 * Service d'historique par process — point d'entrée.
 *
 * `record()` est appelé depuis server.js, dans la même boucle pm2.list()
 * que l'évaluation des règles d'alerte "process" (voir server.js et le
 * commentaire au-dessus de son setInterval unifié) : pas de second poller
 * PM2 pour ce service, réutilisation explicite du collecteur existant.
 *
 * `query()` est consommé par la route GET /api/processes/:id/metrics
 * (server.js, même convention que les routes /logs/* existantes).
 *
 * La boucle de maintenance (rollup + purge, lib/services/process-history/rollup.js)
 * est en revanche gérée ici via start()/stop(), sur son propre intervalle
 * indépendant de la collecte — même découpage que lib/services/queue/persistent-queue.js
 * (poller de traitement séparé du reste du service).
 */

const { resolveConfig } = require("./config");
const store = require("./store");
const { runMaintenance } = require("./rollup");
const { readProcessMetric } = require("../alerts/collector");
const { aggregateRollupBuckets, computeStats } = require("./aggregator");

const RESOLUTIONS = ["raw", "medium", "long"];
const DEFAULT_RANGE_MS = 60 * 60 * 1000; // 1h si ni start ni end fournis

class ProcessHistoryService {
  constructor(env = process.env) {
    this.config = resolveConfig(env);
    this._maintenanceTimer = null;
    this._maintenanceRunning = false;
  }

  // --- Collecte ------------------------------------------------------------

  /**
   * @param {Array} processList - liste formatée façon fmtProcess() (server.js)
   * @param {number} now
   */
  async record(processList, now = Date.now()) {
    if (!this.config.enabled || !Array.isArray(processList) || !processList.length) return 0;

    const samples = processList.map((proc) => ({
      processName: proc.name,
      ts: now,
      cpu: readProcessMetric(proc, "cpu"),
      memory: proc.memory ?? null, // en octets, cohérent avec fmtProcess() (contrairement à collector.js qui convertit en Mo pour les alertes)
      restartCount: readProcessMetric(proc, "restart_count"),
      instances: typeof proc.instances === "number" ? proc.instances : null,
      status: proc.status || null,
      uptimeMs: proc.uptime ? Math.max(0, now - proc.uptime) : null,
    }));

    await store.insertRawBatch(samples);
    return samples.length;
  }

  // --- Maintenance (rollup + purge) -----------------------------------------

  start() {
    if (this._maintenanceTimer || !this.config.enabled) return;
    this._maintenanceTimer = setInterval(() => this._tick(), this.config.maintenanceIntervalMs);
    if (this._maintenanceTimer.unref) this._maintenanceTimer.unref();
  }

  stop() {
    if (this._maintenanceTimer) clearInterval(this._maintenanceTimer);
    this._maintenanceTimer = null;
  }

  async _tick() {
    if (this._maintenanceRunning) return; // évite le chevauchement si un cycle prend plus longtemps que l'intervalle
    this._maintenanceRunning = true;
    try {
      await runMaintenance(this.config);
    } catch (e) {
      console.error("Erreur de maintenance de l'historique process :", e.message);
    } finally {
      this._maintenanceRunning = false;
    }
  }

  /** Exposé pour les tests (et un éventuel appel manuel) : un cycle synchrone, sans passer par le timer. */
  runMaintenanceOnce(now) {
    return runMaintenance(this.config, now);
  }

  // --- Lecture (API) ---------------------------------------------------------

  pickResolution(spanMs) {
    if (spanMs <= this.config.rawMaxSpanMs) return "raw";
    if (spanMs <= this.config.mediumMaxSpanMs) return "medium";
    return "long";
  }

  /**
   * @param {object} opts
   * @param {string} opts.processName
   * @param {number} [opts.start] - ms epoch, défaut : end - 1h
   * @param {number} [opts.end] - ms epoch, défaut : maintenant
   * @param {string} [opts.resolution] - "raw"|"medium"|"long", défaut : auto selon la plage
   * @param {string[]} [opts.metrics] - sous-ensemble de ["cpu","memory","restarts","instances","status"]
   */
  async query({ processName, start, end, resolution, metrics } = {}) {
    if (!processName) throw new Error("processName requis.");
    if (resolution && !RESOLUTIONS.includes(resolution)) {
      throw new Error(`resolution invalide: "${resolution}". Attendu: ${RESOLUTIONS.join(", ")}.`);
    }

    const now = Date.now();
    const rangeEnd = Number.isFinite(end) ? end : now;
    const rangeStart = Number.isFinite(start) ? start : rangeEnd - DEFAULT_RANGE_MS;
    if (rangeStart >= rangeEnd) throw new Error("start doit être strictement antérieur à end.");

    const effectiveResolution = resolution || this.pickResolution(rangeEnd - rangeStart);

    let points;
    if (effectiveResolution === "raw") {
      const rows = await store.queryRaw({ processName, start: rangeStart, end: rangeEnd });
      points = downsampleRaw(rows, this.config.maxPoints);
    } else {
      const rows = await store.queryRollup({
        processName,
        resolution: effectiveResolution,
        start: rangeStart,
        end: rangeEnd,
      });
      points = downsampleRollup(rows, this.config.maxPoints);
    }

    if (Array.isArray(metrics) && metrics.length) {
      points = points.map((p) => filterMetrics(p, metrics));
    }

    return { processName, resolution: effectiveResolution, start: rangeStart, end: rangeEnd, points };
  }
}

// --- Downsampling (borne le nombre de points renvoyés par l'API) -----------
//
// Même logique que lib/history-store.js (moyenne par bucket), déclinée pour
// les deux formes de point possibles : valeurs scalaires (raw) ou objets
// avg/min/max/p95 déjà agrégés (rollup, via aggregateRollupBuckets).

function downsampleRaw(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const bucketSize = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += bucketSize) {
    const bucket = points.slice(i, i + bucketSize);
    const cpu = computeStats(bucket.map((b) => b.cpu));
    const memory = computeStats(bucket.map((b) => b.memory));
    const restarts = bucket.map((b) => b.restartCount).filter((v) => v !== null && v !== undefined);
    out.push({
      ts: bucket[Math.floor(bucket.length / 2)].ts,
      processName: bucket[0].processName,
      cpu: cpu.avg,
      memory: memory.avg,
      restartCount: restarts.length ? restarts[restarts.length - 1] : null,
      instances: bucket[bucket.length - 1].instances,
      status: bucket[bucket.length - 1].status,
    });
  }
  return out;
}

function downsampleRollup(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const bucketSize = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += bucketSize) {
    const bucket = points.slice(i, i + bucketSize);
    const agg = aggregateRollupBuckets(bucket);
    out.push({ ts: bucket[Math.floor(bucket.length / 2)].ts, processName: bucket[0].processName, ...agg });
  }
  return out;
}

function filterMetrics(point, metrics) {
  const allowed = new Set(metrics);
  const out = { ts: point.ts };
  if (allowed.has("cpu")) out.cpu = point.cpu;
  if (allowed.has("memory")) out.memory = point.memory;
  if (allowed.has("restarts")) out.restartCount = point.restartCount ?? point.restartCountMax;
  if (allowed.has("instances")) out.instances = point.instances ?? point.instancesAvg;
  if (allowed.has("status") && point.status !== undefined) out.status = point.status;
  return out;
}

// Pas de singleton auto-instancié ici (contrairement à lib/services/alerts/,
// dont l'engine ne lit aucune variable d'environnement) : ProcessHistoryService
// lit process.env.PROCESS_HISTORY_* dans son constructeur, et server.js ne
// charge le .env (loadDotEnv()) qu'après avoir fait tous ses require() — un
// singleton créé ici, au moment du require(), verrait donc un .env pas
// encore chargé. server.js instancie explicitement `new ProcessHistoryService()`
// une fois le .env chargé, et c'est cette instance qui est partagée entre la
// boucle de collecte et la route REST (les deux vivent dans server.js).
module.exports = { ProcessHistoryService, RESOLUTIONS };
