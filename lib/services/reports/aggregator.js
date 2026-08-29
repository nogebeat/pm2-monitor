"use strict";

/**
 * lib/services/reports/aggregator.js — Phase 20 (Reports & Capacity Planning).
 *
 * Compose un rapport à partir de services déjà existants, exactement comme
 * lib/services/dashboard/index.js#buildSnapshot() compose le dashboard :
 * AUCUNE nouvelle collecte, aucun second système de métriques. Sources
 * réutilisées :
 *  - lib/services/process-history/analytics.js#computePeriodStats() : par
 *    process, disponibilité/CPU/RAM/restarts/crashes sur la période (Phase 11).
 *  - lib/services/reports/queries.js : alertes/incidents/notifications/
 *    auto-healing sur la période (lecture directe des tables existantes).
 *  - lib/services/health-checks/store.js#list() : statut COURANT des health
 *    checks (aucune table d'historique de résultats n'existe pour ce
 *    domaine — voir docs/reports/README.md, section "Limites connues").
 *  - lib/services/reports/system-history-store.js (CPU/RAM/disque système)
 *    pour le Capacity Planning système : persistance downsamplée (5 min)
 *    de la même valeur déjà calculée par lib/system-stats.js à chaque tick
 *    (voir migration 021_system_metrics_history.js) — contourne la limite
 *    24h de lib/history-store.js (en mémoire) pour permettre des
 *    projections weekly/monthly réellement basées sur plusieurs semaines
 *    d'historique.
 */

const analytics = require("../process-history/analytics");
const ranking = require("./ranking");
const capacity = require("./capacity");
const queries = require("./queries");
const { resolveProcessScope } = require("./scope");
const healthChecksStore = require("../health-checks/store");
const systemHistoryStore = require("./system-history-store");

const CAPACITY_LOOKBACK_MIN_MS = 14 * 24 * 60 * 60 * 1000; // au moins 14j de recul, même pour un rapport "daily"
const CAPACITY_THRESHOLDS = { cpu: 80, memory: 80, disk: 80 };

function num(v) {
  return v === null || v === undefined ? null : Number(v);
}

/**
 * @param {object} deps
 * @param {import("../process-history").ProcessHistoryService} deps.processHistory - pour pickResolution()
 * @param {boolean} [deps.includeSystemCapacity] - inclut le Capacity Planning système (CPU/RAM/disque) —
 *   à false si l'appelant n'a pas la permission "system" (voir lib/routes/reports.js).
 * @param {string[]} [deps.liveProcessNames] - process actuellement listés par PM2 (voir scope.js)
 * @param {object} filters - { period, start, end } déjà résolus par periods.js#resolvePeriod(),
 *   + { serverKey, environment, group, process } (scope.js#resolveProcessScope)
 * @param {object} [user] - req.user, pour le filtrage de visibilité (voir scope.js)
 */
async function generateReport(deps, filters, user = null) {
  const { processHistory, includeSystemCapacity, liveProcessNames } = deps;
  const { start, end } = filters;

  const scope = await resolveProcessScope({ ...filters, liveProcessNames }, user);
  const processNames = scope.map((s) => s.processName);

  const resolution = processHistory ? processHistory.pickResolution(end - start) : "medium";

  const [perProcessStats, alerts, incidents, notifications, autoHealing, healthChecks] = await Promise.all([
    Promise.all(
      scope.map(async (p) => {
        const stats = await analytics.computePeriodStats({
          processName: p.processName,
          serverKey: p.serverKey,
          start,
          end,
          resolution,
        });
        return { ...p, stats };
      }),
    ),
    queries.alertsInPeriod({ start, end, processNames }),
    queries.incidentsInPeriod({ start, end, processNames }),
    queries.notificationsInPeriod({ start, end, processNames }),
    queries.autoHealingInPeriod({ start, end, processNames }),
    healthChecksStore.list({}),
  ]);

  const alertCountByProcess = new Map();
  for (const a of alerts) {
    if (a.target_type === "process" && a.target_value) {
      alertCountByProcess.set(a.target_value, (alertCountByProcess.get(a.target_value) || 0) + 1);
    }
  }

  const periodMs = Math.max(0, end - start);
  const processEntries = perProcessStats.map(({ processName, serverKey, stats }) => {
    const availabilityPercent = stats.availabilityPercent;
    const downtimeMs =
      availabilityPercent === null ? 0 : Math.round(periodMs * (1 - availabilityPercent / 100));
    return {
      processName,
      serverKey,
      availabilityPercent,
      crashes: stats.crashes || 0,
      restarts: stats.restarts || 0,
      cpuAvg: num(stats.cpu.avg),
      memoryAvg: num(stats.memory.avg),
      downtimeMs,
      alertCount: alertCountByProcess.get(processName) || 0,
      sampleCount: stats.sampleCount,
    };
  });

  const summary = buildSummary({
    processEntries,
    alerts,
    incidents,
    notifications,
    autoHealing,
    healthChecks,
    processNames,
  });

  const capacityPlanning = includeSystemCapacity
    ? await buildCapacityPlanning({ start, end })
    : { system: null };

  return {
    period: { period: filters.period, start, end },
    scope: {
      serverKey: filters.serverKey || null,
      environment: filters.environment || null,
      group: filters.group || null,
      process: filters.process || null,
      processCount: scope.length,
      resolution,
    },
    summary,
    processes: processEntries,
    ranking: ranking.rankByAllCriteria(processEntries, { limit: filters.rankingLimit || 10 }),
    capacityPlanning,
    generatedAt: Date.now(),
  };
}

function buildSummary({
  processEntries,
  alerts,
  incidents,
  notifications,
  autoHealing,
  healthChecks,
  processNames,
}) {
  const availabilities = processEntries.map((p) => p.availabilityPercent).filter((v) => v !== null);
  const cpuAvgs = processEntries.map((p) => p.cpuAvg).filter((v) => v !== null);
  const memAvgs = processEntries.map((p) => p.memoryAvg).filter((v) => v !== null);

  const avg = (arr) =>
    arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null;

  const relevantHealthChecks = processNames.length
    ? healthChecks.filter((h) => !h.processName || processNames.includes(h.processName))
    : healthChecks;

  return {
    availabilityPercent: avg(availabilities),
    crashes: processEntries.reduce((a, p) => a + p.crashes, 0),
    restarts: processEntries.reduce((a, p) => a + p.restarts, 0),
    cpu: { avg: avg(cpuAvgs) },
    memory: { avg: avg(memAvgs) },
    incidents: incidents.length,
    alerts: {
      total: alerts.length,
      critical: alerts.filter((a) => a.severity === "critical").length,
      warning: alerts.filter((a) => a.severity === "warning").length,
      info: alerts.filter((a) => a.severity === "info").length,
    },
    healthChecks: {
      up: relevantHealthChecks.filter((h) => h.status === "UP").length,
      down: relevantHealthChecks.filter((h) => h.status === "DOWN").length,
      degraded: relevantHealthChecks.filter((h) => h.status === "DEGRADED").length,
      unknown: relevantHealthChecks.filter((h) => h.status === "UNKNOWN").length,
      // Statut COURANT uniquement (pas d'historique de résultats persistant pour ce domaine) —
      // voir en-tête de fichier.
      currentSnapshot: true,
    },
    notifications: {
      total: notifications.length,
      sent: notifications.filter((n) => n.status === "sent" || n.status === "success").length,
      failed: notifications.filter((n) => n.status === "failed" || n.status === "error").length,
    },
    autoHealing: {
      total: autoHealing.length,
      success: autoHealing.filter((h) => h.result === "success").length,
      failure: autoHealing.filter((h) => h.result === "failure").length,
      blocked: autoHealing.filter((h) => h.result === "blocked").length,
    },
  };
}

/**
 * Capacity Planning système (CPU/RAM/disque), basé sur
 * lib/services/reports/system-history-store.js (persistance downsamplée à
 * 5 min, voir migration 021_system_metrics_history.js) — dispose donc
 * réellement de plusieurs semaines/mois d'historique pour un rapport
 * `weekly`/`monthly`/`custom`, contrairement à lib/history-store.js seul
 * (24h en mémoire). Le recul utilisé est au moins CAPACITY_LOOKBACK_MIN_MS
 * (14j), et étendu jusqu'au début de la période demandée si celle-ci est
 * plus longue (utile pour un `custom` couvrant plusieurs mois) — la
 * tendance a besoin d'assez de recul, pas seulement de la période affichée.
 *
 * Sur une installation neuve (moins de quelques points persistés),
 * capacity.js#computeProjection renvoie naturellement `confidence:
 * "insufficient_data"` (MIN_POINTS) plutôt que d'échouer — pas de cas
 * particulier à gérer ici.
 */
async function buildCapacityPlanning({ start, end }) {
  const lookbackStart = Math.min(start, end - CAPACITY_LOOKBACK_MIN_MS);
  const rows = await systemHistoryStore.querySince(lookbackStart, end);
  const dataWindowMs = rows.length >= 2 ? rows[rows.length - 1].ts - rows[0].ts : 0;

  const toSeries = (key) =>
    rows.filter((r) => r[key] !== null && r[key] !== undefined).map((r) => ({ t: r.ts, value: r[key] }));

  const project = (key, threshold) => ({
    ...capacity.computeProjection(toSeries(key), { threshold, now: end }),
    dataWindowMs,
    note: "Projection système basée sur l'historique persisté (échantillonné toutes les 5 minutes, voir lib/services/reports/system-history-store.js) — une tendance statistique, pas une certitude.",
  });

  return {
    system: {
      cpu: project("cpu_percent", CAPACITY_THRESHOLDS.cpu),
      memory: project("mem_percent", CAPACITY_THRESHOLDS.memory),
      disk: project("disk_percent", CAPACITY_THRESHOLDS.disk),
    },
  };
}

module.exports = { generateReport, buildSummary, buildCapacityPlanning, CAPACITY_THRESHOLDS };
