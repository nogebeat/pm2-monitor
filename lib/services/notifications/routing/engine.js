"use strict";

/**
 * RoutingEngine — Phase 5D. Fait le pont entre l'Alert Engine
 * (lib/services/alerts/engine.js) et le Notification Registry
 * (lib/services/notifications/registry.js) :
 *
 *   AlertEngine transition (triggered/resolved) --> RoutingEngine.dispatch()
 *     --> notification_routes activées dont les `conditions` matchent
 *     --> pour chaque provider de la règle : rendu du template (templates.js)
 *         + provider.send() (déjà implémenté, Phase 5B)
 *     --> écriture dans notification_history (succès/échec, jamais de secret)
 *
 * Volontairement indépendant de lib/services/alerts/ : ce module ne reçoit
 * qu'un objet "alerte" déjà résolu (même forme que
 * alert-store.js#rowToAlert) et une chaîne d'événement — aucun import de
 * lib/services/alerts/ ici, pour ne pas créer de dépendance circulaire ni
 * changer le comportement/l'API de l'Alert Engine (déjà testé
 * indépendamment, voir test/unit/alert-engine.test.js). C'est l'appelant
 * (server.js) qui détecte la transition et appelle dispatch() — voir
 * server.js pour comment une transition "on vient de déclencher"/"on vient
 * de résoudre" est détectée sans modifier engine.js.
 *
 * Mise en file d'attente / retry (Phase 5E, lib/services/notifications/
 * dispatch-queue.js, adossé à lib/services/queue/ déjà existante) :
 * `dispatch()` reste responsable du *routing* (quelle règle matche, quel
 * template) — l'*envoi* est délégué à `deps.dispatchQueue` quand il est
 * fourni : au lieu d'appeler `provider.send()` en direct et d'attendre,
 * on empile un job (retry + backoff exponentiel, rate limiting,
 * déduplication — voir dispatch-queue.js) et l'entrée d'historique créée
 * immédiatement est "pending", pas "success"/"failed" (elle évoluera de
 * façon asynchrone via le worker de la queue). Sans `dispatchQueue` fourni
 * (comportement historique de la Phase 5D, toujours utilisé par les tests
 * unitaires de ce module et par tout appelant qui veut un résultat
 * synchrone), `dispatch()` continue d'envoyer directement via le provider.
 * Dans les deux cas, jamais d'exception ne remonte à l'appelant (voir
 * section 6 "Failure scenarios" de la tâche : un provider en panne ne doit
 * jamais interrompre la boucle de monitoring principale). Anti-spam
 * (section 5 de la tâche) : assuré en amont par l'Alert Engine lui-même
 * (déduplication + cooldown, voir engine.js) et, côté notifications, par le
 * rate limiter + la déduplication de dispatch-queue.js — dispatch() n'est
 * de toute façon appelé qu'une fois par transition d'état réelle, jamais à
 * chaque tick d'évaluation.
 */

function matchesList(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true; // pas de filtre = tout passe
  if (value === undefined || value === null) return false;
  return list.includes(String(value));
}

class RoutingEngine {
  /**
   * @param {{
   *   routeStore: import("./route-store"),
   *   providerStore: import("../provider-store"),
   *   registry: import("../registry").ProviderRegistry,
   *   historyStore: import("../history-store"),
   *   renderNotification?: Function,
   *   now?: () => number,
   *   dispatchQueue?: import("../dispatch-queue").NotificationDispatchQueue,
   * }} deps
   */
  constructor({ routeStore, providerStore, registry, historyStore, renderNotification, now, dispatchQueue } = {}) {
    if (!routeStore) throw new Error("RoutingEngine : routeStore requis.");
    if (!providerStore) throw new Error("RoutingEngine : providerStore requis.");
    if (!registry) throw new Error("RoutingEngine : registry requis.");
    if (!historyStore) throw new Error("RoutingEngine : historyStore requis.");
    this.routeStore = routeStore;
    this.providerStore = providerStore;
    this.registry = registry;
    this.historyStore = historyStore;
    this.renderNotification = renderNotification || require("./templates").renderNotification;
    this.now = now || (() => Date.now());
    // Optionnel (Phase 5E) : voir commentaire de classe ci-dessus.
    this.dispatchQueue = dispatchQueue || null;
  }

  // --- Matching --------------------------------------------------------

  /**
   * `conditions.server` et `conditions.tag` sont déclarés dans le modèle
   * (voir route-store.js) mais n'ont pas encore d'équivalent côté alerte :
   * ce moniteur est mono-hôte (pas de notion de "serveur" distinct d'une
   * cible process/system) et les règles d'alerte ne portent pas de tag. Une
   * règle qui filtre sur `tag` ne matchera donc jamais tant qu'aucune
   * alerte ne porte de tag (limitation documentée, voir docs/notifications).
   * `server` est accepté pour compatibilité future (déploiement multi-hôte)
   * et interprété prudemment : seules les cibles "system" peuvent matcher
   * un filtre `server` non vide (une cible "process" n'a pas de serveur).
   */
  routeMatches(route, alert) {
    const c = (route && route.conditions) || {};
    if (!matchesList(c.severity, alert.severity)) return false;
    if (!matchesList(c.alertType, alert.metric)) return false;

    if (Array.isArray(c.process) && c.process.length > 0) {
      if (alert.targetType !== "process" || !c.process.includes(alert.targetValue)) return false;
    }
    if (Array.isArray(c.server) && c.server.length > 0) {
      if (alert.targetType !== "system") return false;
    }
    if (Array.isArray(c.tag) && c.tag.length > 0) {
      // Aucune alerte ne porte de tag actuellement : un filtre tag non vide
      // ne matche donc jamais (voir commentaire de classe ci-dessus).
      return false;
    }
    return true;
  }

  async findMatchingRoutes(alert) {
    const routes = await this.routeStore.list({ enabledOnly: true });
    return routes.filter((route) => this.routeMatches(route, alert));
  }

  // --- Dispatch ----------------------------------------------------------

  /**
   * @param {object} alert - occurrence d'alerte (alert-store.js#rowToAlert)
   * @param {"triggered"|"resolved"} event
   * @returns {Promise<Array>} un résultat par (règle matchée × provider ciblé) tenté
   */
  async dispatch(alert, event) {
    if (!alert) return [];
    try {
      const routes = await this.findMatchingRoutes(alert);
      const results = [];
      for (const route of routes) {
        if (event === "resolved" && !route.notifyOnResolve) continue;

        const providerIds = Array.isArray(route.providerIds) ? route.providerIds : [];
        if (!providerIds.length) continue;

        const notification = this.renderNotification(route, alert, event);
        for (const providerId of providerIds) {
          results.push(await this._sendToProvider(providerId, notification, alert, event));
        }
      }
      return results;
    } catch (e) {
      // Ne doit jamais remonter : appelé depuis la boucle de monitoring
      // principale (server.js), qui doit continuer à tourner quoi qu'il
      // arrive côté notifications.
      console.error("Erreur de dispatch de notification (routing) :", e.message);
      return [];
    }
  }

  async _sendToProvider(providerId, notification, alert, event) {
    // Phase 5E : si une dispatchQueue est fournie, on ne fait plus l'envoi
    // ici — on empile un job (retry/backoff/rate limit/dedup gérés par
    // dispatch-queue.js) et on renvoie le résultat de la mise en file
    // (statut "pending"/"queued", pas encore "success"/"failed").
    if (this.dispatchQueue) {
      return this.dispatchQueue.enqueue({ providerId, notification, alertId: alert.id, event });
    }

    const startedAt = this.now();
    try {
      const provider = await this.providerStore.getById(providerId);
      if (!provider || !provider.enabled) {
        return this._recordHistory({
          providerId,
          alertId: alert.id,
          status: "failed",
          errorCode: provider ? "PROVIDER_DISABLED" : "PROVIDER_NOT_FOUND",
          startedAt,
        });
      }

      const implementation = this.registry.getProvider(provider.type);
      if (!implementation) {
        return this._recordHistory({
          providerId,
          alertId: alert.id,
          status: "failed",
          errorCode: "UNKNOWN_PROVIDER_TYPE",
          startedAt,
        });
      }

      const secrets = (await this.providerStore.getDecryptedSecrets(providerId)) || {};
      const config = { ...provider.configuration, ...secrets };
      const result = await implementation.send(notification, config);

      return this._recordHistory({
        providerId,
        alertId: alert.id,
        status: result && result.success ? "success" : "failed",
        errorCode: (result && result.errorCode) || null,
        responseTimeMs:
          result && result.responseTime !== undefined && result.responseTime !== null
            ? result.responseTime
            : this.now() - startedAt,
        startedAt,
      });
    } catch (e) {
      // Un provider ne doit jamais lancer (voir types.js), mais on se
      // protège quand même : une erreur ici ne doit ni remonter ni
      // empêcher les providers suivants d'être appelés.
      return this._recordHistory({
        providerId,
        alertId: alert.id,
        status: "failed",
        errorCode: "INTERNAL_ERROR",
        startedAt,
      });
    }
  }

  async _recordHistory({ providerId, alertId, status, errorCode, responseTimeMs, startedAt }) {
    try {
      return await this.historyStore.create({
        providerId,
        alertId,
        status,
        timestamp: this.now(),
        responseTimeMs: responseTimeMs !== undefined ? responseTimeMs : this.now() - startedAt,
        errorCode: errorCode || null,
      });
    } catch (e) {
      // L'échec d'écriture de l'historique ne doit pas faire perdre le
      // résultat de l'envoi lui-même à l'appelant, ni faire planter le
      // dispatch — on journalise seulement.
      console.error("Erreur d'écriture de l'historique de notification :", e.message);
      return null;
    }
  }
}

module.exports = { RoutingEngine, matchesList };
