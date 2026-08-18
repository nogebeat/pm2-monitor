"use strict";

/**
 * lib/services/dashboard/index.js — Phase 8.
 *
 * Compose un instantané ("snapshot") du dashboard global à partir des
 * services déjà existants : aucune nouvelle source de données, aucun
 * nouveau scheduler. `buildSnapshot()` ne fait qu'appeler les fonctions
 * déjà utilisées ailleurs dans server.js (metrics système, liste process,
 * alertes actives, health checks, timeline récente, audit Auto-Healing) et
 * les passe aux fonctions pures de ce dossier
 * (`calculateProcessOverview`, `calculateGlobalStatus`).
 */

const { calculateGlobalStatusDetailed, DEFAULT_THRESHOLDS } = require("./global-status");
const { calculateProcessOverview } = require("./process-overview");

const RECENT_TIMELINE_LIMIT = 20;

/**
 * @param {object} deps
 * @param {() => Promise<Array>} deps.listProcesses - process déjà formatés (server.js#fmtProcess),
 *   déjà filtrés par visibilité pour l'utilisateur courant (voir server.js#visibleProcesses)
 * @param {() => object} deps.getSystemSnapshot - lib/system-stats.js#snapshot()
 * @param {{listActive: Function}} [deps.alertStore] - omis si l'utilisateur n'a pas authealing_read/alerts_read
 * @param {{list: Function}} [deps.healthChecksStore] - omis si l'utilisateur n'a pas health_checks_read
 * @param {{list: Function}} [deps.eventsStore] - lib/services/events/event-store.js
 * @param {{list: Function}} [deps.autoHealingAuditStore] - lib/services/auto-healing/audit-store.js
 * @param {object} [deps.thresholds] - surcharge des seuils de calculateGlobalStatus()
 */
async function buildSnapshot(deps) {
  const {
    listProcesses,
    getSystemSnapshot,
    alertStore,
    healthChecksStore,
    eventsStore,
    autoHealingAuditStore,
    thresholds,
  } = deps;

  const [processesRaw, alerts, resolvedAlerts, healthChecks, recentEvents, recentHealings] =
    await Promise.all([
      listProcesses(),
      alertStore ? alertStore.listActive() : Promise.resolve(null),
      alertStore
        ? alertStore.listHistory({ state: "resolved", limit: RECENT_TIMELINE_LIMIT })
        : Promise.resolve(null),
      healthChecksStore ? healthChecksStore.list() : Promise.resolve(null),
      eventsStore ? eventsStore.list({ limit: RECENT_TIMELINE_LIMIT }) : Promise.resolve(null),
      autoHealingAuditStore
        ? autoHealingAuditStore.list({ limit: RECENT_TIMELINE_LIMIT })
        : Promise.resolve(null),
    ]);

  const system = getSystemSnapshot ? getSystemSnapshot() : null;
  const processOverview = calculateProcessOverview(processesRaw);

  const { status: globalStatus, reasons } = calculateGlobalStatusDetailed({
    system,
    processes: processOverview,
    alerts: alerts || [],
    healthChecks: healthChecks || [],
    thresholds,
  });

  return {
    globalStatus,
    globalStatusReasons: reasons,
    system,
    processes: {
      overview: processOverview,
      items: processesRaw,
    },
    alerts: alerts
      ? {
          active: alerts.length,
          critical: alerts.filter((a) => a.severity === "critical").length,
          warning: alerts.filter((a) => a.severity === "warning").length,
          acknowledged: alerts.filter((a) => a.state === "acknowledged").length,
          items: alerts,
        }
      : null,
    healthChecks: healthChecks
      ? {
          up: healthChecks.filter((c) => c.status === "UP").length,
          down: healthChecks.filter((c) => c.status === "DOWN").length,
          degraded: healthChecks.filter((c) => c.status === "DEGRADED").length,
          unknown: healthChecks.filter((c) => c.status === "UNKNOWN").length,
          items: healthChecks,
        }
      : null,
    // Timeline récente (section 7) : fusion d'événements process (Phase 4),
    // d'alertes, de résultats health check et de tentatives Auto-Healing,
    // triée par horodatage décroissant — aucune nouvelle table, uniquement
    // une lecture combinée de ce qui existe déjà.
    recentTimeline: buildRecentTimeline({ recentEvents, alerts, resolvedAlerts, recentHealings }),
  };
}

function buildRecentTimeline({ recentEvents, alerts, resolvedAlerts, recentHealings }) {
  const items = [];

  (recentEvents && recentEvents.items ? recentEvents.items : []).forEach((e) => {
    items.push({
      kind: "process_event",
      at: e.timestamp,
      process: e.process,
      type: e.type,
      severity: e.severity,
    });
  });

  (alerts || []).forEach((a) => {
    items.push({
      kind: "alert",
      at: a.triggeredAt || a.lastSeenAt,
      process: a.targetValue,
      type: a.state, // "active" | "acknowledged"
      severity: a.severity,
      ruleName: a.ruleName,
    });
  });

  // Résolutions récentes (guérisons) : c'est ce qui permet au dashboard
  // d'afficher une "recovery" dans la timeline (section 7), sans dupliquer
  // le système d'alertes existant — simple lecture de listHistory().
  (resolvedAlerts || []).forEach((a) => {
    items.push({
      kind: "alert",
      at: a.resolvedAt,
      process: a.targetValue,
      type: "resolved",
      severity: a.severity,
      ruleName: a.ruleName,
    });
  });

  (recentHealings || []).forEach((h) => {
    items.push({
      kind: "auto_healing",
      at: h.createdAt,
      process: h.processName,
      type: h.action, // "restart" | "block" | "unblock"
      result: h.result,
      reason: h.reason,
    });
  });

  return items
    .filter((i) => typeof i.at === "number")
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_TIMELINE_LIMIT);
}

module.exports = { buildSnapshot, buildRecentTimeline, RECENT_TIMELINE_LIMIT, DEFAULT_THRESHOLDS };
