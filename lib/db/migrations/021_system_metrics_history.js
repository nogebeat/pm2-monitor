"use strict";

/**
 * 021_system_metrics_history
 *
 * Phase 20 (suite) — Reports & Capacity Planning : lib/history-store.js
 * (métriques système CPU/RAM/disque) ne conserve que les dernières 24h EN
 * MÉMOIRE (voir MAX_AGE_MS) — insuffisant pour des projections de capacity
 * planning fiables sur des rapports weekly/monthly. Cette table persiste un
 * point TOUTES LES 5 MINUTES (voir
 * lib/services/reports/system-history-store.js#PERSIST_INTERVAL_MS),
 * dérivé de la MÊME valeur déjà calculée à chaque tick par
 * lib/system-stats.js — ce n'est PAS une nouvelle collecte de métriques
 * (elle continue d'être calculée exactement comme avant, avec le même
 * intervalle de 5s pour l'affichage temps réel via HistoryStore), seulement
 * une persistance downsamplée de ce qui existe déjà, à la manière du
 * rollup "medium"/"long" du process-history existant
 * (lib/services/process-history/rollup.js, Phase 11) mais en une seule
 * résolution (le volume horaire d'un host unique ne justifie pas plusieurs
 * niveaux).
 *
 * Volume : ~288 lignes/jour, purgées au-delà de la rétention configurée
 * (voir system-history-store.js#RETENTION_MS, 400 jours par défaut) —
 * négligeable.
 */

async function up(db) {
  const isMysql = db.driver === "mysql";

  if (isMysql) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS system_metrics_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ts BIGINT NOT NULL,
        cpu_percent DOUBLE,
        mem_percent DOUBLE,
        disk_percent DOUBLE,
        created_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
      await db.run("CREATE INDEX idx_system_metrics_history_ts ON system_metrics_history(ts)");
    } catch (e) {
      if (!/ER_DUP_KEYNAME|Duplicate key name/i.test(e.message || "")) throw e;
    }
    return;
  }

  await db.run(`
    CREATE TABLE IF NOT EXISTS system_metrics_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      cpu_percent REAL,
      mem_percent REAL,
      disk_percent REAL,
      created_at INTEGER NOT NULL
    )
  `);
  await db.run("CREATE INDEX IF NOT EXISTS idx_system_metrics_history_ts ON system_metrics_history(ts)");
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS system_metrics_history");
}

module.exports = {
  version: "021_system_metrics_history",
  description:
    "Persistance downsamplée (5 min) des métriques système (CPU/RAM/disque) pour le Capacity Planning (Phase 20) au-delà des 24h en mémoire de lib/history-store.js.",
  up,
  down,
};
