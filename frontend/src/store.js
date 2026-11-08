import { reactive } from "vue";
import { socket } from "./socket";
import { apiGet, apiPost } from "./api";
import { i18n } from "./i18n";

// Traduction hors composant (confirmations, toasts) : suit la langue courante.
const tr = (key, params) => i18n.global.t(key, params);

const MAX_LOG_LINES = 4000;
const MAX_CPU_HISTORY = 20;

export const state = reactive({
  connected: false,
  // Mobile (<= 820px) : la vue "Process" affiche soit la liste, soit les logs (voir style.css, .layout).
  mobilePane: "list", // "list" | "logs"
  view: "dashboard", // "process" | "dashboard" | "system" | "events" | "servers" | "incidents" | "serviceDependencies"

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

  // ---------- Rapports & Capacity Planning (onglet "Reports", Phase 20) ----------
  reports: {
    filters: {
      period: "daily", // daily | weekly | monthly | custom
      start: "", // ISO, utilisé seulement si period === "custom"
      end: "",
      serverKey: "",
      environment: "",
      group: "",
      process: "",
    },
    report: null, // dernier rapport reçu de GET /api/reports (voir lib/services/reports/aggregator.js)
    loading: false,
    loaded: false,
    catalog: null, // { periods, formats, rankingCriteria } (GET /api/reports/catalog)
  },

  // ---------- Carte de dépendances de service (onglet "Dépendances",
  // Phase 17 — Service Dependency Map) ----------
  serviceDependencies: {
    items: [], // [{ id, source, target, type, enabled, description, healthCheckId, metadata, ... }]
    loading: false,
    loaded: false,
    catalog: null, // { types: [...] }
    graph: null, // { nodes: [{name,status}], edges: [...withStatus], generatedAt }
    graphLoading: false,
    selectedId: null,
    impact: null, // { service, status, potentiallyAffected } du nœud sélectionné
    impactLoading: false,
  },

  // ---------- Serveurs distants (onglet "Serveurs", Phase 10 — Multi-server / Remote PM2) ----------
  servers: {
    items: [], // [{ id, serverKey, name, hostname, environment, kind, enabled, status, agentVersion,
    //   protocolVersion, lastSeen, snapshot, processes, hasToken, createdAt, updatedAt }]
    loaded: false,
    loading: false,
  },

  // ---------- Docker Monitoring (onglet "Docker", Phase 22) ----------
  // Instantané reçu via GET /api/docker/containers ET via le socket
  // "docker.snapshot" (voir lib/realtime/docker-bus.js) — même conteneurs,
  // le socket ne fait que rafraîchir plus vite que le polling de secours de
  // DockerView.vue. `logs.*` ne concerne QUE le conteneur `selectedId` : pas
  // de flux Docker ouvert pour les autres (voir selectDockerContainer()).
  docker: {
    loaded: false,
    loading: false,
    enabled: true,
    available: false,
    checkedAt: null,
    containers: [],
    selectedId: null,
    selectedFilter: "all", // all | out | err — même vocabulaire que state.filter (logs PM2)
    logs: [],
    logCounter: 0,
    logsError: null, // dernier message de docker:log-error pour le conteneur sélectionné
    streamEnded: false, // le flux s'est interrompu (conteneur redémarré/arrêté) : réabonnement auto quand il repart
    clearedAt: {}, // containerId -> instant (ms) de la dernière action "Vider" : l'historique plus ancien n'est plus rechargé
    autoscroll: true,
    paused: false,
    pausedQueue: [],
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
  pm2MenuPos: { top: 64, right: 16 }, // position (px, viewport) du menu PM2, calculée depuis le bouton à l'ouverture
  toast: null, // { kind: "error"|"info", message }

  // Modale générique : { type: "more"|"scale"|"env"|"config"|"fulltext"|"gotodate"|"exportrange", process }
  modal: null,
});

// Même règle que lib/log-store.js#classifyLevel (backend) — notamment le
// fallback selon le flux (`streamType`) : une ligne stderr sans mot-clé
// explicite doit rester "error" ici aussi, sinon le filtre par niveau ne
// donne pas le même résultat en direct (LogsPanel) qu'une fois persistée
// (Log Explorer, qui utilise classifyLevel côté serveur).
function detectLevel(text, streamType) {
  const t = String(text).toLowerCase();
  if (/\b(error|err!|exception|fatal|traceback|fail(?:ed|ure)?)\b/.test(t)) return "error";
  if (/\b(warn(?:ing)?|deprecat(?:ed|ion))\b/.test(t)) return "warn";
  if (/\bdebug\b/.test(t)) return "debug";
  return streamType === "err" ? "error" : "info";
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
  state.mobilePane = "logs";
  state.errCounts[id] = 0;
  state.logs = [];
  state.logCounter = 0;
  state.paused = false;
  state.pausedQueue = [];
  loadLogsStats();
  loadBacklog(id);
}

// Charge l'historique récent du process (voir GET /api/processes/:id/logs/tail),
// affiché immédiatement au lieu d'attendre une nouvelle ligne en direct — évite
// l'impression de "aucun log" sur une app calme.
//
// Le serveur renvoie stdout et stderr dans l'ordre réel (avec horodatage) quand
// il le connaît (source "store"). Sinon (source "native" : lecture brute des
// fichiers out/err de PM2, qui ne portent aucune heure commune), les deux flux
// sont simplement mis bout à bout : on l'indique par un séparateur plutôt que
// de laisser croire que les lignes d'erreur — placées en dernier — sont les
// plus récentes.
export function loadBacklog(id) {
  apiGet(`/api/processes/${id}/logs/tail?lines=200`)
    .then((r) => {
      if (state.selected !== id) return; // l'utilisateur a changé de sélection entretemps
      let previousType = null;
      r.results.forEach((row) => {
        if (r.source === "native" && previousType !== row.type) {
          pushLog({
            kind: "event",
            event: tr(row.type === "err" ? "logs.historyStderr" : "logs.historyStdout"),
            at: null,
          });
        }
        previousType = row.type;
        pushLog({
          kind: "log",
          type: row.type,
          data: row.text,
          at: row.at || null, // null : fichier natif sans horodatage
          level: detectLevel(row.text, row.type),
          backlog: true,
        });
      });
      if (r.results.length) {
        pushLog({ kind: "event", event: tr("logs.liveBelow"), at: Date.now() });
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
//
// Filtrage appliqué UNIQUEMENT à l'affichage (visibleLogs), jamais à
// l'ingestion : state.logs accumule tout ce qui arrive (backlog ET direct),
// dans la limite de MAX_LOG_LINES. Ça évite deux problèmes qu'avait
// l'ancienne version :
//  1) le backlog (loadBacklog) poussait ses lignes sans jamais passer par ce
//     filtre, contrairement aux lignes reçues en direct par le socket "log" —
//     changer le filtre stdout/stderr ou niveau n'avait donc aucun effet sur
//     les lignes déjà chargées à la sélection d'un process ;
//  2) filtrer dès l'ingestion perdait définitivement les lignes qui ne
//     matchaient pas au moment de leur arrivée : re-choisir "tout" ensuite ne
//     les faisait pas réapparaître, puisqu'elles n'avaient jamais été stockées.
function passesFilters(entry) {
  if (entry.kind === "event") return true;
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
    } else if (!entry.data.toLowerCase().includes(state.search.toLowerCase())) {
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
    state.pausedQueue.forEach((entry) => pushLog(entry));
    state.pausedQueue = [];
  }
}

// File d'attente pendant la pause : bornée comme l'affichage lui-même, sinon une
// pause oubliée sur une app bavarde ferait grossir la mémoire du navigateur sans limite.
function queueWhilePaused(entry) {
  state.pausedQueue.push(entry);
  if (state.pausedQueue.length > MAX_LOG_LINES) {
    state.pausedQueue.splice(0, state.pausedQueue.length - MAX_LOG_LINES);
  }
}

export function notifyInfo(message) {
  state.toast = { kind: "info", message };
  setTimeout(() => {
    if (state.toast && state.toast.message === message) state.toast = null;
  }, 4000);
}

function wipeLogsView() {
  state.logs = [];
  state.logCounter = 0;
  state.pausedQueue = [];
}

/**
 * "Vider" : vide VRAIMENT les logs du process sélectionné (fichiers out/err de
 * PM2 + historique persisté du Log Explorer, POST /api/processes/:id/flush),
 * pas seulement l'affichage. Avant, le bouton ne faisait que vider la liste en
 * mémoire du navigateur : les lignes revenaient dès qu'on re-sélectionnait le
 * process (l'historique est relu depuis les fichiers) et le compteur de
 * fichiers/taille ne bougeait pas.
 *
 * Sans le droit "flush" sur ce process, on retombe sur le vidage d'affichage
 * seul, en le disant explicitement.
 */
export function clearLogs() {
  const proc = selectedProcess();
  if (!proc) return Promise.resolve();

  if (!can("flush", proc.name)) {
    wipeLogsView();
    notifyInfo(tr("logs.clearLocalOnly"));
    return Promise.resolve();
  }
  if (!confirm(tr("logs.clearConfirm", { name: proc.name }))) return Promise.resolve();

  return apiPost(`/api/processes/${proc.id}/flush`)
    .then(() => {
      if (state.selected !== proc.id) return;
      wipeLogsView();
      loadLogsStats();
      notifyInfo(tr("logs.clearDone", { name: proc.name }));
    })
    .catch(notifyError);
}

export function visibleLogs() {
  return state.logs.filter(passesFilters);
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

// ---------- Rapports & Capacity Planning (GET /api/reports/*, Phase 20) ----------

function reportsQueryParams() {
  const f = state.reports.filters;
  const params = new URLSearchParams({ period: f.period });
  if (f.period === "custom") {
    if (f.start) params.set("start", String(new Date(f.start).getTime()));
    if (f.end) params.set("end", String(new Date(f.end).getTime()));
  }
  if (f.serverKey) params.set("serverKey", f.serverKey);
  if (f.environment) params.set("environment", f.environment);
  if (f.group) params.set("group", f.group);
  if (f.process) params.set("process", f.process);
  return params;
}

export function loadReportsCatalog() {
  if (state.reports.catalog) return Promise.resolve(state.reports.catalog);
  return apiGet("/api/reports/catalog")
    .then((catalog) => {
      state.reports.catalog = catalog;
      return catalog;
    })
    .catch((err) => {
      notifyError(err);
      return null;
    });
}

export function loadReports() {
  state.reports.loading = true;
  return apiGet(`/api/reports?${reportsQueryParams().toString()}`)
    .then((report) => {
      state.reports.report = report;
    })
    .catch((err) => {
      state.reports.report = null;
      notifyError(err);
    })
    .finally(() => {
      state.reports.loading = false;
      state.reports.loaded = true;
    });
}

/** Met à jour un ou plusieurs filtres puis recharge le rapport (voir ReportsView.vue). */
export function setReportsFilters(patch) {
  Object.assign(state.reports.filters, patch);
  loadReports();
}

/** Ouvre le téléchargement de l'export (voir exportLogExplorer() plus bas pour le même principe). */
export function exportReport(format) {
  const params = reportsQueryParams();
  params.set("format", format);
  window.open(`/api/reports/export?${params.toString()}`, "_blank");
}

// ---------- Carte de dépendances de service (GET/POST/PUT/DELETE
// /api/service-dependencies/*, Phase 17) ----------

export function loadServiceDependencies() {
  state.serviceDependencies.loading = true;
  return apiGet("/api/service-dependencies")
    .then((items) => {
      state.serviceDependencies.items = items;
    })
    .catch(notifyError)
    .finally(() => {
      state.serviceDependencies.loading = false;
      state.serviceDependencies.loaded = true;
    });
}

export function loadServiceDependenciesCatalog() {
  if (state.serviceDependencies.catalog) return Promise.resolve(state.serviceDependencies.catalog);
  return apiGet("/api/service-dependencies/catalog")
    .then((catalog) => {
      state.serviceDependencies.catalog = catalog;
      return catalog;
    })
    .catch(notifyError);
}

export function loadServiceDependenciesGraph() {
  state.serviceDependencies.graphLoading = true;
  return apiGet("/api/service-dependencies/graph")
    .then((graph) => {
      state.serviceDependencies.graph = graph;
    })
    .catch(notifyError)
    .finally(() => {
      state.serviceDependencies.graphLoading = false;
    });
}

export function createServiceDependency(fields) {
  return apiPost("/api/service-dependencies", fields).then((dep) => {
    state.serviceDependencies.items = [...state.serviceDependencies.items, dep];
    loadServiceDependenciesGraph();
    return dep;
  });
}

function mergeServiceDependency(updated) {
  const idx = state.serviceDependencies.items.findIndex((d) => d.id === updated.id);
  if (idx !== -1) state.serviceDependencies.items.splice(idx, 1, updated);
  loadServiceDependenciesGraph();
}

export function updateServiceDependency(id, fields) {
  return apiPut(`/api/service-dependencies/${id}`, fields).then((updated) => {
    mergeServiceDependency(updated);
    return updated;
  });
}

export function setServiceDependencyEnabled(id, enabled) {
  return apiPost(`/api/service-dependencies/${id}/${enabled ? "enable" : "disable"}`).then((updated) => {
    mergeServiceDependency(updated);
    return updated;
  });
}

export function deleteServiceDependency(id) {
  return apiDelete(`/api/service-dependencies/${id}`).then(() => {
    state.serviceDependencies.items = state.serviceDependencies.items.filter((d) => d.id !== id);
    if (state.serviceDependencies.selectedId === id) {
      state.serviceDependencies.selectedId = null;
      state.serviceDependencies.impact = null;
    }
    loadServiceDependenciesGraph();
  });
}

/** Sélectionne un nœud (nom de service) du graphe et charge son impact potentiel. */
export function selectServiceDependencyNode(name) {
  state.serviceDependencies.selectedId = name;
  state.serviceDependencies.impact = null;
  if (!name) return;
  state.serviceDependencies.impactLoading = true;
  return apiGet(`/api/service-dependencies/impact/${encodeURIComponent(name)}?assumeDown=1`)
    .then((impact) => {
      if (state.serviceDependencies.selectedId === name) state.serviceDependencies.impact = impact;
    })
    .catch(notifyError)
    .finally(() => {
      state.serviceDependencies.impactLoading = false;
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

// ---------- Docker Monitoring (onglet "Docker", Phase 22) ----------

function mergeDockerSnapshot(snapshot) {
  state.docker.available = snapshot.available;
  state.docker.checkedAt = snapshot.checkedAt;
  state.docker.containers = snapshot.containers || [];
  // Le conteneur sélectionné a disparu (supprimé) : on ferme proprement le
  // suivi de logs, même règle que "le conteneur est supprimé" (section 5).
  if (state.docker.selectedId && !state.docker.containers.some((c) => c.id === state.docker.selectedId)) {
    unselectDockerContainer();
  }
}

export function loadDockerContainers() {
  state.docker.loading = true;
  return apiGet("/api/docker/containers")
    .then(mergeDockerSnapshot)
    .catch(notifyError)
    .finally(() => {
      state.docker.loading = false;
      state.docker.loaded = true;
    });
}

export function selectedDockerContainer() {
  return state.docker.containers.find((c) => c.id === state.docker.selectedId) || null;
}

function pushDockerLog(entry) {
  state.docker.logCounter++;
  state.docker.logs.push({ ...entry, n: state.docker.logCounter });
  if (state.docker.logs.length > MAX_LOG_LINES) {
    state.docker.logs.splice(0, state.docker.logs.length - MAX_LOG_LINES);
  }
}

export function visibleDockerLogs() {
  const f = state.docker.selectedFilter;
  if (f === "all") return state.docker.logs;
  return state.docker.logs.filter((l) => l.type === f);
}

export function toggleDockerPause() {
  state.docker.paused = !state.docker.paused;
  if (!state.docker.paused) {
    state.docker.pausedQueue.forEach((entry) => pushDockerLog(entry));
    state.docker.pausedQueue = [];
  }
}

// Instant (ms, horloge Docker quand on la connaît) de la dernière vraie ligne affichée.
function dockerLastLogAt() {
  for (let i = state.docker.logs.length - 1; i >= 0; i--) {
    const l = state.docker.logs[i];
    if (l.kind !== "event" && l.at) return l.at;
  }
  return null;
}

/**
 * Ouvre le flux en direct APRÈS l'historique déjà chargé : `since` (la ligne
 * suivante la dernière affichée) évite à la fois le trou et le doublon qu'il y
 * avait quand historique et flux étaient demandés en parallèle, le flux
 * démarrant à "maintenant".
 */
function subscribeDockerLogs(id) {
  const from = Math.max(dockerLastLogAt() || 0, state.docker.clearedAt[id] || 0);
  socket.emit("docker:subscribe-logs", {
    containerId: id,
    since: from ? (from + 1) / 1000 : undefined,
  });
}

/**
 * "Vider" côté Docker : Docker Monitoring est strictement en lecture seule
 * (on ne touche jamais aux logs du conteneur lui-même), donc on vide
 * l'affichage ET on retient l'instant du vidage pour ne plus recharger
 * l'historique antérieur quand on revient sur ce conteneur.
 */
export function clearDockerLogs() {
  const id = state.docker.selectedId;
  if (id) state.docker.clearedAt[id] = dockerLastLogAt() || Date.now();
  state.docker.logs = [];
  state.docker.logCounter = 0;
  state.docker.pausedQueue = [];
}

/**
 * Sélectionne UN conteneur : charge son historique récent (comme
 * loadBacklog() pour PM2) puis s'abonne à son flux en direct via le socket
 * ("docker:subscribe-logs" — voir lib/realtime/docker-bus.js). Changer de
 * sélection ferme automatiquement le flux précédent côté serveur (section 5
 * du prompt maître) — le désabonnement explicite ci-dessous n'est qu'une
 * mesure de propreté supplémentaire (ex: utilisateur sans docker_logs, pour
 * qui aucun flux n'a de toute façon jamais été ouvert côté serveur).
 */
export function selectDockerContainer(id) {
  if (state.docker.selectedId) socket.emit("docker:unsubscribe-logs");
  state.docker.selectedId = id;
  state.docker.logs = [];
  state.docker.logCounter = 0;
  state.docker.logsError = null;
  state.docker.streamEnded = false;
  state.docker.paused = false;
  state.docker.pausedQueue = [];

  // Sans docker_logs (ex: rôle auditor), aucun flux n'est demandé : le serveur
  // refuserait de toute façon (voir docker-bus.js), autant ne rien ouvrir.
  if (!can("docker_logs")) return;

  apiGet(`/api/docker/containers/${encodeURIComponent(id)}/logs?tail=200`)
    .then((r) => {
      if (state.docker.selectedId !== id) return false; // sélection déjà changée entretemps
      const clearedAt = state.docker.clearedAt[id] || 0;
      const rows = r.results.filter((row) => !clearedAt || !row.at || row.at > clearedAt);
      rows.forEach((row) => pushDockerLog({ type: row.type, text: row.text, at: row.at, backlog: true }));
      if (rows.length) {
        pushDockerLog({ kind: "event", event: tr("logs.liveBelow"), at: Date.now() });
      }
      return true;
    })
    .catch(() => {
      /* pas grave : on retombe simplement sur le flux en direct */
      return state.docker.selectedId === id;
    })
    .then((stillSelected) => {
      if (stillSelected) subscribeDockerLogs(id);
    });
}

export function unselectDockerContainer() {
  if (state.docker.selectedId) socket.emit("docker:unsubscribe-logs");
  state.docker.selectedId = null;
  state.docker.logs = [];
  state.docker.logCounter = 0;
  state.docker.logsError = null;
  state.docker.streamEnded = false;
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

  const level = detectLevel(entry.data, entry.type);
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

  const full = { ...entry, kind: "log", level: detectLevel(entry.data, entry.type) };

  // Le filtrage (type/niveau/recherche) est appliqué à l'affichage par
  // visibleLogs(), pas ici : voir le commentaire au-dessus de passesFilters().
  if (state.paused) {
    queueWhilePaused(full);
    return;
  }
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
    level: detectLevel(entry.data, entry.type),
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

// Docker Monitoring (Phase 22, lib/realtime/docker-bus.js) : "docker.snapshot"
// est diffusé à TOUS les clients (comme "server.snapshot" ci-dessus, pas de
// scope par ressource pour docker_read — voir lib/permissions.js) ; on
// l'applique toujours, l'onglet lui-même ne s'affiche que si can("docker_read").
// "docker:log"/"docker:log-error" ne sont émis QUE vers le socket qui s'est
// explicitement abonné (state.docker.selectedId), jamais un broadcast.
socket.on("docker.snapshot", (snapshot) => {
  state.docker.available = snapshot.available;
  state.docker.checkedAt = snapshot.checkedAt;
  state.docker.containers = snapshot.containers || [];
  if (state.docker.selectedId && !state.docker.containers.some((c) => c.id === state.docker.selectedId)) {
    unselectDockerContainer();
    return;
  }
  // Le flux de logs s'était arrêté parce que le conteneur a redémarré : sans ça, la console
  // restait figée sur l'ancien contenu même une fois le conteneur reparti.
  const selected = selectedDockerContainer();
  if (selected && state.docker.streamEnded && selected.state === "running" && can("docker_logs")) {
    state.docker.streamEnded = false;
    state.docker.logsError = null;
    pushDockerLog({ kind: "event", event: tr("dockerView.streamResumed"), at: Date.now() });
    subscribeDockerLogs(selected.id);
  }
});

socket.on("docker:log", ({ containerId, type, text, at }) => {
  if (state.docker.selectedId !== containerId) return; // sélection déjà changée entretemps
  const entry = { type, text, at };
  if (state.docker.paused) {
    state.docker.pausedQueue.push(entry);
    if (state.docker.pausedQueue.length > MAX_LOG_LINES) {
      state.docker.pausedQueue.splice(0, state.docker.pausedQueue.length - MAX_LOG_LINES);
    }
    return;
  }
  pushDockerLog(entry);
});

socket.on("docker:log-error", ({ containerId, error, ended }) => {
  if (state.docker.selectedId !== containerId) return;
  state.docker.logsError = error;
  // `ended` : flux interrompu côté Docker (conteneur arrêté/redémarré/supprimé), pas un refus
  // de permission — voir le réabonnement automatique dans "docker.snapshot".
  state.docker.streamEnded = !!ended;
});

socket.on("metrics.updated", scheduleDashboardRefresh);
socket.on("process.updated", scheduleDashboardRefresh);
socket.on("alert.triggered", scheduleDashboardRefresh);
socket.on("alert.resolved", scheduleDashboardRefresh);
socket.on("health.updated", scheduleDashboardRefresh);
socket.on("event.created", scheduleDashboardRefresh);

// Service Dependency Map (Phase 17) : diffusé par server.js à chaque
// résultat de health check concernant une dépendance liée (voir
// healthCheckEngine.onCheckResult). "dependency.updated" -> le statut d'une
// arête a pu changer, on ne rafraîchit le graphe que si l'onglet est
// affiché (même filet que scheduleDashboardRefresh). "dependency.impact"
// -> au moins un service est potentiellement affecté ; si c'est le nœud
// actuellement sélectionné, on rafraîchit aussi son panneau d'impact.
socket.on("dependency.updated", () => {
  if (state.view === "serviceDependencies") loadServiceDependenciesGraph();
});

socket.on("dependency.impact", (payload) => {
  if (state.view !== "serviceDependencies") return;
  loadServiceDependenciesGraph();
  const selected = state.serviceDependencies.selectedId;
  if (selected && payload.impacts.some((i) => i.service === selected)) {
    selectServiceDependencyNode(selected);
  }
});

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
