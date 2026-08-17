"use strict";

/**
 * lib/realtime/process-socket.js — extrait de server.js.
 *
 * Un setInterval par client connecté (nettoyé à la déconnexion), qui pousse
 * la liste des process visibles par l'utilisateur de la session. Indépendant
 * de la boucle de polling "process" utilisée pour les alertes/l'historique
 * (voir lib/polling.js), qui elle tourne même sans client connecté.
 */

const pm2 = require("pm2");
const auth = require("../auth");
const userStore = require("../user-store");
const { fmtProcess, visibleProcesses } = require("../process-helpers");

/** @param {import("socket.io").Server} io */
function attachProcessSocket(io) {
  io.on("connection", (socket) => {
    const sessUserId = auth.AUTH_ENABLED ? socket.request.session && socket.request.session.userId : 0;

    const interval = setInterval(() => {
      pm2.list(async (err, list) => {
        if (err) return;
        let user = null;
        if (auth.AUTH_ENABLED) {
          user = sessUserId ? await userStore.getUserWithPermissions(sessUserId) : null;
        }
        const visible = visibleProcesses(user, list.map(fmtProcess));
        socket.emit("processes", visible);
        // Dashboard global (Phase 8) : même donnée, alias d'événement dédié
        // (voir docs/dashboard/README.md#temps-réel) — "processes" reste
        // inchangé pour ne pas toucher les vues existantes.
        socket.emit("process.updated", visible);
      });
    }, 1500);

    socket.on("disconnect", () => clearInterval(interval));
  });
}

module.exports = { attachProcessSocket };
