"use strict";

/**
 * lib/process-helpers.js
 *
 * Helpers utilisés par plusieurs routers process/logs/système
 * (lib/routes/processes.js, lib/routes/logs.js, lib/routes/pm2-daemon.js) ainsi
 * que par le temps réel (lib/realtime/). Extrait de server.js pour éviter la
 * duplication : c'était déjà tout ce qui n'appartenait à aucune route précise
 * dans le fichier original.
 *
 * `pm2` est requis directement ici plutôt qu'injecté : le module `pm2` est un
 * singleton Node (même instance partout où il est require()), donc pas besoin
 * de le faire transiter par un constructeur, exactement comme le fait déjà
 * lib/routes/alerts.js pour ses propres dépendances.
 */

const pm2 = require("pm2");
const auth = require("./auth");
const permissions = require("./permissions");
const { recordEvent, ACTIONS } = require("./services/audit");

// --- Métriques "avancées" best-effort (Phase 11 — Advanced Metrics) --------
//
// PM2 n'expose heap used/total et la latence de l'event loop que pour les
// process Node.js instrumentés côté application (ex: `@pm2/io`/pmx), via
// `pm2_env.axm_monitor` — jamais pour un process quelconque (script Python,
// binaire, Node sans probe…). Contrairement à cpu/memory (toujours présents
// via `p.monit`), ces métriques sont donc absentes la plupart du temps :
// `readAxmMetrics()` les lit quand elles existent et retourne `null` sinon,
// sans jamais rien inventer (voir prompt de phase 11, section "métriques").
//
// Formats observés selon les versions de @pm2/io (labels non garantis) :
//   "Used Heap Size": { value: "42.50 MiB" }   -> heapUsedBytes
//   "Heap Usage":     { value: "63.00 %" }      -> combiné à heapUsedBytes
//                                                  pour dériver heapTotalBytes
//   "Heap Size":      { value: "64.00 MiB" }    -> heapTotalBytes direct si présent
//   "Loop delay" / "Event Loop Latency" / "Event Loop Latency p50": { value: "0.32ms" } -> eventLoopLagMs

const UNIT_MULTIPLIERS = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
};

/** Parse une chaîne de type "42.50 MiB" / "63 %" / "0.32ms" -> { value, unit }. */
function parseAxmValue(raw) {
  if (raw === null || raw === undefined) return null;
  const str = typeof raw === "object" && raw.value !== undefined ? raw.value : raw;
  if (typeof str === "number") return { value: str, unit: "" };
  if (typeof str !== "string") return null;
  const m = str.trim().match(/^(-?[\d.]+)\s*([a-zA-Z%]*)$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: (m[2] || "").toLowerCase() };
}

function toBytes(parsed) {
  if (!parsed) return null;
  const mult = UNIT_MULTIPLIERS[parsed.unit];
  if (!mult) return parsed.unit === "" || parsed.unit === "b" ? Math.round(parsed.value) : null;
  return Math.round(parsed.value * mult);
}

function toMs(parsed) {
  if (!parsed) return null;
  if (parsed.unit === "s") return Math.round(parsed.value * 1000 * 100) / 100;
  return Math.round(parsed.value * 100) / 100; // "ms" ou pas d'unité : déjà en ms
}

function findAxmEntry(axm, patterns) {
  if (!axm || typeof axm !== "object") return null;
  for (const key of Object.keys(axm)) {
    if (patterns.some((re) => re.test(key))) return axm[key];
  }
  return null;
}

/** @param {object} env - pm2_env d'un process (p.pm2_env) */
function readAxmMetrics(env) {
  const axm = env && env.axm_monitor;
  if (!axm) return { heapUsedBytes: null, heapTotalBytes: null, eventLoopLagMs: null };

  const heapUsedBytes = toBytes(parseAxmValue(findAxmEntry(axm, [/used heap size/i])));
  let heapTotalBytes = toBytes(parseAxmValue(findAxmEntry(axm, [/^heap size$/i, /total heap size/i])));

  if (heapTotalBytes === null && heapUsedBytes !== null) {
    // Pas de "Heap Size" direct, mais "Heap Usage" (%) + heap utilisé permettent
    // de dériver le total — valeurs réellement rapportées par PM2, pas inventées.
    const usage = parseAxmValue(findAxmEntry(axm, [/heap usage/i]));
    if (usage && usage.value > 0) {
      heapTotalBytes = Math.round(heapUsedBytes / (usage.value / 100));
    }
  }

  const eventLoopLagMs = toMs(
    parseAxmValue(findAxmEntry(axm, [/loop delay/i, /event loop latency$/i, /event loop latency p50/i])),
  );

  return { heapUsedBytes, heapTotalBytes, eventLoopLagMs };
}

/** Normalise un process pm2.list()/pm2.describe() vers le format renvoyé au frontend. */
function fmtProcess(p) {
  const env = p.pm2_env || {};
  const axm = readAxmMetrics(env);
  return {
    id: p.pm_id,
    name: p.name,
    pid: p.pid,
    status: env.status, // online | stopped | errored | stopping | launching
    restarts: env.restart_time || 0,
    uptime: env.pm_uptime || null,
    createdAt: env.created_at || null,
    cpu: p.monit ? p.monit.cpu : 0,
    memory: p.monit ? p.monit.memory : 0, // RSS process (octets) — voir docs/process-history/README.md
    instances: env.instances || 1,
    execMode: env.exec_mode || "",
    version: env.version || "",
    watching: !!env.watch,
    script: env.pm_exec_path || "",
    args: env.args || [],
    cwd: env.pm_cwd || "",
    env: env.env || {},
    // Best-effort (Phase 11), null si le process n'expose pas axm_monitor.
    heapUsedBytes: axm.heapUsedBytes,
    heapTotalBytes: axm.heapTotalBytes,
    eventLoopLagMs: axm.eventLoopLagMs,
  };
}

function withPm2(cb) {
  pm2.connect((err) => {
    if (err) return cb(err);
    cb(null);
  });
}

/** Pour les actions basées sur une Promise (lib/pm2-actions.js). */
function handleAction(promise, res, audit) {
  promise
    .then(() => {
      if (audit) {
        recordEvent({ ...audit, status: "success" });
      }
      res.json({ ok: true });
    })
    .catch((err) => {
      if (audit) {
        recordEvent({
          ...audit,
          status: "failed",
          metadata: { ...(audit.metadata || {}), error: err.message },
        });
      }
      res.status(500).json({ error: err.message });
    });
}

/** Comme handleAction, mais pour les actions pm2.* basées sur callback (err) plutôt que Promise. */
function handleCallbackAction(fn, res, audit) {
  fn((err) => {
    if (err) {
      if (audit) {
        recordEvent({
          ...audit,
          status: "failed",
          metadata: { ...(audit.metadata || {}), error: err.message },
        });
      }
      return res.status(500).json({ error: err.message });
    }
    if (audit) {
      recordEvent({ ...audit, status: "success" });
    }
    res.json({ ok: true });
  });
}

/** Filtre une liste de process pm2 formatés selon ce que l'utilisateur peut "view". */
function visibleProcesses(user, list) {
  if (!auth.AUTH_ENABLED) return list;
  if (user && user.isAdmin) return list;
  return list.filter((p) => permissions.hasPermission(user, p.name, "view"));
}

// Sous-ensemble des actions process considérées "sensibles" au sens de
// l'audit (section 1 du prompt maître) — mappe l'action de permission
// (lib/permissions.js#APP_ACTIONS) vers la constante ACTIONS.* correspondante.
// Les actions non listées ici (scale/watch/flush/reset/logs/view…) ne sont
// pas auditées : elles ne figurent pas dans la liste du prompt maître, et
// pour "flush"/"reset"/"scale"/"watch" ce sont des réglages mineurs, pas
// des actions "sensibles" au même titre que start/stop/delete.
const AUDITED_APP_ACTIONS = {
  start: ACTIONS.PROCESS_START,
  stop: ACTIONS.PROCESS_STOP,
  restart: ACTIONS.PROCESS_RESTART,
  reload: ACTIONS.PROCESS_RELOAD,
  delete: ACTIONS.PROCESS_DELETE,
  env: ACTIONS.PROCESS_ENV_CHANGE,
  config: ACTIONS.PROCESS_CONFIG_CHANGE,
};

/**
 * Résout le nom d'app pm2 depuis un :id de route, puis vérifie la permission
 * avant d'exécuter le handler. Renvoie 404 si le process n'existe pas et 403
 * si l'action n'est pas autorisée sur cette app précise.
 *
 * Audite les refus de permission ("denied") pour les actions sensibles
 * (voir AUDITED_APP_ACTIONS) : un utilisateur qui tente une action non
 * autorisée doit laisser une trace, même si l'action n'a jamais eu lieu.
 */
function withAppPermission(action) {
  return (req, res, next) => {
    if (!auth.AUTH_ENABLED) return next();
    pm2.describe(req.params.id, (err, list) => {
      if (err || !list || !list.length) {
        return res.status(404).json({ error: "Process introuvable." });
      }
      if (!permissions.hasPermission(req.user, list[0].name, action)) {
        const auditAction = AUDITED_APP_ACTIONS[action];
        if (auditAction) {
          recordEvent({
            user: req.user,
            action: auditAction,
            target: list[0].name,
            targetType: "process",
            status: "denied",
            ip: req.ip,
          });
        }
        return res.status(403).json({ error: "Action non autorisée pour cette app." });
      }
      req.processName = list[0].name; // résolu une fois ici, réutilisé par le handler pour l'audit
      next();
    });
  };
}

module.exports = {
  fmtProcess,
  readAxmMetrics,
  withPm2,
  handleAction,
  handleCallbackAction,
  visibleProcesses,
  AUDITED_APP_ACTIONS,
  withAppPermission,
};
