"use strict";

/**
 * Point d'entrée du service Incidents (Phase 14) — assemble le store, le
 * corrélateur (correlation.js) et le store de silences, et expose
 * `handleAlertTransition()`, le hook unique appelé depuis
 * lib/alert-dispatch.js pour chaque transition d'alerte (comme
 * dispatchAlertTransition le fait déjà pour notifications/websocket/
 * auto-healing — voir en-tête de ce fichier-là).
 *
 * Instance partagée par lib/routes/incidents.js et lib/alert-dispatch.js,
 * même raisonnement que lib/services/alerts/index.js (un seul corrélateur en
 * mémoire — bien que sa logique soit sans état, tout passant par la DB).
 */

const incidentStore = require("./incident-store");
const timelineStore = require("./timeline-store");
const silenceStore = require("./silence-store");
const { IncidentCorrelator } = require("./correlation");
const processOrgStore = require("../process-organization/store");

const correlator = new IncidentCorrelator({ store: incidentStore, processOrgStore });

/**
 * Appelé pour CHAQUE transition d'alerte (active/resolved), qu'elle vienne
 * du polling process/system ou des health checks (même alerte, mêmes
 * champs — voir lib/alert-dispatch.js).
 *
 * - "active" (déclenchement) : corrèle vers un incident existant ou en crée
 *   un nouveau (correlation.js), rattache l'alerte (incident_alerts). La
 *   ligne de timeline "alerte déclenchée" n'est pas écrite ici : elle est
 *   résolue à la lecture depuis `alerts` (voir timeline-store.js#deriveAlertEntries).
 * - "resolved" : rien à corréler (l'alerte est déjà rattachée à un
 *   incident, ou ne l'a jamais été si elle n'a jamais atteint "active" —
 *   voir engine.js, seule "active" et "resolved" nous intéressent ici, pas
 *   "trigger" qui n'est qu'un compte à rebours interne). La résolution de
 *   l'alerte est elle aussi dérivée à la lecture, pas de transition
 *   d'incident automatique (l'opérateur décide quand MARQUER l'incident
 *   résolu via l'API, voir lib/routes/incidents.js).
 *
 * Ne lance jamais : mêmes garanties que dispatchAlertTransition/
 * RoutingEngine#dispatch (appelé depuis la boucle de monitoring
 * principale, qui ne doit jamais être interrompue par ce service).
 */
async function handleAlertTransition(alert) {
  if (!alert) return null;
  try {
    if (alert.state === "active" && alert.triggeredAt === alert.lastSeenAt) {
      const { incident } = await correlator.attach(alert);
      return incident;
    }
    // "resolved" (ou tout autre état) : rien à faire côté corrélation — la
    // résolution de l'alerte est déjà visible dans la timeline dérivée dès
    // que l'incident est relu (voir timeline-store.js).
    return null;
  } catch (e) {
    console.error("Erreur de corrélation d'incident :", e.message);
    return null;
  }
}

module.exports = {
  incidentStore,
  timelineStore,
  silenceStore,
  correlator,
  processOrgStore,
  handleAlertTransition,
};
