"use strict";

const crypto = require("crypto");
const session = require("express-session");
const userStore = require("./user-store");
const {
  hasPermission,
  hasServerAccess,
  apiKeyHasServerAccess,
  apiKeyCanPerform,
  isSensitiveApiKeyScope,
  ACTION_TO_API_KEY_SCOPE,
} = require("./permissions");
const { recordEvent, ACTIONS } = require("./services/audit");
const apiKeysStore = require("./services/api-keys/store");

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

/**
 * Charge une éventuelle clé API M2M depuis `Authorization: Bearer <clé>`
 * (Phase 18 — Advanced RBAC & API Keys). Totalement indépendant de la session
 * navigateur (loadCurrentUser/sessionMiddleware ci-dessus) : une requête peut
 * porter les deux, mais req.user (session) reste toujours prioritaire côté
 * requirePermission()/withAppPermission() ci-dessous — voir leurs
 * commentaires. Ne fait jamais échouer la requête elle-même : une clé absente,
 * malformée, invalide, expirée ou révoquée laisse simplement req.apiKeyAuth
 * indéfini (requireAuth/requirePermission décident ensuite s'il faut bloquer).
 */
async function loadApiKeyAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return next();
  try {
    const apiKey = await apiKeysStore.verify(match[1]);
    if (apiKey) req.apiKeyAuth = apiKey;
  } catch (e) {
    console.error("Erreur de vérification de clé API :", e.message);
  }
  next();
}

/** Bloque les routes API (sauf login) et laisse passer les assets tant que non authentifié. */
function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (req.session && req.session.userId) return next();
  if (req.apiKeyAuth) return next(); // clé API M2M valide (Phase 18) — le scope exact est vérifié par requirePermission()
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

    // Chemin normal : utilisateur avec session (inchangé depuis avant la
    // Phase 18). req.user n'est jamais défini pour une requête authentifiée
    // uniquement par clé API (voir loadCurrentUser), donc ce chemin et le
    // suivant sont mutuellement exclusifs.
    if (req.user) {
      if (hasPermission(req.user, appName, action)) return next();
    } else if (req.apiKeyAuth) {
      // Clé API M2M (Phase 18) : n'autorise qu'un sous-ensemble d'actions
      // explicitement exposées en scope (lib/permissions.js#ACTION_TO_API_KEY_SCOPE) —
      // tout le reste est refusé par défaut, ce n'est PAS un second système
      // de permissions, juste une vérification supplémentaire sur le même
      // catalogue d'actions.
      if (apiKeyCanPerform(req.apiKeyAuth, appName, action)) {
        const scope = ACTION_TO_API_KEY_SCOPE[action];
        if (isSensitiveApiKeyScope(scope)) {
          recordEvent({
            usernameOverride: `api-key:${req.apiKeyAuth.name}`,
            action: ACTIONS.API_KEY_SENSITIVE_USE,
            target: action,
            targetType: "api_key_scope",
            status: "success",
            ip: req.ip,
            metadata: { apiKeyId: req.apiKeyAuth.id, scope, appName },
          });
        }
        return next();
      }
    }

    if (auditOptions) {
      recordEvent({
        user: req.user || null,
        usernameOverride: !req.user && req.apiKeyAuth ? `api-key:${req.apiKeyAuth.name}` : undefined,
        action: auditOptions.action,
        target: auditOptions.targetFromReq ? auditOptions.targetFromReq(req) : appName,
        targetType: auditOptions.targetType,
        status: "denied",
        ip: req.ip,
      });
    }
    return res.status(403).json({ error: "Action non autorisée pour cet utilisateur." });
  };
}

/**
 * Middleware factory (Phase 10 — Multi-server) : vérifie que l'utilisateur a
 * accès au serveur ciblé (lib/permissions.js#hasServerAccess), en plus de
 * toute vérification de permission "classique" (action/app) faite par
 * ailleurs. serverKeyFromReq(req) => server_key concerné (ex: req.params.key).
 */
function requireServerAccess(serverKeyFromReq) {
  return (req, res, next) => {
    if (!AUTH_ENABLED) return next();
    const serverKey = serverKeyFromReq(req);
    // Phase 18 — Advanced RBAC & API Keys : chemin clé API en complément du
    // chemin session existant (inchangé) — voir
    // lib/permissions.js#apiKeyHasServerAccess.
    const allowed = req.user
      ? hasServerAccess(req.user, serverKey)
      : apiKeyHasServerAccess(req.apiKeyAuth, serverKey);
    if (!allowed) {
      return res.status(403).json({ error: "Accès non autorisé à ce serveur." });
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
  loadApiKeyAuth,
  requirePermission,
  requireServerAccess,
  requireAdmin,
};
