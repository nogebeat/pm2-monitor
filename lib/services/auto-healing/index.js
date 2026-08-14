"use strict";

/**
 * Service Auto-Healing (Phase 7) — point d'entrée.
 *
 * Pas de singleton auto-instancié : server.js crée `new AutoHealingService({ pm2 })`
 * une fois la connexion PM2 établie (même raison que ProcessHistoryService /
 * EventsService : certains services ont besoin d'un contexte disponible
 * seulement après le bootstrap).
 *
 * Les fonctions `feedFromAlertTransition` / `feedFromPm2Event` ci-dessous
 * sont de simples adaptateurs (event brut -> { processName, source, reason })
 * appelés depuis server.js, à côté de dispatchAlertTransition (notifications)
 * et du bus PM2 déjà existants — aucun second listener/scheduler créé.
 */

const { AutoHealingService } = require("./engine");
const settingsStore = require("./settings-store");
const stateStore = require("./state-store");
const auditStore = require("./audit-store");

/**
 * Une transition d'alerte "active" concernant un process ou un health check
 * est un signal de guérison potentiel. targetValue porte le nom du process
 * (ou du health check, dont le nom est censé correspondre au process
 * surveillé dans un usage standard — voir docs/auto-healing/README.md).
 * Retourne null si l'alerte ne concerne pas un process nommé (ex: "system").
 */
function feedFromAlertTransition(service, alert) {
  if (!alert || !alert.targetValue || alert.targetValue === "system") return null;

  if (alert.state === "active") {
    return service.trigger({
      processName: alert.targetValue,
      source: alert.targetType === "health_check" ? "health_check" : "alert",
      reason: `${alert.metric} ${alert.operator} ${alert.threshold}`,
    });
  }
  if (alert.state === "resolved") {
    return service.recordRecovery(alert.targetValue);
  }
  return null;
}

/** Packet brut du bus PM2 process:event — seul "exit" est un signal de crash exploitable ici. */
function feedFromPm2Event(service, packet) {
  if (!packet || packet.event !== "exit" || !packet.process || !packet.process.name) return null;
  return service.trigger({
    processName: packet.process.name,
    source: "pm2_event",
    reason: "process crashed",
  });
}

module.exports = {
  AutoHealingService,
  settingsStore,
  stateStore,
  auditStore,
  feedFromAlertTransition,
  feedFromPm2Event,
};
