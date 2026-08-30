"use strict";

/**
 * Routes REST du Plugin System (Phase 21). Même découpage que
 * lib/routes/anomaly-detection.js / lib/routes/service-dependencies.js : ce
 * module ne fait que valider la requête HTTP, appeler
 * lib/services/plugins/ (jamais registry.js/store.js/loader.js
 * directement), formater la réponse.
 *
 * Monté dans server.js via `app.use("/api/plugins", require("./lib/routes/plugins")())`.
 *
 * Volontairement AUCUNE route d'installation/upload : un plugin ne peut
 * être ajouté qu'en déposant un dossier sur le serveur (voir
 * plugins/README.md et docs/plugins/README.md#sécurité) — jamais via
 * l'API, quel que soit le rôle de l'utilisateur.
 */

const express = require("express");
const auth = require("../auth");
const plugins = require("../services/plugins");
const { recordEvent, ACTIONS } = require("../services/audit");

function createPluginsRouter() {
  const router = express.Router();

  router.get("/", auth.requirePermission("plugins_read"), (req, res) => {
    res.json(plugins.list());
  });

  router.get("/:name", auth.requirePermission("plugins_read"), (req, res) => {
    const entry = plugins.getEntry(req.params.name);
    if (!entry) return res.status(404).json({ error: "Plugin introuvable." });
    res.json(entry);
  });

  router.post("/:name/enable", auth.requirePermission("plugins_manage"), async (req, res) => {
    try {
      const entry = await plugins.enable(req.params.name);
      recordEvent({
        user: req.user,
        action: ACTIONS.PLUGIN_CHANGE,
        target: req.params.name,
        targetType: "plugin",
        status: entry.status === "error" ? "failed" : "success",
        ip: req.ip,
        metadata: { op: "enable", status: entry.status, error: entry.error || undefined },
      });
      res.json(entry);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.PLUGIN_CHANGE,
        target: req.params.name,
        targetType: "plugin",
        status: "failed",
        ip: req.ip,
        metadata: { op: "enable", error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  });

  router.post("/:name/disable", auth.requirePermission("plugins_manage"), async (req, res) => {
    try {
      const entry = await plugins.disable(req.params.name);
      recordEvent({
        user: req.user,
        action: ACTIONS.PLUGIN_CHANGE,
        target: req.params.name,
        targetType: "plugin",
        status: "success",
        ip: req.ip,
        metadata: { op: "disable" },
      });
      res.json(entry);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.PLUGIN_CHANGE,
        target: req.params.name,
        targetType: "plugin",
        status: "failed",
        ip: req.ip,
        metadata: { op: "disable", error: e.message },
      });
      res.status(404).json({ error: e.message });
    }
  });

  router.put("/:name/config", auth.requirePermission("plugins_manage"), async (req, res) => {
    try {
      const entry = await plugins.updateConfig(req.params.name, req.body || {});
      recordEvent({
        user: req.user,
        action: ACTIONS.PLUGIN_CHANGE,
        target: req.params.name,
        targetType: "plugin",
        status: "success",
        ip: req.ip,
        metadata: { op: "config", fields: Object.keys(req.body || {}) },
      });
      res.json(entry);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.PLUGIN_CHANGE,
        target: req.params.name,
        targetType: "plugin",
        status: "failed",
        ip: req.ip,
        metadata: { op: "config", error: e.message },
      });
      res.status(404).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createPluginsRouter;
