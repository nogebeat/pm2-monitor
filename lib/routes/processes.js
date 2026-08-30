"use strict";

/**
 * lib/routes/processes.js — extrait de server.js. Monté sur /api.
 * Couvre la liste des process, les actions de base (start/stop/restart/delete,
 * callback pm2.* directes) et les actions étendues (lib/pm2-actions.js :
 * reload/scale/watch/env/config/flush/reset), ainsi que /processes/:id/metrics
 * et /processes/:id/analytics (lib/services/process-history/, Phase 11).
 *
 * `processHistory` est une instance créée une fois dans server.js (son
 * constructeur lit process.env) : elle est donc injectée ici plutôt que
 * require()-ée directement, contrairement à pm2/pm2Actions qui sont des
 * singletons stateless.
 */

const express = require("express");
const pm2 = require("pm2");
const pm2Actions = require("../pm2-actions");
const { ACTIONS, recordEvent } = require("../services/audit");
const permissions = require("../permissions");
const {
  fmtProcess,
  visibleProcesses,
  withAppPermission,
  handleAction,
  handleCallbackAction,
} = require("../process-helpers");
const { processResourceScopeAllows } = require("../services/api-keys/resource-scope");

/**
 * @param {object} deps
 * @param {import("../services/process-history").ProcessHistoryService} deps.processHistory
 * @param {import("../log-store").LogStore} deps.logStore
 */
function createProcessesRouter({ processHistory, logStore }) {
  const router = express.Router();

  // --- Liste / actions de base sur les process ------------------------------

  router.get("/processes", (req, res) => {
    pm2.list(async (err, list) => {
      if (err) return res.status(500).json({ error: err.message });
      const formatted = list.map(fmtProcess);

      // Phase 18 — Advanced RBAC & API Keys : cette route ne passe pas par
      // withAppPermission (elle liste, ne cible pas un :id précis), donc le
      // chemin clé API doit être géré explicitement ici — sans ça, une
      // requête authentifiée uniquement par clé API (req.user indéfini)
      // recevrait silencieusement une liste vide via visibleProcesses().
      if (!req.user && req.apiKeyAuth) {
        if (!permissions.hasScope(req.apiKeyAuth, "processes:read")) {
          return res.status(403).json({ error: "Action non autorisée pour cette clé API." });
        }
        const allowedProcesses = req.apiKeyAuth.resourceScopes && req.apiKeyAuth.resourceScopes.processes;
        let visible =
          Array.isArray(allowedProcesses) && allowedProcesses.length
            ? formatted.filter((p) => allowedProcesses.includes(p.name))
            : formatted;

        // Scope de ressource "environment"/"group" (lookup DB, voir
        // lib/services/api-keys/resource-scope.js) — même vérification que
        // withAppPermission côté action ciblée, appliquée ici process par
        // process pour filtrer la liste plutôt que refuser toute la requête.
        const rs = req.apiKeyAuth.resourceScopes;
        if (
          rs &&
          ((Array.isArray(rs.environments) && rs.environments.length) ||
            (Array.isArray(rs.groups) && rs.groups.length))
        ) {
          const checks = await Promise.all(
            visible.map((p) => processResourceScopeAllows(req.apiKeyAuth, p.name).catch(() => false)),
          );
          visible = visible.filter((_, i) => checks[i]);
        }

        return res.json(visible);
      }

      res.json(visibleProcesses(req.user, formatted));
    });
  });

  router.post("/processes/:id/restart", withAppPermission("restart"), (req, res) => {
    // Phase 18 : "restart" est la seule action de mutation process exposée
    // aux clés API (voir lib/permissions.js#SENSITIVE_API_KEY_SCOPES) — son
    // usage est donc audité même en succès, pas seulement en cas de refus
    // (contrairement au reste des actions process, où seul le refus est
    // audité — voir lib/process-helpers.js#withAppPermission).
    if (!req.user && req.apiKeyAuth) {
      recordEvent({
        usernameOverride: `api-key:${req.apiKeyAuth.name}`,
        action: ACTIONS.API_KEY_SENSITIVE_USE,
        target: "restart",
        targetType: "api_key_scope",
        status: "success",
        ip: req.ip,
        metadata: { apiKeyId: req.apiKeyAuth.id, scope: "processes:restart", appName: req.processName },
      });
    }
    handleCallbackAction((cb) => pm2.restart(req.params.id, cb), res, {
      user: req.user,
      usernameOverride: !req.user && req.apiKeyAuth ? `api-key:${req.apiKeyAuth.name}` : undefined,
      action: ACTIONS.PROCESS_RESTART,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
    });
  });

  router.post("/processes/:id/stop", withAppPermission("stop"), (req, res) => {
    handleCallbackAction((cb) => pm2.stop(req.params.id, cb), res, {
      user: req.user,
      action: ACTIONS.PROCESS_STOP,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
    });
  });

  router.post("/processes/:id/start", withAppPermission("start"), (req, res) => {
    handleCallbackAction((cb) => pm2.start(req.params.id, cb), res, {
      user: req.user,
      action: ACTIONS.PROCESS_START,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
    });
  });

  router.post("/processes/:id/delete", withAppPermission("delete"), (req, res) => {
    handleCallbackAction((cb) => pm2.delete(req.params.id, cb), res, {
      user: req.user,
      action: ACTIONS.PROCESS_DELETE,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
    });
  });

  // --- Actions PM2 étendues --------------------------------------------------

  router.post("/processes/:id/reload", withAppPermission("reload"), (req, res) => {
    handleAction(pm2Actions.reload(pm2, req.params.id), res, {
      user: req.user,
      action: ACTIONS.PROCESS_RELOAD,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
    });
  });

  router.post("/processes/:id/scale", withAppPermission("scale"), (req, res) => {
    handleAction(pm2Actions.scale(pm2, req.params.id, req.body.instances), res);
  });

  router.post("/processes/:id/watch", withAppPermission("watch"), (req, res) => {
    handleAction(pm2Actions.toggleWatch(pm2, req.params.id, !!req.body.enable), res);
  });

  router.post("/processes/:id/env", withAppPermission("env"), (req, res) => {
    // Metadata volontairement limitée aux CLÉS d'environnement modifiées, jamais
    // aux valeurs : une variable d'env est un vecteur fréquent de secret
    // (voir lib/services/audit/sanitize.js — filet de sécurité indépendant,
    // mais on évite ici de lui donner quoi que ce soit à filtrer).
    const envKeys = Object.keys(req.body.env || {});
    handleAction(pm2Actions.editEnv(pm2, req.params.id, req.body.env || {}), res, {
      user: req.user,
      action: ACTIONS.PROCESS_ENV_CHANGE,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
      metadata: { envKeys },
    });
  });

  router.post("/processes/:id/config", withAppPermission("config"), (req, res) => {
    // { script, args, execMode, instances }
    handleAction(pm2Actions.editConfig(pm2, req.params.id, req.body || {}), res, {
      user: req.user,
      action: ACTIONS.PROCESS_CONFIG_CHANGE,
      target: req.processName || req.params.id,
      targetType: "process",
      ip: req.ip,
      metadata: { fields: Object.keys(req.body || {}) },
    });
  });

  router.post("/processes/:id/flush", withAppPermission("flush"), (req, res) => {
    // pm2.flush() (voir lib/pm2-actions.js) ne vide que les fichiers de log
    // NATIFS PM2 (out/err) — jamais le LogStore persistant de l'appli (utilisé
    // par /logs/search, /logs/stats et le Log Explorer). Sans ce nettoyage
    // supplémentaire, "Vider les logs" viderait /logs/tail mais laisserait
    // tout l'historique déjà indexé réapparaître ailleurs dans l'UI.
    const action = new Promise((resolve) => {
      pm2.describe(req.params.id, (descErr, list) => {
        resolve(descErr || !list || !list.length ? null : list[0]);
      });
    }).then((proc) =>
      pm2Actions.flush(pm2, req.params.id).then(() => {
        if (proc && logStore) logStore.clear("local", proc.pm_id, proc.name);
      }),
    );
    handleAction(action, res);
  });

  router.post("/processes/:id/reset", withAppPermission("reset"), (req, res) => {
    handleAction(pm2Actions.resetCounter(pm2, req.params.id), res);
  });

  // Historique CPU/RAM/restarts d'un process (lib/services/process-history/).
  // Même permission que la vue du process ("view") : lecture seule, pas d'action PM2.
  router.get("/processes/:id/metrics", withAppPermission("view"), (req, res) => {
    pm2.describe(req.params.id, async (err, list) => {
      if (err || !list || !list.length) {
        return res.status(404).json({ error: "Process introuvable." });
      }
      try {
        const { start, end, resolution } = req.query;
        const metrics = req.query.metrics ? String(req.query.metrics).split(",").filter(Boolean) : undefined;
        const result = await processHistory.query({
          processName: list[0].name,
          start: start !== undefined ? Number(start) : undefined,
          end: end !== undefined ? Number(end) : undefined,
          resolution,
          metrics,
        });
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });
  });

  // Analytics (Phase 11) : stats de période (avg/min/max/p95, restarts,
  // crashes, disponibilité) + comparaison à la période précédente. Même
  // permission que /metrics ("view", lecture seule).
  router.get("/processes/:id/analytics", withAppPermission("view"), (req, res) => {
    pm2.describe(req.params.id, async (err, list) => {
      if (err || !list || !list.length) {
        return res.status(404).json({ error: "Process introuvable." });
      }
      try {
        const { start, end, resolution, compare } = req.query;
        const result = await processHistory.analytics({
          processName: list[0].name,
          start: start !== undefined ? Number(start) : undefined,
          end: end !== undefined ? Number(end) : undefined,
          resolution,
          compare: compare === undefined ? true : compare !== "0" && compare !== "false",
        });
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });
  });

  return router;
}

module.exports = createProcessesRouter;
