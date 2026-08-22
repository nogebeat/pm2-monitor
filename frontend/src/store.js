import { reactive } from "vue";
import { socket } from "./socket";
import { apiGet, apiPost } from "./api";

const MAX_LOG_LINES = 4000;
const MAX_CPU_HISTORY = 20;

export const state = reactive({
  connected: false,
  view: "dashboard", // "process" | "dashboard" | "system" | "events" | "servers"

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

  // ---------- Dashboard global (onglet "Dashboard", Phase 8) ----------
  dashboard: {
    loaded: false,
    loading: false,
    globalStatus: null, // "HEALTHY" | "WARNING" | "CRITICAL"
    globalStatusReasons: [],
    processesOverview: null, // { total, online, stopped, errored, crashed, restarting }
    alerts: null, // { active, critical, warning, acknowledged } | null (permission absente)
    healthChecks: null, // { up, down, degraded, unknown } | null
    recentTimeline: [],
  },

  // ---------- Timeline d'événements/crashs (onglet "Timeline") ----------
  events: {
    items: [], // { id, timestamp, type, severity, process, processId, server, status, exitCode, signal, metadata }
    filter: "all", // all | started | stopped | restarted | crashed | errored
    total: 0,
    limit: 50,
    offset: 0,
    loading: false,
    loaded: false, // au moins un chargement effectué (distingue "vide" de "pas encore chargé")
  },

  // ---------- Serveurs distants (onglet "Serveurs", Phase 10 — Multi-server / Remote PM2) ----------
  servers: {
    items: [], // [{ id, serverKey, name, hostname, environment, kind, enabled, status, agentVersion,
    //   protocolVersion, lastSeen, snapshot, processes, hasToken, createdAt, updatedAt }]
    loaded: false,
    loading: false,
  },

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

// ---------- Analytics par process (Phase 11 — stats + comparaison période précédente) ----------

export function loadProcessAnalytics(processId, range) {
  const end = Date.now();
  const start = end - (PROCESS_RANGE_MS[range] || PROCESS_RANGE_MS["1h"]);
  return apiGet(`/api/processes/${processId}/analytics?start=${start}&end=${end}`);
}

// ---------- Timeline d'événements/crashs (GET /api/events) ----------

// "All"/"Starts"/"Stops"/"Restarts"/"Crashes"/"Errors" — les filtres demandés par la spec de
// phase. "online" existe dans le modèle mais n'a pas de bouton dédié (regroupé sous "All").
const EVENTS_FILTER_TYPE = {
  all: undefined,
  started: "started",
  stopped: "stopped",
  restarted: "restarted",
  crashed: "crashed",
  errored: "errored",
};

export function loadEvents({ reset = true } = {}) {
  if (reset) {
    state.events.offset = 0;
    state.events.items = [];
  }
  state.events.loading = true;
  const type = EVENTS_FILTER_TYPE[state.events.filter];
  const params = new URLSearchParams({ limit: state.events.limit, offset: state.events.offset });
  if (type) params.set("type", type);

  return apiGet(`/api/events?${params.toString()}`)
    .then((r) => {
      state.events.items = reset ? r.items : [...state.events.items, ...r.items];
      state.events.total = r.total;
    })
    .catch((err) => {
      if (reset) state.events.items = [];
      notifyError(err);
    })
    .finally(() => {
      state.events.loading = false;
      state.events.loaded = true;
    });
}

export function setEventsFilter(filter) {
  if (state.events.filter === filter) return;
  state.events.filter = filter;
  loadEvents({ reset: true });
}

export function loadMoreEvents() {
  if (state.events.loading || state.events.items.length >= state.events.total) return;
  state.events.offset += state.events.limit;
  loadEvents({ reset: false });
}

// ---------- Dashboard global (GET /api/dashboard, Phase 8) ----------

export function loadDashboard() {
  state.dashboard.loading = true;
  return apiGet("/api/dashboard")
    .then((r) => {
      state.dashboard.globalStatus = r.globalStatus;
      state.dashboard.globalStatusReasons = r.globalStatusReasons || [];
      state.dashboard.processesOverview = r.processes.overview;
      state.dashboard.alerts = r.alerts;
      state.dashboard.healthChecks = r.healthChecks;
      state.dashboard.recentTimeline = r.recentTimeline || [];
    })
    .catch((err) => {
      notifyError(err);
    })
    .finally(() => {
      state.dashboard.loading = false;
      state.dashboard.loaded = true;
    });
}

// Réutilise le même Socket.IO que le reste de l'app (voir ./socket.js) :
// pas de second polling dédié au dashboard. Sur réception d'un des
// événements temps réel de la Phase 8, on ne recalcule rien côté client
// (le calcul de calculateGlobalStatus() resterait dupliqué et pourrait
// diverger du serveur) : on redemande simplement GET /api/dashboard,
// et seulement si l'onglet Dashboard est affiché.
let dashboardRefreshTimer = null;
function scheduleDashboardRefresh() {
  if (state.view !== "dashboard") return;
  if (dashboardRefreshTimer) return;
  dashboardRefreshTimer = setTimeout(() => {
    dashboardRefreshTimer = null;
    loadDashboard();
  }, 500);
}

// ---------- Serveurs distants (GET/POST/PUT /api/servers, Phase 10) ----------
// Même découpage que les autres sections : le store ne fait qu'appeler
// lib/routes/servers.js et refléter la réponse ; le statut/les métriques
// temps réel arrivent séparément via les événements socket "server.snapshot"
// et "server.status" (voir câblage WebSocket ci-dessous et server.js).

function apiPut(url, body) {
  return fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || `Erreur HTTP ${r.status}`);
    return data;
  });
}

function apiDelete(url) {
  return fetch(url, { method: "DELETE" }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || `Erreur HTTP ${r.status}`);
    return data;
  });
}

function mergeServerItem(server) {
  const existing = state.servers.items.find((s) => s.serverKey === server.serverKey);
  const merged = existing ? { ...existing, ...server } : { ...server, processes: [] };
  const idx = state.servers.items.findIndex((s) => s.serverKey === server.serverKey);
  if (idx === -1) state.servers.items.push(merged);
  else state.servers.items.splice(idx, 1, merged);
  return merged;
}

export function loadServers() {
  state.servers.loading = true;
  return apiGet("/api/servers")
    .then((list) => {
      list.forEach(mergeServerItem);
      // Retire du store local les serveurs supprimés côté serveur entretemps.
      const keys = new Set(list.map((s) => s.serverKey));
      state.servers.items = state.servers.items.filter((s) => keys.has(s.serverKey));
    })
    .catch(notifyError)
    .finally(() => {
      state.servers.loading = false;
      state.servers.loaded = true;
    });
}

/** Retourne { server, token } — le token en clair n'est disponible qu'à cet instant. */
export function createServer({ name, hostname, environment }) {
  return apiPost("/api/servers", { name, hostname, environment }).then((r) => {
    mergeServerItem(r.server);
    return r;
  });
}

export function updateServer(serverKey, patch) {
  return apiPut(`/api/servers/${serverKey}`, patch).then((server) => {
    mergeServerItem(server);
    return server;
  });
}

export function setServerEnabled(serverKey, enabled) {
  return apiPost(`/api/servers/${serverKey}/${enabled ? "enable" : "disable"}`).then((server) => {
    mergeServerItem(server);
    return server;
  });
}

export function deleteServer(serverKey) {
  return apiDelete(`/api/servers/${serverKey}`).then(() => {
    state.servers.items = state.servers.items.filter((s) => s.serverKey !== serverKey);
  });
}

/** Retourne { server, token } — l'ancien token devient invalide immédiatement. */
export function regenerateServerToken(serverKey) {
  return apiPost(`/api/servers/${serverKey}/regenerate-token`).then((r) => {
    mergeServerItem(r.server);
    return r;
  });
}

export function runRemoteAction(serverKey, action, processName) {
  return apiPost(`/api/servers/${serverKey}/action`, { action, processName });
}

// Analytics d'un process d'un serveur distant (Phase 11 + correctif
// multi-serveur, migration 014_process_metrics_server_key.js) — même forme
// de réponse que loadProcessAnalytics() (process local), route différente
// car /api/processes/:id/* résout :id via pm2.describe() (local uniquement).
export function loadServerProcessAnalytics(serverKey, processName, range) {
  const end = Date.now();
  const start = end - (PROCESS_RANGE_MS[range] || PROCESS_RANGE_MS["1h"]);
  return apiGet(
    `/api/servers/${serverKey}/processes/${encodeURIComponent(processName)}/analytics?start=${start}&end=${end}`,
  );
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

// Timeline d'événements/crashs en direct (lib/services/events/, server.js#startPm2Bus).
// Émis en plus de "event" (déjà utilisé par le panneau de logs, inchangé) — pas de
// filtrage par permission ici, même choix que "processes"/"log" (voir le commentaire
// au-dessus de bus.on("process:event") dans server.js) : le client n'affiche de toute
// façon que ce que l'onglet Timeline montre déjà (visible pour cet utilisateur via can()).
socket.on("timeline_event", (entry) => {
  if (!state.events.loaded) return; // timeline jamais ouverte : rien à tenir à jour
  if (state.events.offset !== 0) return; // pas sur la première page : un ajout en tête la désynchroniserait
  const type = EVENTS_FILTER_TYPE[state.events.filter];
  if (type && entry.type !== type) return;
  state.events.items.unshift(entry);
  state.events.total += 1;
});

// Dashboard global (Phase 8) : mêmes événements déjà émis par server.js
// pour les onglets Système/Process/Timeline (voir le commentaire sur
// scheduleDashboardRefresh ci-dessus) — pas de nouveau canal temps réel.
// Serveurs distants (server.snapshot / server.status, voir server.js#agentHub
// et lib/realtime/agent-hub.js) : identifiés par serverId (= serverKey), pas
// par pm_id seul, pour ne jamais confondre deux process de même nom sur deux
// serveurs différents (voir prompt maître Phase 10, section WebSocket).
socket.on("server.snapshot", ({ serverId, snapshot, processes }) => {
  const existing = state.servers.items.find((s) => s.serverKey === serverId);
  if (!existing) return; // pas encore chargé via loadServers() : ignoré, la liste se rafraîchira au prochain GET
  existing.status = "ONLINE";
  existing.snapshot = snapshot || existing.snapshot;
  existing.processes = processes || [];
});

socket.on("server.status", ({ serverId, status }) => {
  const existing = state.servers.items.find((s) => s.serverKey === serverId);
  if (!existing) return;
  existing.status = status;
});

socket.on("metrics.updated", scheduleDashboardRefresh);
socket.on("process.updated", scheduleDashboardRefresh);
socket.on("alert.triggered", scheduleDashboardRefresh);
socket.on("alert.resolved", scheduleDashboardRefresh);
socket.on("health.updated", scheduleDashboardRefresh);
socket.on("event.created", scheduleDashboardRefresh);

// ---------- Chargement initial ----------

export function bootstrap() {
  if (state.auth.authEnabled && !state.auth.user) return; // pas connecté : rien à charger

  // Onglet "Dashboard" par défaut à la connexion (au lieu de "Process") : sauf
  // si l'utilisateur n'a pas la permission "system" (le tab Dashboard, gated
  // par can('system') dans TopBar.vue, ne lui serait alors pas accessible) —
  // dans ce cas on retombe sur "process", toujours visible quel que soit le rôle.
  state.view = can("system") ? "dashboard" : "process";

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
