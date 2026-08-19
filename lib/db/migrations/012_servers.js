"use strict";

/**
 * 012_servers
 *
 * Phase 10 — Multi-server / Remote PM2 : registre des serveurs surveillés
 * (l'hôte local + agents distants) et scoping optionnel des utilisateurs par
 * serveur.
 *
 * Deux tables :
 *
 *  - `servers` : un serveur = une ligne, identifié par `server_key`
 *    (identifiant stable, ex. "local" pour l'hôte local, ou une chaîne
 *    générée pour un agent distant — voir lib/services/servers/store.js).
 *    `token_hash` stocke un hash bcrypt du token d'authentification agent
 *    (jamais le token en clair, même logique que `password_hash` sur
 *    `users`), NULL pour le serveur local (qui n'a pas d'agent : il tourne
 *    dans le même process que le serveur central, voir docs/multi-server/).
 *
 *  - `user_servers` : scoping optionnel d'un utilisateur à un sous-ensemble
 *    de serveurs. Absence de ligne pour un user = pas de restriction (voit
 *    tous les serveurs auxquels ses permissions habituelles lui donnent
 *    accès) — comportement strictement rétrocompatible pour les comptes
 *    existants. Ce n'est PAS un second système RBAC : ça ne remplace ni ne
 *    duplique `permissions` (lib/permissions.js), ça ajoute juste un filtre
 *    orthogonal "quels serveurs" par-dessus le filtre existant "quelles
 *    actions/apps" (voir lib/permissions.js#hasServerAccess).
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS servers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        server_key VARCHAR(191) NOT NULL UNIQUE,
        name VARCHAR(191) NOT NULL,
        hostname VARCHAR(191),
        environment VARCHAR(64) NOT NULL DEFAULT 'production',
        kind VARCHAR(16) NOT NULL DEFAULT 'agent',
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        status VARCHAR(16) NOT NULL DEFAULT 'OFFLINE',
        token_hash VARCHAR(255),
        protocol_version VARCHAR(16),
        agent_version VARCHAR(64),
        last_seen_at BIGINT,
        last_snapshot TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS user_servers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        server_key VARCHAR(191) NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE KEY uniq_user_server (user_id, server_key),
        CONSTRAINT fk_user_servers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
      await db.run("CREATE INDEX idx_user_servers_user ON user_servers(user_id)");
    } catch (e) {
      if (!/ER_DUP_KEYNAME|Duplicate key name/i.test(e.message || "")) throw e;
    }
  } else {
    await db.run(`
      CREATE TABLE IF NOT EXISTS servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        hostname TEXT,
        environment TEXT NOT NULL DEFAULT 'production',
        kind TEXT NOT NULL DEFAULT 'agent',
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'OFFLINE',
        token_hash TEXT,
        protocol_version TEXT,
        agent_version TEXT,
        last_seen_at INTEGER,
        last_snapshot TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS user_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        server_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, server_key)
      )
    `);
    await db.run("CREATE INDEX IF NOT EXISTS idx_user_servers_user ON user_servers(user_id)");
  }
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS user_servers");
  await db.run("DROP TABLE IF EXISTS servers");
}

module.exports = {
  version: "012_servers",
  description: "Tables servers et user_servers (Phase 10 — Multi-server / Remote PM2).",
  up,
  down,
};
