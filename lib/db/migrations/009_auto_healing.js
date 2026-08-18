"use strict";

/**
 * 009_auto_healing
 *
 * Phase 7 — Auto-Healing : redémarrage automatique d'un process quand une
 * condition (crash, health check DOWN, seuil dépassé) est détectée, avec
 * garde-fous (tentatives max, cooldown/backoff, blocage). Fonctionnalité
 * CRITIQUE/DANGEREUSE (voir docs/auto-healing/README.md) : désactivée par
 * défaut, ne peut agir que via l'API PM2 déjà utilisée par l'application
 * (aucune commande shell).
 *
 * Trois tables, même découpage que health_checks / alert_rules+alerts :
 *  - auto_healing_settings : une seule ligne (id=1) de configuration globale
 *    (activé/désactivé, tentatives max, paliers de backoff). Ligne unique
 *    plutôt qu'un système de clé/valeur générique : la configuration est
 *    petite et toujours relue entièrement (formulaire d'admin), pas besoin
 *    d'une table plus générique pour l'instant.
 *  - auto_healing_state : état courant *par process* (tentatives en cours,
 *    bloqué ou non, prochain essai autorisé) — un peu comme `health_checks`
 *    porte son propre état courant sur la ligne de config, mais ici la
 *    "config" est globale (auto_healing_settings) alors que l'état est par
 *    process, donc deux tables.
 *  - auto_healing_audit : historique append-only de toute tentative
 *    (déclenchée, bloquée, réussie, échouée) — jamais de suppression via
 *    l'API, uniquement consultée (section 8 du prompt : "Aucune exception,
 *    même un échec doit être audité").
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS auto_healing_settings (
        id INT PRIMARY KEY,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        backoff_seconds VARCHAR(500) NOT NULL DEFAULT '60,300,900',
        updated_by INT,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS auto_healing_state (
        process_name VARCHAR(191) PRIMARY KEY,
        attempts INT NOT NULL DEFAULT 0,
        blocked TINYINT(1) NOT NULL DEFAULT 0,
        blocked_at BIGINT,
        blocked_reason VARCHAR(500),
        last_attempt_at BIGINT,
        next_allowed_at BIGINT,
        unblocked_by INT,
        unblocked_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS auto_healing_audit (
        id INT AUTO_INCREMENT PRIMARY KEY,
        process_name VARCHAR(191) NOT NULL,
        source VARCHAR(32) NOT NULL,
        reason VARCHAR(255) NOT NULL,
        action VARCHAR(32) NOT NULL,
        attempt INT,
        max_attempts INT,
        result VARCHAR(16) NOT NULL,
        message VARCHAR(1000),
        created_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const indexes = [
      ["idx_auto_healing_audit_process", "auto_healing_audit(process_name)"],
      ["idx_auto_healing_audit_created", "auto_healing_audit(created_at)"],
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
      CREATE TABLE IF NOT EXISTS auto_healing_settings (
        id INTEGER PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        backoff_seconds TEXT NOT NULL DEFAULT '60,300,900',
        updated_by INTEGER,
        updated_at INTEGER NOT NULL
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS auto_healing_state (
        process_name TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        blocked_at INTEGER,
        blocked_reason TEXT,
        last_attempt_at INTEGER,
        next_allowed_at INTEGER,
        unblocked_by INTEGER,
        unblocked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS auto_healing_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        process_name TEXT NOT NULL,
        source TEXT NOT NULL,
        reason TEXT NOT NULL,
        action TEXT NOT NULL,
        attempt INTEGER,
        max_attempts INTEGER,
        result TEXT NOT NULL,
        message TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_auto_healing_audit_process ON auto_healing_audit(process_name)",
    );
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_auto_healing_audit_created ON auto_healing_audit(created_at)",
    );
  }

  // Ligne de config unique, désactivée par défaut (voir section 7 du prompt maître :
  // "AUTO-HEALING = OFF" tant qu'aucune activation explicite n'a eu lieu).
  const now = Date.now();
  await db.run(
    `INSERT INTO auto_healing_settings (id, enabled, max_attempts, backoff_seconds, updated_at)
     SELECT 1, 0, 3, '60,300,900', ${now}
     WHERE NOT EXISTS (SELECT 1 FROM auto_healing_settings WHERE id = 1)`,
  );
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS auto_healing_audit");
  await db.run("DROP TABLE IF EXISTS auto_healing_state");
  await db.run("DROP TABLE IF EXISTS auto_healing_settings");
}

module.exports = {
  version: "009_auto_healing",
  description:
    "Tables auto_healing_settings / auto_healing_state / auto_healing_audit (Phase 7 — Auto-Healing).",
  up,
  down,
};
