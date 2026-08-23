import { reactive } from "vue";
import { socket } from "./socket";
import { apiGet, apiPost } from "./api";

const MAX_LOG_LINES = 4000;
const MAX_CPU_HISTORY = 20;

export const state = reactive({
  connected: false,
  view: "dashboard", // "process" | "dashboard" | "system" | "events" | "servers" | "incidents"

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

  // ---------- Incidents & Silences (onglet "Incidents", Phase 14 — Incident
  // Management & Alert Silencing) ----------
  incidents: {
    items: [], // [{ id, title, status, severity, targetType, targetValue, metric, openedAt, ... }]
    total: 0,
    limit: 100,
    offset: 0,
    statusFilter: "all", // all | OPEN | ACKNOWLEDGED | INVESTIGATING | MITIGATED | RESOLVED
    loading: false,
    loaded: false,
    selectedId: null,
    detail: null, // incident sélectionné, enrichi de alertIds
    timeline: [], // entrées triées de l'incident sélectionné
    timelineLoading: false,
    catalog: null, // { states, allowedTransitions, silenceScopeTypes, silenceTypes }
    silences: [],
    silencesLoading: false,
    silencesLoaded: false,
  },

  // ---------- Serveurs distants (onglet "Serveurs", Phase 10 — Multi-server / Remote PM2) ----------
  servers: {
    items: [], // [{ id, serverKey, name, hostname, environment, kind, enabled, status, agentVersion,
    //   protocolVersion, lastSeen, snapshot, processes, hasToken, createdAt, updatedAt }]
    loaded: false,
    loading: false,
  },

  // ---------- Log Explorer (onglet "Logs", Phase 12) ----------
  // Recherche GLOBALE (plusieurs process, plusieurs serveurs) — distincte de
  // `state.logs` ci-dessus (flux en direct d'UN seul process sélectionné,
  // LogsPanel.vue, inchangé). Voir GET /api/logs/search (lib/routes/log-explorer.js).
  logExplorer: {
    selectedProcesses: [], // [] = tous les process visibles (voir logExplorerVisibleProcessNames())
    selectedServers: [], // [] = tous les serveurs visibles
    filters: {
      type: "all", // all | out | err
      level: "all", // all | info | warn | error | debug
      query: "",
      regex: false,
      sort: "desc", // desc = plus récent d'abord
      context: 0, // lignes de contexte avant/après (0-20)
      from: null, // ms epoch | null
      to: null,
    },
    limit: 50,
    offset: 0,
    results: [], // [{ t, type, level, text, line, source: {serverKey, name}, before?, after? }]
    total: 0,
    truncated: false,
    loading: false,
    loaded: false,
    error: null,
    live: false, // en plus des résultats paginés : ajoute en tête les nouvelles lignes correspondantes
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

/**
 * Comme can(), mais sans app précise : "cet utilisateur a-t-il cette action
 * sur AU MOINS une app ?" — utilisé pour afficher/masquer un onglet qui
 * agrège plusieurs apps (Log Explorer : la vérité par-app reste appliquée
 * par le backend à chaque recherche, voir lib/routes/log-explorer.js).
 */
export function canAny(action) {
  const user = state.auth.user;
  if (!state.auth.authEnabled) return true;
  if (!user) return false;
  if (user.isAdmin) return true;
  if (!Array.isArray(user.permissions)) return false;
  return user.permissions.some((p) => p.action === "*" || p.action === action);
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

// ---------- Incidents & Silences (GET/POST /api/incidents/*, Phase 14) ----------

export function loadIncidents() {
  state.incidents.loading = true;
  const params = new URLSearchParams({
    limit: state.incidents.limit,
    offset: state.incidents.offset,
  });
  if (state.incidents.statusFilter !== "all") params.set("status", state.incidents.statusFilter);

  return apiGet(`/api/incidents?${params.toString()}`)
    .then((r) => {
      state.incidents.items = r.items;
      state.incidents.total = r.total;
    })
    .catch((err) => {
      state.incidents.items = [];
      notifyError(err);
    })
    .finally(() => {
      state.incidents.loading = false;
      state.incidents.loaded = true;
    });
}

export function setIncidentsStatusFilter(filter) {
  if (state.incidents.statusFilter === filter) return;
  state.incidents.statusFilter = filter;
  state.incidents.offset = 0;
  loadIncidents();
}

export function loadIncidentsCatalog() {
  if (state.incidents.catalog) return Promise.resolve(state.incidents.catalog);
  return apiGet("/api/incidents/catalog")
    .then((catalog) => {
      state.incidents.catalog = catalog;
      return catalog;
    })
    .catch((err) => {
      notifyError(err);
      return null;
    });
}

/** Sélectionne un incident et charge son détail + sa timeline (fusion alertes/événements/notifications/auto-healing). */
export function selectIncident(id) {
  state.incidents.selectedId = id;
  state.incidents.detail = null;
  state.incidents.timeline = [];
  if (!id) return;
  apiGet(`/api/incidents/${id}`)
    .then((detail) => {
      state.incidents.detail = detail;
    })
    .catch((err) => notifyError(err));
  loadIncidentTimeline(id);
}

export function loadIncidentTimeline(id) {
  const incidentId = id || state.incidents.selectedId;
  if (!incidentId) return Promise.resolve();
  state.incidents.timelineLoading = true;
  return apiGet(`/api/incidents/${incidentId}/timeline`)
    .then((timeline) => {
      if (state.incidents.selectedId === incidentId) state.incidents.timeline = timeline;
    })
    .catch((err) => notifyError(err))
    .finally(() => {
      state.incidents.timelineLoading = false;
    });
}

function mergeIncidentItem(updated) {
  const idx = state.incidents.items.findIndex((i) => i.id === updated.id);
  if (idx !== -1) state.incidents.items.splice(idx, 1, { ...state.incidents.items[idx], ...updated });
  if (state.incidents.detail && state.incidents.detail.id === updated.id) {
    state.incidents.detail = { ...state.incidents.detail, ...updated };
  }
}

/** action: "acknowledge" | "investigate" | "mitigate" | "resolve" */
export function transitionIncident(id, action) {
  return apiPost(`/api/incidents/${id}/${action}`)
    .then((updated) => {
      mergeIncidentItem(updated);
      loadIncidentTimeline(id);
      return updated;
    })
    .catch((err) => {
      notifyError(err);
      throw err;
    });
}

export function loadSilences({ activeOnly = false } = {}) {
  state.incidents.silencesLoading = true;
  const params = activeOnly ? "?active=1" : "";
  return apiGet(`/api/incidents/silences${params}`)
    .then((items) => {
      state.incidents.silences = items;
    })
    .catch((err) => notifyError(err))
    .finally(() => {
      state.incidents.silencesLoading = false;
      state.incidents.silencesLoaded = true;
    });
}

/**
 * @param {object} fields
 * @param {"rule"|"process"|"tag"|"environment"|"group"} fields.scopeType
 * @param {string} fields.scopeValue
 * @param {"duration"|"until"} fields.silenceType
 * @param {number} [fields.durationMinutes] - requis si silenceType === "duration"
 * @param {string} [fields.until] - date ISO, requis si silenceType === "until"
 * @param {string} [fields.reason]
 */
export function createSilence(fields) {
  return apiPost("/api/incidents/silences", fields).then((silence) => {
    state.incidents.silences = [silence, ...state.incidents.silences];
    return silence;
  });
}

export function cancelSilence(id) {
  return apiDelete(`/api/incidents/silences/${id}`).then((cancelled) => {
    const idx = state.incidents.silences.findIndex((s) => s.id === id);
    if (idx !== -1) state.incidents.silences.splice(idx, 1, cancelled);
    return cancelled;
  });
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

// ---------- Log Explorer (GET /api/logs/search, GET /api/logs/export, Phase 12) ----------
//
// Le picker process/serveur de l'Explorer se construit à partir de ce que le
// client sait déjà en direct (state.processes pour l'hôte local, alimenté par
// le socket "processes" déjà filtré par permission côté serveur — voir
// lib/realtime/process-socket.js ; state.servers.items[].processes pour les
// serveurs distants, alimenté par "server.snapshot") plutôt que d'ajouter un
// nouvel endpoint de découverte — voir la note en tête de
// lib/routes/log-explorer.js pour le raisonnement complet (nom de process
// slugifié sur disque, pas de reconstruction fiable côté serveur).

export function logExplorerVisibleProcessNames() {
  const names = new Set(state.processes.map((p) => p.name));
  state.servers.items.forEach((s) => {
    (s.processes || []).forEach((p) => names.add(p.name));
  });
  return [...names].sort();
}

export function logExplorerVisibleServers() {
  // state.servers.items contient déjà "local" (enregistré automatiquement,
  // voir serversStore.ensureLocalServer() côté serveur) une fois loadServers()
  // appelé — pas de cas particulier à gérer ici.
  return state.servers.items.map((s) => ({ serverKey: s.serverKey, name: s.name }));
}

function logExplorerBuildParams(extra = {}) {
  const ex = state.logExplorer;
  const processes = ex.selectedProcesses.length ? ex.selectedProcesses : logExplorerVisibleProcessNames();
  if (!processes.length) return null;

  const params = new URLSearchParams();
  params.set("process", processes.join(","));
  if (ex.selectedServers.length) params.set("server", ex.selectedServers.join(","));
  if (ex.filters.type !== "all") params.set("type", ex.filters.type);
  if (ex.filters.level !== "all") params.set("level", ex.filters.level);
  if (ex.filters.query) params.set("q", ex.filters.query);
  if (ex.filters.regex) params.set("regex", "1");
  if (ex.filters.from) params.set("from", String(ex.filters.from));
  if (ex.filters.to) params.set("to", String(ex.filters.to));
  params.set("sort", ex.filters.sort);
  if (ex.filters.context) params.set("context", String(ex.filters.context));
  Object.entries(extra).forEach(([k, v]) => params.set(k, String(v)));
  return params;
}

/** Lance (ou relance) la recherche avec les filtres/sélection actuels. */
export function runLogExplorerSearch({ resetOffset = true } = {}) {
  const ex = state.logExplorer;
  if (resetOffset) ex.offset = 0;

  const params = logExplorerBuildParams({ limit: ex.limit, offset: ex.offset });
  if (!params) {
    ex.results = [];
    ex.total = 0;
    ex.truncated = false;
    ex.error = "Aucun process accessible à rechercher.";
    ex.loaded = true;
    return Promise.resolve();
  }

  ex.loading = true;
  ex.error = null;
  return apiGet(`/api/logs/search?${params.toString()}`)
    .then((r) => {
      ex.results = r.results;
      ex.total = r.total;
      ex.truncated = r.truncated;
    })
    .catch((err) => {
      ex.error = err.message;
      ex.results = [];
      ex.total = 0;
      ex.truncated = false;
    })
    .finally(() => {
      ex.loading = false;
      ex.loaded = true;
    });
}

/** Ouvre l'onglet Log Explorer : charge les serveurs si besoin, sélectionne "tout" par défaut, cherche. */
export function openLogExplorer() {
  state.view = "logExplorer";
  const ready = state.servers.loaded ? Promise.resolve() : loadServers();
  return ready.then(() => runLogExplorerSearch());
}

export function setLogExplorerFilter(patch) {
  Object.assign(state.logExplorer.filters, patch);
  runLogExplorerSearch();
}

export function setLogExplorerSelection({ processes, servers } = {}) {
  if (processes !== undefined) state.logExplorer.selectedProcesses = processes;
  if (servers !== undefined) state.logExplorer.selectedServers = servers;
  runLogExplorerSearch();
}

export function logExplorerNextPage() {
  const ex = state.logExplorer;
  if (ex.loading || ex.offset + ex.limit >= ex.total) return;
  ex.offset += ex.limit;
  runLogExplorerSearch({ resetOffset: false });
}

export function logExplorerPrevPage() {
  const ex = state.logExplorer;
  if (ex.loading || ex.offset === 0) return;
  ex.offset = Math.max(0, ex.offset - ex.limit);
  runLogExplorerSearch({ resetOffset: false });
}

export function toggleLogExplorerLive() {
  state.logExplorer.live = !state.logExplorer.live;
}

export function exportLogExplorer() {
  const params = logExplorerBuildParams();
  if (!params) return;
  window.open(`/api/logs/export?${params.toString()}`, "_blank");
}

/** "Ouvrir le process" depuis un résultat de l'Explorer : seulement pour l'hôte local (voir template). */
export function openLogExplorerResultProcess(entry) {
  if (entry.source.serverKey !== "local") return;
  const p = state.processes.find((x) => x.name === entry.source.name);
  if (!p) return;
  state.view = "process";
  selectProcess(p.id);
}

function passesLogExplorerLiveFilters(entry) {
  const ex = state.logExplorer;
  const serverKey = entry.serverId || "local";

  // Même filet de sécurité que le "log" socket.on() historique ci-dessous
  // (state.processes déjà filtré par permission côté serveur) : une ligne
  // "en direct" n'est reprise dans l'Explorer que si son process apparaît
  // dans une liste que le client a déjà reçue, elle-même déjà filtrée par
  // hasPermission côté serveur — jamais de confiance dans le seul contenu
  // du paquet socket.
  if (serverKey === "local") {
    if (!state.processes.some((p) => p.name === entry.process)) return false;
  } else {
    const srv = state.servers.items.find((s) => s.serverKey === serverKey);
    if (!srv || !(srv.processes || []).some((p) => p.name === entry.process)) return false;
  }

  if (ex.selectedProcesses.length && !ex.selectedProcesses.includes(entry.process)) return false;
  if (ex.selectedServers.length && !ex.selectedServers.includes(serverKey)) return false;
  if (ex.filters.type !== "all" && ex.filters.type !== entry.type) return false;

  const level = detectLevel(entry.data);
  if (ex.filters.level !== "all" && ex.filters.level !== level) return false;

  if (ex.filters.query) {
    if (ex.filters.regex) {
      try {
        if (!new RegExp(ex.filters.query, "i").test(entry.data)) return false;
      } catch (e) {
        /* regex invalide : filtre ignoré, comme passesFilters() ci-dessous */
      }
    } else if (!entry.data.toLowerCase().includes(ex.filters.query.toLowerCase())) {
      return false;
    }
  }
  return true;
}

const LOG_EXPLORER_LIVE_MAX = 500; // même ordre de grandeur que MAX_LOG_LINES, mémoire client bornée

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

// Log Explorer (Phase 12) : listener SÉPARÉ du flux "process sélectionné"
// ci-dessus (même événement socket "log", diffusé globalement — voir
// server.js#onLog et lib/realtime/pm2-bus.js) — actif seulement si l'onglet
// Explorer a activé le direct (state.logExplorer.live).
socket.on("log", (entry) => {
  if (!state.logExplorer.live) return;
  if (!passesLogExplorerLiveFilters(entry)) return;
  state.logExplorer.results.unshift({
    t: entry.at || Date.now(),
    type: entry.type,
    level: detectLevel(entry.data),
    text: entry.data,
    line: null,
    source: { serverKey: entry.serverId || "local", name: entry.process },
    live: true,
  });
  state.logExplorer.total += 1;
  if (state.logExplorer.results.length > LOG_EXPLORER_LIVE_MAX) {
    state.logExplorer.results.pop();
  }
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
