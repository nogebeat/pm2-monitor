"use strict";

/**
 * lib/realtime/pm2-bus.js — extrait de server.js.
 *
 * Se connecte à PM2, ouvre son bus de logs/événements, et ne fait démarrer
 * `server.listen()` qu'une fois ce bus ouvert (dernière étape de la séquence
 * de démarrage dans server.js : DB -> migrations -> admin bootstrap -> bus PM2).
 *
 * Un seul bus de logs partagé, diffusé à tous les clients connectés (le
 * filtrage par permission "logs" sur une app précise se fait déjà côté REST
 * pour l'historique/export ; en direct, le frontend n'affiche que les logs
 * de l'app sélectionnée, elle-même filtrée par la liste de process visible).
 */

const pm2 = require("pm2");
const { withPm2 } = require("../process-helpers");
const { feedFromPm2Event } = require("../services/auto-healing");

/**
 * @param {object} deps
 * @param {import("socket.io").Server} deps.io
 * @param {import("http").Server} deps.server
 * @param {number|string} deps.port
 * @param {import("../log-store").LogStore} deps.logStore
 * @param {import("../services/events").EventsService} deps.eventsService
 * @param {object} deps.autoHealing - instance AutoHealingService
 * @returns {() => void} startPm2Bus, à appeler pour lancer la connexion + le serveur HTTP
 */
function createPm2Bus({ io, server, port, logStore, eventsService, autoHealing }) {
  return function startPm2Bus() {
    withPm2((err) => {
      if (err) {
        console.error("Impossible de se connecter à PM2 :", err.message);
        process.exit(1);
      }

      pm2.launchBus((err, bus) => {
        if (err) {
          console.error("Impossible d'ouvrir le bus de logs PM2 :", err.message);
          return;
        }

        bus.on("log:out", (packet) => {
          const at = Date.now();
          logStore.appendPacket(packet.process.pm_id, packet.process.name, "out", packet.data, at);
          io.emit("log", {
            type: "out",
            process: packet.process.name,
            pm_id: packet.process.pm_id,
            data: packet.data,
            at,
          });
        });

        bus.on("log:err", (packet) => {
          const at = Date.now();
          logStore.appendPacket(packet.process.pm_id, packet.process.name, "err", packet.data, at);
          io.emit("log", {
            type: "err",
            process: packet.process.name,
            pm_id: packet.process.pm_id,
            data: packet.data,
            at,
          });
        });

        bus.on("process:event", (packet) => {
          io.emit("event", {
            event: packet.event,
            process: packet.process.name,
            pm_id: packet.process.pm_id,
            at: Date.now(),
          });

          // Timeline d'événements/crashs (lib/services/events/) : même packet,
          // pas de second listener PM2 (voir startPm2Bus). Normalise puis
          // persiste ; ne fait rien si le packet ne correspond à aucun type
          // retenu (ex: "delete") ou si le service est désactivé (voir
          // normalizer.js#resolveType et EventsService#recordFromPacket).
          eventsService
            .recordFromPacket(packet)
            .then((stored) => {
              if (stored) {
                io.emit("timeline_event", stored);
                // Dashboard global (Phase 8) : alias dédié, même donnée — voir
                // le commentaire sur "metrics.updated"/"process.updated" ci-dessus.
                io.emit("event.created", stored);
              }
            })
            .catch((e) => {
              console.error("Erreur d'enregistrement dans la timeline d'événements :", e.message);
            });

          // Auto-Healing (Phase 7) : même packet "process:event", pas de second
          // listener PM2 (voir le commentaire au-dessus pour eventsService).
          // feedFromPm2Event() ignore tout ce qui n'est pas "exit" et
          // AutoHealingService.trigger() est un no-op si désactivé (défaut).
          Promise.resolve(feedFromPm2Event(autoHealing, packet)).catch((e) => {
            console.error("Erreur Auto-Healing (événement PM2) :", e.message);
          });
        });
      });

      server.listen(port, () => {
        console.log(`PM2 Monitor disponible sur http://localhost:${port}`);
      });
    });
  };
}

module.exports = { createPm2Bus };
