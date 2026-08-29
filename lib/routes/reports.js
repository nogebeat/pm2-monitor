"use strict";

/**
 * Routes REST des rapports (Phase 20 — Reports & Capacity Planning). Même
 * découpage que lib/routes/dashboard.js : ce module ne fait que valider la
 * requête HTTP, résoudre la période, appeler
 * lib/services/reports/aggregator.js#generateReport(), formater la réponse.
 *
 * Monté dans server.js via
 * `app.use("/api/reports", reportsRouter({ pm2, fmtProcess, visibleProcesses, processHistory }))`.
 *
 * Permission unique `reports_read` (voir lib/permissions.js) pour la
 * consultation ET l'export : un rapport n'est qu'une vue dérivée de données
 * déjà lisibles par ailleurs (alertes, incidents, métriques process...) —
 * chaque source individuelle reste de toute façon filtrée par la visibilité
 * de l'utilisateur (permission "view" par process, voir
 * lib/services/reports/scope.js), donc exporter un rapport n'expose jamais
 * plus qu'une consultation normale, contrairement à backup_export (Phase 19)
 * qui peut inclure des secrets chiffrés.
 */

const express = require("express");
const auth = require("../auth");
const permissions = require("../permissions");
const { resolvePeriod, generateReport, exportReport, FORMATS, PERIODS } = require("../services/reports");

function parseFilters(req) {
  const q = req.query || {};
  const period = resolvePeriod({ period: q.period || "daily", start: q.start, end: q.end });
  return {
    ...period,
    serverKey: q.serverKey || undefined,
    environment: q.environment || undefined,
    group: q.group || undefined,
    process: q.process || undefined,
    rankingLimit: q.rankingLimit ? Number(q.rankingLimit) : undefined,
  };
}

function createReportsRouter({ pm2, fmtProcess, visibleProcesses, processHistory }) {
  const router = express.Router();

  function listLiveProcessNames(req) {
    return new Promise((resolve) => {
      if (!pm2 || !fmtProcess || !visibleProcesses) return resolve([]);
      pm2.list((err, list) => {
        if (err) return resolve([]);
        resolve(visibleProcesses(req.user, list.map(fmtProcess)).map((p) => p.name));
      });
    });
  }

  // Même règle que lib/routes/dashboard.js : le Capacity Planning système
  // (CPU/RAM/disque) n'est inclus que si l'utilisateur a la permission
  // "system" (métriques système, lib/permissions.js) — jamais exposé sans droit.
  function canSeeSystemCapacity(req) {
    return permissions.hasPermission(req.user, undefined, "system");
  }

  router.get("/catalog", auth.requirePermission("reports_read"), (req, res) => {
    res.json({
      periods: PERIODS,
      formats: FORMATS,
      rankingCriteria: require("../services/reports").CRITERIA,
    });
  });

  router.get("/", auth.requirePermission("reports_read"), async (req, res) => {
    try {
      const filters = parseFilters(req);
      const liveProcessNames = await listLiveProcessNames(req);
      const report = await generateReport(
        { processHistory, includeSystemCapacity: canSeeSystemCapacity(req), liveProcessNames },
        filters,
        req.user,
      );
      res.json(report);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get("/export", auth.requirePermission("reports_read"), async (req, res) => {
    try {
      const filters = parseFilters(req);
      const format = (req.query.format || "json").toLowerCase();
      const liveProcessNames = await listLiveProcessNames(req);
      const report = await generateReport(
        { processHistory, includeSystemCapacity: canSeeSystemCapacity(req), liveProcessNames },
        filters,
        req.user,
      );
      const { contentType, filename, body } = exportReport(report, format);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(body);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createReportsRouter;
