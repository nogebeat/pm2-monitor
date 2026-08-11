import { reactive } from "vue";
import { socket } from "./socket";
import { apiGet, apiPost } from "./api";

const MAX_LOG_LINES = 4000;
const MAX_CPU_HISTORY = 20;

export const state = reactive({
  connected: false,
  view: "process", // "process" | "system"

  // ---------- Auth / permissions ----------
  auth: {
    ready: false, // /api/auth/me a répondu au moins une fois
    authEnabled: true,
    user: null, // { id, username, isAdmin, permissions: [{appName, action}] }
    loginError: null,
    loggingIn: false,
  },

  processes: [],
  selected: null, // pm_id
  cpuHistory: {}, // pm_id -> [cpu%,…] mini sparkline
  errCounts: {}, // pm_id -> erreurs non vues

  logs: [], // { id, type, data, at, level }
  logCounter: 0,
  filter: "all", // all | out | err
  levelFilter: "all",
  search: "",
  regexMode: false,
  ansiOn: true,
  lineNumOn: false,
  autoscroll: true,
  paused: false,
  pausedQueue: [],
  logsStats: null,

  system: null,
  historyRange: "1h",

  pm2MenuOpen: false,
  toast: null, // { kind: "error"|"info", message }

  // Modale générique : { type: "more"|"scale"|"env"|"config"|"fulltext"|"gotodate"|"exportrange", process }
  modal: null,
});

function detectLevel(text) {
  const t = text.toLowerCase();
  if (/\berror\b|\bexception\b|\bfatal\b/.test(t)) return "error";
  if (/\bwarn(ing)?\b/.test(t)) return "warn";
  if (/\bdebug\b/.test(t)) return "debug";
  return "info";
}

export function notifyError(err) {
  state.toast = { kind: "error", message: err && err.message ? err.message : String(err) };
  setTimeout(() => {
    if (state.toast && state.toast.message === (err && err.message ? err.message : String(err))) {
      state.toast = null;
    }
  }, 5000);
}

// ---------- Auth / permissions ----------

/**
 * Réplique côté client la logique de lib/permissions.js (hasPermission), pour
 * afficher/masquer les boutons d'action. La vérité vient toujours du serveur :
 * ceci n'est qu'un confort d'UI, chaque requête est de toute façon revalidée côté API.
 */
export function can(action, appName) {
  const user = state.auth.user;
  if (!state.auth.authEnabled) return true;
  if (!user) return false;
  if (user.isAdmin) return true;
  if (!Array.isArray(user.permissions)) return false;
  return user.permissions.some((p) => {
    if (p.action !== "*" && p.action !== action) return false;
    if (appName === undefined || appName === null) return true; // action globale
    return p.appName === "*" || p.appName === appName;
  });
}

export function fetchMe() {
  return apiGet("/api/auth/me")
    .then((r) => {
      state.auth.authEnabled = r.authEnabled;
      state.auth.user = r.user;
    })
    .catch(() => {
      state.auth.user = null;
    })
    .finally(() => {
      state.auth.ready = true;
    });
}

export function login(username, password) {
  state.auth.loggingIn = true;
  state.auth.loginError = null;
  return apiPost("/api/auth/login", { username, password })
    .then(() => fetchMe())
    .then(() => bootstrap())
    .catch((err) => {
      state.auth.loginError = err.message || "Connexion impossible.";
    })
    .finally(() => {
      state.auth.loggingIn = false;
    });
}

export function logout() {
  return fetch("/api/auth/logout", { method: "POST" }).finally(() => {
    state.auth.user = null;
    state.processes = [];
    state.selected = null;
  });
}

// ---------- Process ----------

export function selectProcess(id) {
  state.selected = id;
  state.errCounts[id] = 0;
  state.logs = [];
  state.logCounter = 0;
  state.paused = false;
  state.pausedQueue = [];
  loadLogsStats();
  loadBacklog(id);
}

// Charge les dernières lignes déjà écrites dans les fichiers de log natifs PM2
// (comme le ferait `pm2 logs`), affichées immédiatement au lieu d'attendre une
// nouvelle ligne en direct — évite l'impression de "aucun log" sur une app calme.
export function loadBacklog(id) {
  apiGet(`/api/processes/${id}/logs/tail?lines=200`)
    .then((r) => {
      if (state.selected !== id) return; // l'utilisateur a changé de sélection entretemps
      r.results.forEach((row) => {
        pushLog({
          kind: "log",
          type: row.type,
          data: row.text,
          at: null, // pas d'horodatage exact disponible pour l'historique natif PM2
          level: detectLevel(row.text),
          backlog: true,
        });
      });
      if (r.results.length) {
        pushLog({ kind: "event", event: "flux en direct ci-dessous", at: Date.now() });
      }
    })
    .catch(() => {
      /* pas grave : on retombe simplement sur le flux en direct */
    });
}

export function selectedProcess() {
  return state.processes.find((p) => p.id === state.selected) || null;
}

export function runProcessAction(id, action) {
  return fetch(`/api/processes/${id}/${action}`, { method: "POST" }).catch(() => {});
}

export function runGlobalAction(action) {
  const routes = {
    save: { url: "/api/pm2/save", confirm: null },
    resurrect: { url: "/api/pm2/resurrect", confirm: null },
    "flush-all": { url: "/api/pm2/flush-all", confirm: "Vider TOUS les logs de TOUS les process ?" },
    update: { url: "/api/pm2/update", confirm: "Mettre à jour le daemon PM2 (pm2 update) ?" },
    kill: {
      url: "/api/pm2/kill",
      confirm: "⚠️ Ceci va tuer le daemon PM2. Les apps managées perdront leur supervision. Continuer ?",
    },
  };
  const r = routes[action];
  if (!r) return;
  if (r.confirm && !confirm(r.confirm)) return;
  apiPost(r.url).catch(notifyError);
}

export function loadLogsStats() {
  if (state.selected === null) return;
  apiGet(`/api/processes/${state.selected}/logs/stats`)
    .then((s) => {
      state.logsStats = s;
    })
    .catch(() => {
      state.logsStats = null;
    });
}

// ---------- Logs ----------

function passesFilters(entry) {
  if (state.filter !== "all" && state.filter !== entry.type) return false;
  if (state.levelFilter !== "all" && entry.level && state.levelFilter !== entry.level) return false;
  if (state.search) {
    if (state.regexMode) {
      try {
        const re = new RegExp(state.search, "i");
        if (!re.test(entry.data)) return false;
      } catch (e) {
        /* regex invalide : on n'exclut rien */
      }
    } else if (!entry.data.toLowerCase().includes(state.search)) {
      return false;
    }
  }
  return true;
}

function pushLog(entry) {
  state.logCounter++;
  state.logs.push({ ...entry, n: state.logCounter });
  if (state.logs.length > MAX_LOG_LINES) {
    state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
  }
}

export function togglePause() {
  state.paused = !state.paused;
  if (!state.paused) {
    state.pausedQueue.forEach((entry) => {
      if (passesFilters(entry)) pushLog(entry);
    });
    state.pausedQueue = [];
  }
}

export function clearLogs() {
  state.logs = [];
  state.logCounter = 0;
}

export function visibleLogs() {
  if (!state.search) return state.logs;
  const q = state.regexMode ? state.search : state.search.toLowerCase();
  return state.logs.filter((entry) => {
    if (entry.kind === "event") return true;
    if (state.regexMode) {
      try {
        return new RegExp(q, "i").test(entry.data);
      } catch (e) {
        return true;
      }
    }
    return entry.data.toLowerCase().includes(q);
  });
}

// ---------- Historique CPU/RAM (vue système) ----------

export function loadHistoryChart(range) {
  return apiGet(`/api/system/history?range=${range}`);
}

// ---------- Historique par process (onglet "Metrics" d'une carte) ----------

const PROCESS_RANGE_MS = {
  "1h": 3600 * 1000,
  "6h": 6 * 3600 * 1000,
  "24h": 24 * 3600 * 1000,
  "7d": 7 * 24 * 3600 * 1000,
  "30d": 30 * 24 * 3600 * 1000,
};

export function loadProcessMetrics(processId, range) {
  const end = Date.now();
  const start = end - (PROCESS_RANGE_MS[range] || PROCESS_RANGE_MS["1h"]);
  return apiGet(`/api/processes/${processId}/metrics?start=${start}&end=${end}`);
}

// ---------- Câblage WebSocket ----------

socket.on("connect", () => {
  state.connected = true;
});

socket.on("disconnect", () => {
  state.connected = false;
});

socket.on("processes", (list) => {
  state.processes = list;
  list.forEach((p) => {
    if (!state.cpuHistory[p.id]) state.cpuHistory[p.id] = [];
    state.cpuHistory[p.id].push(p.cpu);
    if (state.cpuHistory[p.id].length > MAX_CPU_HISTORY) state.cpuHistory[p.id].shift();
  });
});

socket.on("log", (entry) => {
  const p = state.processes.find((x) => x.id === entry.pm_id);
  if (!p) return;

  if (entry.type === "err" && state.selected !== entry.pm_id) {
    state.errCounts[entry.pm_id] = (state.errCounts[entry.pm_id] || 0) + 1;
  }

  if (state.selected !== entry.pm_id) return;

  const full = { ...entry, kind: "log", level: detectLevel(entry.data) };

  if (state.paused) {
    state.pausedQueue.push(full);
    return;
  }
  if (!passesFilters(full)) return;
  pushLog(full);
});

socket.on("event", (entry) => {
  if (state.selected !== entry.pm_id) return;
  pushLog({ ...entry, kind: "event" });
});

socket.on("system", (snap) => {
  state.system = snap;
});

// ---------- Chargement initial ----------

export function bootstrap() {
  if (state.auth.authEnabled && !state.auth.user) return; // pas connecté : rien à charger

  fetch("/api/processes")
    .then((r) => r.json())
    .then((list) => {
      state.processes = list;
    })
    .catch(() => {
      state.processes = [];
      state.toast = { kind: "error", message: "Impossible de joindre le serveur." };
    });

  if (can("system")) {
    apiGet("/api/system")
      .then((snap) => {
        state.system = snap;
      })
      .catch(() => {});
  }
}
