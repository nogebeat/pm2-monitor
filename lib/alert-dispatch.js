"use strict";

/**
 * lib/alert-dispatch.js
 *
 * Extrait de server.js : point d'entrée unique par lequel une transition
 * d'alerte (déclenchement ou résolution, "process", "system" ou
 * "health-check") se propage vers les notifications, le dashboard temps réel
 * et l'auto-healing. Un seul endroit à modifier si un futur consommateur de
 * transition doit être ajouté.
 *
 * Fabrique dépendante de `io` et `autoHealing` (instances créées dans
 * server.js), d'où le passage en factory plutôt qu'un simple require comme
 * pour lib/process-helpers.js.
 */

const { routingEngine: notificationRoutingEngine } = require("./services/notifications");
const { feedFromAlertTransition } = require("./services/auto-healing");
// Phase 14 — Incident Management & Alert Silencing : même point d'entrée
// unique que les notifications/l'auto-healing ci-dessus, pour corréler
// chaque transition d'alerte vers un incident (lib/services/incidents/).
const { handleAlertTransition: handleIncidentAlertTransition } = require("./services/incidents");

/**
 * @param {object} deps
 * @param {import("socket.io").Server} deps.io
 * @param {object} deps.autoHealing - instance AutoHealingService
 * @param {boolean} deps.notificationsDispatchEnabled
 */
function createDispatchAlertTransition({ io, autoHealing, notificationsDispatchEnabled }) {
  /**
   * Détecte, sans modifier lib/services/alerts/engine.js, qu'un résultat
   * d'evaluate() correspond à une transition "on vient de passer active"
   * (triggeredAt vient d'être posé au même timestamp que lastSeenAt — un
   * touch() ultérieur avance lastSeenAt sans toucher triggeredAt, donc cette
   * égalité n'est vraie qu'au tick de la transition trigger->active, voir
   * engine.js#trigger) ou "on vient de passer resolved" (resolve() est
   * terminal pour une occurrence : dedupKey sort des OPEN_STATES, donc ce
   * résultat n'est jamais revu par un futur evaluate() sur la même occurrence
   * — pas besoin d'égalité de timestamp ici).
   */
  return function dispatchAlertTransition(alert) {
    if (!alert) return;
    if (notificationsDispatchEnabled) {
      if (alert.state === "active" && alert.triggeredAt === alert.lastSeenAt) {
        notificationRoutingEngine.dispatch(alert, "triggered").catch((e) => {
          console.error("Erreur de dispatch de notification (déclenchement) :", e.message);
        });
      } else if (alert.state === "resolved") {
        notificationRoutingEngine.dispatch(alert, "resolved").catch((e) => {
          console.error("Erreur de dispatch de notification (résolution) :", e.message);
        });
      }
    }

    // Dashboard global (Phase 8) : diffuse la transition en websocket, sur le
    // même bus Socket.IO déjà utilisé pour "system"/"processes"/"event" —
    // aucun second canal temps réel. Même choix que pour "timeline_event" :
    // pas de filtrage par permission au niveau du socket ; le frontend ne
    // s'abonne à ces événements que depuis la vue Dashboard, elle-même
    // masquée par can("system") côté client comme le reste des onglets.
    if (alert.state === "active" && alert.triggeredAt === alert.lastSeenAt) {
      io.emit("alert.triggered", alert);
    } else if (alert.state === "resolved") {
      io.emit("alert.resolved", alert);
    }

    // Auto-Healing (Phase 7) : même transition d'alerte que ci-dessus, source
    // supplémentaire indépendante des notifications (voir lib/services/auto-healing/).
    // AutoHealingService.trigger() est un no-op si Auto-Healing est désactivé
    // (défaut), donc sans effet tant qu'une activation explicite n'a pas eu lieu.
    if (alert.state === "active" || alert.state === "resolved") {
      Promise.resolve(feedFromAlertTransition(autoHealing, alert)).catch((e) => {
        console.error("Erreur Auto-Healing :", e.message);
      });
    }

    // Incidents (Phase 14) : indépendant de notificationsDispatchEnabled — la
    // corrélation d'incidents doit avoir lieu même si l'envoi de
    // notifications est désactivé (debug, incident fournisseur). Ne lance
    // jamais (voir lib/services/incidents/index.js#handleAlertTransition).
    Promise.resolve(handleIncidentAlertTransition(alert)).catch((e) => {
      console.error("Erreur de corrélation d'incident :", e.message);
    });
  };
}

module.exports = { createDispatchAlertTransition };
