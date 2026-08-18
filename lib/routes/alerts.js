"use strict";

/**
 * Routes REST du moteur d'alertes. Toute la logique métier vit dans
 * lib/services/alerts/ (règle "ne mets pas toute la logique dans
 * server.js") : ce module ne fait que valider la requête HTTP, appeler le
 * service concerné, et formater la réponse — même découpage que le reste
 * des routes de server.js (ex: pm2-actions.js).
 *
 * Monté dans server.js via `app.use("/api/alerts", require("./lib/routes/alerts")())`.
 * Extrait dans son propre module (plutôt que défini inline dans server.js
 * comme les routes historiques) pour pouvoir être testé isolément dans
 * test/integration/alerts-api.test.js, sans dépendre de PM2/Socket.IO.
 */

const express = require("express");
const auth = require("../auth");
const { engine, ruleStore, alertStore } = require("../services/alerts");
const { recordEvent, ACTIONS } = require("../services/audit");

function createAlertsRouter() {
  const router = express.Router();

  // --- Règles ------------------------------------------------------------

  router.get("/rules", auth.requirePermission("alerts_read"), async (req, res) => {
    try {
      const enabledOnly = req.query.enabled === "1";
      res.json(await ruleStore.list({ enabledOnly }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/rules/:id", auth.requirePermission("alerts_read"), async (req, res) => {
    try {
      const rule = await ruleStore.getById(Number(req.params.id));
      if (!rule) return res.status(404).json({ error: "Règle introuvable." });
      res.json(rule);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/rules", auth.requirePermission("alerts_create"), async (req, res) => {
    try {
      const rule = await ruleStore.create(req.body || {}, { userId: req.user ? req.user.id : null });
      recordEvent({
        user: req.user,
        action: ACTIONS.ALERT_RULE_CREATE,
        target: rule.name || String(rule.id),
        targetType: "alert_rule",
        status: "success",
        ip: req.ip,
        metadata: { ruleId: rule.id, targetType: rule.targetType, metric: rule.metric },
      });
      res.status(201).json(rule);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.ALERT_RULE_CREATE,
        targetType: "alert_rule",
        status: "failed",
        ip: req.ip,
        metadata: { error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  });

  async function updateRule(req, res) {
    try {
      const updated = await ruleStore.update(Number(req.params.id), req.body || {});
      if (!updated) return res.status(404).json({ error: "Règle introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.ALERT_RULE_UPDATE,
        target: updated.name || String(updated.id),
        targetType: "alert_rule",
        status: "success",
        ip: req.ip,
        metadata: { ruleId: updated.id, fields: Object.keys(req.body || {}) },
      });
      res.json(updated);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.ALERT_RULE_UPDATE,
        target: req.params.id,
        targetType: "alert_rule",
        status: "failed",
        ip: req.ip,
        metadata: { error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  }
  router.put("/rules/:id", auth.requirePermission("alerts_update"), updateRule);
  router.patch("/rules/:id", auth.requirePermission("alerts_update"), updateRule);

  router.delete("/rules/:id", auth.requirePermission("alerts_delete"), async (req, res) => {
    try {
      const deleted = await ruleStore.remove(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Règle introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.ALERT_RULE_DELETE,
        target: req.params.id,
        targetType: "alert_rule",
        status: "success",
        ip: req.ip,
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Catalogue (métriques/opérateurs/sévérités valides) : utile pour construire
  // un formulaire de création de règle côté frontend, même schéma que
  // GET /api/permissions/catalog déjà existant.
  router.get("/catalog", auth.requirePermission("alerts_read"), (req, res) => {
    res.json({
      targetTypes: ruleStore.TARGET_TYPES,
      metricsByTargetType: ruleStore.METRICS_BY_TARGET_TYPE,
      operators: ruleStore.OPERATORS,
      severities: ruleStore.SEVERITIES,
    });
  });

  // --- Alertes (occurrences) ----------------------------------------------

  router.get("/active", auth.requirePermission("alerts_read"), async (req, res) => {
    try {
      const includeTrigger = req.query.includePending === "1";
      res.json(await alertStore.listActive({ includeTrigger }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/history", auth.requirePermission("alerts_read"), async (req, res) => {
    try {
      const { state, severity, ruleId, limit, offset } = req.query;
      res.json(
        await alertStore.listHistory({
          state: state || undefined,
          severity: severity || undefined,
          ruleId: ruleId ? Number(ruleId) : undefined,
          limit: limit ? Number(limit) : undefined,
          offset: offset ? Number(offset) : undefined,
        }),
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/:id/acknowledge", auth.requirePermission("alerts_acknowledge"), async (req, res) => {
    try {
      const updated = await engine.acknowledge(Number(req.params.id), req.user);
      recordEvent({
        user: req.user,
        action: ACTIONS.ALERT_ACKNOWLEDGE,
        target: String(req.params.id),
        targetType: "alert",
        status: "success",
        ip: req.ip,
      });
      res.json(updated);
    } catch (e) {
      const notFound = /introuvable/i.test(e.message);
      recordEvent({
        user: req.user,
        action: ACTIONS.ALERT_ACKNOWLEDGE,
        target: String(req.params.id),
        targetType: "alert",
        status: "failed",
        ip: req.ip,
        metadata: { error: e.message },
      });
      res.status(notFound ? 404 : 400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createAlertsRouter;
