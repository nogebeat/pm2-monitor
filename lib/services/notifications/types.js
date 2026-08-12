"use strict";

/**
 * Abstraction commune à tous les providers de notification (email, discord,
 * telegram, slack, webhook…). Le Notification Manager (manager.js) ne parle
 * qu'à cette interface via le Provider Registry (registry.js) : il ne connaît
 * jamais les détails d'un provider précis, ce qui permet d'en ajouter un
 * nouveau sans toucher au manager (voir docs/notifications/README.md).
 *
 * Phase 5B : les providers (lib/services/notifications/providers/)
 * implémentent réellement l'envoi. `test()` a une implémentation par défaut
 * ici (valide la config puis envoie une notification de test standard via
 * `send()`) — un provider n'a donc à écrire que `validateConfig()` et
 * `send()`. `healthCheck()` reste optionnel : seuls les providers qui ont une
 * vérification de connectivité distincte d'un envoi (ex. SMTP `verify()`,
 * Telegram `getMe()`) le surchargent. La mise en file d'attente/retry et le
 * routing par règles restent hors scope (lib/services/queue/, déjà
 * existante, sera branchée en Phase 5C avec l'Alert Engine).
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
   * Envoie une notification de test avec cette configuration. Implémentation
   * par défaut : valide la config (retourne un résultat d'échec normalisé
   * `INVALID_CONFIG` sans appel réseau si invalide), puis délègue à
   * `send()` avec une notification de test standard. Un provider peut la
   * surcharger s'il a besoin d'un comportement différent, mais ce n'est
   * généralement pas nécessaire.
   */
  async test(config) {
    const { buildTestNotification } = require("./providers/shared");
    const errors = this.validateConfig(config || {});
    if (errors.length) {
      return {
        success: false,
        provider: this.type,
        errorCode: "INVALID_CONFIG",
        safeMessage: errors.join(" "),
        responseTime: null,
      };
    }
    return this.send(buildTestNotification(this.label), config || {});
  }

  /**
   * Envoie effectivement une notification. Chaque provider doit l'implémenter
   * et retourner un résultat normalisé (voir docs/notifications/README.md) :
   *   succès : { success: true, provider, messageId, responseTime }
   *   échec  : { success: false, provider, errorCode, safeMessage, responseTime }
   * Ne doit jamais lancer pour une erreur d'envoi "attendue" (réseau,
   * timeout, refus du fournisseur) — uniquement pour un bug interne.
   */
  async send(_notification, _config) {
    throw new Error(`send() non implémenté pour le provider "${this.type}".`);
  }

  /**
   * Vérification de connectivité optionnelle, distincte d'un envoi réel
   * (ex. SMTP `verify()`, Telegram `getMe()`). Retourne `null` si le
   * provider n'a pas de vérification dédiée (repli : utiliser `test()`).
   */
  async healthCheck(_config) {
    return null;
  }
}

module.exports = { NotificationProvider };