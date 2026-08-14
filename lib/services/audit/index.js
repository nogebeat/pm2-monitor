"use strict";

/**
 * lib/services/audit/index.js — Phase 9.
 *
 * `recordEvent()` est le SEUL chemin par lequel une entrée atteint la table
 * `audit_log` en dehors des tests : il force le passage par
 * `sanitizeAuditMetadata()` avant d'appeler `audit-store.js#create()` — un
 * appelant ne peut donc jamais, même par erreur, stocker une metadata non
 * sanitisée (voir sanitize.js pour la justification, section 4 du prompt
 * maître : "ne pas compter uniquement sur les développeurs").
 *
 * Volontairement tolérant aux pannes : une erreur d'écriture de l'audit ne
 * doit jamais faire échouer l'action métier qu'il est censé tracer (ex: un
 * restart de process qui réussit ne doit pas se transformer en 500 parce
 * que l'insertion de la ligne d'audit a échoué) — voir recordEvent(), qui
 * avale l'erreur et logge sur stderr plutôt que de la propager.
 */

const auditStore = require("./audit-store");
const { sanitizeAuditMetadata } = require("./sanitize");

const STATUS = { SUCCESS: "success", FAILED: "failed", DENIED: "denied" };

/**
 * Catalogue des actions auditées (section 1 du prompt maître). Documenté ET
 * appliqué : lib/routes/audit.js#GET /catalog l'expose tel quel au
 * frontend, pour construire le filtre "Action" sans dupliquer la liste.
 *
 * Volontairement une liste plate de constantes (pas un enum strict côté
 * store/route) : un `action` inconnu de ce catalogue est quand même
 * accepté à l'écriture (mieux vaut un événement mal étiqueté qu'un
 * événement perdu), mais toute nouvelle action DEVRAIT être ajoutée ici
 * pour rester documentée et filtrable.
 */
const ACTIONS = {
  // Authentification
  LOGIN: "login",
  LOGOUT: "logout",

  // Process
  PROCESS_START: "process.start",
  PROCESS_STOP: "process.stop",
  PROCESS_RESTART: "process.restart",
  PROCESS_RELOAD: "process.reload",
  PROCESS_DELETE: "process.delete",
  PROCESS_ENV_CHANGE: "process.env_change",
  PROCESS_CONFIG_CHANGE: "process.config_change",

  // PM2 (daemon)
  PM2_SAVE: "pm2.save",
  PM2_RESURRECT: "pm2.resurrect",
  PM2_KILL: "pm2.kill",

  // Alertes
  ALERT_RULE_CREATE: "alert.rule_create",
  ALERT_RULE_UPDATE: "alert.rule_update",
  ALERT_RULE_DELETE: "alert.rule_delete",
  ALERT_ACKNOWLEDGE: "alert.acknowledge",

  // Notifications
  NOTIFICATION_CONFIG_CHANGE: "notification.config_change",

  // Health checks
  HEALTH_CHECK_CHANGE: "health_check.change",

  // Auto-healing (actions humaines/administratives seulement — voir
  // docs/audit/README.md : les tentatives *automatiques* de redémarrage
  // restent dans auto_healing_audit, pas de doublon ici)
  AUTO_HEALING_ACTION: "auto_healing.action",
};

/**
 * @param {object} input
 * @param {object|null} [input.user] - req.user ({ id, username }) — peut être null
 *   (ex: tentative de login échouée avec un username invalide)
 * @param {string} [input.usernameOverride] - utilisé quand `user` est null (ex: login échoué :
 *   on veut quand même tracer le username *tenté*, jamais le mot de passe)
 * @param {string} input.action - une valeur de ACTIONS (ou une chaîne libre, voir commentaire ACTIONS)
 * @param {string} [input.target] - identifiant de la cible (nom de process, id de règle…)
 * @param {string} [input.targetType] - type de cible ("process", "alert_rule", "user"…)
 * @param {string} [input.server] - nom du serveur/hôte (multi-serveur futur ; hostname local par défaut)
 * @param {"success"|"failed"|"denied"} input.status
 * @param {string} [input.ip] - IP de la requête (req.ip, déjà résolue via `trust proxy`)
 * @param {object} [input.metadata] - contexte additionnel — TOUJOURS passé par sanitizeAuditMetadata()
 * @returns {Promise<object|null>} l'entrée stockée, ou null si l'écriture a échoué (jamais throw)
 */
async function recordEvent(input) {
  try {
    const user = input.user || null;
    const entry = {
      timestamp: Date.now(),
      userId: user ? user.id : null,
      username: user ? user.username : input.usernameOverride || null,
      action: input.action,
      target: input.target !== undefined && input.target !== null ? String(input.target) : null,
      targetType: input.targetType || null,
      server: input.server || require("os").hostname(),
      status: input.status || STATUS.SUCCESS,
      ip: input.ip || null,
      // Passage OBLIGATOIRE par le sanitizer, quelle que soit la provenance
      // de metadata — voir commentaire de tête de fichier.
      metadata: sanitizeAuditMetadata(input.metadata),
    };
    return await auditStore.create(entry);
  } catch (e) {
    console.error("Erreur d'écriture de l'audit log :", e.message);
    return null;
  }
}

module.exports = { recordEvent, ACTIONS, STATUS, auditStore };
