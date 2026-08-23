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
 *
 * `AuditRetentionService` (fin de fichier) gère la purge par rétention,
 * optionnelle et désactivée par défaut (voir config.js) — même découpage
 * que EventsService pour la timeline d'événements.
 */

const auditStore = require("./audit-store");
const { sanitizeAuditMetadata } = require("./sanitize");
const { resolveConfig } = require("./config");

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

  // Multi-server / Remote PM2 (Phase 10) — gestion du registre de serveurs
  // (lib/services/servers/, lib/routes/servers.js) et actions PM2 relayées
  // vers un agent distant (lib/realtime/agent-hub.js).
  SERVER_REGISTER: "server.register",
  SERVER_UPDATE: "server.update",
  SERVER_ENABLE: "server.enable",
  SERVER_DISABLE: "server.disable",
  SERVER_DELETE: "server.delete",
  SERVER_TOKEN_REGENERATE: "server.token_regenerate",
  SERVER_REMOTE_ACTION: "server.remote_action",

  // Organisation des process (Phase 13) — CRUD du catalogue (tags/
  // environnements/groupes) et assignation à un process, une seule action
  // (comme HEALTH_CHECK_CHANGE) : le détail (create/update/delete/assign)
  // part en `metadata`, pas dans l'action elle-même.
  PROCESS_ORG_CHANGE: "process_organization.change",
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

/**
 * Rétention automatique (optionnelle, désactivée par défaut — voir
 * config.js). Même découpage que EventsService
 * (lib/services/events/index.js#start/stop/purgeOnce) : un intervalle
 * dédié, indépendant de tout autre polling, purge par lots via
 * `audit-store.js#purgeOlderThan`. Instanciée par server.js une fois le
 * `.env` chargé (comme EventsService/ProcessHistoryService), pas au
 * moment du require() de ce module.
 */
class AuditRetentionService {
  constructor(env = process.env) {
    this.config = resolveConfig(env);
    this._maintenanceTimer = null;
    this._maintenanceRunning = false;
  }

  start() {
    if (this._maintenanceTimer || !this.config.retentionMs) return; // 0 = purge désactivée
    this._maintenanceTimer = setInterval(() => this._tick(), this.config.maintenanceIntervalMs);
    if (this._maintenanceTimer.unref) this._maintenanceTimer.unref();
  }

  stop() {
    if (this._maintenanceTimer) clearInterval(this._maintenanceTimer);
    this._maintenanceTimer = null;
  }

  async _tick() {
    if (this._maintenanceRunning) return; // évite le chevauchement si un cycle prend plus longtemps que l'intervalle
    this._maintenanceRunning = true;
    try {
      await this.purgeOnce();
    } catch (e) {
      console.error("Erreur de purge de l'audit log :", e.message);
    } finally {
      this._maintenanceRunning = false;
    }
  }

  /** Exposé pour les tests (et un éventuel appel manuel) : un cycle de purge synchrone. Pas d'effet si retentionMs vaut 0. */
  purgeOnce(now = Date.now()) {
    if (!this.config.retentionMs) return Promise.resolve(0);
    return auditStore.purgeOlderThan(now - this.config.retentionMs);
  }
}

module.exports.AuditRetentionService = AuditRetentionService;
