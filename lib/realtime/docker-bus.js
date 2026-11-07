"use strict";

/**
 * lib/realtime/docker-bus.js — Docker Monitoring (Phase 22).
 *
 * Branche Docker Monitoring sur le Socket.IO EXISTANT (même instance `io`
 * que lib/realtime/process-socket.js / lib/realtime/pm2-bus.js — pas un
 * second système temps réel, voir sections 4 et 9 du prompt maître).
 *
 * Deux mécanismes, volontairement différents l'un de l'autre (voir
 * lib/services/docker/index.js pour le pourquoi — PM2 a un bus de logs
 * passif qui streame déjà tout gratuitement, Docker n'a rien d'équivalent) :
 *
 *  - Snapshot (liste + stats) : rediffuse simplement le dernier instantané
 *    du service dès qu'il change ("docker.snapshot"), à TOUS les clients —
 *    même philosophie que "processes"/"server.snapshot"/"health.updated"
 *    (broadcast global, filtré côté client via can("docker_read"), pas de
 *    scope par ressource ici : docker_read est une permission globale, pas
 *    par conteneur — voir lib/permissions.js).
 *  - Logs : PAS de flux permanent par conteneur (contrairement au bus PM2).
 *    Un flux Docker n'est ouvert que sur abonnement explicite d'UN socket à
 *    UN conteneur, et fermé dès que l'abonné change de conteneur, se
 *    déconnecte, ou que le conteneur disparaît (section 5 du prompt maître).
 *    Contrairement au flux "log" de PM2 (jamais filtré par permission côté
 *    serveur, voir server.js#onLog), l'abonnement est ici vérifié
 *    explicitement (docker_logs) AVANT d'ouvrir le flux Docker : plus facile
 *    à faire correctement pour un abonnement à la demande que pour un
 *    broadcast déjà en place, donc pas de raison de s'en priver.
 */

const auth = require("../auth");
const userStore = require("../user-store");
const permissions = require("../permissions");
const dockerService = require("../services/docker");

/** @param {import("socket.io").Server} io */
function attachDockerBus(io) {
  const unsubscribeSnapshot = dockerService.onSnapshot((snapshot) => {
    io.emit("docker.snapshot", snapshot);
  });

  // socketId -> { containerId, handle } — un seul abonnement de logs actif
  // par socket ; s'abonner à un nouveau conteneur ferme silencieusement le
  // précédent (section 5 : "l'utilisateur sélectionne un autre conteneur").
  const subscriptions = new Map();

  async function closeSubscription(socketId) {
    const sub = subscriptions.get(socketId);
    if (!sub) return;
    subscriptions.delete(socketId);
    try {
      sub.handle.close();
    } catch (e) {
      /* déjà fermé / erreur de fermeture : sans conséquence, plus rien ne lit ce flux */
    }
  }

  function canReadLogs(socket) {
    if (!auth.AUTH_ENABLED) return Promise.resolve(true);
    const sess = socket.request.session;
    if (!sess || !sess.userId) return Promise.resolve(false);
    return userStore
      .getUserWithPermissions(sess.userId)
      .then((user) => permissions.hasPermission(user, null, "docker_logs"))
      .catch(() => false);
  }

  io.on("connection", (socket) => {
    socket.on("docker:subscribe-logs", async (payload) => {
      const containerId = payload && payload.containerId;
      if (!containerId || typeof containerId !== "string") return;

      const allowed = await canReadLogs(socket);
      if (!allowed) {
        socket.emit("docker:log-error", { containerId, error: "Action non autorisée." });
        return;
      }

      await closeSubscription(socket.id);

      try {
        const handle = await dockerService.subscribeToLogs(
          containerId,
          (line) => socket.emit("docker:log", { containerId, ...line }),
          (err) => {
            subscriptions.delete(socket.id);
            socket.emit("docker:log-error", { containerId, error: err.message });
          },
        );
        // Le socket a pu se déconnecter (ou se réabonner ailleurs) pendant
        // l'attente de subscribeToLogs() (inspect + ouverture du flux ne
        // sont pas instantanés) : si un abonnement plus récent existe déjà,
        // on ferme immédiatement celui-ci plutôt que de l'enregistrer.
        if (subscriptions.has(socket.id) || !socket.connected) {
          handle.close();
          return;
        }
        subscriptions.set(socket.id, { containerId, handle });
      } catch (e) {
        socket.emit("docker:log-error", { containerId, error: e.message });
      }
    });

    socket.on("docker:unsubscribe-logs", () => {
      closeSubscription(socket.id);
    });

    socket.on("disconnect", () => {
      closeSubscription(socket.id);
    });
  });

  return {
    stop() {
      unsubscribeSnapshot();
      for (const socketId of Array.from(subscriptions.keys())) closeSubscription(socketId);
    },
  };
}

module.exports = { attachDockerBus };
