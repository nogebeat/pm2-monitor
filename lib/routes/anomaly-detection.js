"use strict";

/**
 * Routes REST de la détection d'anomalies (Phase 16). Même découpage que
 * lib/routes/health-checks.js : la logique métier vit dans
 * lib/services/anomaly-detection/ (rules-store CRUD + detections-store
 * lecture seule + service d'évaluation), ce module ne fait que valider la
 * requête HTTP, appeler le service, formater la réponse.
 *
 * Monté dans server.js via
 * `app.use("/api/anomaly-detection", require("./lib/routes/anomaly-detection")())`.
 */

const express = require("express");
const auth = require("../auth");
const { ruleStore, detectionStore } = require("../services/anomaly-detection");
const { recordEvent, ACTIONS } = require("../services/audit");

function createAnomalyDetectionRouter() {
  const router = express.Router();

  // --- Règles ---------------------------------------------------------------

  router.get("/rules", auth.requirePermission("anomaly_read"), async (req, res) => {
    try {
      const enabledOnly = req.query.enabled === "1";
      res.json(await ruleStore.list({ enabledOnly }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Catalogue (types de cible/métriques valides) : construction du formulaire
  // côté frontend, même schéma que GET /api/alerts/catalog et
  // GET /api/health-checks/catalog.
  router.get("/catalog", auth.requirePermission("anomaly_read"), (req, res) => {
    res.json({
      targetTypes: ruleStore.TARGET_TYPES,
      metricsByTargetType: ruleStore.METRICS_BY_TARGET_TYPE,
      severities: ruleStore.SEVERITIES,
    });
  });

  router.get("/rules/:id", auth.requirePermission("anomaly_read"), async (req, res) => {
    try {
      const rule = await ruleStore.getById(Number(req.params.id));
      if (!rule) return res.status(404).json({ error: "Règle d'anomalie introuvable." });
      res.json(rule);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/rules", auth.requirePermission("anomaly_create"), async (req, res) => {
    try {
      const rule = await ruleStore.create(req.body || {}, { userId: req.user ? req.user.id : null });
      recordEvent({
        user: req.user,
        action: ACTIONS.ANOMALY_RULE_CHANGE,
        target: rule.name || String(rule.id),
        targetType: "anomaly_rule",
        status: "success",
        ip: req.ip,
        metadata: { op: "create", ruleId: rule.id, metric: rule.metric, targetType: rule.targetType },
      });
      res.status(201).json(rule);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.ANOMALY_RULE_CHANGE,
        targetType: "anomaly_rule",
        status: "failed",
        ip: req.ip,
        metadata: { op: "create", error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  });

  async function updateRule(req, res) {
    try {
      const updated = await ruleStore.update(Number(req.params.id), req.body || {});
      if (!updated) return res.status(404).json({ error: "Règle d'anomalie introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.ANOMALY_RULE_CHANGE,
        target: updated.name || String(updated.id),
        targetType: "anomaly_rule",
        status: "success",
        ip: req.ip,
        metadata: { op: "update", ruleId: updated.id, fields: Object.keys(req.body || {}) },
      });
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }
  router.put("/rules/:id", auth.requirePermission("anomaly_update"), updateRule);
  router.patch("/rules/:id", auth.requirePermission("anomaly_update"), updateRule);

  router.post("/rules/:id/enable", auth.requirePermission("anomaly_update"), async (req, res) => {
    try {
      const updated = await ruleStore.setEnabled(Number(req.params.id), true);
      if (!updated) return res.status(404).json({ error: "Règle d'anomalie introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.ANOMALY_RULE_CHANGE,
        target: updated.name || String(updated.id),
        targetType: "anomaly_rule",
        status: "success",
        ip: req.ip,
        metadata: { op: "enable", ruleId: updated.id },
      });
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/rules/:id/disable", auth.requirePermission("anomaly_update"), async (req, res) => {
    try {
      const updated = await ruleStore.setEnabled(Number(req.params.id), false);
      if (!updated) return res.status(404).json({ error: "Règle d'anomalie introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.ANOMALY_RULE_CHANGE,
        target: updated.name || String(updated.id),
        targetType: "anomaly_rule",
        status: "success",
        ip: req.ip,
        metadata: { op: "disable", ruleId: updated.id },
      });
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete("/rules/:id", auth.requirePermission("anomaly_delete"), async (req, res) => {
    try {
      const deleted = await ruleStore.remove(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Règle d'anomalie introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.ANOMALY_RULE_CHANGE,
        target: String(req.params.id),
        targetType: "anomaly_rule",
        status: "success",
        ip: req.ip,
        metadata: { op: "delete", ruleId: Number(req.params.id) },
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Détections (historique + explications) --------------------------------

  router.get("/detections", auth.requirePermission("anomaly_read"), async (req, res) => {
    try {
      const { ruleId, alertId, targetType, targetValue, metric, startTs, endTs, limit, offset } = req.query;
      res.json(
        await detectionStore.list({
          ruleId: ruleId !== undefined ? Number(ruleId) : undefined,
          alertId: alertId !== undefined ? Number(alertId) : undefined,
          targetType,
          targetValue,
          metric,
          startTs: startTs !== undefined ? Number(startTs) : undefined,
          endTs: endTs !== undefined ? Number(endTs) : undefined,
          limit: limit !== undefined ? Number(limit) : undefined,
          offset: offset !== undefined ? Number(offset) : undefined,
        }),
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/detections/:id", auth.requirePermission("anomaly_read"), async (req, res) => {
    try {
      const detection = await detectionStore.getById(Number(req.params.id));
      if (!detection) return res.status(404).json({ error: "Détection introuvable." });
      res.json(detection);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createAnomalyDetectionRouter;
