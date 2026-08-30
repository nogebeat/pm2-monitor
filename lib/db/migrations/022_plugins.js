"use strict";

/**
 * 022_plugins
 *
 * Phase 21 — Plugin System : persiste l'état ADMINISTRATIF d'un plugin
 * (activé/désactivé + sa propre configuration), PAS le code du plugin
 * lui-même. Le code vit sur disque, dans le dossier `plugins/<name>/`
 * (voir lib/services/plugins/loader.js), jamais en base — un plugin est
 * un fichier local que l'opérateur self-hosted a explicitement déposé,
 * jamais téléchargé/installé automatiquement (voir docs/plugins/README.md,
 * section Sécurité).
 *
 * Une ligne = un plugin DÉCOUVERT au moins une fois par le loader (créée à
 * la première découverte, voir lib/services/plugins/store.js#ensureRow).
 * Une ligne dont le fichier a depuis été supprimé du disque n'est jamais
 * purgée automatiquement (l'admin peut avoir désactivé/retiré un plugin
 * temporairement) — voir DELETE /api/plugins/:name pour la suppression
 * explicite de l'entrée.
 */

async function up(db) {
  const isMysql = db.driver === "mysql";

  if (isMysql) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS plugins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        config TEXT,
        installed_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    return;
  }

  await db.run(`
    CREATE TABLE IF NOT EXISTS plugins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 0,
      config TEXT,
      installed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS plugins");
}

module.exports = {
  version: "022_plugins",
  description:
    "Table plugins (Phase 21) : état activé/désactivé + configuration persistée par plugin, découplé du code (voir plugins/ sur disque).",
  up,
  down,
};
