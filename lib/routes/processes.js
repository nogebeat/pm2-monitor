"use strict";

/**
 * lib/routes/processes.js — extrait de server.js. Monté sur /api.
 * Couvre la liste des process, les actions de base (start/stop/restart/delete,
 * callback pm2.* directes) et les actions étendues (lib/pm2-actions.js :
 * reload/scale/watch/env/config/flush/reset), ainsi que /processes/:id/metrics
 * et /processes/:id/analytics (lib/services/process-history/, Phase 11).
 *
 * `processHistory` est une instance créée une fois dans server.js (son
 * constructeur lit process.env) : elle est donc injectée ici plutôt que
 * require()-ée directement, contrairement à pm2/pm2Actions qui sont des
 * singletons stateless.
 */

const express = require("express");
const pm2 = require("pm2");
const pm2Actions = require("../pm2-actions");
const { ACTIONS } = require("../services/audit");
const {
  fmtProcess,
  visibleProcesses,
  withAppPermission,
  handleAction,
  handleCallbackAction,
} = require("../process-helpers");

/**
 * @param {object} deps
 * @param {import("../services/process-history").ProcessHistoryService} deps.processHistory
 */
function createProcessesRouter({ processHistory }) {
  const router = express.Router();

  // --- Liste / actions de base sur les process ------------------------------

  router.get("/processes", (req, res) => {
    pm2.list((err, list) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(visibleProcesses(req.user, list.map(fmtProcess)));
    });
  });

  router.post("/processes/:id/restart", withAppPermission("restart"), (req, res) => {
    handleCallbackAction((cb) => pm2.restart(req.params.id, cb), res, {
      user: req.user,
      action: ACTIONS.PROCESS_RESTART,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
    });
  });

  router.post("/processes/:id/stop", withAppPermission("stop"), (req, res) => {
    handleCallbackAction((cb) => pm2.stop(req.params.id, cb), res, {
      user: req.user,
      action: ACTIONS.PROCESS_STOP,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
    });
  });

  router.post("/processes/:id/start", withAppPermission("start"), (req, res) => {
    handleCallbackAction((cb) => pm2.start(req.params.id, cb), res, {
      user: req.user,
      action: ACTIONS.PROCESS_START,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
    });
  });

  router.post("/processes/:id/delete", withAppPermission("delete"), (req, res) => {
    handleCallbackAction((cb) => pm2.delete(req.params.id, cb), res, {
      user: req.user,
      action: ACTIONS.PROCESS_DELETE,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
    });
  });

  // --- Actions PM2 étendues --------------------------------------------------

  router.post("/processes/:id/reload", withAppPermission("reload"), (req, res) => {
    handleAction(pm2Actions.reload(pm2, req.params.id), res, {
      user: req.user,
      action: ACTIONS.PROCESS_RELOAD,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
    });
  });

  router.post("/processes/:id/scale", withAppPermission("scale"), (req, res) => {
    handleAction(pm2Actions.scale(pm2, req.params.id, req.body.instances), res);
  });

  router.post("/processes/:id/watch", withAppPermission("watch"), (req, res) => {
    handleAction(pm2Actions.toggleWatch(pm2, req.params.id, !!req.body.enable), res);
  });

  router.post("/processes/:id/env", withAppPermission("env"), (req, res) => {
    // Metadata volontairement limitée aux CLÉS d'environnement modifiées, jamais
    // aux valeurs : une variable d'env est un vecteur fréquent de secret
    // (voir lib/services/audit/sanitize.js — filet de sécurité indépendant,
    // mais on évite ici de lui donner quoi que ce soit à filtrer).
    const envKeys = Object.keys(req.body.env || {});
    handleAction(pm2Actions.editEnv(pm2, req.params.id, req.body.env || {}), res, {
      user: req.user,
      action: ACTIONS.PROCESS_ENV_CHANGE,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
      metadata: { envKeys },
    });
  });

  router.post("/processes/:id/config", withAppPermission("config"), (req, res) => {
    // { script, args, execMode, instances }
    handleAction(pm2Actions.editConfig(pm2, req.params.id, req.body || {}), res, {
      user: req.user,
      action: ACTIONS.PROCESS_CONFIG_CHANGE,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
      metadata: { fields: Object.keys(req.body || {}) },
    });
  });

  router.post("/processes/:id/flush", withAppPermission("flush"), (req, res) => {
    handleAction(pm2Actions.flush(pm2, req.params.id), res);
  });

  router.post("/processes/:id/reset", withAppPermission("reset"), (req, res) => {
    handleAction(pm2Actions.resetCounter(pm2, req.params.id), res);
  });

  // Historique CPU/RAM/restarts d'un process (lib/services/process-history/).
  // Même permission que la vue du process ("view") : lecture seule, pas d'action PM2.
  router.get("/processes/:id/metrics", withAppPermission("view"), (req, res) => {
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

  // Analytics (Phase 11) : stats de période (avg/min/max/p95, restarts,
  // crashes, disponibilité) + comparaison à la période précédente. Même
  // permission que /metrics ("view", lecture seule).
  router.get("/processes/:id/analytics", withAppPermission("view"), (req, res) => {
    pm2.describe(req.params.id, async (err, list) => {
      if (err || !list || !list.length) {
        return res.status(404).json({ error: "Process introuvable." });
      }
      try {
        const { start, end, resolution, compare } = req.query;
        const result = await processHistory.analytics({
          processName: list[0].name,
          start: start !== undefined ? Number(start) : undefined,
          end: end !== undefined ? Number(end) : undefined,
          resolution,
          compare: compare === undefined ? true : compare !== "0" && compare !== "false",
        });
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });
  });

  return router;
}

module.exports = createProcessesRouter;
