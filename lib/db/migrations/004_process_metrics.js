"use strict";

/**
 * 004_process_metrics
 *
 * Deux tables pour l'historique par process (lib/services/process-history/) :
 *
 *  - `process_metrics_raw` : un échantillon brut par tick de collecte
 *    (résolution "raw", court terme — voir PROCESS_HISTORY_SHORT_RETENTION_MS).
 *    Alimentée par la même boucle pm2.list() que le moteur d'alertes
 *    (server.js), pas de second poller PM2.
 *
 *  - `process_metrics_rollup` : agrégats avg/min/max/p95 par bucket de temps,
 *    calculés à partir de `process_metrics_raw` (résolution "medium",
 *    buckets horaires) puis à partir des buckets "medium" eux-mêmes
 *    (résolution "long", buckets journaliers). Une seule table pour les deux
 *    résolutions (colonne `resolution`) plutôt que deux tables quasi
 *    identiques, pour ne pas dupliquer le schéma ni les requêtes.
 *
 * Comme pour `alerts` (003_alert_engine.js), `process_name` est utilisé comme
 * identifiant de cible plutôt que le `pm_id` PM2, qui change à chaque
 * suppression/recréation du process — voir collector.js.
 *
 * Aucune contrainte FK vers une éventuelle table "apps" : le monitor ne
 * maintient pas de registre des apps connues indépendant de PM2 lui-même,
 * même choix que le reste du projet (ex: alert_rules.target_value).
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS process_metrics_raw (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        process_name VARCHAR(191) NOT NULL,
        ts BIGINT NOT NULL,
        cpu DOUBLE,
        memory BIGINT,
        restart_count INT,
        instances INT,
        status VARCHAR(32),
        uptime_ms BIGINT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS process_metrics_rollup (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        process_name VARCHAR(191) NOT NULL,
        resolution VARCHAR(16) NOT NULL,
        bucket_start BIGINT NOT NULL,
        cpu_avg DOUBLE, cpu_min DOUBLE, cpu_max DOUBLE, cpu_p95 DOUBLE,
        memory_avg DOUBLE, memory_min DOUBLE, memory_max DOUBLE, memory_p95 DOUBLE,
        instances_avg DOUBLE,
        restart_count_max INT,
        restart_delta INT,
        sample_count INT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE KEY uniq_process_res_bucket (process_name, resolution, bucket_start)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const indexes = [
      ["idx_pmr_process_ts", "process_metrics_raw(process_name, ts)"],
      ["idx_pmr_ts", "process_metrics_raw(ts)"],
      ["idx_pmroll_lookup", "process_metrics_rollup(process_name, resolution, bucket_start)"],
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
      CREATE TABLE IF NOT EXISTS process_metrics_raw (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        process_name TEXT NOT NULL,
        ts INTEGER NOT NULL,
        cpu REAL,
        memory INTEGER,
        restart_count INTEGER,
        instances INTEGER,
        status TEXT,
        uptime_ms INTEGER
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS process_metrics_rollup (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        process_name TEXT NOT NULL,
        resolution TEXT NOT NULL,
        bucket_start INTEGER NOT NULL,
        cpu_avg REAL, cpu_min REAL, cpu_max REAL, cpu_p95 REAL,
        memory_avg REAL, memory_min REAL, memory_max REAL, memory_p95 REAL,
        instances_avg REAL,
        restart_count_max INTEGER,
        restart_delta INTEGER,
        sample_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (process_name, resolution, bucket_start)
      )
    `);

    await db.run("CREATE INDEX IF NOT EXISTS idx_pmr_process_ts ON process_metrics_raw(process_name, ts)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_pmr_ts ON process_metrics_raw(ts)");
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_pmroll_lookup ON process_metrics_rollup(process_name, resolution, bucket_start)",
    );
  }
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS process_metrics_rollup");
  await db.run("DROP TABLE IF EXISTS process_metrics_raw");
}

module.exports = {
  version: "004_process_metrics",
  description:
    "Tables process_metrics_raw et process_metrics_rollup (historique par process, multi-résolution).",
  up,
  down,
};
