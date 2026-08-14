"use strict";

/**
 * Routes REST des health checks (Phase 6). Même découpage que
 * lib/routes/alerts.js : la logique métier vit dans
 * lib/services/health-checks/ (store CRUD + engine d'exécution), ce module
 * ne fait que valider la requête HTTP, appeler le service, formater la
 * réponse.
 *
 * Monté dans server.js via
 * `app.use("/api/health-checks", require("./lib/routes/health-checks")())`.
 */

const express = require("express");
const auth = require("../auth");
const { engine, store } = require("../services/health-checks");

function createHealthChecksRouter() {
  const router = express.Router();

  router.get("/", auth.requirePermission("health_checks_read"), async (req, res) => {
    try {
      const enabledOnly = req.query.enabled === "1";
      res.json(await store.list({ enabledOnly }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Catalogue (types/méthodes/statuts valides) : construction du formulaire côté frontend,
  // même schéma que GET /api/alerts/catalog.
  router.get("/catalog", auth.requirePermission("health_checks_read"), (req, res) => {
    res.json({ types: store.TYPES, methods: store.METHODS, statuses: store.STATUSES });
  });

  // Endpoint de statut agrégé (dashboard rapide) : liste condensée statut/dernier check.
  // Déclaré avant "/:id" pour que "status" ne soit pas capturé comme un id.
  router.get("/status/summary", auth.requirePermission("health_checks_read"), async (req, res) => {
    try {
      const checks = await store.list({});
      res.json(
        checks.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          enabled: c.enabled,
          status: c.status,
          lastCheckAt: c.lastCheckAt,
          lastResponseTimeMs: c.lastResponseTimeMs,
          lastFailureAt: c.lastFailureAt,
        }))
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/:id", auth.requirePermission("health_checks_read"), async (req, res) => {
    try {
      const check = await store.getById(Number(req.params.id));
      if (!check) return res.status(404).json({ error: "Health check introuvable." });
      res.json(check);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/", auth.requirePermission("health_checks_create"), async (req, res) => {
    try {
      const check = await store.create(req.body || {}, { userId: req.user ? req.user.id : null });
      res.status(201).json(check);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  async function updateCheck(req, res) {
    try {
      const updated = await store.update(Number(req.params.id), req.body || {});
      if (!updated) return res.status(404).json({ error: "Health check introuvable." });
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }
  router.put("/:id", auth.requirePermission("health_checks_update"), updateCheck);
  router.patch("/:id", auth.requirePermission("health_checks_update"), updateCheck);

  router.post("/:id/enable", auth.requirePermission("health_checks_update"), async (req, res) => {
    try {
      const updated = await store.setEnabled(Number(req.params.id), true);
      if (!updated) return res.status(404).json({ error: "Health check introuvable." });
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/:id/disable", auth.requirePermission("health_checks_update"), async (req, res) => {
    try {
      const updated = await store.setEnabled(Number(req.params.id), false);
      if (!updated) return res.status(404).json({ error: "Health check introuvable." });
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete("/:id", auth.requirePermission("health_checks_delete"), async (req, res) => {
    try {
      const deleted = await store.remove(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Health check introuvable." });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // "run test" : exécute la sonde immédiatement et persiste le résultat (donc alimente
  // aussi l'Alert Engine, comme une exécution planifiée) — pas un deuxième chemin de code.
  router.post("/:id/test", auth.requirePermission("health_checks_test"), async (req, res) => {
    try {
      const result = await engine.run(Number(req.params.id));
      if (!result) return res.status(404).json({ error: "Health check introuvable, ou désactivé." });
      res.json(result);
    } catch (e) {
      const notFound = /introuvable/i.test(e.message);
      res.status(notFound ? 404 : 400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createHealthChecksRouter;
