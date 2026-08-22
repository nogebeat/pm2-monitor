"use strict";

/**
 * 014_process_metrics_server_key
 *
 * Corrige un oubli de la Phase 10 (multi-server) : `process_metrics_raw` /
 * `process_metrics_rollup` (004_process_metrics.js, écrite avant Phase 10)
 * n'ont jamais eu de notion de serveur. Deux conséquences concrètes :
 *
 *  1. `lib/realtime/agent-hub.js` ne branche jamais les heartbeats des
 *     agents distants sur `ProcessHistoryService#record()` : aucune donnée
 *     Metrics/Analytics (Phase 11) pour un process tournant sur un serveur
 *     distant, seulement pour l'hôte local (voir `lib/polling.js`).
 *  2. Même en branchant les heartbeats, deux serveurs différents avec un
 *     process de même nom (ex: "api" sur le hub ET sur un agent) auraient
 *     fusionné leur historique dans les mêmes lignes — `process_name` seul
 *     ne suffit plus à identifier une cible dès qu'il y a plusieurs hôtes
 *     PM2 (voir `lib/services/servers/store.js`, qui, lui, différencie déjà
 *     bien les serveurs par `server_key`).
 *
 * Ajoute `server_key` (défaut `'local'`, rétrocompatible avec les lignes
 * existantes : elles ne pouvaient venir que de l'hôte local avant ce
 * correctif) et déplace la contrainte d'unicité du rollup sur
 * (process_name, server_key, resolution, bucket_start).
 *
 * SQLite ne permet ni de modifier une contrainte UNIQUE existante ni de la
 * supprimer par un simple ALTER : reconstruction de `process_metrics_rollup`
 * (table temporaire -> copie -> drop -> rename), pattern standard SQLite.
 * `process_metrics_raw` n'a pas de contrainte UNIQUE à modifier, un simple
 * ADD COLUMN suffit.
 */

async function up(db) {
  const isMysql = db.driver === "mysql";

  // --- process_metrics_raw : ADD COLUMN suffit (pas de contrainte à toucher) ---
  if (!(await hasColumn(db, "process_metrics_raw", "server_key"))) {
    await db.run(
      `ALTER TABLE process_metrics_raw ADD COLUMN server_key ${isMysql ? "VARCHAR(191)" : "TEXT"} NOT NULL DEFAULT 'local'`,
    );
  }
  await createIndexIfMissing(
    db,
    "idx_pmr_server_process_ts",
    "process_metrics_raw(server_key, process_name, ts)",
  );

  // --- process_metrics_rollup : reconstruction (contrainte UNIQUE à changer) ---
  if (await hasColumn(db, "process_metrics_rollup", "server_key")) return; // déjà migré

  if (isMysql) {
    // MySQL sait modifier une clé UNIQUE en place.
    await db.run(
      `ALTER TABLE process_metrics_rollup ADD COLUMN server_key VARCHAR(191) NOT NULL DEFAULT 'local'`,
    );
    await db.run(`ALTER TABLE process_metrics_rollup DROP INDEX uniq_process_res_bucket`);
    await db.run(
      `ALTER TABLE process_metrics_rollup ADD UNIQUE KEY uniq_process_res_bucket (process_name, server_key, resolution, bucket_start)`,
    );
    try {
      await db.run(
        `CREATE INDEX idx_pmroll_lookup ON process_metrics_rollup(server_key, process_name, resolution, bucket_start)`,
      );
    } catch (e) {
      if (!/ER_DUP_KEYNAME|Duplicate key name/i.test(e.message || "")) throw e;
    }
    return;
  }

  await db.run(`
    CREATE TABLE process_metrics_rollup_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_name TEXT NOT NULL,
      server_key TEXT NOT NULL DEFAULT 'local',
      resolution TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      cpu_avg REAL, cpu_min REAL, cpu_max REAL, cpu_p95 REAL,
      memory_avg REAL, memory_min REAL, memory_max REAL, memory_p95 REAL,
      instances_avg REAL,
      restart_count_max INTEGER,
      restart_delta INTEGER,
      sample_count INTEGER NOT NULL DEFAULT 0,
      heap_used_avg REAL, heap_used_min REAL, heap_used_max REAL, heap_used_p95 REAL,
      heap_total_avg REAL, heap_total_min REAL, heap_total_max REAL, heap_total_p95 REAL,
      event_loop_lag_avg REAL, event_loop_lag_min REAL, event_loop_lag_max REAL, event_loop_lag_p95 REAL,
      online_count INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (process_name, server_key, resolution, bucket_start)
    )
  `);
  await db.run(`
    INSERT INTO process_metrics_rollup_new
      (id, process_name, server_key, resolution, bucket_start,
       cpu_avg, cpu_min, cpu_max, cpu_p95,
       memory_avg, memory_min, memory_max, memory_p95,
       instances_avg, restart_count_max, restart_delta, sample_count,
       heap_used_avg, heap_used_min, heap_used_max, heap_used_p95,
       heap_total_avg, heap_total_min, heap_total_max, heap_total_p95,
       event_loop_lag_avg, event_loop_lag_min, event_loop_lag_max, event_loop_lag_p95,
       online_count, created_at, updated_at)
    SELECT
      id, process_name, 'local', resolution, bucket_start,
      cpu_avg, cpu_min, cpu_max, cpu_p95,
      memory_avg, memory_min, memory_max, memory_p95,
      instances_avg, restart_count_max, restart_delta, sample_count,
      heap_used_avg, heap_used_min, heap_used_max, heap_used_p95,
      heap_total_avg, heap_total_min, heap_total_max, heap_total_p95,
      event_loop_lag_avg, event_loop_lag_min, event_loop_lag_max, event_loop_lag_p95,
      online_count, created_at, updated_at
    FROM process_metrics_rollup
  `);
  await db.run(`DROP TABLE process_metrics_rollup`);
  await db.run(`ALTER TABLE process_metrics_rollup_new RENAME TO process_metrics_rollup`);
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_pmroll_lookup ON process_metrics_rollup(server_key, process_name, resolution, bucket_start)",
  );
}

async function down(db) {
  // Rétrograde vers le schéma 004 (contrainte sans server_key). Les lignes
  // provenant d'un serveur distant (server_key != 'local') seraient
  // fusionnées avec celles d'un process local de même nom si on les
  // conservait sous l'ancienne contrainte — comportement pré-existant
  // avant cette migration (voir description ci-dessus), donc pas une
  // régression introduite par ce rollback, juste un retour en arrière.
  const isMysql = db.driver === "mysql";

  if (!(await hasColumn(db, "process_metrics_rollup", "server_key"))) return; // déjà en l'état d'avant

  if (isMysql) {
    await db.run(`ALTER TABLE process_metrics_rollup DROP INDEX uniq_process_res_bucket`);
    await db.run(
      `ALTER TABLE process_metrics_rollup ADD UNIQUE KEY uniq_process_res_bucket (process_name, resolution, bucket_start)`,
    );
    await db.run(`ALTER TABLE process_metrics_rollup DROP COLUMN server_key`);
    if (await hasColumn(db, "process_metrics_raw", "server_key")) {
      await db.run(`ALTER TABLE process_metrics_raw DROP COLUMN server_key`);
    }
    return;
  }

  await db.run(`
    CREATE TABLE process_metrics_rollup_old (
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
      heap_used_avg REAL, heap_used_min REAL, heap_used_max REAL, heap_used_p95 REAL,
      heap_total_avg REAL, heap_total_min REAL, heap_total_max REAL, heap_total_p95 REAL,
      event_loop_lag_avg REAL, event_loop_lag_min REAL, event_loop_lag_max REAL, event_loop_lag_p95 REAL,
      online_count INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (process_name, resolution, bucket_start)
    )
  `);
  await db.run(`
    INSERT OR IGNORE INTO process_metrics_rollup_old
      (id, process_name, resolution, bucket_start,
       cpu_avg, cpu_min, cpu_max, cpu_p95,
       memory_avg, memory_min, memory_max, memory_p95,
       instances_avg, restart_count_max, restart_delta, sample_count,
       heap_used_avg, heap_used_min, heap_used_max, heap_used_p95,
       heap_total_avg, heap_total_min, heap_total_max, heap_total_p95,
       event_loop_lag_avg, event_loop_lag_min, event_loop_lag_max, event_loop_lag_p95,
       online_count, created_at, updated_at)
    SELECT
      id, process_name, resolution, bucket_start,
      cpu_avg, cpu_min, cpu_max, cpu_p95,
      memory_avg, memory_min, memory_max, memory_p95,
      instances_avg, restart_count_max, restart_delta, sample_count,
      heap_used_avg, heap_used_min, heap_used_max, heap_used_p95,
      heap_total_avg, heap_total_min, heap_total_max, heap_total_p95,
      event_loop_lag_avg, event_loop_lag_min, event_loop_lag_max, event_loop_lag_p95,
      online_count, created_at, updated_at
    FROM process_metrics_rollup
  `);
  await db.run(`DROP TABLE process_metrics_rollup`);
  await db.run(`ALTER TABLE process_metrics_rollup_old RENAME TO process_metrics_rollup`);
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_pmroll_lookup ON process_metrics_rollup(process_name, resolution, bucket_start)",
  );

  if (await hasColumn(db, "process_metrics_raw", "server_key")) {
    // SQLite ne sait pas DROP COLUMN sur les versions embarquées courantes :
    // même pattern que 010/013, colonne laissée en place (nullable, inerte).
  }
}

async function hasColumn(db, table, column) {
  if (db.driver === "mysql") {
    const rows = await db.all(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return rows.length > 0;
  }
  const rows = await db.all(`PRAGMA table_info(${table})`, []);
  return rows.some((r) => r.name === column);
}

async function createIndexIfMissing(db, name, def) {
  if (db.driver === "mysql") {
    try {
      await db.run(`CREATE INDEX ${name} ON ${def}`);
    } catch (e) {
      if (!/ER_DUP_KEYNAME|Duplicate key name/i.test(e.message || "")) throw e;
    }
    return;
  }
  await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${def}`);
}

module.exports = {
  version: "014_process_metrics_server_key",
  description:
    "Ajoute server_key à process_metrics_raw/rollup (scoping multi-serveur) — corrige l'absence d'historique pour les process d'agents distants et la collision de noms entre serveurs.",
  up,
  down,
};
