"use strict";

/**
 * 013_process_metrics_analytics
 *
 * Phase 11 — Advanced Metrics & Analytics : étend `process_metrics_raw` /
 * `process_metrics_rollup` (004_process_metrics.js) plutôt que de créer un
 * second système de stockage métrique.
 *
 * Colonnes ajoutées :
 *
 *  - `heap_used` / `heap_total` (octets), `event_loop_lag` (ms) sur les deux
 *    tables (avg/min/max/p95 sur le rollup, comme cpu/memory). Ces trois
 *    métriques ne sont PAS garanties : PM2 ne les expose (`pm2_env.axm_monitor`)
 *    que pour les process Node.js instrumentés côté app (ex: `@pm2/io`) — pas
 *    pour un process quelconque (script Python, binaire, Node sans probe…).
 *    `lib/process-helpers.js#fmtProcess` les lit en best-effort et les laisse
 *    `null` sinon ; jamais de valeur inventée (voir prompt de phase). RSS est
 *    déjà couvert par la colonne `memory` existante (p.monit.memory = RSS
 *    process, pas une métrique nouvelle — voir docs/process-history/README.md).
 *
 *  - `online_count` sur `process_metrics_rollup` uniquement : nombre
 *    d'échantillons du bucket dont `status === "online"`, à comparer à
 *    `sample_count` pour calculer une disponibilité (%) sur des plages
 *    couvrant du rollup (7j/30j), où la colonne `status` brute n'existe plus
 *    (voir store.js). Pas de colonne équivalente sur `process_metrics_raw` :
 *    la colonne `status` déjà présente y suffit (comptage direct).
 */

async function up(db) {
  const isMysql = db.driver === "mysql";

  const rawColumns = [
    ["heap_used", isMysql ? "BIGINT" : "INTEGER"],
    ["heap_total", isMysql ? "BIGINT" : "INTEGER"],
    ["event_loop_lag", isMysql ? "DOUBLE" : "REAL"],
  ];
  for (const [name, type] of rawColumns) {
    if (await hasColumn(db, "process_metrics_raw", name)) continue;
    await db.run(`ALTER TABLE process_metrics_raw ADD COLUMN ${name} ${type}`);
  }

  const rollupColumns = [
    ["heap_used_avg", isMysql ? "DOUBLE" : "REAL"],
    ["heap_used_min", isMysql ? "DOUBLE" : "REAL"],
    ["heap_used_max", isMysql ? "DOUBLE" : "REAL"],
    ["heap_used_p95", isMysql ? "DOUBLE" : "REAL"],
    ["heap_total_avg", isMysql ? "DOUBLE" : "REAL"],
    ["heap_total_min", isMysql ? "DOUBLE" : "REAL"],
    ["heap_total_max", isMysql ? "DOUBLE" : "REAL"],
    ["heap_total_p95", isMysql ? "DOUBLE" : "REAL"],
    ["event_loop_lag_avg", isMysql ? "DOUBLE" : "REAL"],
    ["event_loop_lag_min", isMysql ? "DOUBLE" : "REAL"],
    ["event_loop_lag_max", isMysql ? "DOUBLE" : "REAL"],
    ["event_loop_lag_p95", isMysql ? "DOUBLE" : "REAL"],
    ["online_count", isMysql ? "INT" : "INTEGER"],
  ];
  for (const [name, type] of rollupColumns) {
    if (await hasColumn(db, "process_metrics_rollup", name)) continue;
    await db.run(`ALTER TABLE process_metrics_rollup ADD COLUMN ${name} ${type}`);
  }
}

async function down(db) {
  // SQLite (versions embarquées courantes) ne supporte pas DROP COLUMN de
  // façon fiable : on laisse les colonnes en place, nullable et sans effet
  // si inutilisées — même pattern que 010_health_checks_process_name.js.
  if (db.driver !== "mysql") return;

  const rawColumns = ["heap_used", "heap_total", "event_loop_lag"];
  for (const name of rawColumns) {
    if (await hasColumn(db, "process_metrics_raw", name)) {
      await db.run(`ALTER TABLE process_metrics_raw DROP COLUMN ${name}`);
    }
  }

  const rollupColumns = [
    "heap_used_avg",
    "heap_used_min",
    "heap_used_max",
    "heap_used_p95",
    "heap_total_avg",
    "heap_total_min",
    "heap_total_max",
    "heap_total_p95",
    "event_loop_lag_avg",
    "event_loop_lag_min",
    "event_loop_lag_max",
    "event_loop_lag_p95",
    "online_count",
  ];
  for (const name of rollupColumns) {
    if (await hasColumn(db, "process_metrics_rollup", name)) {
      await db.run(`ALTER TABLE process_metrics_rollup DROP COLUMN ${name}`);
    }
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

module.exports = {
  version: "013_process_metrics_analytics",
  description:
    "Ajoute heap_used/heap_total/event_loop_lag (raw+rollup) et online_count (rollup) pour les analytics de la Phase 11.",
  up,
  down,
};
