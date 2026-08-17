"use strict";

/**
 * lib/routes/auth.js — extrait de server.js, même découpage que le reste de
 * lib/routes/*.js. Monté sur /api/auth.
 */

const express = require("express");
const auth = require("../auth");
const userStore = require("../user-store");
const { recordEvent, ACTIONS } = require("../services/audit");

function createAuthRouter() {
  const router = express.Router();

  router.post("/login", async (req, res) => {
    try {
      const { username, password } = req.body || {};
      const user = await userStore.verifyCredentials(username, password);
      if (!user) {
        // JAMAIS le mot de passe dans metadata, même échoué (voir lib/services/audit/sanitize.js) :
        // seul le username *tenté* est tracé (usernameOverride, pas de req.user à ce stade).
        recordEvent({
          usernameOverride: typeof username === "string" ? username : null,
          action: ACTIONS.LOGIN,
          targetType: "user",
          target: typeof username === "string" ? username : null,
          status: "failed",
          ip: req.ip,
        });
        return res.status(401).json({ error: "Identifiants invalides." });
      }
      req.session.userId = user.id;
      recordEvent({
        user,
        action: ACTIONS.LOGIN,
        targetType: "user",
        target: user.username,
        status: "success",
        ip: req.ip,
      });
      res.json({ ok: true, user: { username: user.username, isAdmin: user.isAdmin } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/logout", (req, res) => {
    const user = req.user;
    if (req.session) {
      req.session.destroy(() => {});
    }
    if (user) {
      recordEvent({ user, action: ACTIONS.LOGOUT, targetType: "user", target: user.username, status: "success", ip: req.ip });
    }
    res.json({ ok: true });
  });

  router.get("/me", (req, res) => {
    if (!auth.AUTH_ENABLED) {
      return res.json({ authEnabled: false, user: { username: "anonyme", isAdmin: true, permissions: [] } });
    }
    if (!req.user) return res.status(401).json({ error: "Non authentifié." });
    res.json({ authEnabled: true, user: req.user });
  });

  return router;
}

module.exports = createAuthRouter;
