"use strict";

/**
 * Catalogue des permissions du monitor.
 *
 * Deux familles :
 *  - APP_ACTIONS   : actions qui s'appliquent à une app précise (ou à "*" = toutes les apps)
 *  - GLOBAL_ACTIONS : actions qui n'ont pas de notion d'app (daemon PM2, gestion des users…)
 *
 * Une ligne de permission = (user_id, app_name, action). app_name = "*" veut dire
 * "toutes les apps" et action = "*" veut dire "toutes les actions" — ça permet de
 * donner des droits larges (ex: "*"/"*" = admin fonctionnel) ou très ciblés
 * (ex: "api-prod"/"restart" = peut seulement redémarrer cette app précise).
 */

const APP_ACTIONS = {
  view: "Voir l'app (liste, statut, métriques)",
  logs: "Voir / rechercher / exporter les logs",
  restart: "Redémarrer",
  stop: "Arrêter",
  start: "Démarrer",
  reload: "Reload (0-downtime)",
  delete: "Supprimer du process manager",
  scale: "Changer le nombre d'instances",
  watch: "Activer/désactiver le watch",
  env: "Éditer les variables d'environnement",
  config: "Éditer script / args / mode d'exécution",
  flush: "Vider les logs",
  reset: "Réinitialiser le compteur de restart",
};

const GLOBAL_ACTIONS = {
  system: "Voir les métriques système (CPU/RAM/disque)",
  pm2_save: "pm2 save",
  pm2_resurrect: "pm2 resurrect",
  pm2_flush_all: "Vider tous les logs",
  pm2_update: "pm2 update",
  pm2_kill: "Tuer le daemon PM2",
  manage_users: "Gérer les utilisateurs et permissions",

  // Moteur d'alertes (lib/services/alerts/) — actions globales : une règle
  // peut cibler une app précise, mais sa configuration (créer/modifier/
  // supprimer une règle, voir/acquitter les alertes) reste une action de
  // gestion du monitor, pas une action "sur" une app comme restart/logs.
  alerts_read: "Voir les règles d'alerte et les alertes (actives / historique)",
  alerts_create: "Créer une règle d'alerte",
  alerts_update: "Modifier une règle d'alerte",
  alerts_delete: "Supprimer une règle d'alerte",
  alerts_acknowledge: "Acquitter une alerte active",

  // Timeline d'événements (lib/services/events/) — action globale, comme
  // alerts_read : la lecture de la timeline n'est pas décomposée par app
  // dans cette phase (voir docs/events/README.md, section "Permissions").
  events_read: "Voir la timeline d'événements et de crashs",

  // Notification system (lib/services/notifications/) — action globale,
  // même raisonnement que alerts_*/events_read : une configuration de
  // provider ou une règle de routing n'est pas "sur" une app précise.
  //
  // Phase 5C : notifications_create/update/delete/test sont vérifiées par
  // lib/routes/notifications.js (CRUD complet des providers + test).
  // Phase 5D : notifications_history (GET /history) et notifications_manage
  // (CRUD /routes) sont désormais vérifiées elles aussi — voir
  // lib/routes/notifications.js et lib/services/notifications/routing/.
  //
  // Remarque : la tâche demandait un nommage en dot-notation
  // ("notifications.read"...) — adapté ici en snake_case pour rester
  // cohérent avec le reste de GLOBAL_ACTIONS (alerts_read, events_read…).
  notifications_read: "Voir les providers de notification, leurs types et les règles de routing",
  notifications_create: "Créer une configuration de provider de notification",
  notifications_update: "Modifier une configuration de provider de notification",
  notifications_delete: "Supprimer une configuration de provider de notification",
  notifications_test: "Envoyer une notification de test avec une configuration de provider",
  notifications_history: "Voir l'historique détaillé des notifications envoyées",
  notifications_manage: "Gérer les règles de routing des notifications",

  // Health checks (lib/services/health-checks/) — action globale, même
  // raisonnement que alerts_*/events_read : un health check n'est pas "sur"
  // une app précise au sens des permissions (il peut même ne cibler aucune
  // app PM2, ex: un check TCP sur une base de données externe).
  health_checks_read: "Voir les health checks et leur statut",
  health_checks_create: "Créer un health check",
  health_checks_update: "Modifier / activer / désactiver un health check",
  health_checks_delete: "Supprimer un health check",
  health_checks_test: "Exécuter un health check à la demande (run test)",

  // Auto-Healing (lib/services/auto-healing/) — Phase 7, fonctionnalité
  // CRITIQUE/DANGEREUSE : elle peut redémarrer automatiquement des process
  // de production. Deux permissions seulement (comme demandé par le prompt
  // maître, section 7) : lecture (état/audit) et gestion (activer/
  // désactiver, changer la configuration, débloquer un process).
  authealing_read: "Voir la configuration, l'état par process et l'historique d'Auto-Healing",
  authealing_manage: "Activer/désactiver Auto-Healing, changer sa configuration, débloquer un process",

  // Audit Log (lib/services/audit/) — Phase 9, action globale (comme
  // alerts_read/events_read) : la lecture de l'audit n'est pas décomposée
  // par app, exactement comme la timeline d'événements. Une seule
  // permission de LECTURE : l'audit log lui-même n'est jamais modifiable
  // via l'API (append-only, voir docs/audit/README.md).
  audit_read: "Voir le journal d'audit (actions sensibles : connexions, actions process, configuration…)",

  // Multi-server / Remote PM2 (lib/services/servers/, lib/routes/servers.js)
  // — Phase 10, action globale (comme alerts_read/events_read/audit_read) :
  // le registre de serveurs lui-même n'est pas "sur" une app précise.
  // servers_manage recouvre créer/modifier/activer-désactiver/supprimer un
  // serveur et régénérer son token ; servers_read couvre la liste/le statut.
  // Le SCOPE "quels serveurs précis un utilisateur peut voir" est un filtre
  // orthogonal, distinct de cette permission — voir hasServerAccess()
  // ci-dessous et lib/services/servers/user-scope.js.
  servers_read: "Voir la liste des serveurs, leur statut et leurs métriques",
  servers_manage: "Enregistrer/modifier/activer-désactiver/supprimer un serveur, régénérer son token d'agent",

  // Organisation des process (lib/services/process-organization/,
  // lib/routes/process-organization.js) — Phase 13, action globale (comme
  // servers_read/servers_manage) : le catalogue de tags/environnements/
  // groupes n'est pas "sur" une app précise, et l'assignation d'un tag à un
  // process est une opération de méta-données du monitor, pas une action
  // process au sens de APP_ACTIONS (elle ne modifie ni ne redémarre rien
  // côté PM2). process_org_read couvre la lecture du catalogue et des
  // assignations (y compris les filtres/la vue groupe côté UI) ;
  // process_org_manage couvre la CRUD du catalogue et l'assignation à un
  // process.
  process_org_read: "Voir les tags, environnements, groupes et leurs assignations aux process",
  process_org_manage:
    "Créer/modifier/supprimer des tags, environnements, groupes et les assigner à un process",

  // Incident Management & Alert Silencing (lib/services/incidents/,
  // lib/routes/incidents.js) — Phase 14, action globale (comme
  // alerts_read/events_read/audit_read) : un incident regroupe des alertes
  // déjà globales, il n'est pas "sur" une app précise. incidents_read couvre
  // la liste/le détail/la timeline ; incidents_manage couvre les transitions
  // d'état (acknowledge/investigate/mitigate/resolve) ET la gestion des
  // silences (créer/annuler) — même regroupement que health_checks_read/
  // health_checks_update plutôt qu'une permission par transition, pour ne
  // pas multiplier les permissions sans besoin exprimé par la tâche.
  incidents_read: "Voir les incidents, leur timeline et les silences actifs",
  incidents_manage:
    "Faire transiter un incident (acquitter/enquêter/mitiger/résoudre) et créer/annuler un silence",

  // Détection d'anomalies (lib/services/anomaly-detection/,
  // lib/routes/anomaly-detection.js) — Phase 16, action globale, même
  // raisonnement que alerts_*/health_checks_* : une règle d'anomalie n'est
  // pas "sur" une app précise au sens des permissions (elle peut cibler
  // "system" ou une app, mais sa gestion reste une action de configuration
  // du monitor). Les détections elles-mêmes (table `anomaly_detections`,
  // l'historique/l'explication statistique) se lisent avec anomaly_read —
  // pas de permission séparée, comme alerts_read couvre à la fois les
  // règles et les occurrences.
  anomaly_read: "Voir les règles de détection d'anomalies et l'historique des anomalies détectées",
  anomaly_create: "Créer une règle de détection d'anomalies",
  anomaly_update: "Modifier / activer / désactiver une règle de détection d'anomalies",
  anomaly_delete: "Supprimer une règle de détection d'anomalies",

  // Service Dependency Map (lib/services/service-dependencies/,
  // lib/routes/service-dependencies.js) — Phase 17, action globale, même
  // raisonnement que anomaly_*/health_checks_* : une dépendance déclarée
  // (source -> target) n'est pas "sur" une app précise au sens des
  // permissions (elle peut relier deux apps, ou une app à un service
  // externe comme "PostgreSQL"). CRUD complet comme anomaly_* (pas de
  // regroupement read/manage comme incidents_*/process_org_*, la tâche
  // décrivant un vrai CRUD plutôt que des transitions d'état).
  // dependencies_read couvre aussi la lecture du graphe/statut/impact
  // (GET /graph, /impact/:service) — pas de permission séparée, comme
  // anomaly_read couvre à la fois les règles et les détections.
  dependencies_read: "Voir les dépendances de service déclarées, le graphe et le statut dérivé",
  dependencies_create: "Créer une dépendance de service",
  dependencies_update: "Modifier / activer / désactiver une dépendance de service",
  dependencies_delete: "Supprimer une dépendance de service",

  // Clés API M2M (lib/services/api-keys/, lib/routes/api-keys.js) — Phase 18,
  // action globale, même raisonnement que servers_read/servers_manage : le
  // registre de clés API n'est pas "sur" une app précise. api_keys_read
  // couvre la liste (jamais le secret, voir lib/services/api-keys/store.js) ;
  // api_keys_manage couvre créer/révoquer/modifier une clé.
  api_keys_read: "Voir la liste des clés API (jamais le secret)",
  api_keys_manage: "Créer, modifier et révoquer une clé API",
};

const ALL_APP_ACTIONS = Object.keys(APP_ACTIONS);
const ALL_GLOBAL_ACTIONS = Object.keys(GLOBAL_ACTIONS);

/**
 * Rôles prédéfinis (Phase 18) — un rôle n'est qu'un GABARIT pratique pour
 * remplir `permissions` en une fois depuis l'UI/CLI (voir
 * lib/user-store.js#applyRole) : il n'introduit AUCUNE nouvelle notion
 * d'autorisation, `hasPermission()` ci-dessous continue à ne lire que des
 * lignes (user_id, app_name, action) + le flag `is_admin` exactement comme
 * avant cette phase. "Admin" est un cas particulier : appliquer ce rôle
 * revient à poser `is_admin = 1` (qui court-circuite déjà toute vérification,
 * voir hasPermission()) plutôt qu'à lister explicitement toutes les actions.
 *
 * - Admin    : accès complet (is_admin = 1).
 * - Operator : peut opérer les process (toutes actions sauf delete) sur
 *   toutes les apps ("*"), plus les actions de gestion "opérationnelles"
 *   courantes (acquitter une alerte, tester un health check, gérer un
 *   incident) — mais pas la gestion des utilisateurs/clés API/serveurs.
 * - Viewer   : lecture seule sur les process ("view"/"logs" sur "*") — pas
 *   d'accès aux sous-systèmes de configuration (alertes, notifications…).
 * - Auditor  : lecture seule transverse orientée conformité/supervision
 *   (audit, événements, alertes, incidents, health checks, notifications,
 *   serveurs) — volontairement PAS "view"/"logs" (un auditeur consulte les
 *   traces et l'état des sous-systèmes, pas le contenu des logs applicatifs).
 */
const ROLES = {
  admin: { label: "Admin", isAdmin: true, permissions: [] },
  operator: {
    label: "Operator",
    isAdmin: false,
    permissions: [
      ...ALL_APP_ACTIONS.filter((a) => a !== "delete").map((action) => ({ appName: "*", action })),
      { appName: "*", action: "alerts_read" },
      { appName: "*", action: "alerts_acknowledge" },
      { appName: "*", action: "health_checks_read" },
      { appName: "*", action: "health_checks_test" },
      { appName: "*", action: "incidents_read" },
      { appName: "*", action: "incidents_manage" },
      { appName: "*", action: "events_read" },
      { appName: "*", action: "authealing_read" },
    ],
  },
  viewer: {
    label: "Viewer",
    isAdmin: false,
    permissions: [
      { appName: "*", action: "view" },
      { appName: "*", action: "logs" },
    ],
  },
  auditor: {
    label: "Auditor",
    isAdmin: false,
    permissions: [
      { appName: "*", action: "audit_read" },
      { appName: "*", action: "events_read" },
      { appName: "*", action: "alerts_read" },
      { appName: "*", action: "incidents_read" },
      { appName: "*", action: "health_checks_read" },
      { appName: "*", action: "notifications_read" },
      { appName: "*", action: "notifications_history" },
      { appName: "*", action: "servers_read" },
      { appName: "*", action: "anomaly_read" },
      { appName: "*", action: "dependencies_read" },
    ],
  },
};

const ALL_ROLE_NAMES = Object.keys(ROLES);

/**
 * Catalogue des scopes de clé API (Phase 18, lib/services/api-keys/).
 * Volontairement une liste COURTE et explicite (pas un mapping 1:1 avec
 * APP_ACTIONS/GLOBAL_ACTIONS) : une clé API est faite pour une intégration
 * machine précise (superviser des métriques, lire des logs, relayer des
 * alertes…), pas pour reproduire l'intégralité des droits d'un utilisateur
 * humain. Toute action non listée dans ACTION_TO_API_KEY_SCOPE reste
 * inatteignable par une clé API, quels que soient ses scopes — refus par
 * défaut (voir apiKeyCanPerform ci-dessous).
 */
const API_KEY_SCOPES = {
  "metrics:read": "Lecture des métriques système (CPU/RAM/disque, historique)",
  "processes:read": "Lecture de la liste des process et de leur statut",
  "processes:restart": "Redémarrer un process (action sensible — seule action de mutation exposée à une clé API)",
  "logs:read": "Lecture / recherche des logs d'un process",
  "alerts:read": "Lecture des règles d'alerte et des alertes actives/historique",
  "alerts:write": "Acquitter une alerte active (action sensible)",
  "notifications:test": "Déclencher l'envoi d'une notification de test (action sensible)",
  "servers:read": "Lecture du registre de serveurs (Multi-server) et de leur statut",
};

const ALL_API_KEY_SCOPES = Object.keys(API_KEY_SCOPES);

// Actions dangereuses au sens de la clé API : leur utilisation est TOUJOURS
// tracée dans l'audit log (voir lib/auth.js#requirePermission et
// lib/process-helpers.js#withAppPermission), pas seulement en cas de refus —
// voir prompt de phase, section Audit ("utilisation sensible").
// Actions dangereuses au sens de la clé API : leur utilisation est TOUJOURS
// tracée dans l'audit log (voir lib/auth.js#requirePermission et
// lib/process-helpers.js#withAppPermission), pas seulement en cas de refus —
// voir prompt de phase, section Audit ("utilisation sensible"). "restart"
// est la SEULE action de mutation process exposée à une clé API dans cette
// phase (stop/reload/scale/delete restent hors de portée, quels que soient
// les scopes détenus — voir ACTION_TO_API_KEY_SCOPE ci-dessous) : un besoin
// M2M courant (un orchestrateur externe qui relance un service) est couvert
// sans élargir la surface aux actions destructives.
const SENSITIVE_API_KEY_SCOPES = ["alerts:write", "notifications:test", "processes:restart"];

/**
 * Mappe une action interne (APP_ACTIONS/GLOBAL_ACTIONS) vers le scope de clé
 * API qui l'autorise. Une action absente de cette table n'est JAMAIS
 * accessible à une clé API (voir apiKeyCanPerform) — c'est le seul endroit à
 * modifier pour exposer une nouvelle action aux intégrations M2M.
 */
const ACTION_TO_API_KEY_SCOPE = {
  system: "metrics:read",
  view: "processes:read",
  restart: "processes:restart",
  logs: "logs:read",
  alerts_read: "alerts:read",
  alerts_acknowledge: "alerts:write",
  notifications_test: "notifications:test",
  servers_read: "servers:read",
};

function isSensitiveApiKeyScope(scope) {
  return SENSITIVE_API_KEY_SCOPES.includes(scope);
}

/** apiKeyAuth: { id, name, scopes: string[], resourceScopes?: {processes?: string[], ...} } (voir lib/services/api-keys/index.js#verify) */
function hasScope(apiKeyAuth, scope) {
  return !!apiKeyAuth && Array.isArray(apiKeyAuth.scopes) && apiKeyAuth.scopes.includes(scope);
}

/**
 * Équivalent de hasPermission() mais pour une clé API M2M (jamais pour un
 * utilisateur avec session — les deux chemins restent séparés, voir
 * lib/auth.js#requirePermission). appName = null pour une action globale.
 *
 * Scope de ressource "process" (voir migration 020_rbac_api_keys.js) : si la
 * clé porte `resourceScopes.processes` (liste non vide), elle ne peut agir
 * que sur les apps listées — sinon (absent/vide) elle a accès à toutes les
 * apps pour les scopes qu'elle possède, même convention que
 * hasServerAccess() pour allowedServerKeys.
 *
 * Volontairement SANS lookup DB (voir en-tête de fichier — ce module reste
 * pur) : les scopes de ressource "environment"/"group", qui nécessitent une
 * requête sur lib/services/process-organization/, sont vérifiés séparément
 * par lib/services/api-keys/resource-scope.js#processResourceScopeAllows(),
 * appelé en complément de cette fonction par
 * lib/process-helpers.js#withAppPermission et
 * lib/routes/processes.js#GET /processes. Le scope "server" est vérifié par
 * apiKeyHasServerAccess() ci-dessus, appelé depuis
 * lib/auth.js#requireServerAccess (middleware séparé).
 */
function apiKeyCanPerform(apiKeyAuth, appName, action) {
  if (!apiKeyAuth) return false;
  const scope = ACTION_TO_API_KEY_SCOPE[action];
  if (!scope || !hasScope(apiKeyAuth, scope)) return false;
  const allowedProcesses = apiKeyAuth.resourceScopes && apiKeyAuth.resourceScopes.processes;
  if (appName && Array.isArray(allowedProcesses) && allowedProcesses.length) {
    return allowedProcesses.includes(appName);
  }
  return true;
}

/**
 * user: { id, username, isAdmin, permissions: [{appName, action}] }
 * appName: nom de l'app pm2 concernée (ignoré pour les actions globales)
 * action: une clé de APP_ACTIONS ou GLOBAL_ACTIONS
 */
function hasPermission(user, appName, action) {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (!Array.isArray(user.permissions)) return false;

  const isGlobal = Object.prototype.hasOwnProperty.call(GLOBAL_ACTIONS, action);
  return user.permissions.some((p) => {
    const actionMatches = p.action === "*" || p.action === action;
    if (!actionMatches) return false;
    if (isGlobal) return true; // les actions globales ne dépendent pas de app_name
    return p.appName === "*" || p.appName === appName;
  });
}

/** Sous-ensemble des apps (par nom) visibles par l'utilisateur (au moins "view"). */
function visibleAppNames(user, allAppNames) {
  if (!user) return [];
  if (user.isAdmin) return allAppNames;
  return allAppNames.filter((name) => hasPermission(user, name, "view"));
}

/**
 * Scoping optionnel par serveur (Phase 10 — Multi-server / Remote PM2).
 * `user.allowedServerKeys` est chargé par lib/user-store.js (comme
 * `user.permissions`) depuis lib/services/servers/user-scope.js.
 *
 * Ce n'est volontairement PAS un second système de permissions : il n'y a
 * qu'une seule question ici ("cet utilisateur a-t-il le droit de voir CE
 * serveur ?"), orthogonale à hasPermission() (qui reste seule responsable
 * de "quelle action / quelle app"). Un utilisateur doit passer les DEUX
 * vérifications pour agir sur un process d'un serveur donné.
 *
 * - admin, ou pas de restriction explicite (liste vide/absente) -> accès à tous les serveurs.
 * - sinon -> accès uniquement aux server_key listés.
 */
function hasServerAccess(user, serverKey) {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (!Array.isArray(user.allowedServerKeys) || user.allowedServerKeys.length === 0) return true;
  return user.allowedServerKeys.includes(serverKey);
}

/**
 * Équivalent de hasServerAccess() pour une clé API M2M (Phase 18) — même
 * convention que resourceScopes.processes dans apiKeyCanPerform() : une
 * liste absente/vide = pas de restriction, une liste non vide restreint aux
 * serverKey listés. Volontairement séparée de apiKeyCanPerform() : elle est
 * appelée par lib/auth.js#requireServerAccess, un middleware distinct de
 * requirePermission() (les deux sont chaînés sur les routes serveur, voir
 * lib/routes/servers.js).
 */
function apiKeyHasServerAccess(apiKeyAuth, serverKey) {
  if (!apiKeyAuth) return false;
  const allowedServers = apiKeyAuth.resourceScopes && apiKeyAuth.resourceScopes.servers;
  if (Array.isArray(allowedServers) && allowedServers.length) {
    return allowedServers.includes(serverKey);
  }
  return true;
}

/** Sous-ensemble d'une liste de serveurs (objets avec serverKey) visibles par l'utilisateur. */
function visibleServers(user, allServers) {
  if (!user) return [];
  if (user.isAdmin) return allServers;
  return allServers.filter((s) => hasServerAccess(user, s.serverKey));
}

module.exports = {
  APP_ACTIONS,
  GLOBAL_ACTIONS,
  ALL_APP_ACTIONS,
  ALL_GLOBAL_ACTIONS,
  hasPermission,
  visibleAppNames,
  hasServerAccess,
  apiKeyHasServerAccess,
  visibleServers,
  // Phase 18 — Advanced RBAC & API Keys
  ROLES,
  ALL_ROLE_NAMES,
  API_KEY_SCOPES,
  ALL_API_KEY_SCOPES,
  SENSITIVE_API_KEY_SCOPES,
  ACTION_TO_API_KEY_SCOPE,
  isSensitiveApiKeyScope,
  hasScope,
  apiKeyCanPerform,
};
