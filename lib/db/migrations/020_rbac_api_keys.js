"use strict";

/**
 * 020_rbac_api_keys
 *
 * Phase 18 — Advanced RBAC & API Keys.
 *
 * Deux changements additifs, aucun des deux ne modifie le comportement des
 * tables `users`/`permissions` existantes (voir lib/permissions.js : la
 * vérification `hasPermission()` reste inchangée, ligne (user_id, app_name,
 * action) toujours seule source de vérité pour un utilisateur "humain") :
 *
 *  1. `users.role` (nullable) — étiquette purement informative posée quand un
 *     rôle prédéfini (Admin/Operator/Viewer/Auditor, voir
 *     lib/permissions.js#ROLES) a été appliqué à un utilisateur via
 *     lib/user-store.js#applyRole(). Un rôle N'EST PAS un second système de
 *     permissions : l'appliquer se contente d'écrire des lignes concrètes
 *     dans `permissions` (comme le ferait un admin à la main) + éventuellement
 *     `is_admin`. Cette colonne ne sert qu'à afficher/retrouver "quel rôle a
 *     été appliqué en dernier" côté UI/CLI ; elle n'est jamais lue par
 *     hasPermission(). Un utilisateur dont les permissions ont ensuite été
 *     éditées à la main garde son étiquette de rôle (potentiellement obsolète,
 *     purement indicative, voir docs/rbac-api-keys/README.md).
 *
 *  2. `api_keys` — clés API pour intégrations machine-to-machine (voir
 *     lib/services/api-keys/). Une clé est un objet totalement distinct d'un
 *     utilisateur (pas de user_id NOT NULL) : elle porte ses propres scopes
 *     (`scopes`, JSON — sous-ensemble de lib/permissions.js#API_KEY_SCOPES)
 *     et un scoping de ressources préparatoire (`resource_scopes`, JSON
 *     optionnel : { servers?, environments?, groups?, processes? } — seul
 *     `processes` est appliqué à la vérification dans cette phase, voir
 *     lib/permissions.js#apiKeyCanPerform ; les trois autres champs sont
 *     acceptés/stockés/exposés dès maintenant pour ne pas casser un futur
 *     changement de schéma, mais pas encore appliqués sur chaque route —
 *     limitation documentée, voir docs/rbac-api-keys/README.md).
 *
 *     `created_by` (nullable, SANS contrainte de clé étrangère — même
 *     convention que `audit_log.user_id`, voir 011_audit_log.js : une clé
 *     API doit rester listable/auditable même si son créateur est ensuite
 *     supprimé, on ne veut ni la faire disparaître en cascade ni bloquer la
 *     suppression de l'utilisateur).
 *     `key_hash` : SHA-256 hex du secret brut complet (jamais stocké en
 *     clair, jamais bcrypt ici — contrairement à `servers.token_hash` : un
 *     secret de clé API est un token aléatoire à haute entropie généré par le
 *     serveur, pas un mot de passe choisi par un humain, donc un hachage lent
 *     façon bcrypt n'apporte rien contre le bruteforce et empêcherait une
 *     recherche directe `WHERE key_hash = ?` — voir lib/services/api-keys/store.js).
 *     `key_prefix` : les 12 premiers caractères de la clé en clair (incluant
 *     le préfixe `pmk_`), stockés pour permettre à l'utilisateur de
 *     reconnaître une clé dans la liste sans jamais réafficher le secret
 *     complet après sa création.
 *     `revoked_at` (nullable) : une clé révoquée n'est jamais supprimée (trace
 *     d'audit conservée), voir lib/services/api-keys/store.js#revoke.
 */

async function up(db) {
  const usersHasRole = await hasColumn(db, "users", "role");
  if (!usersHasRole) {
    if (db.driver === "mysql") {
      await db.run("ALTER TABLE users ADD COLUMN role VARCHAR(32) NULL AFTER is_admin");
    } else {
      await db.run("ALTER TABLE users ADD COLUMN role TEXT");
    }
  }

  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL,
        key_prefix VARCHAR(32) NOT NULL,
        key_hash VARCHAR(64) NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        resource_scopes TEXT,
        created_by INT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT,
        last_used_at BIGINT,
        revoked_at BIGINT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const indexes = await db.all(
      `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_NAME = 'api_keys' AND INDEX_NAME = 'idx_api_keys_hash'`,
      [],
    );
    if (!indexes.length) {
      await db.run("CREATE INDEX idx_api_keys_hash ON api_keys (key_hash)");
    }
  } else {
    await db.run(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        resource_scopes TEXT,
        created_by INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        last_used_at INTEGER,
        revoked_at INTEGER
      )
    `);
    await db.run("CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash)");
  }
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS api_keys");
  // `users.role` reste en place : SQLite ne supporte pas DROP COLUMN de
  // façon fiable sur toutes les versions embarquées, même raisonnement que
  // 010_health_checks_process_name.js (colonne nullable, sans effet si
  // inutilisée par le code applicatif après rollback).
  if (db.driver === "mysql") {
    const usersHasRole = await hasColumn(db, "users", "role");
    if (usersHasRole) {
      await db.run("ALTER TABLE users DROP COLUMN role");
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
  version: "020_rbac_api_keys",
  description:
    "Ajoute users.role (étiquette de rôle prédéfini) et la table api_keys (clés API M2M scopées).",
  up,
  down,
};
