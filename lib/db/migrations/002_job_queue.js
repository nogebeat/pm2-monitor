"use strict";

/**
 * 002_job_queue
 *
 * Table `jobs` : support de la file d'attente persistante utilisée par
 * lib/services/queue/. Un job survit à un redémarrage du process (il est
 * en base, pas en mémoire) : c'est la seule exigence de cette phase, aucune
 * fonctionnalité métier (alertes, notifications…) n'est encore branchée
 * dessus — ce sera fait dans une phase ultérieure.
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        queue_name VARCHAR(191) NOT NULL,
        payload LONGTEXT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        last_error TEXT,
        run_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
      await db.run("CREATE INDEX idx_jobs_queue_status_runat ON jobs(queue_name, status, run_at)");
    } catch (e) {
      // MySQL < 8.0.29 ne supporte pas "CREATE INDEX IF NOT EXISTS" : si
      // l'index existe déjà (code MySQL 1061, ré-exécution de la migration
      // après un échec partiel), on l'ignore pour rester idempotent.
      if (!/ER_DUP_KEYNAME|Duplicate key name/i.test(e.message || "")) throw e;
    }
  } else {
    await db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_name TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        run_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_jobs_queue_status_runat ON jobs(queue_name, status, run_at)",
    );
  }
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS jobs");
}

module.exports = {
  version: "002_job_queue",
  description: "Table jobs (file d'attente persistante, lib/services/queue/).",
  up,
  down,
};
