"use strict";

/**
 * GET /api/dashboard — Phase 8. Un seul endpoint, qui compose des données
 * déjà exposées ailleurs (system, processes, alerts, health-checks, events,
 * auto-healing) via lib/services/dashboard/index.js#buildSnapshot(). Aucune
 * nouvelle table, aucun nouveau scheduler.
 *
 * Permissions (voir docs/dashboard/README.md#permissions) :
 *  - accès à la route : permission globale "system" (même permission que
 *    l'onglet Système existant — le dashboard en est une extension, pas un
 *    nouveau périmètre).
 *  - process : filtrés par la visibilité existante (permission "view" par
 *    app, comme partout ailleurs) — jamais tous les process en clair pour
 *    tout le monde.
 *  - alertes / health checks : inclus seulement si l'utilisateur a
 *    respectivement `alerts_read` / `health_checks_read` ; sinon la
 *    section correspondante vaut `null` plutôt que d'exposer des données
 *    sans droit de les voir.
 */

const express = require("express");
const auth = require("../auth");
const permissions = require("../permissions");
const { buildSnapshot } = require("../services/dashboard");

/** Comme lib/permissions.js#hasPermission, mais true si l'auth est désactivée (voir server.js/lib/auth.js). */
function allowed(user, action) {
  if (!auth.AUTH_ENABLED) return true;
  return permissions.hasPermission(user, undefined, action);
}

function createDashboardRouter({
  pm2,
  fmtProcess,
  visibleProcesses,
  getSystemSnapshot,
  alertStore,
  healthChecksStore,
  eventsStore,
  autoHealingAuditStore,
}) {
  const router = express.Router();

  router.get("/", auth.requirePermission("system"), async (req, res) => {
    try {
      const snapshot = await buildSnapshot({
        listProcesses: () =>
          new Promise((resolve, reject) => {
            pm2.list((err, list) => {
              if (err) return reject(err);
              resolve(visibleProcesses(req.user, list.map(fmtProcess)));
            });
          }),
        getSystemSnapshot,
        alertStore: permissions.hasPermission(req.user, undefined, "alerts_read") ? alertStore : null,
        healthChecksStore: permissions.hasPermission(req.user, undefined, "health_checks_read")
          ? healthChecksStore
          : null,
        eventsStore: permissions.hasPermission(req.user, undefined, "events_read") ? eventsStore : null,
        autoHealingAuditStore: permissions.hasPermission(req.user, undefined, "authealing_read")
          ? autoHealingAuditStore
          : null,
      });
      res.json(snapshot);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createDashboardRouter;
