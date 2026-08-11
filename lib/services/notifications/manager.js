"use strict";

/**
 * Point d'entrée haut niveau du notification system. Ne connaît que le
 * Provider Registry (registry.js) — jamais les détails d'un provider précis
 * (voir types.js). C'est ce découplage qui permet d'ajouter un provider en
 * Phase 5B/5C sans modifier cette classe.
 *
 * Phase 5A : seules les capacités de lecture (catalogue de types disponibles,
 * validation de configuration) sont implémentées. L'envoi effectif
 * (dispatch), la mise en file d'attente (lib/services/queue/, déjà
 * existante), le retry et le routing par règles (notification_routes, voir
 * lib/db/migrations/006_notifications.js) sont volontairement absents ici et
 * arrivent dans les sous-phases suivantes.
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
      // Aucun provider n'envoie réellement de notification en Phase 5A —
      // voir types.js#send. Exposé pour que le frontend puisse distinguer
      // "configurable" de "opérationnel" sans dupliquer cette liste.
      implemented: false,
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
      "NotificationManager.send() non implémenté en Phase 5A (fondations uniquement) — prévu en Phase 5B/5C."
    );
  }
}

module.exports = { NotificationManager };
