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
const healthChecksStore = require("../health-checks/store");

/**
 * Une transition d'alerte "active" concernant un process est un signal de
 * guérison potentiel. Pour targetType === "process", targetValue est déjà
 * le nom du process PM2 (comportement existant de l'Alert Engine, inchangé).
 *
 * Pour targetType === "health_check", targetValue est le *nom du check*
 * (health_checks.name), pas forcément celui d'un process PM2 — rien ne
 * l'impose (voir migration 010_health_checks_process_name.js, correctif
 * d'un problème connu de la Phase 7 initiale, qui supposait à tort
 * `check.name === nom de process`). On résout donc explicitement via
 * `health_checks.process_name` : si ce champ n'est pas renseigné pour ce
 * check, Auto-Healing ignore l'événement plutôt que de risquer de
 * redémarrer le mauvais process (ou un process inexistant).
 */
async function feedFromAlertTransition(service, alert) {
  if (!alert || !alert.targetValue || alert.targetValue === "system") return null;

  const processName = await resolveProcessName(alert);
  if (!processName) return null;

  if (alert.state === "active") {
    return service.trigger({
      processName,
      source: alert.targetType === "health_check" ? "health_check" : "alert",
      reason: `${alert.metric} ${alert.operator} ${alert.threshold}`,
    });
  }
  if (alert.state === "resolved") {
    return service.recordRecovery(processName);
  }
  return null;
}

async function resolveProcessName(alert) {
  if (alert.targetType !== "health_check") return alert.targetValue;

  const check = await healthChecksStore.getByName(alert.targetValue);
  return check ? check.processName : null;
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
