const express = require("express");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pm2 = require("pm2");
const { Server } = require("socket.io");

const systemStats = require("./lib/system-stats");
const { HistoryStore, SAMPLE_INTERVAL_MS } = require("./lib/history-store");
const { LogStore } = require("./lib/log-store");
const pm2Actions = require("./lib/pm2-actions");
const db = require("./lib/db");
const migrator = require("./lib/db/migrator");
const userStore = require("./lib/user-store");
const permissions = require("./lib/permissions");
const auth = require("./lib/auth");
const { engine: alertEngine } = require("./lib/services/alerts");
const alertsRouter = require("./lib/routes/alerts");
const { ProcessHistoryService } = require("./lib/services/process-history");
const { EventsService } = require("./lib/services/events");
const eventsRouter = require("./lib/routes/events");
const notificationsRouter = require("./lib/routes/notifications");
const {
  routingEngine: notificationRoutingEngine,
  dispatchQueue: notificationDispatchQueue,
} = require("./lib/services/notifications");

// --- Config / .env minimal (pas de dépendance dotenv) -----------------

loadDotEnv();

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (!m) return;
      const key = m[1];
      let val = (m[2] || "").trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    });
}

const PORT = process.env.PORT || 4200;

// --- Moteur d'alertes : activable/désactivable (voir lib/services/alerts/
// et docs/alerts/README.md). Depuis la Phase 5D, une transition
// trigger->active ou ->resolved déclenche en plus le routing des
// notifications (voir plus bas, NOTIFICATIONS_DISPATCH_ENABLED) --------
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

/**
 * Détecte, sans modifier lib/services/alerts/engine.js, qu'un résultat
 * d'evaluate() correspond à une transition "on vient de passer active"
 * (triggeredAt vient d'être posé au même timestamp que lastSeenAt — un
 * touch() ultérieur avance lastSeenAt sans toucher triggeredAt, donc cette
 * égalité n'est vraie qu'au tick de la transition trigger->active, voir
 * engine.js#trigger) ou "on vient de passer resolved" (resolve() est
 * terminal pour une occurrence : dedupKey sort des OPEN_STATES, donc ce
 * résultat n'est jamais revu par un futur evaluate() sur la même occurrence
 * — pas besoin d'égalité de timestamp ici).
 */
function dispatchAlertTransition(alert) {
  if (!NOTIFICATIONS_DISPATCH_ENABLED || !alert) return;
  if (alert.state === "active" && alert.triggeredAt === alert.lastSeenAt) {
    notificationRoutingEngine.dispatch(alert, "triggered").catch((e) => {
      console.error("Erreur de dispatch de notification (déclenchement) :", e.message);
    });
  } else if (alert.state === "resolved") {
    notificationRoutingEngine.dispatch(alert, "resolved").catch((e) => {
      console.error("Erreur de dispatch de notification (résolution) :", e.message);
    });
  }
}

// --- Historique par process : activable/désactivable (voir
// lib/services/process-history/ et PROCESS_HISTORY_* dans .env.example) ---
// Instancié seulement après loadDotEnv() (le service lit process.env dans
// son constructeur, voir lib/services/process-history/index.js).
const processHistory = new ProcessHistoryService();

// --- Timeline d'événements/crashs : activable/désactivable (voir
// lib/services/events/ et EVENTS_* dans .env.example). Même contrainte
// d'instanciation tardive que processHistory ci-dessus (lit process.env au
// constructeur, doit donc être créé après loadDotEnv()).
const eventsService = new EventsService();

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

// --- Stores globaux ------------------------------------------------------

const historyStore = new HistoryStore();
const logStore = new LogStore(path.join(__dirname, "data", "logs"));

// --- Bootstrap : DB + migration douce depuis l'ancien mode mono-utilisateur ---

async function ensureBootstrapAdmin() {
  const n = await userStore.countUsers();
  if (n > 0) return;

  // Migration depuis l'ancien système (.env PM2_MONITOR_USER/PM2_MONITOR_PASS)
  // ou génération d'un compte admin par défaut, pour ne pas laisser une
  // installation existante sans accès après mise à jour.
  const legacyUser = process.env.PM2_MONITOR_USER || "admin";
  const legacyPass = process.env.PM2_MONITOR_PASS || crypto.randomBytes(9).toString("base64");

  await userStore.createUser({ username: legacyUser, password: legacyPass, isAdmin: true });

  console.warn(
    `\n👤  Aucun utilisateur trouvé : un compte administrateur a été créé.\n` +
      `   Identifiant : ${legacyUser}\n` +
      (process.env.PM2_MONITOR_PASS
        ? ""
        : `   Mot de passe (généré, à noter) : ${legacyPass}\n`) +
      `   Gère les comptes ensuite depuis l'UI (menu utilisateurs) ou via ` +
      `\`node bin/manage-users.js\`.\n`
  );
}

// --- Helpers ---------------------------------------------------------

function fmtProcess(p) {
  const env = p.pm2_env || {};
  return {
    id: p.pm_id,
    name: p.name,
    pid: p.pid,
    status: env.status, // online | stopped | errored | stopping | launching
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

function withPm2(cb) {
  pm2.connect((err) => {
    if (err) return cb(err);
    cb(null);
  });
}

function handleAction(promise, res) {
  promise
    .then(() => res.json({ ok: true }))
    .catch((err) => res.status(500).json({ error: err.message }));
}

/** Filtre une liste de process pm2 formatés selon ce que l'utilisateur peut "view". */
function visibleProcesses(user, list) {
  if (!auth.AUTH_ENABLED) return list;
  if (user && user.isAdmin) return list;
  return list.filter((p) => permissions.hasPermission(user, p.name, "view"));
}

/**
 * Résout le nom d'app pm2 depuis un :id de route, puis vérifie la permission
 * avant d'exécuter le handler. Renvoie 404 si le process n'existe pas et 403
 * si l'action n'est pas autorisée sur cette app précise.
 */
function withAppPermission(action) {
  return (req, res, next) => {
    if (!auth.AUTH_ENABLED) return next();
    pm2.describe(req.params.id, (err, list) => {
      if (err || !list || !list.length) {
        return res.status(404).json({ error: "Process introuvable." });
      }
      if (!permissions.hasPermission(req.user, list[0].name, action)) {
        return res.status(403).json({ error: "Action non autorisée pour cette app." });
      }
      next();
    });
  };
}

// --- REST API : authentification -----------------------------------------

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await userStore.verifyCredentials(username, password);
    if (!user) return res.status(401).json({ error: "Identifiants invalides." });
    req.session.userId = user.id;
    res.json({ ok: true, user: { username: user.username, isAdmin: user.isAdmin } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/auth/logout", (req, res) => {
  if (req.session) req.session.destroy(() => {});
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  if (!auth.AUTH_ENABLED) {
    return res.json({ authEnabled: false, user: { username: "anonyme", isAdmin: true, permissions: [] } });
  }
  if (!req.user) return res.status(401).json({ error: "Non authentifié." });
  res.json({ authEnabled: true, user: req.user });
});

// --- REST API : gestion des utilisateurs (admin seulement) ---------------

app.get("/api/users", auth.requireAdmin, async (req, res) => {
  try {
    res.json(await userStore.listUsers());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/users", auth.requireAdmin, async (req, res) => {
  try {
    const { username, password, isAdmin, permissions: perms } = req.body || {};
    const user = await userStore.createUser({ username, password, isAdmin: !!isAdmin });
    if (Array.isArray(perms) && perms.length) {
      await userStore.replacePermissions(user.id, perms);
    }
    res.json(await userStore.getUserWithPermissions(user.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/users/:id", auth.requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { password, isAdmin, permissions: perms } = req.body || {};
    if (password) await userStore.setPassword(id, password);
    if (isAdmin !== undefined) await userStore.setAdmin(id, !!isAdmin);
    if (Array.isArray(perms)) await userStore.replacePermissions(id, perms);
    const updated = await userStore.getUserWithPermissions(id);
    if (!updated) return res.status(404).json({ error: "Utilisateur introuvable." });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/users/:id", auth.requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (req.user && req.user.id === id) {
      return res.status(400).json({ error: "Impossible de supprimer son propre compte." });
    }
    await userStore.deleteUser(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/permissions/catalog", auth.requireAdmin, (req, res) => {
  res.json({
    appActions: permissions.APP_ACTIONS,
    globalActions: permissions.GLOBAL_ACTIONS,
  });
});

// --- REST API : moteur d'alertes (lib/services/alerts/, lib/routes/alerts.js) ---

app.use("/api/alerts", alertsRouter());

// --- REST API : timeline d'événements/crashs (lib/services/events/, lib/routes/events.js) ---

app.use("/api/events", eventsRouter(eventsService));

// --- REST API : notification system, fondations Phase 5A (lib/services/notifications/, lib/routes/notifications.js) ---

app.use("/api/notifications", notificationsRouter());

// --- REST API : liste / actions de base sur les process ------------------

app.get("/api/processes", (req, res) => {
  pm2.list((err, list) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(visibleProcesses(req.user, list.map(fmtProcess)));
  });
});

app.post("/api/processes/:id/restart", withAppPermission("restart"), (req, res) => {
  pm2.restart(req.params.id, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.post("/api/processes/:id/stop", withAppPermission("stop"), (req, res) => {
  pm2.stop(req.params.id, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.post("/api/processes/:id/start", withAppPermission("start"), (req, res) => {
  pm2.start(req.params.id, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.post("/api/processes/:id/delete", withAppPermission("delete"), (req, res) => {
  pm2.delete(req.params.id, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// --- REST API : actions PM2 étendues --------------------------------------

app.post("/api/processes/:id/reload", withAppPermission("reload"), (req, res) => {
  handleAction(pm2Actions.reload(pm2, req.params.id), res);
});

app.post("/api/processes/:id/scale", withAppPermission("scale"), (req, res) => {
  handleAction(pm2Actions.scale(pm2, req.params.id, req.body.instances), res);
});

app.post("/api/processes/:id/watch", withAppPermission("watch"), (req, res) => {
  handleAction(pm2Actions.toggleWatch(pm2, req.params.id, !!req.body.enable), res);
});

app.post("/api/processes/:id/env", withAppPermission("env"), (req, res) => {
  handleAction(pm2Actions.editEnv(pm2, req.params.id, req.body.env || {}), res);
});

app.post("/api/processes/:id/config", withAppPermission("config"), (req, res) => {
  // { script, args, execMode, instances }
  handleAction(pm2Actions.editConfig(pm2, req.params.id, req.body || {}), res);
});

app.post("/api/pm2/save", auth.requirePermission("pm2_save"), (req, res) => {
  handleAction(pm2Actions.save(pm2), res);
});

app.post("/api/pm2/resurrect", auth.requirePermission("pm2_resurrect"), (req, res) => {
  handleAction(pm2Actions.resurrect(pm2), res);
});

app.post("/api/processes/:id/flush", withAppPermission("flush"), (req, res) => {
  handleAction(pm2Actions.flush(pm2, req.params.id), res);
});

app.post("/api/pm2/flush-all", auth.requirePermission("pm2_flush_all"), (req, res) => {
  handleAction(pm2Actions.flush(pm2), res);
});

app.post("/api/processes/:id/reset", withAppPermission("reset"), (req, res) => {
  handleAction(pm2Actions.resetCounter(pm2, req.params.id), res);
});

app.post("/api/pm2/update", auth.requirePermission("pm2_update"), (req, res) => {
  handleAction(pm2Actions.updatePM2(pm2), res);
});

app.post("/api/pm2/kill", auth.requirePermission("pm2_kill"), (req, res) => {
  handleAction(pm2Actions.killDaemon(pm2), res);
});

// --- REST API : système & historique ---------------------------------------

app.get("/api/system", auth.requirePermission("system"), (req, res) => {
  res.json(systemStats.snapshot());
});

app.get("/api/system/history", auth.requirePermission("system"), (req, res) => {
  const range = ["1h", "6h", "24h"].includes(req.query.range) ? req.query.range : "1h";
  res.json({ range, interval: SAMPLE_INTERVAL_MS, samples: historyStore.query(range) });
});

// --- REST API : logs (export brut PM2 + recherche avancée sur nos archives) ---

// Export des logs complets bruts : lit directement les fichiers gérés par PM2
// (out + err), pas seulement ce qui a été capturé en direct côté navigateur.
app.get("/api/processes/:id/logs/export", withAppPermission("logs"), (req, res) => {
  pm2.describe(req.params.id, (err, list) => {
    if (err || !list || !list.length) {
      return res.status(404).json({ error: "Process introuvable." });
    }
    const proc = list[0];
    const env = proc.pm2_env || {};
    const which = req.query.type === "out" || req.query.type === "err" ? req.query.type : "all";

    const parts = [];
    if ((which === "all" || which === "out") && env.pm_out_log_path) {
      parts.push(readLogSafe(env.pm_out_log_path, "STDOUT"));
    }
    if ((which === "all" || which === "err") && env.pm_err_log_path) {
      parts.push(readLogSafe(env.pm_err_log_path, "STDERR"));
    }

    const body = parts.filter(Boolean).join("\n\n");
    const filename = `${proc.name}-${which}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(body || "(fichier de log vide ou introuvable)");
  });
});

function readLogSafe(filePath, label) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return `===== ${label} (${filePath}) =====\n${content}`;
  } catch (e) {
    return `===== ${label} (${filePath}) =====\n(illisible : ${e.message})`;
  }
}

// Lit les dernières lignes d'un fichier log natif PM2 (sans tout charger en mémoire
// pour les gros fichiers), utilisé pour l'historique affiché à la sélection d'un process.
// C'est la même source que "pm2 logs" en CLI, donc indépendante du bus PM2 en temps réel.
function readTailLinesSafe(filePath, maxLines) {
  const MAX_BYTES = 300 * 1024; // largement suffisant pour ~maxLines lignes usuelles
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - MAX_BYTES);
    const fd = fs.openSync(filePath, "r");
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    let text = buffer.toString("utf8");
    if (start > 0) {
      // la première ligne peut être coupée en plein milieu : on la jette
      const firstBreak = text.indexOf("\n");
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
    }
    return text.split("\n").filter(Boolean).slice(-maxLines);
  } catch (e) {
    return [];
  }
}

// Recherche full-text / regex / niveau / date sur nos logs persistés (avec timestamp par ligne)
app.get("/api/processes/:id/logs/search", withAppPermission("logs"), (req, res) => {
  pm2.describe(req.params.id, (err, list) => {
    if (err || !list || !list.length) {
      return res.status(404).json({ error: "Process introuvable." });
    }
    const proc = list[0];
    const result = logStore.search(proc.pm_id, proc.name, {
      type: req.query.type || "all",
      level: req.query.level || "all",
      query: req.query.q || "",
      regex: req.query.regex === "1",
      from: req.query.from ? Number(req.query.from) : 0,
      to: req.query.to ? Number(req.query.to) : Infinity,
      limit: req.query.limit ? Number(req.query.limit) : 1000,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  });
});

// Export d'une période précise (date de début / fin en ms epoch)
app.get("/api/processes/:id/logs/export-range", withAppPermission("logs"), (req, res) => {
  pm2.describe(req.params.id, (err, list) => {
    if (err || !list || !list.length) {
      return res.status(404).json({ error: "Process introuvable." });
    }
    const proc = list[0];
    const from = req.query.from ? Number(req.query.from) : 0;
    const to = req.query.to ? Number(req.query.to) : Infinity;
    const type = req.query.type || "all";
    const body = logStore.exportRange(proc.pm_id, proc.name, { from, to, type });
    const filename = `${proc.name}-periode-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(body || "(aucune ligne dans cette période)");
  });
});

// Historique immédiat à afficher quand on sélectionne un process dans l'UI :
// lit directement les fichiers de log natifs PM2 (out + err), exactement comme
// le ferait `pm2 logs`, plutôt que d'attendre une nouvelle ligne en direct.
app.get("/api/processes/:id/logs/tail", withAppPermission("logs"), (req, res) => {
  pm2.describe(req.params.id, (err, list) => {
    if (err || !list || !list.length) {
      return res.status(404).json({ error: "Process introuvable." });
    }
    const proc = list[0];
    const env = proc.pm2_env || {};
    const limit = req.query.lines ? Math.min(1000, Number(req.query.lines)) : 200;

    // On borne chaque flux séparément (et pas leur concaténation) pour être sûr de
    // représenter à la fois stdout et stderr, même si l'un des deux est très bavard.
    const outLines = env.pm_out_log_path ? readTailLinesSafe(env.pm_out_log_path, limit) : [];
    const errLines = env.pm_err_log_path ? readTailLinesSafe(env.pm_err_log_path, limit) : [];

    // On ne connaît pas l'horodatage exact de chaque ligne native PM2 (pas de JSON structuré),
    // donc on les restitue dans leur ordre de fichier respectif, stdout puis stderr,
    // avec une étiquette "historique" côté frontend plutôt qu'une heure précise.
    const results = [
      ...outLines.map((text) => ({ type: "out", text })),
      ...errLines.map((text) => ({ type: "err", text })),
    ];

    res.json({ results, pmId: proc.pm_id });
  });
});

app.get("/api/processes/:id/logs/stats", withAppPermission("logs"), (req, res) => {
  pm2.describe(req.params.id, (err, list) => {
    if (err || !list || !list.length) {
      return res.status(404).json({ error: "Process introuvable." });
    }
    const proc = list[0];
    res.json(logStore.stats(proc.pm_id, proc.name));
  });
});

// Historique CPU/RAM/restarts d'un process (lib/services/process-history/).
// Même permission que la vue du process ("view") : lecture seule, pas d'action PM2.
app.get("/api/processes/:id/metrics", withAppPermission("view"), (req, res) => {
  pm2.describe(req.params.id, async (err, list) => {
    if (err || !list || !list.length) {
      return res.status(404).json({ error: "Process introuvable." });
    }
    try {
      const { start, end, resolution } = req.query;
      const metrics = req.query.metrics ? String(req.query.metrics).split(",").filter(Boolean) : undefined;
      const result = await processHistory.query({
        processName: list[0].name,
        start: start !== undefined ? Number(start) : undefined,
        end: end !== undefined ? Number(end) : undefined,
        resolution,
        metrics,
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

// --- Realtime: liste des process (polling léger) + logs (bus PM2) ------

io.on("connection", (socket) => {
  const sessUserId = auth.AUTH_ENABLED ? socket.request.session && socket.request.session.userId : 0;

  const interval = setInterval(() => {
    pm2.list(async (err, list) => {
      if (err) return;
      let user = null;
      if (auth.AUTH_ENABLED) {
        user = sessUserId ? await userStore.getUserWithPermissions(sessUserId) : null;
      }
      socket.emit("processes", visibleProcesses(user, list.map(fmtProcess)));
    });
  }, 1500);

  socket.on("disconnect", () => clearInterval(interval));
});

// Boucle système : échantillonne + diffuse à tous les clients + alimente l'historique
setInterval(() => {
  const snap = systemStats.snapshot();
  historyStore.push(snap);
  io.emit("system", snap);
  if (ALERTS_ENABLED) {
    alertEngine
      .evaluateSystemReading(snap)
      .then((results) => results.forEach(dispatchAlertTransition))
      .catch((e) => {
        console.error("Erreur d'évaluation des alertes système :", e.message);
      });
  }
}, SAMPLE_INTERVAL_MS);

// Boucle dédiée au polling process, partagée par l'évaluation des règles
// d'alerte "process" (CPU/RAM/restarts/statut par app) ET la collecte
// d'historique par process (lib/services/process-history/). Indépendante du
// polling par socket ci-dessus (qui ne tourne que si un client est connecté) :
// les deux doivent continuer même sans personne devant le dashboard.
// Réutilise un seul pm2.list() + fmtProcess() par tick — pas de second bus PM2
// ni de second poller. Tourne à ALERTS_EVAL_INTERVAL_MS : c'est aussi la
// valeur par défaut de PROCESS_HISTORY_COLLECT_INTERVAL_MS (15s), donc les
// deux réglages restent cohérents sans config supplémentaire.
if (ALERTS_ENABLED || processHistory.config.enabled) {
  setInterval(() => {
    pm2.list((err, list) => {
      if (err) return; // PM2 momentanément indisponible : on retentera au prochain tick
      const processes = list.map(fmtProcess);
      if (ALERTS_ENABLED) {
        alertEngine
          .evaluateProcessReadings(processes)
          .then((results) => results.forEach(dispatchAlertTransition))
          .catch((e) => {
            console.error("Erreur d'évaluation des alertes process :", e.message);
          });
      }
      if (processHistory.config.enabled) {
        processHistory.record(processes).catch((e) => {
          console.error("Erreur de collecte de l'historique process :", e.message);
        });
      }
    });
  }, ALERTS_EVAL_INTERVAL_MS);
}

// Maintenance (rollup + purge) de l'historique process, sur son propre
// intervalle (PROCESS_HISTORY_MAINTENANCE_INTERVAL_MS) indépendant du polling.
processHistory.start();

// Purge périodique de la timeline d'événements (rétention EVENTS_RETENTION_MS),
// sur son propre intervalle indépendant — même découpage que processHistory ci-dessus.
eventsService.start();

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

// Un seul bus de logs partagé, diffusé à tous les clients connectés
// (le filtrage par permission "logs" sur une app précise se fait déjà côté
// REST pour l'historique/export ; en direct, le frontend n'affiche que les
// logs de l'app sélectionnée, elle-même filtrée par la liste de process visible).
function startPm2Bus() {
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
            if (stored) io.emit("timeline_event", stored);
          })
          .catch((e) => {
            console.error("Erreur d'enregistrement dans la timeline d'événements :", e.message);
          });
      });
    });

    server.listen(PORT, () => {
      console.log(`PM2 Monitor disponible sur http://localhost:${PORT}`);
    });
  });
}

// --- Démarrage : DB, migrations, puis bus PM2 --------------------------

async function runMigrationsAtBoot() {
  const applied = await migrator.up();
  if (applied.length) {
    console.log(`🗄️  Migrations appliquées au démarrage : ${applied.join(", ")}`);
  }
}

db.init()
  .then(runMigrationsAtBoot)
  .then(ensureBootstrapAdmin)
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
