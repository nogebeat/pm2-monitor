"use strict";

/**
 * 007_notification_routing_templates
 *
 * Phase 5D du notification system (lib/services/notifications/routing/) :
 * le moteur de routing branché sur l'Alert Engine devient capable de
 * personnaliser le titre/message envoyé à chaque provider, et de notifier
 * (en plus du déclenchement) la résolution d'une alerte si la règle le
 * demande explicitement.
 *
 * Ajoute deux colonnes à `notification_routes` (créée en Phase 5A,
 * 006_notifications.js) plutôt qu'une nouvelle table `notification_templates` :
 * un template est toujours attaché 1:1 à la règle de routing qui l'utilise
 * (pas de partage de template entre plusieurs règles dans cette phase), donc
 * une table séparée n'apporterait qu'une jointure supplémentaire sans
 * bénéfice. Voir lib/services/notifications/routing/templates.js pour le
 * moteur de rendu ({{placeholder}}) et le gabarit par défaut utilisé quand
 * ces colonnes sont NULL.
 *
 *  - `title_template` / `message_template` (TEXT, nullable) : gabarits texte
 *    libre avec placeholders `{{ruleName}}`, `{{severity}}`, `{{metric}}`,
 *    `{{operator}}`, `{{threshold}}`, `{{value}}`, `{{targetType}}`,
 *    `{{targetValue}}`, `{{state}}`, `{{event}}`, `{{alertId}}` (voir
 *    templates.js#buildVariables). NULL = gabarit par défaut généré à partir
 *    de l'alerte.
 *  - `notify_on_resolve` (bool, défaut 0) : par défaut une règle ne notifie
 *    qu'au déclenchement (transition trigger -> active côté Alert Engine) ;
 *    ce flag active en plus une notification à la résolution
 *    (active|acknowledged -> resolved), comme demandé dans la tâche
 *    ("Lorsqu'une alerte est résolue, permettre également une notification
 *    si configuré").
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`ALTER TABLE notification_routes ADD COLUMN title_template TEXT`);
    await db.run(`ALTER TABLE notification_routes ADD COLUMN message_template TEXT`);
    await db.run(
      `ALTER TABLE notification_routes ADD COLUMN notify_on_resolve TINYINT(1) NOT NULL DEFAULT 0`,
    );
  } else {
    await db.run(`ALTER TABLE notification_routes ADD COLUMN title_template TEXT`);
    await db.run(`ALTER TABLE notification_routes ADD COLUMN message_template TEXT`);
    await db.run(`ALTER TABLE notification_routes ADD COLUMN notify_on_resolve INTEGER NOT NULL DEFAULT 0`);
  }
}

async function down(db) {
  // DROP COLUMN : supporté par MySQL et par SQLite >= 3.35 (better-sqlite3
  // embarque une version récente) — pas besoin du contournement
  // "recréer la table" utilisé par les vieux SQLite.
  await db.run(`ALTER TABLE notification_routes DROP COLUMN notify_on_resolve`);
  await db.run(`ALTER TABLE notification_routes DROP COLUMN message_template`);
  await db.run(`ALTER TABLE notification_routes DROP COLUMN title_template`);
}

module.exports = {
  version: "007_notification_routing_templates",
  description:
    "Templates de message (title/message) et notify_on_resolve sur notification_routes (Phase 5D).",
  up,
  down,
};
