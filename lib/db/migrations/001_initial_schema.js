"use strict";

/**
 * 001_initial_schema
 *
 * Tables `users` et `permissions`. C'est exactement le schéma qui était
 * auparavant créé "en dur" via `CREATE TABLE IF NOT EXISTS` au démarrage
 * (lib/db/sqlite-driver.js / lib/db/mysql-driver.js avant l'introduction du
 * système de migrations).
 *
 * Comme les instructions utilisent IF NOT EXISTS, cette migration est sûre à
 * exécuter sur une installation déjà existante : si les tables existent déjà
 * (créées par une version antérieure du projet), les CREATE TABLE ne font
 * rien et la migration est simplement enregistrée comme appliquée. Aucune
 * donnée existante n'est touchée.
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(191) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        is_admin TINYINT(1) NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS permissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        app_name VARCHAR(191) NOT NULL,
        action VARCHAR(64) NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE KEY uniq_perm (user_id, app_name, action),
        CONSTRAINT fk_perm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } else {
    await db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        app_name TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, app_name, action)
      )
    `);
  }
}

async function down(db) {
  // Destructif par nature (perte des comptes et permissions) : uniquement
  // pertinent en développement pour tester un rollback complet, jamais
  // recommandé en production.
  await db.run("DROP TABLE IF EXISTS permissions");
  await db.run("DROP TABLE IF EXISTS users");
}

module.exports = {
  version: "001_initial_schema",
  description: "Tables users et permissions (schéma historique du projet).",
  up,
  down,
};
