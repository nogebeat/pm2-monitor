const express = require("express");
const http = require("http");
const path = require("path");
const pm2 = require("pm2");
const { Server } = require("socket.io");

const bootstrap = require("./lib/bootstrap");
const systemStats = require("./lib/system-stats");
const { HistoryStore } = require("./lib/history-store");
const { LogStore } = require("./lib/log-store");
const db = require("./lib/db");
const migrator = require("./lib/db/migrator");
const auth = require("./lib/auth");
const { alertStore } = require("./lib/services/alerts");
const { ProcessHistoryService } = require("./lib/services/process-history");
const { EventsService } = require("./lib/services/events");
const { AuditRetentionService } = require("./lib/services/audit");
const eventsStore = require("./lib/services/events/event-store");
const { dispatchQueue: notificationDispatchQueue } = require("./lib/services/notifications");
const { engine: healthCheckEngine } = require("./lib/services/health-checks");
const healthChecksStore = require("./lib/services/health-checks/store");
const { service: anomalyService } = require("./lib/services/anomaly-detection");
const serviceDependencies = require("./lib/services/service-dependencies");
const { AutoHealingService, auditStore: autoHealingAuditStore } = require("./lib/services/auto-healing");
const serversStore = require("./lib/services/servers/store");
const processOrgStore = require("./lib/services/process-organization/store");

const { createDispatchAlertTransition } = require("./lib/alert-dispatch");
const { fmtProcess, visibleProcesses } = require("./lib/process-helpers");
const { startPolling } = require("./lib/polling");
const { attachProcessSocket } = require("./lib/realtime/process-socket");
const { createPm2Bus } = require("./lib/realtime/pm2-bus");
const { attachAgentHub } = require("./lib/realtime/agent-hub");

const authRouter = require("./lib/routes/auth");
const usersRouter = require("./lib/routes/users");
const alertsRouter = require("./lib/routes/alerts");
const eventsRouter = require("./lib/routes/events");
const notificationsRouter = require("./lib/routes/notifications");
const healthChecksRouter = require("./lib/routes/health-checks");
const autoHealingRouter = require("./lib/routes/auto-healing");
const dashboardRouter = require("./lib/routes/dashboard");
const auditRouter = require("./lib/routes/audit");
const processesRouter = require("./lib/routes/processes");
const pm2DaemonRouter = require("./lib/routes/pm2-daemon");
const systemRouter = require("./lib/routes/system");
const logsRouter = require("./lib/routes/logs");
const logExplorerRouter = require("./lib/routes/log-explorer");
const serversRouter = require("./lib/routes/servers");
const processOrganizationRouter = require("./lib/routes/process-organization");
const incidentsRouter = require("./lib/routes/incidents");
const metricsRouter = require("./lib/routes/metrics");
const anomalyDetectionRouter = require("./lib/routes/anomaly-detection");
const serviceDependenciesRouter = require("./lib/routes/service-dependencies");
const apiKeysRouter = require("./lib/routes/api-keys");
const backupRouter = require("./lib/routes/backup");
const reportsRouter = require("./lib/routes/reports");
const reportsSystemHistory = require("./lib/services/reports/system-history-store");

// --- Config / .env minimal (pas de dépendance dotenv) -----------------

bootstrap.loadDotEnv(__dirname);

const PORT = process.env.PORT || 4200;

// --- Moteur d'alertes : activable/désactivable (voir lib/services/alerts/
// et docs/alerts/README.md). Depuis la Phase 5D, une transition
// trigger->active ou ->resolved déclenche en plus le routing des
// notifications (voir lib/alert-dispatch.js, NOTIFICATIONS_DISPATCH_ENABLED) --
const ALERTS_ENABLED = process.env.ALERTS_ENABLED !== "0";
const ALERTS_EVAL_INTERVAL_MS = process.env.ALERTS_EVAL_INTERVAL_MS
  ? Number(process.env.ALERTS_EVAL_INTERVAL_MS)
  : 15000;

// --- Dispatch des notifications (Phase 5D) : indépendant de ALERTS_ENABLED
// pour pouvoir couper uniquement l'envoi de notifications (debug, incident
// fournisseur) sans désactiver le moteur d'alertes lui-même. Sans effet si
// ALERTS_ENABLED=0 (pas de transition à dispatcher dans ce cas). Voir
// lib/services/notifications/routing/engine.js#dispatch — ne lance jamais,
// donc jamais bloquant pour la boucle de monitoring même en cas d'échec.
const NOTIFICATIONS_DISPATCH_ENABLED = process.env.NOTIFICATIONS_DISPATCH_ENABLED !== "0";

// --- Health checks (Phase 6, lib/services/health-checks/) : indépendant du
// statut PM2, activable/désactivable séparément. Le scheduler interne du
// moteur (engine.start()) tourne à un intervalle court (par défaut 5s) et
// ne réexécute que les checks réellement "dus" (leur propre intervalScheduler
// intervalSeconds étant configuré par check, voir engine.runDueChecks()) ---
const HEALTH_CHECKS_ENABLED = process.env.HEALTH_CHECKS_ENABLED !== "0";
const HEALTH_CHECKS_SCHEDULER_INTERVAL_MS = process.env.HEALTH_CHECKS_SCHEDULER_INTERVAL_MS
  ? Number(process.env.HEALTH_CHECKS_SCHEDULER_INTERVAL_MS)
  : 5000;

// --- Détection d'anomalies (Phase 16, lib/services/anomaly-detection/) :
// activable/désactivable séparément du moteur d'alertes classique
// (ALERTS_ENABLED) — une anomalie ne peut de toute façon produire aucune
// alerte tant qu'au moins une règle anomaly_rules est créée et activée,
// mais ce flag permet de couper l'évaluation elle-même (perf, debug) sans
// toucher aux règles enregistrées. Évaluée dans les deux boucles de
// lib/polling.js existantes (pas de troisième poller).
const ANOMALY_DETECTION_ENABLED = process.env.ANOMALY_DETECTION_ENABLED !== "0";

// --- Services (instanciés une fois, injectés dans les routers/temps réel
// concernés). Doivent être créés après loadDotEnv() : plusieurs constructeurs
// lisent process.env (voir chaque service pour le détail des variables). ----
const processHistory = new ProcessHistoryService();
const eventsService = new EventsService();
const auditRetentionService = new AuditRetentionService();

// Auto-Healing (Phase 7, lib/services/auto-healing/) : CRITIQUE/DANGEREUX,
// désactivé par défaut en base (voir migration 009_auto_healing.js). `pm2`
// est passé maintenant (l'instance module, connectée plus tard par le bus
// PM2) : le service ne fait que fermer dessus au moment de l'action, comme
// pm2Actions.* utilisé ailleurs dans les routers process.
const autoHealing = new AutoHealingService({ pm2 });

const historyStore = new HistoryStore();
const logStore = new LogStore(path.join(__dirname, "data", "logs"));

// Détection d'anomalies (Phase 16) : branche les stores déjà instanciés
// ci-dessus / déjà existants sur le service — même approche que
// healthCheckEngine.onAlertResult plus bas (le module lui-même ne dépend ni
// de PM2 ni d'Express, ces instances lui sont injectées ici).
anomalyService.historyStore = historyStore;
anomalyService.processHistoryStore = require("./lib/services/process-history/store");
anomalyService.eventStore = eventsStore;

const app = express();
app.set("trust proxy", 1); // derrière nginx/un reverse proxy : IP réelle, X-Forwarded-* fiables

const server = http.createServer(app);
const io = new Server(server);

const sessionMw = auth.sessionMiddleware();
app.use(sessionMw);
// Phase 19 — Backup & Restore : un backup complet (beaucoup
// d'enregistrements et/ou secrets inclus) peut dépasser la limite globale
// de 100 Ko (défaut d'express.json() ci-dessous) — scope dédié, monté
// AVANT le parseur générique, pour ne pas changer cette limite pour le
// reste de l'API (posture anti-DoS inchangée partout ailleurs). Le
// parseur générique voit `req._body` déjà positionné par celui-ci et ne
// retente pas de parser (garde interne de body-parser) — voir
// docs/backup-restore/README.md#limites-connues.
app.use("/api/backup", express.json({ limit: process.env.BACKUP_MAX_BODY_SIZE || "20mb" }));
app.use(express.json());
app.use(auth.loadCurrentUser);
// Phase 18 — Advanced RBAC & API Keys : charge une éventuelle clé API M2M
// (header Authorization: Bearer <clé>) AVANT requireAuth, pour qu'une
// requête sans cookie de session mais avec une clé valide ne soit pas
// bloquée en 401 — voir lib/auth.js#loadApiKeyAuth/requireAuth.
app.use(auth.loadApiKeyAuth);
app.use(auth.requireAuth);

// Empêche tout intermédiaire (CDN type Cloudflare, cache navigateur, proxy) de mettre
// en cache une réponse API par URL : sans ça, un 401 obtenu avant connexion peut être
// re-servi tel quel après un login réussi, avec le bon cookie envoyé mais ignoré.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// Le bus Socket.IO partage la même session que les requêtes HTTP (cookie envoyé
// automatiquement par le navigateur), pour appliquer les mêmes règles de visibilité.
io.engine.use(sessionMw);
io.use((socket, next) => {
  if (!auth.AUTH_ENABLED) return next();
  const sess = socket.request.session;
  if (sess && sess.userId) return next();
  next(new Error("unauthorized"));
});

// --- Dispatch d'une transition d'alerte (notifications + websocket +
// auto-healing) : voir lib/alert-dispatch.js pour le détail. ---------------
const dispatchAlertTransition = createDispatchAlertTransition({
  io,
  autoHealing,
  notificationsDispatchEnabled: NOTIFICATIONS_DISPATCH_ENABLED,
});

// --- Multi-server / Remote PM2 (Phase 10, lib/realtime/agent-hub.js) -----
// Namespace Socket.IO `/agent` séparé du namespace principal (io.use()
// ci-dessus, qui exige une session navigateur) : les agents s'authentifient
// par token, jamais par cookie de session (voir agent-hub.js). Les données
// temps réel reçues d'un agent (snapshot système + process) sont diffusées
// aux clients navigateur avec un `serverId` explicite pour éviter toute
// collision entre deux process de même nom sur deux serveurs différents
// (voir prompt maître, section WebSocket).
const agentHub = attachAgentHub(io, {
  onSnapshot: (serverKey, snapshot, processes) => {
    io.emit("server.snapshot", { serverId: serverKey, snapshot, processes });
    // Historique/Analytics (lib/services/process-history/, Phase 11) : avant
    // la migration 014_process_metrics_server_key.js, ce service n'était
    // jamais alimenté pour les process d'un serveur distant (seul
    // lib/polling.js appelait record(), pour l'hôte local uniquement) —
    // aucune donnée Metrics/Analytics n'existait pour un agent. `processes`
    // porte déjà la forme fmtProcess() (voir bin/agent.js, copie locale de
    // lib/process-helpers.js#fmtProcess), donc réutilisable telle quelle.
    if (processHistory.config.enabled && Array.isArray(processes) && processes.length) {
      processHistory.record(processes, Date.now(), serverKey).catch((e) => {
        console.error(`Erreur de collecte de l'historique process (serveur "${serverKey}") :`, e.message);
      });
    }
  },
  onProcessEvent: (serverKey, payload) => {
    io.emit("event", { ...payload, serverId: serverKey });
  },
  onLog: (serverKey, payload) => {
    io.emit("log", { ...payload, serverId: serverKey });
    // Persistance (Phase 12, Log Explorer) : avant cette phase, un log
    // reçu d'un agent distant n'était que diffusé en direct (io.emit
    // ci-dessus), jamais écrit sur disque — donc jamais consultable a
    // posteriori ni cherchable, contrairement aux logs de l'hôte local
    // (voir lib/realtime/pm2-bus.js, alimenté depuis toujours). `payload`
    // a la forme { type, process, pm_id, data, at } (voir bin/agent.js) —
    // mêmes champs que ceux passés à logStore.appendPacket() pour l'hôte
    // local, à la nomenclature près (process/pm_id ici vs name/pmId
    // localement).
    if (payload && payload.data) {
      logStore.appendPacket(
        payload.pm_id,
        payload.process,
        payload.type,
        payload.data,
        payload.at || Date.now(),
        serverKey,
      );
    }
  },
  onStatusChange: (serverKey, status) => {
    io.emit("server.status", { serverId: serverKey, status });
  },
});
agentHub.startStaleSweep();

// --- Prometheus Metrics Export (Phase 15, lib/routes/metrics.js) ---------
// Monté hors de /api volontairement : un scraper Prometheus ne porte jamais
// le cookie de session du navigateur (voir lib/auth.js#requireAuth, qui ne
// bloque que /api/*). Ce routeur applique sa propre politique d'accès
// (token bearer et/ou restriction IP, voir lib/services/metrics/config.js)
// indépendante du système d'auth par session/permissions existant.
app.use(
  "/metrics",
  metricsRouter({
    pm2,
    fmtProcess,
    getSystemSnapshot: () => systemStats.snapshot(),
    alertStore,
    healthChecksStore,
    serversStore,
    agentHub,
  }),
);

// --- REST API --------------------------------------------------------------

app.use("/api/auth", authRouter());
app.use("/api", usersRouter());

// Moteur d'alertes (lib/services/alerts/, lib/routes/alerts.js)
app.use("/api/alerts", alertsRouter());

// Timeline d'événements/crashs (lib/services/events/, lib/routes/events.js)
app.use("/api/events", eventsRouter(eventsService));

// Notification system, fondations Phase 5A (lib/services/notifications/, lib/routes/notifications.js)
app.use("/api/notifications", notificationsRouter());

// Health checks (lib/services/health-checks/, lib/routes/health-checks.js)
app.use("/api/health-checks", healthChecksRouter());

// Auto-healing (lib/services/auto-healing/, lib/routes/auto-healing.js)
app.use("/api/auto-healing", autoHealingRouter(autoHealing));

// Dashboard global (lib/services/dashboard/, Phase 8)
app.use(
  "/api/dashboard",
  dashboardRouter({
    pm2,
    fmtProcess,
    visibleProcesses,
    getSystemSnapshot: () => systemStats.snapshot(),
    alertStore,
    healthChecksStore,
    eventsStore,
    autoHealingAuditStore,
  }),
);

// Audit log (lib/services/audit/, Phase 9)
app.use("/api/audit", auditRouter());

// Multi-server / Remote PM2 (lib/services/servers/, lib/routes/servers.js, Phase 10)
app.use("/api/servers", serversRouter({ agentHub, processHistory }));

// Organisation des process : tags/environnements/groupes (lib/services/
// process-organization/, lib/routes/process-organization.js, Phase 13)
app.use("/api/process-organization", processOrganizationRouter());

// Incident Management & Alert Silencing (lib/services/incidents/,
// lib/routes/incidents.js, Phase 14) : corrélation branchée sur
// dispatchAlertTransition ci-dessus (lib/alert-dispatch.js), pas ici — ce
// routeur n'expose que la lecture/les transitions manuelles/les silences.
app.use("/api/incidents", incidentsRouter());

// Détection d'anomalies (lib/services/anomaly-detection/,
// lib/routes/anomaly-detection.js, Phase 16) : CRUD des règles + lecture de
// l'historique des détections. Les transitions d'alerte qu'elle produit
// passent par dispatchAlertTransition comme toute autre alerte (voir
// lib/polling.js), pas par ce routeur.
app.use("/api/anomaly-detection", anomalyDetectionRouter());

// Service Dependency Map (lib/services/service-dependencies/,
// lib/routes/service-dependencies.js, Phase 17) : CRUD des dépendances
// déclarées + lecture du graphe/statut/impact (dérivés des health checks
// liés, pas de nouveau poller — voir câblage sur healthCheckEngine.onCheckResult
// plus bas).
app.use("/api/service-dependencies", serviceDependenciesRouter());

// Clés API M2M (lib/services/api-keys/, lib/routes/api-keys.js, Phase 18) :
// gestion (CRUD) réservée aux utilisateurs avec session (api_keys_read/
// api_keys_manage) — voir lib/routes/api-keys.js pour le raisonnement.
app.use("/api/api-keys", apiKeysRouter());
app.use("/api/backup", backupRouter());

// Reports & Capacity Planning (lib/services/reports/, lib/routes/reports.js,
// Phase 20) : agrège les données déjà collectées (process-history, alertes,
// incidents, notifications, auto-healing, health checks, historique système)
// — aucune nouvelle collecte, voir lib/services/reports/aggregator.js.
app.use("/api/reports", reportsRouter({ pm2, fmtProcess, visibleProcesses, processHistory }));

// Process : liste + actions de base/étendues + métriques (lib/routes/processes.js)
app.use("/api", processesRouter({ processHistory }));

// Actions sur le daemon PM2 lui-même (lib/routes/pm2-daemon.js)
app.use("/api/pm2", pm2DaemonRouter());

// Système : snapshot + historique (lib/routes/system.js)
app.use("/api/system", systemRouter({ historyStore }));

// Logs : export brut, recherche, export par période, tail, stats (lib/routes/logs.js)
app.use("/api", logsRouter({ logStore }));

// Log Explorer (lib/routes/log-explorer.js, Phase 12) : recherche globale
// multi-process / multi-serveur, distincte de la recherche par process de
// logsRouter ci-dessus (voir en-tête de lib/routes/log-explorer.js).
app.use("/api/logs", logExplorerRouter({ logStore }));

// --- Temps réel : liste des process (polling léger par client) -----------
attachProcessSocket(io);

// --- Polling partagé : snapshot système + polling process (alertes + historique) ---
startPolling({
  io,
  historyStore,
  processHistory,
  dispatchAlertTransition,
  alertsEnabled: ALERTS_ENABLED,
  alertsEvalIntervalMs: ALERTS_EVAL_INTERVAL_MS,
  anomalyEnabled: ANOMALY_DETECTION_ENABLED,
});

// Maintenance (rollup + purge) de l'historique process, sur son propre
// intervalle (PROCESS_HISTORY_MAINTENANCE_INTERVAL_MS) indépendant du polling.
processHistory.start();

// Purge périodique de la timeline d'événements (rétention EVENTS_RETENTION_MS),
// sur son propre intervalle indépendant — même découpage que processHistory ci-dessus.
eventsService.start();

// Purge périodique de l'audit log (rétention AUDIT_RETENTION_MS, désactivée
// par défaut) : no-op tant que la variable n'est pas définie explicitement,
// voir lib/services/audit/config.js et docs/audit/README.md#rétention.
auditRetentionService.start();

// Purge périodique de l'historique système persisté pour les rapports
// (Phase 20, rétention system-history-store.js#RETENTION_MS) — même
// découpage que les autres boucles de maintenance ci-dessus.
reportsSystemHistory.startPurgeLoop();

// --- Health checks (Phase 6) ---------------------------------------------
// Branche le dispatch de notifications sur les transitions d'alerte
// produites par les health checks, exactement comme pour
// evaluateProcessReadings/evaluateSystemReading (lib/polling.js) — même
// fonction dispatchAlertTransition, un seul chemin de notification.
healthCheckEngine.alertsEnabled = ALERTS_ENABLED;
healthCheckEngine.onAlertResult = ALERTS_ENABLED ? dispatchAlertTransition : null;
// Dashboard global (Phase 8) : diffuse chaque résultat de sonde en websocket
// ("health.updated"), sur le bus Socket.IO existant — aucun second poller.
//
// Service Dependency Map (Phase 17) : un résultat de check peut aussi
// concerner une dépendance déclarée (health_check_id). Pas de nouveau
// poller ici non plus — on ne fait que réagir au même événement, calculer
// l'impact ("dépendances affectées") et le diffuser ("dependency.updated" à
// chaque résultat pertinent pour rafraîchir le graphe côté UI ;
// "dependency.impact" seulement quand au moins un service est
// potentiellement affecté). Jamais bloquant pour la boucle de health checks
// (catch défensif, comme feedAlertEngine/onAlertResult).
healthCheckEngine.onCheckResult = (check) => {
  io.emit("health.updated", check);
  serviceDependencies
    .handleHealthCheckResult(check)
    .then((result) => {
      if (!result) return;
      io.emit("dependency.updated", { checkId: result.checkId, checkStatus: result.checkStatus });
      if (result.impacts.length) io.emit("dependency.impact", result);
    })
    .catch((e) => {
      console.error("Erreur de calcul d'impact (Service Dependency Map) :", e.message);
    });
};
if (HEALTH_CHECKS_ENABLED) {
  healthCheckEngine.start(HEALTH_CHECKS_SCHEDULER_INTERVAL_MS);
}

// --- Notification dispatch queue (Phase 5E) -----------------------------
// Worker de la file d'attente de notifications (retry/backoff/rate limit/
// dedup, voir lib/services/notifications/dispatch-queue.js). Indépendant de
// NOTIFICATIONS_DISPATCH_ENABLED : ce flag contrôle si dispatchAlertTransition
// empile des jobs ; le worker doit tout de même tourner pour vider les jobs
// déjà en base (ex. créés avant un redémarrage) — sinon ils resteraient
// bloqués "pending" indéfiniment. recoverStaleActiveJobs() (appelé dans
// start()) garantit qu'un job interrompu par un arrêt brutal du process
// redevient "pending" et sera retraité.
notificationDispatchQueue.start().catch((e) => {
  console.error("Erreur au démarrage de la file de notifications :", e.message);
});

// --- Bus PM2 (logs + événements process) + démarrage du serveur HTTP -----
const startPm2Bus = createPm2Bus({ io, server, port: PORT, logStore, eventsService, autoHealing });

// --- Démarrage : DB, migrations, puis bus PM2 --------------------------

async function runMigrationsAtBoot() {
  const applied = await migrator.up();
  if (applied.length) {
    console.log(`🗄️  Migrations appliquées au démarrage : ${applied.join(", ")}`);
  }
}

db.init()
  .then(runMigrationsAtBoot)
  .then(bootstrap.ensureBootstrapAdmin)
  // Phase 10 — Multi-server : enregistre automatiquement l'hôte local (idempotent,
  // voir lib/services/servers/store.js#ensureLocalServer) — aucune configuration
  // requise pour qu'une installation existante mono-hôte continue de fonctionner.
  .then(serversStore.ensureLocalServer)
  // Phase 13 — Tags/Environments/Groups : seed les environnements par défaut
  // (production/staging/development) si absents, idempotent comme ci-dessus
  // (voir lib/services/process-organization/store.js#ensureDefaults).
  .then(processOrgStore.ensureDefaults)
  .then(startPm2Bus)
  .catch((err) => {
    console.error("Échec d'initialisation de la base de données :", err.message);
    process.exit(1);
  });

process.on("SIGINT", () => {
  notificationDispatchQueue.stop();
  agentHub.stopStaleSweep();
  pm2.disconnect();
  db.close().finally(() => process.exit(0));
});
