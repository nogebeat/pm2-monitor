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
};

const ALL_APP_ACTIONS = Object.keys(APP_ACTIONS);
const ALL_GLOBAL_ACTIONS = Object.keys(GLOBAL_ACTIONS);

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
  visibleServers,
};
