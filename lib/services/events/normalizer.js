"use strict";

/**
 * Traduit un packet du bus PM2 `process:event` (voir server.js#startPm2Bus,
 * `bus.on("process:event", packet)`) en un événement normalisé, stockable et
 * filtrable. Fonction pure : ne dépend ni de PM2, ni d'Express, ni de la DB —
 * même approche que lib/services/alerts/collector.js — pour rester testable
 * avec de simples objets JS (voir test/unit/events-normalizer.test.js).
 *
 * --- Types supportés -------------------------------------------------------
 *
 * `started`, `stopped`, `restarted`, `online`, `crashed`, `errored` sont
 * dérivés d'événements réels du bus PM2 (`start`, `stop`, `restart`,
 * `online`, `exit`, `restart overlimit` — voir RAW_EVENT_MAP et la détection
 * de crash ci-dessous).
 *
 * `offline` fait partie du modèle standard demandé pour cette phase mais
 * n'est PAS émis par cette normalisation : le bus `process:event` de PM2 n'a
 * pas d'événement brut distinct pour "devient offline" (contrairement à
 * `online`) — un arrêt se traduit par `stop` (→ `stopped`) ou par un `exit`
 * non planifié (→ `crashed`), jamais par un événement "offline" séparé.
 * Plutôt que d'inventer un événement synthétique non fiable, `offline` reste
 * un type valide du modèle (schéma, catalogue API, filtre UI) pour rester
 * compatible avec un futur événement PM2 qui l'émettrait réellement, mais
 * n'est actuellement jamais produit. Voir docs/events/README.md
 * ("Problèmes connus") et le rapport de fin de phase.
 *
 * --- Détection de crash ------------------------------------------------
 *
 * PM2 émet un événement `exit` à chaque sortie de process, qu'elle soit
 * volontaire (stop/restart demandé) ou non (crash). On la classe en
 * `crashed` uniquement si le code de sortie est non-nul OU si le signal
 * reçu n'est pas un signal d'arrêt "propre" (SIGINT/SIGTERM, ceux utilisés
 * par PM2 pour stop/restart). Un `exit` "propre" est absorbé silencieusement
 * (déjà couvert par l'événement `stop`/`restart` correspondant, qui arrive
 * séparément) plutôt que dupliqué dans la timeline.
 *
 * `restart overlimit` (PM2 abandonne les tentatives de redémarrage après
 * `max_restarts`) est normalisé en `errored`, le type le plus proche
 * sémantiquement d'un abandon suite à échecs répétés.
 *
 * `delete` (app retirée du process manager) n'est pas un événement du cycle
 * de vie "started/stopped/crashed" et n'est pas retenu dans la timeline.
 */

const os = require("os");

const CLEAN_EXIT_SIGNALS = new Set(["SIGINT", "SIGTERM"]);

const RAW_EVENT_MAP = {
  start: "started",
  online: "online",
  stop: "stopped",
  restart: "restarted",
  "restart overlimit": "errored",
};

/** Types valides du modèle (voir commentaire ci-dessus pour "offline"). */
const EVENT_TYPES = ["started", "stopped", "restarted", "online", "offline", "crashed", "errored"];

/** Sévérité dérivée du type — mêmes valeurs que lib/services/alerts/ (info/warning/critical). */
const SEVERITY_BY_TYPE = {
  started: "info",
  stopped: "info",
  online: "info",
  restarted: "warning",
  offline: "warning",
  crashed: "critical",
  errored: "critical",
};

function toNullableInt(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** PM2 expose le code de sortie sous des clés qui ont varié selon les versions ; on couvre les deux. */
function readExitCode(proc) {
  if (proc.exit_code !== undefined) return toNullableInt(proc.exit_code);
  if (proc.exitCode !== undefined) return toNullableInt(proc.exitCode);
  return null;
}

function readSignal(proc) {
  return proc.signal || proc.kill_signal || proc.killSignal || null;
}

function resolveType(rawEvent, exitCode, signal) {
  if (Object.prototype.hasOwnProperty.call(RAW_EVENT_MAP, rawEvent)) {
    return RAW_EVENT_MAP[rawEvent];
  }
  if (rawEvent === "exit") {
    const crashed = (exitCode !== null && exitCode !== 0) || (!!signal && !CLEAN_EXIT_SIGNALS.has(signal));
    return crashed ? "crashed" : null; // exit "propre" : absorbé, voir commentaire de fichier
  }
  return null; // "delete" et tout événement PM2 inconnu : ignorés
}

/**
 * @param {object} packet - packet brut du bus PM2 : { event, process: {...pm2_env} }
 * @param {number} [receivedAt] - horodatage de réception (Date.now() par défaut). PM2 ne fournit
 *   pas d'horodatage exploitable dans le packet lui-même, donc l'heure de réception sert de référence
 *   (cohérent avec le traitement existant de "log:out"/"log:err" dans server.js, qui fait de même).
 * @param {string} [hostname] - injectable pour les tests, os.hostname() par défaut.
 * @returns {object|null} l'événement normalisé, ou null si ce packet ne doit pas être retenu.
 */
function normalizeEvent(packet, receivedAt = Date.now(), hostname = os.hostname()) {
  if (!packet || typeof packet.event !== "string" || !packet.process) return null;

  const proc = packet.process;
  const exitCode = readExitCode(proc);
  const signal = readSignal(proc);
  const type = resolveType(packet.event, exitCode, signal);
  if (!type) return null;

  return {
    timestamp: receivedAt,
    type,
    severity: SEVERITY_BY_TYPE[type] || "info",
    process: proc.name || null,
    processId: proc.pm_id !== undefined ? proc.pm_id : null,
    server: hostname,
    status: proc.status || null,
    exitCode,
    signal,
    metadata: {
      rawEvent: packet.event,
      restartCount: proc.restart_time !== undefined ? toNullableInt(proc.restart_time) : null,
      lastKnownState: proc.status || null,
      execMode: proc.exec_mode || null,
    },
  };
}

module.exports = { normalizeEvent, EVENT_TYPES, SEVERITY_BY_TYPE, RAW_EVENT_MAP, CLEAN_EXIT_SIGNALS };
