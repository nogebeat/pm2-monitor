"use strict";

/**
 * 008_health_checks
 *
 * Phase 6 — Health Checks : un système de vérification de disponibilité
 * indépendant du statut PM2 ("online" chez PM2 ne veut pas dire "fonctionne
 * réellement", ex: un process up mais dont le port HTTP ne répond plus).
 *
 * Une seule table (`health_checks`) plutôt que "config" + "occurrences"
 * comme alert_rules/alerts (003_alert_engine.js) : contrairement à une règle
 * d'alerte (qui peut avoir plusieurs occurrences dans le temps), un health
 * check n'a qu'un seul état courant à la fois (UP/DOWN/DEGRADED/UNKNOWN) —
 * l'historique des occurrences de "DOWN" est déjà couvert par les alertes
 * qui s'en nourrissent (voir lib/services/health-checks/engine.js, qui
 * appelle lib/services/alerts/engine.js exactement comme le fait déjà
 * lib/services/process-history/ pour les métriques process). Pas de
 * deuxième système d'alerte : les health checks ne sont qu'une nouvelle
 * *source* de valeurs pour le moteur d'alerte existant, via un nouveau
 * target_type "health_check" (voir lib/services/alerts/alert-rules-store.js).
 *
 * Colonnes de config (type/target/timeout/interval/expected...) + colonnes
 * d'état courant (status/consécutifs/dernier check/dernière panne) sur la
 * même ligne : un health check est de toute façon toujours relu en entier
 * (form d'édition + carte de statut dans l'UI), une jointure n'apporterait
 * rien ici.
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS health_checks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL,
        type VARCHAR(16) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,

        -- HTTP
        url VARCHAR(2048),
        method VARCHAR(8) DEFAULT 'GET',
        expected_status VARCHAR(32) DEFAULT '200-299',
        expected_content VARCHAR(500),

        -- TCP
        host VARCHAR(255),
        port INT,

        -- Command (voir lib/services/health-checks/runner.js : execFile,
        -- jamais de shell, args séparés — pas de concaténation de chaîne)
        command VARCHAR(500),
        command_args TEXT,
        expected_exit_code INT DEFAULT 0,

        -- Commun
        timeout_ms INT NOT NULL DEFAULT 5000,
        interval_seconds INT NOT NULL DEFAULT 60,
        degraded_threshold_ms INT,

        -- État courant (recalculé à chaque exécution, jamais saisi par l'utilisateur)
        status VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
        consecutive_failures INT NOT NULL DEFAULT 0,
        consecutive_successes INT NOT NULL DEFAULT 0,
        last_check_at BIGINT,
        last_response_time_ms INT,
        last_status_code VARCHAR(16),
        last_error VARCHAR(1000),
        last_failure_at BIGINT,

        created_by INT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const indexes = [
      ["idx_health_checks_enabled", "health_checks(enabled)"],
      ["idx_health_checks_name", "health_checks(name)"],
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
      CREATE TABLE IF NOT EXISTS health_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,

        url TEXT,
        method TEXT DEFAULT 'GET',
        expected_status TEXT DEFAULT '200-299',
        expected_content TEXT,

        host TEXT,
        port INTEGER,

        command TEXT,
        command_args TEXT,
        expected_exit_code INTEGER DEFAULT 0,

        timeout_ms INTEGER NOT NULL DEFAULT 5000,
        interval_seconds INTEGER NOT NULL DEFAULT 60,
        degraded_threshold_ms INTEGER,

        status TEXT NOT NULL DEFAULT 'UNKNOWN',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        consecutive_successes INTEGER NOT NULL DEFAULT 0,
        last_check_at INTEGER,
        last_response_time_ms INTEGER,
        last_status_code TEXT,
        last_error TEXT,
        last_failure_at INTEGER,

        created_by INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await db.run("CREATE INDEX IF NOT EXISTS idx_health_checks_enabled ON health_checks(enabled)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_health_checks_name ON health_checks(name)");
  }
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS health_checks");
}

module.exports = {
  version: "008_health_checks",
  description: "Table health_checks (Phase 6 — HTTP/TCP/Command, indépendant du statut PM2).",
  up,
  down,
};
