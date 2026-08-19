"use strict";

/**
 * Constantes du protocole agent <-> serveur central (Phase 10). Partagées
 * entre lib/realtime/agent-hub.js (côté serveur) et agent/lib/agent.js
 * (côté agent) pour éviter toute divergence de valeur "magique" entre les
 * deux bouts de la connexion.
 *
 * PROTOCOL_VERSION : version majeure du protocole (namespace Socket.IO,
 * forme des payloads register/heartbeat/action). Un agent dont la version
 * majeure diffère de celle du serveur est refusé à la connexion (voir
 * agent-hub.js) plutôt que de risquer un payload mal interprété.
 */
const PROTOCOL_VERSION = "1.0";

function protocolMajor(version) {
  return String(version || "").split(".")[0];
}

const HEARTBEAT_INTERVAL_MS = Number(process.env.AGENT_HEARTBEAT_INTERVAL_MS) || 10000;
// Un serveur passe OFFLINE si aucun heartbeat reçu depuis ce délai — laisse
// une marge de plusieurs heartbeats manqués avant de conclure à une panne
// réseau plutôt qu'à un simple ralentissement ponctuel.
const HEARTBEAT_TIMEOUT_MS = Number(process.env.AGENT_HEARTBEAT_TIMEOUT_MS) || HEARTBEAT_INTERVAL_MS * 3;
// Intervalle du balayage périodique qui bascule OFFLINE les serveurs dont le
// heartbeat a expiré (voir lib/realtime/agent-hub.js#startStaleSweep).
const STALE_SWEEP_INTERVAL_MS = Number(process.env.AGENT_STALE_SWEEP_INTERVAL_MS) || 5000;
// Délai d'attente d'un acquittement d'action distante (start/stop/restart…)
// avant de considérer la commande comme perdue (agent injoignable/bloqué).
const ACTION_ACK_TIMEOUT_MS = Number(process.env.AGENT_ACTION_ACK_TIMEOUT_MS) || 15000;

// Actions PM2 qu'un agent est autorisé à exécuter à la demande du serveur
// central (voir agent/lib/agent.js#ALLOWED_ACTIONS, qui applique la même
// liste côté agent — défense en profondeur : même si le serveur central
// était compromis, l'agent refuse toute action hors de cette liste).
const REMOTE_ACTIONS = ["start", "stop", "restart", "reload"];

module.exports = {
  PROTOCOL_VERSION,
  protocolMajor,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  STALE_SWEEP_INTERVAL_MS,
  ACTION_ACK_TIMEOUT_MS,
  REMOTE_ACTIONS,
};
