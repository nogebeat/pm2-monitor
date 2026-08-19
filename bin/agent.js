#!/usr/bin/env node
"use strict";

/**
 * bin/agent.js — Agent distant (Phase 10 — Multi-server / Remote PM2).
 *
 * Léger volontairement : contrairement à server.js, ce script n'ouvre
 * AUCUNE connexion base de données et ne démarre AUCUN serveur Express. Il
 * réutilise uniquement lib/system-stats.js (snapshot système, déjà sans
 * dépendance DB) et lib/pm2-actions.js (actions PM2 déjà découplées de la
 * DB/de l'auth HTTP) — pas lib/process-helpers.js, dont le require()
 * entraînerait lib/auth.js (express-session) et lib/services/audit
 * (lib/db, donc un driver SQLite/MySQL) : un agent tournant sur un hôte
 * distant n'a ni besoin ni vocation à ouvrir une connexion à la base de
 * données du serveur central. `fmtProcess` est donc dupliqué ici en une
 * poignée de lignes plutôt que d'importer tout le module pour ça.
 *
 * Usage :
 *   PM2_MONITOR_HUB_URL=https://monitor.example.com \
 *   PM2_MONITOR_SERVER_KEY=srv_xxxxxxxx \
 *   PM2_MONITOR_AGENT_TOKEN=xxxxxxxx \
 *   node bin/agent.js
 *
 * Variables reconnues :
 *   PM2_MONITOR_HUB_URL      (requis) URL du serveur central (ex: https://monitor.example.com)
 *   PM2_MONITOR_SERVER_KEY   (requis) identifiant de ce serveur, fourni à l'enregistrement (POST /api/servers)
 *   PM2_MONITOR_AGENT_TOKEN  (requis) token d'agent, fourni UNE FOIS à l'enregistrement/régénération
 *   PM2_MONITOR_AGENT_NAME   (optionnel) nom affiché dans les logs de l'agent
 *   AGENT_HEARTBEAT_INTERVAL_MS / AGENT_HEARTBEAT_TIMEOUT_MS / AGENT_ACTION_ACK_TIMEOUT_MS
 *     -> voir lib/services/servers/protocol.js (partagées avec le hub, mêmes valeurs par défaut)
 *
 * Voir docs/multi-server/README.md#installation-agent pour la procédure complète.
 */

const os = require("os");
const path = require("path");
const pm2 = require("pm2");
const { io } = require("socket.io-client");

const systemStats = require(path.join(__dirname, "..", "lib", "system-stats"));
const pm2Actions = require(path.join(__dirname, "..", "lib", "pm2-actions"));
const protocol = require(path.join(__dirname, "..", "lib", "services", "servers", "protocol"));

const HUB_URL = process.env.PM2_MONITOR_HUB_URL;
const SERVER_KEY = process.env.PM2_MONITOR_SERVER_KEY;
const TOKEN = process.env.PM2_MONITOR_AGENT_TOKEN;
const AGENT_NAME = process.env.PM2_MONITOR_AGENT_NAME || os.hostname();

// eslint-disable-next-line global-require
const AGENT_VERSION = require(path.join(__dirname, "..", "package.json")).version;

if (!HUB_URL || !SERVER_KEY || !TOKEN) {
  console.error(
    "Configuration manquante : PM2_MONITOR_HUB_URL, PM2_MONITOR_SERVER_KEY et PM2_MONITOR_AGENT_TOKEN sont requis.",
  );
  process.exit(1);
}

/** Équivalent minimal de lib/process-helpers.js#fmtProcess, sans les dépendances DB/auth de ce module. */
function fmtProcess(p) {
  const env = p.pm2_env || {};
  return {
    id: p.pm_id,
    name: p.name,
    pid: p.pid,
    status: env.status,
    restarts: env.restart_time || 0,
    uptime: env.pm_uptime || null,
    createdAt: env.created_at || null,
    cpu: p.monit ? p.monit.cpu : 0,
    memory: p.monit ? p.monit.memory : 0,
    instances: env.instances || 1,
    execMode: env.exec_mode || "",
    version: env.version || "",
    watching: !!env.watch,
    script: env.pm_exec_path || "",
    args: env.args || [],
    cwd: env.pm_cwd || "",
    env: env.env || {},
  };
}

function listProcesses() {
  return new Promise((resolve) => {
    pm2.list((err, list) => {
      if (err) return resolve([]);
      resolve(list.map(fmtProcess));
    });
  });
}

function withPm2Connected(cb) {
  pm2.connect((err) => {
    if (err) {
      console.error("Impossible de se connecter au daemon PM2 local :", err.message);
      process.exit(1);
    }
    cb();
  });
}

function identity() {
  return {
    hostname: os.hostname(),
    name: AGENT_NAME,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    agentVersion: AGENT_VERSION,
  };
}

async function buildSnapshot() {
  return systemStats.snapshot();
}

// --- Connexion au hub (namespace /agent, lib/realtime/agent-hub.js) ------

const socket = io(`${HUB_URL.replace(/\/$/, "")}/agent`, {
  auth: {
    serverKey: SERVER_KEY,
    token: TOKEN,
    protocolVersion: protocol.PROTOCOL_VERSION,
  },
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
});

let heartbeatTimer = null;
let pm2Bus = null;

function log(...args) {
  console.log(`[agent:${SERVER_KEY}]`, ...args);
}

socket.on("connect", async () => {
  log(`Connecté au hub (${HUB_URL}).`);
  const processes = await listProcesses();
  const snapshot = await buildSnapshot();
  socket.emit(
    "register",
    { ...identity(), snapshot, processes },
    (ack) => {
      if (!ack || !ack.ok) {
        console.error("Enregistrement refusé par le hub :", ack && ack.error);
      } else {
        log("Enregistrement accepté, protocole", ack.protocolVersion);
      }
    },
  );
  startHeartbeat();
});

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    const [processes, snapshot] = await Promise.all([listProcesses(), buildSnapshot()]);
    socket.emit("heartbeat", { agentVersion: AGENT_VERSION, snapshot, processes }, (ack) => {
      if (!ack || !ack.ok) {
        console.error("Heartbeat refusé par le hub :", ack && ack.error);
      }
    });
  }, protocol.HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

socket.on("disconnect", (reason) => {
  log(`Déconnecté du hub (${reason}). Reconnexion automatique en cours…`);
  stopHeartbeat();
});

socket.on("connect_error", (err) => {
  console.error("Erreur de connexion au hub :", err.message);
});

// --- Actions distantes ------------------------------------------------
// Défense en profondeur : même liste blanche que côté hub
// (lib/services/servers/protocol.js#REMOTE_ACTIONS) — même si le hub était
// compromis, l'agent refuse toute action hors de cette liste, et n'exécute
// jamais de commande arbitraire (uniquement les actions PM2 nommées
// ci-dessous, jamais de shell).
socket.on("action", async ({ action, processName } = {}, ack) => {
  const reply = typeof ack === "function" ? ack : () => {};
  if (!protocol.REMOTE_ACTIONS.includes(action)) {
    return reply({ ok: false, error: `Action non autorisée : "${action}".` });
  }
  if (!processName) {
    return reply({ ok: false, error: "Nom de process manquant." });
  }
  try {
    if (action === "start") {
      await new Promise((resolve, reject) => pm2.start(processName, (err) => (err ? reject(err) : resolve())));
    } else if (action === "stop") {
      await new Promise((resolve, reject) => pm2.stop(processName, (err) => (err ? reject(err) : resolve())));
    } else if (action === "restart") {
      await pm2Actions.restart(pm2, processName);
    } else if (action === "reload") {
      await pm2Actions.reload(pm2, processName);
    }
    reply({ ok: true });
  } catch (e) {
    reply({ ok: false, error: e.message });
  }
});

// --- Relais logs + événements PM2 (bus local, même modèle que lib/realtime/pm2-bus.js) ---

function attachPm2Bus() {
  pm2.launchBus((err, bus) => {
    if (err) {
      console.error("Impossible d'ouvrir le bus de logs PM2 local :", err.message);
      return;
    }
    pm2Bus = bus;

    bus.on("log:out", (packet) => {
      socket.emit("log", {
        type: "out",
        process: packet.process.name,
        pm_id: packet.process.pm_id,
        data: packet.data,
        at: Date.now(),
      });
    });

    bus.on("log:err", (packet) => {
      socket.emit("log", {
        type: "err",
        process: packet.process.name,
        pm_id: packet.process.pm_id,
        data: packet.data,
        at: Date.now(),
      });
    });

    bus.on("process:event", (packet) => {
      socket.emit("process:event", {
        event: packet.event,
        process: packet.process.name,
        pm_id: packet.process.pm_id,
        at: Date.now(),
      });
    });
  });
}

withPm2Connected(() => {
  attachPm2Bus();
});

function shutdown() {
  log("Arrêt de l'agent…");
  stopHeartbeat();
  if (pm2Bus) {
    try {
      pm2Bus.close();
    } catch (e) {
      /* déjà fermé */
    }
  }
  socket.close();
  pm2.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
