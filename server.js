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
const AUTH_USER = process.env.PM2_MONITOR_USER || "admin";
const AUTH_PASS = process.env.PM2_MONITOR_PASS || "";
const AUTH_ENABLED = process.env.PM2_MONITOR_DISABLE_AUTH !== "1";

if (AUTH_ENABLED && !AUTH_PASS) {
  console.warn(
    "\n⚠️  Aucun PM2_MONITOR_PASS défini : un mot de passe aléatoire a été généré pour cette session.\n" +
      "   Définis PM2_MONITOR_USER / PM2_MONITOR_PASS (ou un fichier .env) pour un accès stable.\n"
  );
}
const effectivePass = AUTH_PASS || crypto.randomBytes(9).toString("base64");
if (AUTH_ENABLED && !AUTH_PASS) {
  console.warn(`   Identifiants générés → utilisateur: ${AUTH_USER}  mot de passe: ${effectivePass}\n`);
}

function checkCredentials(user, pass) {
  return safeEqual(user, AUTH_USER) && safeEqual(pass, effectivePass);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function basicAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (checkCredentials(user, pass)) return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="PM2 Monitor"');
  res.status(401).send("Authentification requise.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(basicAuth);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Même vérification pour les connexions WebSocket (le navigateur renvoie
// l'en-tête Authorization mise en cache après le premier prompt HTTP).
io.use((socket, next) => {
  if (!AUTH_ENABLED) return next();
  const header = socket.handshake.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (checkCredentials(decoded.slice(0, sep), decoded.slice(sep + 1))) return next();
  }
  next(new Error("unauthorized"));
});

// --- Stores globaux ------------------------------------------------------

const historyStore = new HistoryStore();
const logStore = new LogStore(path.join(__dirname, "data", "logs"));

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

// --- REST API : liste / actions de base sur les process ------------------

app.get("/api/processes", (req, res) => {
  pm2.list((err, list) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(list.map(fmtProcess));
  });
});

app.post("/api/processes/:id/restart", (req, res) => {
  pm2.restart(req.params.id, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.post("/api/processes/:id/stop", (req, res) => {
  pm2.stop(req.params.id, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.post("/api/processes/:id/start", (req, res) => {
  pm2.start(req.params.id, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.post("/api/processes/:id/delete", (req, res) => {
  pm2.delete(req.params.id, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// --- REST API : actions PM2 étendues --------------------------------------

app.post("/api/processes/:id/reload", (req, res) => {
  handleAction(pm2Actions.reload(pm2, req.params.id), res);
});

app.post("/api/processes/:id/scale", (req, res) => {
  handleAction(pm2Actions.scale(pm2, req.params.id, req.body.instances), res);
});

app.post("/api/processes/:id/watch", (req, res) => {
  handleAction(pm2Actions.toggleWatch(pm2, req.params.id, !!req.body.enable), res);
});

app.post("/api/processes/:id/env", (req, res) => {
  handleAction(pm2Actions.editEnv(pm2, req.params.id, req.body.env || {}), res);
});

app.post("/api/processes/:id/config", (req, res) => {
  // { script, args, execMode, instances }
  handleAction(pm2Actions.editConfig(pm2, req.params.id, req.body || {}), res);
});

app.post("/api/pm2/save", (req, res) => {
  handleAction(pm2Actions.save(pm2), res);
});

app.post("/api/pm2/resurrect", (req, res) => {
  handleAction(pm2Actions.resurrect(pm2), res);
});

app.post("/api/processes/:id/flush", (req, res) => {
  handleAction(pm2Actions.flush(pm2, req.params.id), res);
});

app.post("/api/pm2/flush-all", (req, res) => {
  handleAction(pm2Actions.flush(pm2), res);
});

app.post("/api/processes/:id/reset", (req, res) => {
  handleAction(pm2Actions.resetCounter(pm2, req.params.id), res);
});

app.post("/api/pm2/update", (req, res) => {
  handleAction(pm2Actions.updatePM2(pm2), res);
});

app.post("/api/pm2/kill", (req, res) => {
  handleAction(pm2Actions.killDaemon(pm2), res);
});

// --- REST API : système & historique ---------------------------------------

app.get("/api/system", (req, res) => {
  res.json(systemStats.snapshot());
});

app.get("/api/system/history", (req, res) => {
  const range = ["1h", "6h", "24h"].includes(req.query.range) ? req.query.range : "1h";
  res.json({ range, interval: SAMPLE_INTERVAL_MS, samples: historyStore.query(range) });
});

// --- REST API : logs (export brut PM2 + recherche avancée sur nos archives) ---

// Export des logs complets bruts : lit directement les fichiers gérés par PM2
// (out + err), pas seulement ce qui a été capturé en direct côté navigateur.
app.get("/api/processes/:id/logs/export", (req, res) => {
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
app.get("/api/processes/:id/logs/search", (req, res) => {
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
app.get("/api/processes/:id/logs/export-range", (req, res) => {
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
app.get("/api/processes/:id/logs/tail", (req, res) => {
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

app.get("/api/processes/:id/logs/stats", (req, res) => {
  pm2.describe(req.params.id, (err, list) => {
    if (err || !list || !list.length) {
      return res.status(404).json({ error: "Process introuvable." });
    }
    const proc = list[0];
    res.json(logStore.stats(proc.pm_id, proc.name));
  });
});

// --- Realtime: liste des process (polling léger) + logs (bus PM2) ------

io.on("connection", (socket) => {
  const interval = setInterval(() => {
    pm2.list((err, list) => {
      if (err) return;
      socket.emit("processes", list.map(fmtProcess));
    });
  }, 1500);

  socket.on("disconnect", () => clearInterval(interval));
});

// Boucle système : échantillonne + diffuse à tous les clients + alimente l'historique
setInterval(() => {
  const snap = systemStats.snapshot();
  historyStore.push(snap);
  io.emit("system", snap);
}, SAMPLE_INTERVAL_MS);

// Un seul bus de logs partagé, diffusé à tous les clients connectés
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
    });
  });

  server.listen(PORT, () => {
    console.log(`PM2 Monitor disponible sur http://localhost:${PORT}`);
  });
});

process.on("SIGINT", () => {
  pm2.disconnect();
  process.exit(0);
});
