"use strict";

/**
 * lib/polling.js — extrait de server.js.
 *
 * Deux boucles indépendantes des sockets clients (elles tournent même sans
 * personne devant le dashboard, contrairement à lib/realtime/process-socket.js) :
 *
 *  1. Boucle système, cadencée sur SAMPLE_INTERVAL_MS (lib/history-store.js) :
 *     échantillonne, alimente l'historique, diffuse en websocket, évalue les
 *     alertes "system".
 *  2. Boucle process, cadencée sur ALERTS_EVAL_INTERVAL_MS, partagée par
 *     l'évaluation des règles d'alerte "process" (CPU/RAM/restarts/statut par
 *     app) ET la collecte d'historique par process (lib/services/process-history/).
 *     Réutilise un seul pm2.list() + fmtProcess() par tick — pas de second
 *     bus PM2 ni de second poller.
 */

const pm2 = require("pm2");
const systemStats = require("./system-stats");
const { SAMPLE_INTERVAL_MS } = require("./history-store");
const { engine: alertEngine } = require("./services/alerts");
const { service: anomalyService } = require("./services/anomaly-detection");
const { fmtProcess } = require("./process-helpers");

/**
 * @param {object} deps
 * @param {import("socket.io").Server} deps.io
 * @param {import("./history-store").HistoryStore} deps.historyStore
 * @param {import("./services/process-history").ProcessHistoryService} deps.processHistory
 * @param {(alert: object) => void} deps.dispatchAlertTransition
 * @param {boolean} deps.alertsEnabled
 * @param {number} deps.alertsEvalIntervalMs
 * @param {boolean} deps.anomalyEnabled - Phase 16 : évalue en plus les règles
 *   de lib/services/anomaly-detection/ dans les deux mêmes boucles (pas de
 *   troisième poller), en réutilisant dispatchAlertTransition à l'identique.
 */
function startPolling({
  io,
  historyStore,
  processHistory,
  dispatchAlertTransition,
  alertsEnabled,
  alertsEvalIntervalMs,
  anomalyEnabled,
}) {
  // Boucle système : échantillonne + diffuse à tous les clients + alimente l'historique
  setInterval(() => {
    const snap = systemStats.snapshot();
    historyStore.push(snap);
    io.emit("system", snap);
    // Dashboard global (Phase 8) : alias dédié, même snapshot, même intervalle
    // (SAMPLE_INTERVAL_MS) — "system" reste inchangé pour ne pas toucher
    // SystemView.vue.
    io.emit("metrics.updated", snap);
    if (alertsEnabled) {
      alertEngine
        .evaluateSystemReading(snap)
        .then((results) => results.forEach(dispatchAlertTransition))
        .catch((e) => {
          console.error("Erreur d'évaluation des alertes système :", e.message);
        });
    }
    if (anomalyEnabled) {
      anomalyService
        .evaluateSystemReading(snap)
        .then((results) => results.forEach(dispatchAlertTransition))
        .catch((e) => {
          console.error("Erreur d'évaluation des anomalies système :", e.message);
        });
    }
  }, SAMPLE_INTERVAL_MS);

  // Boucle process : tourne à ALERTS_EVAL_INTERVAL_MS — c'est aussi la valeur
  // par défaut de PROCESS_HISTORY_COLLECT_INTERVAL_MS (15s), donc les deux
  // réglages restent cohérents sans config supplémentaire.
  if (alertsEnabled || anomalyEnabled || processHistory.config.enabled) {
    setInterval(() => {
      pm2.list((err, list) => {
        if (err) return; // PM2 momentanément indisponible : on retentera au prochain tick
        const processes = list.map(fmtProcess);
        if (alertsEnabled) {
          alertEngine
            .evaluateProcessReadings(processes)
            .then((results) => results.forEach(dispatchAlertTransition))
            .catch((e) => {
              console.error("Erreur d'évaluation des alertes process :", e.message);
            });
        }
        if (anomalyEnabled) {
          anomalyService
            .evaluateProcessReadings(processes)
            .then((results) => results.forEach(dispatchAlertTransition))
            .catch((e) => {
              console.error("Erreur d'évaluation des anomalies process :", e.message);
            });
        }
        if (processHistory.config.enabled) {
          // Explicite "local" : ce poller ne voit que pm2.list() de l'hôte du
          // hub. Les process d'agents distants arrivent par un autre chemin
          // (heartbeat socket, voir lib/realtime/agent-hub.js) et sont
          // enregistrés avec leur propre server_key (migration 014).
          processHistory.record(processes, Date.now(), "local").catch((e) => {
            console.error("Erreur de collecte de l'historique process :", e.message);
          });
        }
      });
    }, alertsEvalIntervalMs);
  }
}

module.exports = { startPolling };
