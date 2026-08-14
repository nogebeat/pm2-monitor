"use strict";

/**
 * 010_health_checks_process_name
 *
 * Corrige un problème connu de la Phase 7 (Auto-Healing) : un health check
 * n'a pas forcément le même `name` que le process PM2 qu'il surveille (rien
 * ne l'imposait). Auto-Healing utilisait jusqu'ici `check.name` comme nom de
 * process à redémarrer, ce qui pouvait silencieusement cibler le mauvais
 * process (ou aucun) si les deux noms divergeaient.
 *
 * Ajoute une colonne `process_name` explicite, optionnelle et nullable :
 *  - si renseignée, c'est elle que lib/services/auto-healing/index.js utilise
 *    pour résoudre process à redémarrer depuis une alerte "health_check" ;
 *  - si absente (health checks déjà existants, ou sonde ne correspondant à
 *    aucun process PM2 particulier — ex: dépendance externe), Auto-Healing
 *    ne tente plus de deviner : il ignore l'événement plutôt que de risquer
 *    de redémarrer le mauvais process (voir docs/auto-healing/README.md).
 */

async function up(db) {
  const columnExists = await hasColumn(db, "health_checks", "process_name");
  if (columnExists) return;

  if (db.driver === "mysql") {
    await db.run("ALTER TABLE health_checks ADD COLUMN process_name VARCHAR(191) NULL AFTER name");
  } else {
    await db.run("ALTER TABLE health_checks ADD COLUMN process_name TEXT");
  }
}

async function down(db) {
  // SQLite ne supporte pas DROP COLUMN avant 3.35 (versions embarquées
  // variables) : on laisse la colonne en place (nullable, sans effet si
  // inutilisée) plutôt que de risquer une reconstruction de table hasardeuse,
  // même pattern que les autres migrations "additives" de ce projet.
  if (db.driver === "mysql") {
    const columnExists = await hasColumn(db, "health_checks", "process_name");
    if (columnExists) {
      await db.run("ALTER TABLE health_checks DROP COLUMN process_name");
    }
  }
}

async function hasColumn(db, table, column) {
  if (db.driver === "mysql") {
    const rows = await db.all(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    return rows.length > 0;
  }
  const rows = await db.all(`PRAGMA table_info(${table})`, []);
  return rows.some((r) => r.name === column);
}

module.exports = {
  version: "010_health_checks_process_name",
  description: "Ajoute health_checks.process_name (résolution explicite check -> process pour Auto-Healing).",
  up,
  down,
};
