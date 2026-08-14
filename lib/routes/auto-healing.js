"use strict";

/**
 * Routes REST Auto-Healing (Phase 7). Même découpage que
 * lib/routes/health-checks.js : la logique métier vit dans
 * lib/services/auto-healing/ (settings/state/audit stores + engine), ce
 * module ne fait que valider la requête HTTP, vérifier les permissions,
 * appeler le service, formater la réponse.
 *
 * Monté dans server.js via `app.use("/api/auto-healing", require("./lib/routes/auto-healing")(service))`.
 */

const express = require("express");
const auth = require("../auth");
const { settingsStore, stateStore, auditStore } = require("../services/auto-healing");

function createAutoHealingRouter(service) {
  const router = express.Router();

  router.get("/settings", auth.requirePermission("authealing_read"), async (req, res) => {
    try {
      res.json(await settingsStore.get());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // enabled/maxAttempts/backoffSeconds : activer Auto-Healing (ou changer sa
  // config) est explicitement une action de gestion, jamais un effet de bord
  // d'une autre route (section 7 du prompt maître : "une activation doit
  // nécessiter une action explicite").
  router.put("/settings", auth.requirePermission("authealing_manage"), async (req, res) => {
    try {
      const updated = await settingsStore.update(req.body || {}, {
        userId: req.user ? req.user.id : null,
      });
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get("/state", auth.requirePermission("authealing_read"), async (req, res) => {
    try {
      res.json(await stateStore.list());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/state/:process", auth.requirePermission("authealing_read"), async (req, res) => {
    try {
      res.json(await stateStore.get(req.params.process));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Déblocage explicite d'un process AUTO-HEALING BLOCKED. C'est la seule
  // façon de sortir de l'état bloqué (section 6 du prompt maître).
  router.post("/state/:process/unblock", auth.requirePermission("authealing_manage"), async (req, res) => {
    try {
      const updated = await service.unblock(req.params.process, req.user || null);
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/audit", auth.requirePermission("authealing_read"), async (req, res) => {
    try {
      const { process: processName, result, limit, offset } = req.query;
      res.json(await auditStore.list({ processName, result, limit: Number(limit) || undefined, offset: Number(offset) || undefined }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createAutoHealingRouter;
