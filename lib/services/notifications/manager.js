"use strict";

/**
 * Point d'entrée haut niveau du notification system. Ne connaît que le
 * Provider Registry (registry.js) — jamais les détails d'un provider précis
 * (voir types.js). C'est ce découplage qui permet d'ajouter un provider sans
 * modifier cette classe.
 *
 * Phase 5B : les providers du registry envoient réellement (email/discord/
 * telegram/slack/webhook, voir providers/). Le dispatch orchestré (choix du
 * provider par règle de routing, mise en file d'attente via
 * lib/services/queue/ déjà existante, retry, intégration avec l'Alert
 * Engine) reste hors scope de cette phase — c'est pourquoi `send()` reste
 * volontairement non implémenté ici : appeler un provider directement
 * (`registry.getProvider(type).send(...)`) est possible dès maintenant, mais
 * l'orchestration multi-provider/routing est prévue en Phase 5C.
 */
class NotificationManager {
  /**
   * @param {{ registry: import("./registry").ProviderRegistry }} deps
   */
  constructor({ registry }) {
    if (!registry) throw new Error("NotificationManager : registry requis.");
    this.registry = registry;
  }

  /** Catalogue des types de providers connus (pour construire un formulaire côté frontend). */
  listProviderTypes() {
    return this.registry.listProviders().map((p) => ({
      type: p.type,
      label: p.label,
      // Phase 5B : tous les providers du registry envoient réellement (voir
      // providers/ — send() n'est plus un placeholder). Le champ reste
      // exposé pour que le frontend puisse à l'avenir distinguer un
      // provider "configurable" d'un provider "opérationnel" sans dupliquer
      // cette liste (utile si un provider tiers custom est ajouté sans
      // envoi réel, par exemple).
      implemented: true,
    }));
  }

  /** Délègue à provider.validateConfig() sans connaître le détail du provider. */
  validateProviderConfig(type, config) {
    const provider = this.registry.getProvider(type);
    if (!provider) return [`Type de provider inconnu : "${type}".`];
    return provider.validateConfig(config || {});
  }

  /**
   * Non implémenté en Phase 5A : l'envoi effectif (queue + routing +
   * providers réels) arrive dans les sous-phases suivantes.
   */
  async send() {
    throw new Error(
      "NotificationManager.send() (orchestration : routing + queue + retry) reste hors scope de la Phase 5B — les providers envoient réellement (voir providers/), l'orchestration multi-provider est prévue en Phase 5C."
    );
  }
}

module.exports = { NotificationManager };
