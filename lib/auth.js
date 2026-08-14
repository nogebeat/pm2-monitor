"use strict";

const crypto = require("crypto");
const session = require("express-session");
const userStore = require("./user-store");
const { hasPermission } = require("./permissions");
const { recordEvent } = require("./services/audit");

const AUTH_ENABLED = process.env.PM2_MONITOR_DISABLE_AUTH !== "1";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString("hex");

function sessionMiddleware() {
  return session({
    name: "pm2monitor.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.SESSION_COOKIE_SECURE === "1",
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 jours
    },
  });
}

const PUBLIC_API_PATHS = new Set(["/api/auth/login", "/api/auth/me"]);

/** Bloque les routes API (sauf login) et laisse passer les assets tant que non authentifié. */
function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (req.session && req.session.userId) return next();
  if (PUBLIC_API_PATHS.has(req.path)) return next(); // /login doit rester joignable ; /me renvoie 401 proprement
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Authentification requise." });
  }
  next(); // laisse passer les fichiers statiques (index.html gère l'écran de login côté client)
}

/** Charge l'utilisateur courant (avec permissions) sur req.user si une session est ouverte. */
async function loadCurrentUser(req, res, next) {
  if (!AUTH_ENABLED) {
    req.user = { id: 0, username: "anonyme", isAdmin: true, permissions: [] };
    return next();
  }
  if (!req.session || !req.session.userId) return next();
  try {
    req.user = await userStore.getUserWithPermissions(req.session.userId);
    if (!req.user) req.session.destroy(() => {});
  } catch (e) {
    console.error("Erreur de chargement de l'utilisateur :", e.message);
  }
  next();
}

/**
 * Middleware factory : vérifie qu'une permission est accordée.
 * appNameFromReq(req) => nom d'app pm2 concerné (ou null pour une action globale).
 *
 * @param {object} [auditOptions] - si fourni, un refus ("denied") est tracé
 *   dans l'audit log (lib/services/audit/) — voir docs/audit/README.md,
 *   section 1 : les actions sensibles refusées doivent aussi être auditées,
 *   pas seulement leurs succès/échecs. Volontairement opt-in (pas systématique
 *   sur TOUTE permission) : la plupart des permissions de lecture
 *   (alerts_read, events_read…) n'ont pas besoin d'auditer leurs refus —
 *   voir section 1 du prompt maître, "ne capture pas inutilement chaque
 *   action de lecture".
 * @param {string} auditOptions.action - une valeur de lib/services/audit/index.js#ACTIONS
 * @param {string} [auditOptions.targetType]
 * @param {(req) => string} [auditOptions.targetFromReq] - résout la cible depuis la requête
 */
function requirePermission(action, appNameFromReq, auditOptions) {
  return (req, res, next) => {
    if (!AUTH_ENABLED) return next();
    const appName = appNameFromReq ? appNameFromReq(req) : null;
    if (!hasPermission(req.user, appName, action)) {
      if (auditOptions) {
        recordEvent({
          user: req.user,
          action: auditOptions.action,
          target: auditOptions.targetFromReq ? auditOptions.targetFromReq(req) : appName,
          targetType: auditOptions.targetType,
          status: "denied",
          ip: req.ip,
        });
      }
      return res.status(403).json({ error: "Action non autorisée pour cet utilisateur." });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (req.user && req.user.isAdmin) return next();
  return res.status(403).json({ error: "Réservé aux administrateurs." });
}

module.exports = {
  AUTH_ENABLED,
  sessionMiddleware,
  requireAuth,
  loadCurrentUser,
  requirePermission,
  requireAdmin,
};
