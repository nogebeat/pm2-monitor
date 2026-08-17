"use strict";

/**
 * lib/routes/pm2-daemon.js — extrait de server.js. Monté sur /api/pm2.
 * Actions globales sur le daemon PM2 (par opposition aux actions ciblant un
 * process précis, voir lib/routes/processes.js).
 */

const express = require("express");
const pm2 = require("pm2");
const pm2Actions = require("../pm2-actions");
const auth = require("../auth");
const { ACTIONS } = require("../services/audit");
const { handleAction } = require("../process-helpers");

function createPm2DaemonRouter() {
  const router = express.Router();

  router.post("/save", auth.requirePermission("pm2_save", null, { action: ACTIONS.PM2_SAVE, targetType: "pm2_daemon" }), (req, res) => {
    handleAction(pm2Actions.save(pm2), res, {
      user: req.user,
      action: ACTIONS.PM2_SAVE,
      targetType: "pm2_daemon",
      ip: req.ip,
    });
  });

  router.post("/resurrect", auth.requirePermission("pm2_resurrect", null, { action: ACTIONS.PM2_RESURRECT, targetType: "pm2_daemon" }), (req, res) => {
    handleAction(pm2Actions.resurrect(pm2), res, {
      user: req.user,
      action: ACTIONS.PM2_RESURRECT,
      targetType: "pm2_daemon",
      ip: req.ip,
    });
  });

  router.post("/flush-all", auth.requirePermission("pm2_flush_all"), (req, res) => {
    handleAction(pm2Actions.flush(pm2), res);
  });

  router.post("/update", auth.requirePermission("pm2_update"), (req, res) => {
    handleAction(pm2Actions.updatePM2(pm2), res);
  });

  router.post("/kill", auth.requirePermission("pm2_kill", null, { action: ACTIONS.PM2_KILL, targetType: "pm2_daemon" }), (req, res) => {
    handleAction(pm2Actions.killDaemon(pm2), res, {
      user: req.user,
      action: ACTIONS.PM2_KILL,
      targetType: "pm2_daemon",
      ip: req.ip,
    });
  });

  return router;
}

module.exports = createPm2DaemonRouter;
