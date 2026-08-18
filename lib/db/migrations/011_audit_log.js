"use strict";

/**
 * 011_audit_log
 *
 * Phase 9 — Audit Log : traçabilité des actions sensibles (connexion,
 * actions process, configuration, alertes, notifications, health checks,
 * auto-healing…). Une seule table append-only, même esprit que
 * `auto_healing_audit` (009_auto_healing.js) : jamais de suppression via
 * l'API, uniquement consultée (voir docs/audit/README.md).
 *
 * Ne duplique PAS process_events (timeline de crashs/statuts PM2, Phase 4)
 * ni auto_healing_audit (tentatives *automatiques* de redémarrage, Phase 7) :
 * l'audit log capture les actions *humaines/administratives* sensibles —
 * voir lib/services/audit/README pour la distinction exacte.
 *
 * `metadata` est stocké déjà sanitisé (voir
 * lib/services/audit/sanitize.js#sanitizeAuditMetadata) : la table elle-même
 * ne fait aucune hypothèse sur son contenu, c'est le *service* qui garantit
 * qu'aucun secret n'atteint jamais cette colonne.
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ts BIGINT NOT NULL,
        user_id INT,
        username VARCHAR(191),
        action VARCHAR(64) NOT NULL,
        target VARCHAR(255),
        target_type VARCHAR(32),
        server VARCHAR(191),
        status VARCHAR(16) NOT NULL,
        ip VARCHAR(64),
        metadata TEXT,
        created_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const indexes = [
      ["idx_audit_log_ts", "audit_log(ts)"],
      ["idx_audit_log_user", "audit_log(user_id)"],
      ["idx_audit_log_action", "audit_log(action)"],
      ["idx_audit_log_status", "audit_log(status)"],
      ["idx_audit_log_target", "audit_log(target)"],
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
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        target TEXT,
        target_type TEXT,
        server TEXT,
        status TEXT NOT NULL,
        ip TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    await db.run("CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_audit_log_status ON audit_log(status)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target)");
  }
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS audit_log");
}

module.exports = {
  version: "011_audit_log",
  description: "Table audit_log append-only pour les actions sensibles (Phase 9 — Audit Log).",
  up,
  down,
};
