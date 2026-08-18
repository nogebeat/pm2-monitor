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
const { AutoHealingService, auditStore: autoHealingAuditStore } = require("./lib/services/auto-healing");

const { createDispatchAlertTransition } = require("./lib/alert-dispatch");
const { fmtProcess, visibleProcesses } = require("./lib/process-helpers");
const { startPolling } = require("./lib/polling");
const { attachProcessSocket } = require("./lib/realtime/process-socket");
const { createPm2Bus } = require("./lib/realtime/pm2-bus");

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

const app = express();
app.set("trust proxy", 1); // derrière nginx/un reverse proxy : IP réelle, X-Forwarded-* fiables

const server = http.createServer(app);
const io = new Server(server);

const sessionMw = auth.sessionMiddleware();
app.use(sessionMw);
app.use(express.json());
app.use(auth.loadCurrentUser);
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

// Process : liste + actions de base/étendues + métriques (lib/routes/processes.js)
app.use("/api", processesRouter({ processHistory }));

// Actions sur le daemon PM2 lui-même (lib/routes/pm2-daemon.js)
app.use("/api/pm2", pm2DaemonRouter());

// Système : snapshot + historique (lib/routes/system.js)
app.use("/api/system", systemRouter({ historyStore }));

// Logs : export brut, recherche, export par période, tail, stats (lib/routes/logs.js)
app.use("/api", logsRouter({ logStore }));

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

// --- Health checks (Phase 6) ---------------------------------------------
// Branche le dispatch de notifications sur les transitions d'alerte
// produites par les health checks, exactement comme pour
// evaluateProcessReadings/evaluateSystemReading (lib/polling.js) — même
// fonction dispatchAlertTransition, un seul chemin de notification.
healthCheckEngine.alertsEnabled = ALERTS_ENABLED;
healthCheckEngine.onAlertResult = ALERTS_ENABLED ? dispatchAlertTransition : null;
// Dashboard global (Phase 8) : diffuse chaque résultat de sonde en websocket
// ("health.updated"), sur le bus Socket.IO existant — aucun second poller.
healthCheckEngine.onCheckResult = (check) => io.emit("health.updated", check);
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
  .then(startPm2Bus)
  .catch((err) => {
    console.error("Échec d'initialisation de la base de données :", err.message);
    process.exit(1);
  });

process.on("SIGINT", () => {
  notificationDispatchQueue.stop();
  pm2.disconnect();
  db.close().finally(() => process.exit(0));
});
