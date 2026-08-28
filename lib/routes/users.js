"use strict";

/**
 * lib/routes/users.js — extrait de server.js. Monté sur /api (routes
 * /users, /users/:id, /permissions/catalog), gestion des comptes réservée
 * aux admins.
 */

const express = require("express");
const auth = require("../auth");
const userStore = require("../user-store");
const permissions = require("../permissions");

function createUsersRouter() {
  const router = express.Router();

  router.get("/users", auth.requireAdmin, async (req, res) => {
    try {
      res.json(await userStore.listUsers());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/users", auth.requireAdmin, async (req, res) => {
    try {
      const { username, password, isAdmin, role, permissions: perms, allowedServers } = req.body || {};
      const user = await userStore.createUser({ username, password, isAdmin: !!isAdmin });
      // Phase 18 — Advanced RBAC : `role` (optionnel) applique un gabarit de
      // permissions prédéfini (voir lib/permissions.js#ROLES) ; s'il est
      // fourni, il prévaut sur `isAdmin`/`permissions` ci-dessus (appliqué
      // après createUser, dans le même sens que le reste de cette route).
      if (role) {
        await userStore.applyRole(user.id, role);
      } else if (Array.isArray(perms) && perms.length) {
        await userStore.replacePermissions(user.id, perms);
      }
      // Phase 10 — Multi-server : scoping optionnel par serveur (voir
      // lib/permissions.js#hasServerAccess). Liste vide/absente = pas de restriction.
      if (Array.isArray(allowedServers)) {
        await userStore.replaceAllowedServers(user.id, allowedServers);
      }
      res.json(await userStore.getUserWithPermissions(user.id));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.put("/users/:id", auth.requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { password, isAdmin, role, permissions: perms, allowedServers } = req.body || {};
      if (password) await userStore.setPassword(id, password);
      // Phase 18 — comme pour POST /users : `role` prévaut sur
      // isAdmin/permissions s'il est fourni (remplace les deux en un appel).
      if (role) {
        await userStore.applyRole(id, role);
      } else {
        if (isAdmin !== undefined) await userStore.setAdmin(id, !!isAdmin);
        if (Array.isArray(perms)) await userStore.replacePermissions(id, perms);
      }
      if (Array.isArray(allowedServers)) await userStore.replaceAllowedServers(id, allowedServers);
      const updated = await userStore.getUserWithPermissions(id);
      if (!updated) return res.status(404).json({ error: "Utilisateur introuvable." });
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/users/:id", auth.requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (req.user && req.user.id === id) {
        return res.status(400).json({ error: "Impossible de supprimer son propre compte." });
      }
      await userStore.deleteUser(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/permissions/catalog", auth.requireAdmin, (req, res) => {
    res.json({
      appActions: permissions.APP_ACTIONS,
      globalActions: permissions.GLOBAL_ACTIONS,
    });
  });

  // Phase 18 — Advanced RBAC : catalogue des rôles prédéfinis, pour
  // construire le sélecteur de rôle côté UI sans dupliquer la liste (même
  // approche que /permissions/catalog ci-dessus).
  router.get("/roles/catalog", auth.requireAdmin, (req, res) => {
    const catalog = {};
    for (const [name, role] of Object.entries(permissions.ROLES)) {
      catalog[name] = { label: role.label, isAdmin: role.isAdmin, permissions: role.permissions };
    }
    res.json(catalog);
  });

  return router;
}

module.exports = createUsersRouter;
