"use strict";

/**
 * 006_notifications
 *
 * Phase 5A du système de notifications (lib/services/notifications/,
 * lib/routes/notifications.js) : uniquement les fondations — architecture,
 * modèles de données, registry des providers, permissions de base. Aucun
 * provider réel (SMTP/Discord/Telegram/Slack/webhook), aucune queue, aucun
 * routing engine, aucune intégration Alert Engine dans cette phase — voir
 * docs/notifications/README.md.
 *
 * Trois tables :
 *
 *  - `notification_providers` : une configuration de provider (ex: "Discord
 *    Production", "SMTP Admin"). Plusieurs configurations du même `type`
 *    sont supportées (pas de contrainte unique sur `type` — seulement un
 *    index pour les requêtes "toutes les configs Discord"). `configuration`
 *    contient les champs publics (JSON texte, même convention que
 *    `metadata` dans 005_process_events.js) ; `secrets` contient les champs
 *    sensibles (SMTP password, webhook Discord, bot token Telegram, webhook
 *    Slack, headers d'autorisation…) **chiffrés** par
 *    lib/services/notifications/utils/crypto.js avant écriture — jamais en
 *    clair. Cette phase pose seulement l'abstraction de chiffrement ; la
 *    gestion complète des credentials (rotation, masquage UI, CRUD complet)
 *    est prévue en Phase 5C.
 *
 *  - `notification_routes` : modèle de données pour le futur routing
 *    (Phase 5B/5C) — une règle pourra exprimer des conditions (severity,
 *    alert type, process, server, tag) et pointer vers plusieurs providers.
 *    `conditions` et `provider_ids` sont des blobs JSON texte (mêmes raisons
 *    que `metadata` ci-dessus : éviter de migrer le schéma à chaque nouveau
 *    critère). Aucun moteur d'évaluation ne lit encore cette table dans
 *    cette phase.
 *
 *  - `notification_history` : historique des envois (Phase 5B branchera
 *    l'écriture réelle). `provider_id` référence `notification_providers`
 *    avec ON DELETE SET NULL (même pattern que `alerts.rule_id` dans
 *    003_alert_engine.js : supprimer une config de provider ne doit pas
 *    faire disparaître l'historique déjà écrit). `alert_id` référence de la
 *    même façon `alerts` (moteur d'alertes, 003_alert_engine.js) pour
 *    permettre plus tard de relier une notification à l'alerte qui l'a
 *    déclenchée, sans dépendance dure. `metadata` ne doit JAMAIS contenir de
 *    credentials — uniquement des détails d'exécution (ex: code retour HTTP,
 *    extrait de réponse d'un webhook).
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS notification_providers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL,
        type VARCHAR(64) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        configuration TEXT,
        secrets TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS notification_routes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        conditions TEXT,
        provider_ids TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS notification_history (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        provider_id INT,
        alert_id INT,
        status VARCHAR(32) NOT NULL,
        ts BIGINT NOT NULL,
        response_time_ms INT,
        error_code VARCHAR(64),
        metadata TEXT,
        created_at BIGINT NOT NULL,
        CONSTRAINT fk_notification_history_provider FOREIGN KEY (provider_id)
          REFERENCES notification_providers(id) ON DELETE SET NULL,
        CONSTRAINT fk_notification_history_alert FOREIGN KEY (alert_id)
          REFERENCES alerts(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Index séparés : pas de "CREATE INDEX IF NOT EXISTS" portable sous
    // MySQL < 8.0.29 (voir 002_job_queue.js / 003_alert_engine.js pour la
    // même remarque) — on avale l'erreur "doublon" si la migration est
    // rejouée après un échec partiel.
    const indexes = [
      ["idx_notification_providers_type", "notification_providers(type)"],
      ["idx_notification_providers_enabled", "notification_providers(enabled)"],
      ["idx_notification_routes_enabled", "notification_routes(enabled)"],
      ["idx_notification_history_provider_id", "notification_history(provider_id)"],
      ["idx_notification_history_alert_id", "notification_history(alert_id)"],
      ["idx_notification_history_status", "notification_history(status)"],
      ["idx_notification_history_ts", "notification_history(ts)"],
    ];
    for (const [indexName, def] of indexes) {
      try {
        await db.run(`CREATE INDEX ${indexName} ON ${def}`);
      } catch (e) {
        if (!/ER_DUP_KEYNAME|Duplicate key name/i.test(e.message || "")) throw e;
      }
    }
  } else {
    await db.run(`
      CREATE TABLE IF NOT EXISTS notification_providers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        configuration TEXT,
        secrets TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS notification_routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        conditions TEXT,
        provider_ids TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS notification_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id INTEGER REFERENCES notification_providers(id) ON DELETE SET NULL,
        alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        ts INTEGER NOT NULL,
        response_time_ms INTEGER,
        error_code TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_notification_providers_type ON notification_providers(type)",
    );
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_notification_providers_enabled ON notification_providers(enabled)",
    );
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_notification_routes_enabled ON notification_routes(enabled)",
    );
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_notification_history_provider_id ON notification_history(provider_id)",
    );
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_notification_history_alert_id ON notification_history(alert_id)",
    );
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_notification_history_status ON notification_history(status)",
    );
    await db.run("CREATE INDEX IF NOT EXISTS idx_notification_history_ts ON notification_history(ts)");
  }
}

async function down(db) {
  // notification_history avant notification_providers/alerts (FK) — inutile
  // sous SQLite par défaut mais nécessaire sous MySQL/InnoDB (même ordre que
  // 003_alert_engine.js).
  await db.run("DROP TABLE IF EXISTS notification_history");
  await db.run("DROP TABLE IF EXISTS notification_routes");
  await db.run("DROP TABLE IF EXISTS notification_providers");
}

module.exports = {
  version: "006_notifications",
  description:
    "Fondations du notification system (Phase 5A) : notification_providers, notification_routes, notification_history.",
  up,
  down,
};
