"use strict";

/**
 * Abstraction commune à tous les providers de notification (email, discord,
 * telegram, slack, webhook…). Le Notification Manager (manager.js) ne parle
 * qu'à cette interface via le Provider Registry (registry.js) : il ne connaît
 * jamais les détails d'un provider précis, ce qui permet d'en ajouter un
 * nouveau sans toucher au manager (voir docs/notifications/README.md).
 *
 * Phase 5A : seuls des placeholders existent (lib/services/notifications/
 * providers/), qui déclarent leur `type` et une validation de configuration
 * basique. `test()` et `send()` lèvent volontairement une erreur explicite —
 * l'envoi réel est prévu en Phase 5C (les providers), la mise en file
 * d'attente/retry en Phase 5B (lib/services/queue/, déjà existante).
 */
class NotificationProvider {
  /**
   * @param {string} type - identifiant unique du provider (clé du registry), ex: "discord"
   * @param {string} label - nom lisible, ex: "Discord"
   */
  constructor(type, label) {
    if (!type) throw new Error("NotificationProvider : type requis.");
    this.type = type;
    this.label = label || type;
  }

  /**
   * Valide une configuration (champs publics + secrets fusionnés) pour ce
   * provider. Retourne un tableau d'erreurs (vide = valide). Ne doit jamais
   * lancer : les erreurs de validation sont des données, pas des exceptions.
   */
  validateConfig(_config) {
    throw new Error(`validateConfig() non implémenté pour le provider "${this.type}".`);
  }

  /**
   * Envoie une notification de test avec cette configuration. Non implémenté
   * en Phase 5A — prévu en Phase 5C avec les providers réels.
   */
  async test(_config) {
    throw new Error(
      `test() non implémenté pour le provider "${this.type}" (prévu en Phase 5C — voir Phase 5A du notification system).`
    );
  }

  /**
   * Envoie effectivement une notification. Non implémenté en Phase 5A.
   */
  async send(_notification, _config) {
    throw new Error(
      `send() non implémenté pour le provider "${this.type}" (prévu en Phase 5C — voir Phase 5A du notification system).`
    );
  }
}

module.exports = { NotificationProvider };