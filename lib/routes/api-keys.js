"use strict";

/**
 * lib/routes/api-keys.js — Phase 18 (Advanced RBAC & API Keys).
 *
 * Gestion des clés API M2M (lib/services/api-keys/store.js), réservée aux
 * utilisateurs avec session (api_keys_read/api_keys_manage, voir
 * lib/permissions.js) — une clé API ne peut jamais gérer les clés API
 * elles-mêmes (aucune action de ce routeur n'est exposée dans
 * ACTION_TO_API_KEY_SCOPE, voir lib/permissions.js), pour éviter qu'une clé
 * compromise puisse s'auto-régénérer des droits ou en créer de nouvelles.
 *
 * Le secret en clair n'apparaît QUE dans la réponse de POST / (création) —
 * jamais dans GET / ni dans aucune autre réponse, ni dans les logs/erreurs
 * (voir lib/services/api-keys/store.js#rowToApiKey, qui ne l'expose jamais).
 */

const express = require("express");
const auth = require("../auth");
const { store: apiKeysStore } = require("../services/api-keys");
const permissions = require("../permissions");
const { recordEvent, ACTIONS } = require("../services/audit");

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length) {
    throw new Error("Au moins un scope est requis.");
  }
  const unknown = scopes.filter((s) => !permissions.ALL_API_KEY_SCOPES.includes(s));
  if (unknown.length) {
    throw new Error(`Scope(s) inconnu(s) : ${unknown.join(", ")}.`);
  }
}

function createApiKeysRouter() {
  const router = express.Router();

  router.get("/scopes", auth.requirePermission("api_keys_read"), (req, res) => {
    res.json(permissions.API_KEY_SCOPES);
  });

  router.get("/", auth.requirePermission("api_keys_read"), async (req, res) => {
    try {
      res.json(await apiKeysStore.list());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post(
    "/",
    auth.requirePermission("api_keys_manage", null, {
      action: ACTIONS.API_KEY_CREATE,
      targetType: "api_key",
    }),
    async (req, res) => {
      try {
        const { name, scopes, resourceScopes, expiresAt } = req.body || {};
        validateScopes(scopes);
        const { apiKey, secret } = await apiKeysStore.create({
          name,
          scopes,
          resourceScopes,
          expiresAt: expiresAt ? Number(expiresAt) : null,
          createdBy: req.user ? req.user.id : null,
        });
        recordEvent({
          user: req.user,
          action: ACTIONS.API_KEY_CREATE,
          target: String(apiKey.id),
          targetType: "api_key",
          status: "success",
          ip: req.ip,
          metadata: { name: apiKey.name, scopes: apiKey.scopes },
        });
        // Le secret en clair n'est renvoyé qu'ici, une seule fois (voir
        // en-tête de fichier) — jamais journalisé (recordEvent ci-dessus ne
        // le porte pas dans metadata, et sanitizeAuditMetadata l'aurait de
        // toute façon masqué si un appelant l'y ajoutait par erreur, voir
        // lib/services/audit/sanitize.js).
        res.status(201).json({ apiKey, secret });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  );

  router.patch(
    "/:id",
    auth.requirePermission("api_keys_manage", null, {
      action: ACTIONS.API_KEY_UPDATE,
      targetFromReq: (req) => req.params.id,
      targetType: "api_key",
    }),
    async (req, res) => {
      try {
        const id = Number(req.params.id);
        const { name, scopes, resourceScopes, expiresAt } = req.body || {};
        if (scopes !== undefined) validateScopes(scopes);
        const updated = await apiKeysStore.update(id, {
          name,
          scopes,
          resourceScopes,
          expiresAt: expiresAt === undefined ? undefined : expiresAt ? Number(expiresAt) : null,
        });
        if (!updated) return res.status(404).json({ error: "Clé API introuvable." });
        recordEvent({
          user: req.user,
          action: ACTIONS.API_KEY_UPDATE,
          target: String(id),
          targetType: "api_key",
          status: "success",
          ip: req.ip,
          metadata: { name: updated.name, scopes: updated.scopes },
        });
        res.json(updated);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  );

  router.post(
    "/:id/revoke",
    auth.requirePermission("api_keys_manage", null, {
      action: ACTIONS.API_KEY_REVOKE,
      targetFromReq: (req) => req.params.id,
      targetType: "api_key",
    }),
    async (req, res) => {
      try {
        const id = Number(req.params.id);
        const revoked = await apiKeysStore.revoke(id);
        if (!revoked) return res.status(404).json({ error: "Clé API introuvable." });
        recordEvent({
          user: req.user,
          action: ACTIONS.API_KEY_REVOKE,
          target: String(id),
          targetType: "api_key",
          status: "success",
          ip: req.ip,
          metadata: { name: revoked.name },
        });
        res.json(revoked);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  return router;
}

module.exports = createApiKeysRouter;
