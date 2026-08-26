"use strict";

/**
 * Routes REST de la carte de dépendances de service (Phase 17). Même
 * découpage que lib/routes/anomaly-detection.js : la logique métier vit
 * dans lib/services/service-dependencies/ (store CRUD + graph/status en
 * lecture seule), ce module ne fait que valider la requête HTTP, appeler le
 * service, formater la réponse.
 *
 * Monté dans server.js via
 * `app.use("/api/service-dependencies", require("./lib/routes/service-dependencies")())`.
 *
 * Routes statiques (/catalog, /graph, /impact/:service) déclarées AVANT
 * /:id, même raisonnement que /rules/:id après /catalog dans
 * anomaly-detection.js : Express matcherait sinon "graph"/"impact" comme un
 * :id.
 */

const express = require("express");
const auth = require("../auth");
const store = require("../services/service-dependencies/store");
const { buildGraphSnapshot, computeImpact } = require("../services/service-dependencies/status");
const { recordEvent, ACTIONS } = require("../services/audit");

function createServiceDependenciesRouter() {
  const router = express.Router();

  // --- Catalogue (types valides) : construction du formulaire côté frontend,
  // même schéma que GET /api/anomaly-detection/catalog. ---------------------
  router.get("/catalog", auth.requirePermission("dependencies_read"), (req, res) => {
    res.json({ types: store.TYPES });
  });

  // --- Graphe complet (nœuds + arêtes + statut dérivé), pour les vues
  // graphe/liste/statut du frontend. --------------------------------------
  router.get("/graph", auth.requirePermission("dependencies_read"), async (req, res) => {
    try {
      res.json(await buildGraphSnapshot());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Impact ("dépendances affectées") : services potentiellement
  // affectés si :service tombe. ?assumeDown=1 force le calcul même si le
  // statut réel dérivé n'est pas DOWN (exploration hypothétique côté UI). --
  router.get("/impact/:service", auth.requirePermission("dependencies_read"), async (req, res) => {
    try {
      const assumeDown = req.query.assumeDown === "1";
      res.json(await computeImpact(req.params.service, { assumeDown }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- CRUD des dépendances déclarées -------------------------------------

  router.get("/", auth.requirePermission("dependencies_read"), async (req, res) => {
    try {
      const { source, target, type } = req.query;
      const enabledOnly = req.query.enabled === "1";
      res.json(await store.list({ enabledOnly, source, target, type }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/:id", auth.requirePermission("dependencies_read"), async (req, res) => {
    try {
      const dependency = await store.getById(Number(req.params.id));
      if (!dependency) return res.status(404).json({ error: "Dépendance introuvable." });
      res.json(dependency);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/", auth.requirePermission("dependencies_create"), async (req, res) => {
    try {
      const dependency = await store.create(req.body || {}, { userId: req.user ? req.user.id : null });
      recordEvent({
        user: req.user,
        action: ACTIONS.DEPENDENCY_CHANGE,
        target: `${dependency.source} → ${dependency.target}`,
        targetType: "service_dependency",
        status: "success",
        ip: req.ip,
        metadata: { op: "create", dependencyId: dependency.id, type: dependency.type },
      });
      res.status(201).json(dependency);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.DEPENDENCY_CHANGE,
        targetType: "service_dependency",
        status: "failed",
        ip: req.ip,
        metadata: { op: "create", error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  });

  async function updateDependency(req, res) {
    try {
      const updated = await store.update(Number(req.params.id), req.body || {});
      if (!updated) return res.status(404).json({ error: "Dépendance introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.DEPENDENCY_CHANGE,
        target: `${updated.source} → ${updated.target}`,
        targetType: "service_dependency",
        status: "success",
        ip: req.ip,
        metadata: { op: "update", dependencyId: updated.id, fields: Object.keys(req.body || {}) },
      });
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }
  router.put("/:id", auth.requirePermission("dependencies_update"), updateDependency);
  router.patch("/:id", auth.requirePermission("dependencies_update"), updateDependency);

  router.post("/:id/enable", auth.requirePermission("dependencies_update"), async (req, res) => {
    try {
      const updated = await store.setEnabled(Number(req.params.id), true);
      if (!updated) return res.status(404).json({ error: "Dépendance introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.DEPENDENCY_CHANGE,
        target: `${updated.source} → ${updated.target}`,
        targetType: "service_dependency",
        status: "success",
        ip: req.ip,
        metadata: { op: "enable", dependencyId: updated.id },
      });
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/:id/disable", auth.requirePermission("dependencies_update"), async (req, res) => {
    try {
      const updated = await store.setEnabled(Number(req.params.id), false);
      if (!updated) return res.status(404).json({ error: "Dépendance introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.DEPENDENCY_CHANGE,
        target: `${updated.source} → ${updated.target}`,
        targetType: "service_dependency",
        status: "success",
        ip: req.ip,
        metadata: { op: "disable", dependencyId: updated.id },
      });
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete("/:id", auth.requirePermission("dependencies_delete"), async (req, res) => {
    try {
      const existing = await store.getById(Number(req.params.id));
      const deleted = await store.remove(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Dépendance introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.DEPENDENCY_CHANGE,
        target: existing ? `${existing.source} → ${existing.target}` : String(req.params.id),
        targetType: "service_dependency",
        status: "success",
        ip: req.ip,
        metadata: { op: "delete", dependencyId: Number(req.params.id) },
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createServiceDependenciesRouter;
