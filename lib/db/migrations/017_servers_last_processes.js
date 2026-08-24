"use strict";

/**
 * 017_servers_last_processes
 *
 * Phase 15 — Prometheus Metrics Export : les métriques par process d'un
 * serveur distant (`GET /metrics`, lib/routes/metrics.js) ont besoin du
 * dernier snapshot process reçu de l'agent, exactement comme
 * `servers.last_snapshot` (migration 012) le fait déjà pour le snapshot
 * système. Sans cette colonne, cette donnée n'existait qu'en mémoire (le
 * temps d'un process serveur central) : un redémarrage du serveur central
 * la perdait jusqu'au prochain heartbeat de chaque agent — pas de second
 * mécanisme de collecte, juste la même persistance déjà en place pour
 * `last_snapshot`, étendue à la liste de process.
 *
 * Colonne additive et nullable : NULL pour le serveur local (qui n'a pas
 * d'agent, ses process viennent de `pm2.list()` en direct — voir
 * lib/routes/metrics.js) et pour tout serveur distant qui n'a encore reçu
 * aucun heartbeat.
 */

async function up(db) {
  const columnExists = await hasColumn(db, "servers", "last_processes");
  if (columnExists) return;

  if (db.driver === "mysql") {
    await db.run("ALTER TABLE servers ADD COLUMN last_processes TEXT NULL AFTER last_snapshot");
  } else {
    await db.run("ALTER TABLE servers ADD COLUMN last_processes TEXT");
  }
}

async function down(db) {
  // SQLite ne supporte pas DROP COLUMN avant 3.35 (versions embarquées
  // variables) : on laisse la colonne en place (nullable, sans effet si
  // inutilisée) plutôt que de risquer une reconstruction de table hasardeuse,
  // même pattern que la migration 010_health_checks_process_name.js.
  if (db.driver === "mysql") {
    const columnExists = await hasColumn(db, "servers", "last_processes");
    if (columnExists) {
      await db.run("ALTER TABLE servers DROP COLUMN last_processes");
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
  version: "017_servers_last_processes",
  description:
    "Ajoute servers.last_processes (persistance du dernier snapshot process, Phase 15 — Prometheus).",
  up,
  down,
};
