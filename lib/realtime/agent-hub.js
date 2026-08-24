"use strict";

/**
 * lib/realtime/agent-hub.js — Phase 10 (Multi-server / Remote PM2).
 *
 * Implémente le namespace Socket.IO `/agent` : c'est le seul point d'entrée
 * réseau utilisé par un agent distant (bin/agent.js) pour parler au serveur
 * central. Volontairement séparé du namespace principal (`io`, utilisé par
 * le frontend — voir lib/realtime/process-socket.js) : deux populations de
 * clients complètement différentes (navigateurs authentifiés par cookie de
 * session vs agents authentifiés par token), avec des règles d'auth propres
 * à chacune. Comme /agent est un *namespace* et non le socket racine,
 * `io.use()` (middleware de session, voir server.js) ne s'applique pas ici :
 * les connexions agent ne portent jamais de cookie de session.
 *
 * Un seul socket actif par `serverKey` à la fois (voir `sockets`, Map) : si
 * un agent se reconnecte (redémarrage, ré-authentification) pendant qu'une
 * ancienne connexion existe encore, l'ancienne est fermée — pas de connexion
 * fantôme qui continuerait à compter comme "ONLINE" après un redémarrage de
 * l'agent.
 */

const store = require("../services/servers/store");
const protocol = require("../services/servers/protocol");
const { recordEvent, ACTIONS } = require("../services/audit");

/**
 * @param {import("socket.io").Server} io
 * @param {object} [callbacks]
 * @param {(serverKey: string, snapshot: object|null, processes: object[]) => void} [callbacks.onSnapshot]
 *   Appelé à chaque heartbeat avec un nouveau snapshot système + liste de process de l'agent.
 * @param {(serverKey: string, payload: object) => void} [callbacks.onProcessEvent]
 *   Événement PM2 (start/stop/restart/exit…) relayé par l'agent.
 * @param {(serverKey: string, payload: object) => void} [callbacks.onLog]
 *   Ligne de log relayée par l'agent.
 * @param {(serverKey: string, status: "ONLINE"|"OFFLINE") => void} [callbacks.onStatusChange]
 */
function attachAgentHub(io, { onSnapshot, onProcessEvent, onLog, onStatusChange } = {}) {
  const nsp = io.of("/agent");
  /** serverKey -> socket actuellement connecté (au plus un par serveur). */
  const sockets = new Map();

  // --- Authentification -----------------------------------------------
  // Le token n'est JAMAIS transmis en clair côté serveur (voir store.js) :
  // seul son hash bcrypt est stocké, comparé ici via verifyAgentToken().
  nsp.use(async (socket, next) => {
    const auth = socket.handshake.auth || {};
    const { serverKey, token, protocolVersion } = auth;
    if (!serverKey || !token) {
      return next(new Error("Authentification agent requise (serverKey/token manquants)."));
    }
    if (protocol.protocolMajor(protocolVersion) !== protocol.protocolMajor(protocol.PROTOCOL_VERSION)) {
      return next(
        new Error(
          `Version de protocole incompatible (agent: ${protocolVersion || "?"}, serveur: ${protocol.PROTOCOL_VERSION}).`,
        ),
      );
    }
    try {
      const server = await store.verifyAgentToken(serverKey, token);
      if (!server) {
        return next(new Error("Identifiants agent invalides, ou serveur désactivé/inconnu."));
      }
      socket.serverKey = serverKey;
      socket.agentProtocolVersion = protocolVersion;
      next();
    } catch (e) {
      next(new Error("Erreur d'authentification agent."));
    }
  });

  nsp.on("connection", (socket) => {
    const { serverKey } = socket;

    // Connexion en double (ex: l'agent a redémarré avant que l'ancien socket
    // n'ait été détecté déconnecté par le serveur) : on ferme l'ancienne.
    const previous = sockets.get(serverKey);
    if (previous && previous.id !== socket.id) {
      previous.removeAllListeners("disconnect");
      previous.disconnect(true);
    }
    sockets.set(serverKey, socket);

    async function markOnline(payload) {
      await store.touchStatus(serverKey, {
        status: "ONLINE",
        agentVersion: payload && payload.agentVersion,
        protocolVersion: socket.agentProtocolVersion,
        snapshot: (payload && payload.snapshot) || undefined,
        // Phase 15 — Prometheus : persiste le dernier snapshot process reçu
        // (même trajet que `snapshot` juste au-dessus), voir
        // lib/services/servers/store.js#touchStatus et migration 017.
        processes: (payload && payload.processes) || undefined,
      });
      if (onStatusChange) onStatusChange(serverKey, "ONLINE");
    }

    // Premier message envoyé par l'agent juste après connexion : identité
    // (OS/Node/PM2/hostname…) + premier snapshot. Distinct de "heartbeat"
    // uniquement pour permettre au serveur de logger une vraie prise de
    // contact (voir docs/multi-server/README.md#communication) — le
    // traitement est le même (touchStatus ONLINE).
    socket.on("register", (payload = {}, ack) => {
      markOnline(payload)
        .then(() => {
          if (onSnapshot && payload.snapshot) {
            onSnapshot(serverKey, payload.snapshot, payload.processes || []);
          }
          if (typeof ack === "function") {
            ack({ ok: true, protocolVersion: protocol.PROTOCOL_VERSION });
          }
        })
        .catch((e) => {
          if (typeof ack === "function") ack({ ok: false, error: e.message });
        });
    });

    socket.on("heartbeat", (payload = {}, ack) => {
      markOnline(payload)
        .then(() => {
          if (onSnapshot) onSnapshot(serverKey, payload.snapshot || null, payload.processes || []);
          if (typeof ack === "function") ack({ ok: true });
        })
        .catch((e) => {
          if (typeof ack === "function") ack({ ok: false, error: e.message });
        });
    });

    // Événement PM2 (start/stop/restart/exit/crash…) relayé tel quel par
    // l'agent — même packet.event que lib/realtime/pm2-bus.js#bus.on("process:event"),
    // pour pouvoir réutiliser la même normalisation côté timeline (EventsService).
    socket.on("process:event", (payload = {}) => {
      if (onProcessEvent) onProcessEvent(serverKey, payload);
    });

    // Ligne de log (stdout/stderr) relayée par l'agent.
    socket.on("log", (payload = {}) => {
      if (onLog) onLog(serverKey, payload);
    });

    socket.on("disconnect", () => {
      if (sockets.get(serverKey) !== socket) return; // déjà remplacé par une reconnexion plus récente
      sockets.delete(serverKey);
      store.touchStatus(serverKey, { status: "OFFLINE" }).catch((e) => {
        console.error(`Erreur de mise à jour du statut OFFLINE pour "${serverKey}" :`, e.message);
      });
      if (onStatusChange) onStatusChange(serverKey, "OFFLINE");
    });
  });

  // --- Balayage périodique des serveurs "morts" (agent qui n'a pas fermé
  // proprement la connexion : coupure réseau, process tué brutalement…) ---
  let staleSweepTimer = null;
  function startStaleSweep(intervalMs = protocol.STALE_SWEEP_INTERVAL_MS) {
    if (staleSweepTimer) return;
    staleSweepTimer = setInterval(() => {
      store.markStaleOffline(protocol.HEARTBEAT_TIMEOUT_MS).catch((e) => {
        console.error("Erreur du balayage OFFLINE périodique :", e.message);
      });
    }, intervalMs);
    if (staleSweepTimer.unref) staleSweepTimer.unref();
  }
  function stopStaleSweep() {
    if (staleSweepTimer) clearInterval(staleSweepTimer);
    staleSweepTimer = null;
  }

  /** Un agent est considéré ONLINE au sens du hub s'il a une connexion socket active. */
  function isOnline(serverKey) {
    return sockets.has(serverKey);
  }

  /**
   * Relaie une action PM2 (start/stop/restart/reload) vers l'agent d'un
   * serveur distant, et attend son accusé de réception (ack Socket.IO).
   * Rejette après ACTION_ACK_TIMEOUT_MS si l'agent ne répond pas (bloqué,
   * réseau perdu sans que la déconnexion ait encore été détectée…).
   *
   * Trace systématiquement l'action dans l'audit (succès/échec), quelle que
   * soit son issue — action distante = action sensible (voir prompt maître,
   * section Sécurité : "les actions sensibles doivent respecter les
   * permissions et l'audit existants").
   */
  function sendRemoteAction(serverKey, action, processName, { user, ip } = {}) {
    if (!protocol.REMOTE_ACTIONS.includes(action)) {
      return Promise.reject(new Error(`Action distante non autorisée : "${action}".`));
    }
    const socket = sockets.get(serverKey);
    if (!socket) {
      return Promise.reject(new Error("Agent hors ligne : impossible d'envoyer l'action."));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        recordEvent({
          user,
          action: ACTIONS.SERVER_REMOTE_ACTION,
          target: serverKey,
          targetType: "server",
          status: "failed",
          ip,
          metadata: { action, processName, error: "timeout" },
        });
        reject(new Error("Délai dépassé en attendant l'accusé de réception de l'agent."));
      }, protocol.ACTION_ACK_TIMEOUT_MS);
      if (timer.unref) timer.unref();

      socket.emit("action", { action, processName }, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const ok = !!(response && response.ok);
        recordEvent({
          user,
          action: ACTIONS.SERVER_REMOTE_ACTION,
          target: serverKey,
          targetType: "server",
          status: ok ? "success" : "failed",
          ip,
          metadata: { action, processName, error: ok ? undefined : response && response.error },
        });
        if (ok) resolve(response);
        else reject(new Error((response && response.error) || "Échec de l'action distante."));
      });
    });
  }

  return { isOnline, sendRemoteAction, startStaleSweep, stopStaleSweep, sockets };
}

module.exports = { attachAgentHub };
