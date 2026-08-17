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
      const { username, password, isAdmin, permissions: perms } = req.body || {};
      const user = await userStore.createUser({ username, password, isAdmin: !!isAdmin });
      if (Array.isArray(perms) && perms.length) {
        await userStore.replacePermissions(user.id, perms);
      }
      res.json(await userStore.getUserWithPermissions(user.id));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.put("/users/:id", auth.requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { password, isAdmin, permissions: perms } = req.body || {};
      if (password) await userStore.setPassword(id, password);
      if (isAdmin !== undefined) await userStore.setAdmin(id, !!isAdmin);
      if (Array.isArray(perms)) await userStore.replacePermissions(id, perms);
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

  return router;
}

module.exports = createUsersRouter;
