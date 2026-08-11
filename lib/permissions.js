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
  // Phase 5A (fondations) : seule notifications_read est réellement
  // vérifiée par une route (lib/routes/notifications.js expose uniquement
  // des GET). Les autres actions sont déclarées dès maintenant pour que le
  // jeu de permissions complet soit disponible aux admins sans exiger une
  // nouvelle migration de permissions au moment où les endpoints CRUD
  // (Phase 5C), le test de provider (notifications_test, Phase 5C) et le
  // routing (notifications_manage, Phase 5B/5C) seront ajoutés.
  //
  // Remarque : la tâche demandait un nommage en dot-notation
  // ("notifications.read"...) — adapté ici en snake_case pour rester
  // cohérent avec le reste de GLOBAL_ACTIONS (alerts_read, events_read…).
  notifications_read: "Voir les providers de notification, leurs types et l'historique d'envoi",
  notifications_create: "Créer une configuration de provider de notification",
  notifications_update: "Modifier une configuration de provider de notification",
  notifications_delete: "Supprimer une configuration de provider de notification",
  notifications_test: "Envoyer une notification de test avec une configuration de provider",
  notifications_history: "Voir l'historique détaillé des notifications envoyées",
  notifications_manage: "Gérer les règles de routing des notifications",
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

module.exports = {
  APP_ACTIONS,
  GLOBAL_ACTIONS,
  ALL_APP_ACTIONS,
  ALL_GLOBAL_ACTIONS,
  hasPermission,
  visibleAppNames,
};
