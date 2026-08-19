"use strict";

/**
 * lib/routes/servers.js — API REST du registre de serveurs (Phase 10 —
 * Multi-server / Remote PM2). Même découpage que les autres routers
 * (lib/routes/health-checks.js…) : la logique métier vit dans
 * lib/services/servers/ (store CRUD + user-scope), ce module valide la
 * requête HTTP, vérifie permissions/scope, appelle le service, formate la
 * réponse.
 *
 * Monté dans server.js via
 * `app.use("/api/servers", require("./lib/routes/servers")({ agentHub }))`.
 *
 * `agentHub` (lib/realtime/agent-hub.js) est injecté : ce router en a
 * besoin pour connaître le statut de connexion socket en temps réel
 * (isOnline) et relayer les actions distantes (sendRemoteAction) — un seul
 * hub, partagé entre le temps réel et l'API REST, pas de second état.
 */

const express = require("express");
const auth = require("../auth");
const { store, userScope } = require("../services/servers");
const permissions = require("../permissions");
const { recordEvent, ACTIONS } = require("../services/audit");

function serverKeyParam(req) {
  return req.params.key;
}

function createServersRouter({ agentHub }) {
  const router = express.Router();

  /** Décore un serveur du store avec son statut de connexion socket en direct. */
  function withLiveStatus(server) {
    if (!server) return server;
    if (server.kind === "local") return { ...server, status: "ONLINE" };
    const live = agentHub && agentHub.isOnline(server.serverKey);
    // Le hub (socket connecté) est la source la plus à jour ; touchStatus()/
    // markStaleOffline() (lib/services/servers/store.js) restent la source
    // de vérité persistée pour les redémarrages du serveur central (au
    // redémarrage, aucun agent n'est encore reconnecté : on retombe alors
    // sur le statut stocké, corrigé au prochain balayage/heartbeat).
    if (live && server.status !== "ONLINE") return { ...server, status: "ONLINE" };
    return server;
  }

  router.get("/", auth.requirePermission("servers_read"), async (req, res) => {
    try {
      const all = (await store.list()).map(withLiveStatus);
      const visible = permissions.visibleServers(req.user, all);
      res.json(visible);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get(
    "/:key/status",
    auth.requirePermission("servers_read"),
    auth.requireServerAccess(serverKeyParam),
    async (req, res) => {
      try {
        const server = await store.getByKey(req.params.key);
        if (!server) return res.status(404).json({ error: "Serveur introuvable." });
        res.json(withLiveStatus(server));
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  router.post("/", auth.requirePermission("servers_manage"), async (req, res) => {
    try {
      const { name, hostname, environment } = req.body || {};
      const { server, token } = await store.create({ name, hostname, environment });
      recordEvent({
        user: req.user,
        action: ACTIONS.SERVER_REGISTER,
        target: server.name,
        targetType: "server",
        status: "success",
        ip: req.ip,
        metadata: { serverKey: server.serverKey, environment: server.environment },
      });
      // Le token en clair n'est renvoyé qu'ici, une seule fois (voir
      // lib/services/servers/store.js#create) — l'admin doit le copier
      // immédiatement pour configurer l'agent (voir docs/multi-server/README.md#installation-agent).
      res.status(201).json({ server, token });
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.SERVER_REGISTER,
        status: "failed",
        ip: req.ip,
        metadata: { error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  });

  router.put("/:key", auth.requirePermission("servers_manage"), async (req, res) => {
    try {
      const { name, hostname, environment } = req.body || {};
      const updated = await store.update(req.params.key, { name, hostname, environment });
      if (!updated) return res.status(404).json({ error: "Serveur introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.SERVER_UPDATE,
        target: updated.name,
        targetType: "server",
        status: "success",
        ip: req.ip,
        metadata: { serverKey: updated.serverKey, fields: Object.keys(req.body || {}) },
      });
      res.json(withLiveStatus(updated));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post("/:key/enable", auth.requirePermission("servers_manage"), async (req, res) => {
    try {
      const updated = await store.setEnabled(req.params.key, true);
      if (!updated) return res.status(404).json({ error: "Serveur introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.SERVER_ENABLE,
        target: updated.name,
        targetType: "server",
        status: "success",
        ip: req.ip,
        metadata: { serverKey: updated.serverKey },
      });
      res.json(withLiveStatus(updated));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post("/:key/disable", auth.requirePermission("servers_manage"), async (req, res) => {
    try {
      const updated = await store.setEnabled(req.params.key, false);
      if (!updated) return res.status(404).json({ error: "Serveur introuvable." });
      // Un agent désactivé doit être coupé immédiatement, pas seulement au
      // prochain heartbeat manqué (voir docs/multi-server/README.md#sécurité).
      if (agentHub) {
        const socket = agentHub.sockets.get(req.params.key);
        if (socket) socket.disconnect(true);
      }
      recordEvent({
        user: req.user,
        action: ACTIONS.SERVER_DISABLE,
        target: updated.name,
        targetType: "server",
        status: "success",
        ip: req.ip,
        metadata: { serverKey: updated.serverKey },
      });
      res.json(withLiveStatus(updated));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/:key", auth.requirePermission("servers_manage"), async (req, res) => {
    try {
      if (agentHub) {
        const socket = agentHub.sockets.get(req.params.key);
        if (socket) socket.disconnect(true);
      }
      const deleted = await store.remove(req.params.key);
      if (!deleted) return res.status(404).json({ error: "Serveur introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.SERVER_DELETE,
        target: req.params.key,
        targetType: "server",
        status: "success",
        ip: req.ip,
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post("/:key/regenerate-token", auth.requirePermission("servers_manage"), async (req, res) => {
    try {
      const result = await store.regenerateToken(req.params.key);
      if (!result) return res.status(404).json({ error: "Serveur introuvable." });
      // L'ancien token devient invalide immédiatement (voir store.js) :
      // on coupe donc aussi la connexion en cours, qui l'utiliserait sinon
      // jusqu'à sa prochaine reconnexion.
      if (agentHub) {
        const socket = agentHub.sockets.get(req.params.key);
        if (socket) socket.disconnect(true);
      }
      recordEvent({
        user: req.user,
        action: ACTIONS.SERVER_TOKEN_REGENERATE,
        target: result.server.name,
        targetType: "server",
        status: "success",
        ip: req.ip,
        metadata: { serverKey: result.server.serverKey },
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Relaie une action PM2 (start/stop/restart/reload) vers l'agent d'un
  // serveur distant. Le serveur local continue de passer par les routes
  // existantes (lib/routes/processes.js) : pas de second chemin de code
  // pour la même opération sur l'hôte local.
  router.post(
    "/:key/action",
    auth.requireServerAccess(serverKeyParam),
    async (req, res) => {
      try {
        const server = await store.getByKey(req.params.key);
        if (!server) return res.status(404).json({ error: "Serveur introuvable." });
        if (server.kind === "local") {
          return res.status(400).json({ error: "Utilisez /api/processes/:id/:action pour le serveur local." });
        }
        const { action, processName } = req.body || {};
        if (!permissions.hasPermission(req.user, processName || "*", action)) {
          return res.status(403).json({ error: "Action non autorisée pour cette app." });
        }
        if (!agentHub) return res.status(503).json({ error: "Agent hub indisponible." });
        const result = await agentHub.sendRemoteAction(req.params.key, action, processName, {
          user: req.user,
          ip: req.ip,
        });
        res.json({ ok: true, result });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  );

  return router;
}

module.exports = createServersRouter;
