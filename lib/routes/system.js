"use strict";

/**
 * lib/routes/system.js — extrait de server.js. Monté sur /api/system.
 *
 * `historyStore` est une instance créée une fois dans server.js (buffer en
 * mémoire alimenté par la boucle de polling, voir lib/polling.js) : injectée
 * ici plutôt que ré-instanciée.
 */

const express = require("express");
const auth = require("../auth");
const systemStats = require("../system-stats");
const { SAMPLE_INTERVAL_MS } = require("../history-store");

/**
 * @param {object} deps
 * @param {import("../history-store").HistoryStore} deps.historyStore
 */
function createSystemRouter({ historyStore }) {
  const router = express.Router();

  router.get("/", auth.requirePermission("system"), (req, res) => {
    res.json(systemStats.snapshot());
  });

  router.get("/history", auth.requirePermission("system"), (req, res) => {
    const range = ["1h", "6h", "24h"].includes(req.query.range) ? req.query.range : "1h";
    res.json({ range, interval: SAMPLE_INTERVAL_MS, samples: historyStore.query(range) });
  });

  return router;
}

module.exports = createSystemRouter;
