"use strict";

/**
 * 019_service_dependencies
 *
 * Phase 17 — Service Dependency Map. Une seule table (`service_dependencies`),
 * même raisonnement que 008_health_checks.js : chaque ligne EST une
 * dépendance déclarée par l'utilisateur (config + lien optionnel vers un
 * health check existant sur la même ligne), pas de séparation config/
 * occurrences comme alert_rules/alerts — une dépendance n'a qu'un seul état
 * "déclaré" à la fois, son statut *courant* est dérivé en lecture depuis
 * `health_checks.status` via `health_check_id` (JOIN), jamais dupliqué ici.
 *
 * PM2 Monitor ne doit PAS inventer les dépendances (voir prompt de phase) :
 * cette table ne contient que ce que l'utilisateur a explicitement déclaré
 * (source -> target, ex: "API" -> "PostgreSQL"). `source`/`target` sont de
 * simples chaînes libres (nom de process PM2, nom de service externe type
 * "PostgreSQL"/"Redis"...) : pas de FK vers une table "processes" (les
 * process PM2 ne sont pas stockés en base, voir lib/process-helpers.js).
 *
 * `health_check_id` (nullable, FK -> health_checks, ON DELETE SET NULL) :
 * associe optionnellement une dépendance à un health check existant (Phase
 * 6) pour dériver son statut. Une dépendance sans health check lié reste
 * valide (statut "UNKNOWN" côté service, voir lib/services/service-
 * dependencies/status.js) : le graphe reste utile même partiellement
 * instrumenté. ON DELETE SET NULL, pas CASCADE : supprimer le health check
 * ne doit pas supprimer la dépendance déclarée elle-même (même raisonnement
 * que anomaly_detections.rule_id dans 018_anomaly_detection.js).
 *
 * Contrainte UNIQUE (source, target, type) : évite les doublons silencieux
 * (même paire déclarée deux fois avec le même type) — même style que
 * process_tags.name (015_process_organization.js). Les cycles de dépendance
 * (A -> B -> A) ne sont PAS empêchés par le schéma : ils sont détectés en
 * amont par lib/services/service-dependencies/graph.js#detectCycle (validation
 * applicative, comme la plupart des règles métier de ce projet), le schéma
 * ne fait que stocker des arêtes.
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS service_dependencies (
        id INT AUTO_INCREMENT PRIMARY KEY,
        source VARCHAR(191) NOT NULL,
        target VARCHAR(191) NOT NULL,
        type VARCHAR(16) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        description TEXT,
        health_check_id INT,
        metadata TEXT,
        created_by INT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        CONSTRAINT fk_service_dependency_health_check
          FOREIGN KEY (health_check_id) REFERENCES health_checks(id) ON DELETE SET NULL,
        CONSTRAINT uq_service_dependency UNIQUE (source, target, type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const indexes = [
      ["idx_service_dependencies_source", "service_dependencies(source)"],
      ["idx_service_dependencies_target", "service_dependencies(target)"],
      ["idx_service_dependencies_enabled", "service_dependencies(enabled)"],
      ["idx_service_dependencies_health_check_id", "service_dependencies(health_check_id)"],
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
      CREATE TABLE IF NOT EXISTS service_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        description TEXT,
        health_check_id INTEGER REFERENCES health_checks(id) ON DELETE SET NULL,
        metadata TEXT,
        created_by INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (source, target, type)
      )
    `);

    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_service_dependencies_source ON service_dependencies(source)",
    );
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_service_dependencies_target ON service_dependencies(target)",
    );
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_service_dependencies_enabled ON service_dependencies(enabled)",
    );
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_service_dependencies_health_check_id ON service_dependencies(health_check_id)",
    );
  }
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS service_dependencies");
}

module.exports = {
  version: "019_service_dependencies",
  description: "Table service_dependencies (Service Dependency Map, Phase 17).",
  up,
  down,
};
