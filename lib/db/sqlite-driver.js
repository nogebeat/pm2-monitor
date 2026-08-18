"use strict";

const fs = require("fs");
const path = require("path");

// Le schéma (tables users/permissions, etc.) n'est plus créé ici : il est
// désormais géré par le système de migrations versionnées (lib/db/migrator.js
// + lib/db/migrations/). Ce driver ne fait que gérer la connexion et
// l'exécution des requêtes.

let db = null;

function init(config) {
  if (db) return Promise.resolve();

  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (e) {
    throw new Error(
      "Le driver SQLite requiert la dépendance 'better-sqlite3'. Lance `npm install` à la racine du projet.",
    );
  }

  const dbPath = config.sqlitePath || path.join(__dirname, "..", "..", "data", "monitor.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return Promise.resolve();
}

// Interface unifiée (async) même si better-sqlite3 est synchrone sous le capot.

function run(sql, params = []) {
  const info = db.prepare(sql).run(...params);
  return Promise.resolve({ lastID: info.lastInsertRowid, changes: info.changes });
}

function get(sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return Promise.resolve(row || undefined);
}

function all(sql, params = []) {
  const rows = db.prepare(sql).all(...params);
  return Promise.resolve(rows);
}

// --- Transactions (utilisées par le système de migrations) ---------------
//
// SQLite gère nativement le DDL transactionnel (CREATE/DROP TABLE inclus dans
// BEGIN/COMMIT/ROLLBACK), donc une migration qui échoue en cours de route est
// intégralement annulée, y compris ses éventuels CREATE TABLE.

function beginTransaction() {
  db.prepare("BEGIN").run();
  return Promise.resolve();
}

function commit() {
  db.prepare("COMMIT").run();
  return Promise.resolve();
}

function rollback() {
  try {
    db.prepare("ROLLBACK").run();
  } catch (e) {
    // Rien à annuler (transaction déjà terminée) : on l'ignore pour ne pas
    // masquer l'erreur d'origine qui a déclenché ce rollback.
  }
  return Promise.resolve();
}

function close() {
  if (db) db.close();
  db = null;
}

module.exports = {
  init,
  run,
  get,
  all,
  close,
  beginTransaction,
  commit,
  rollback,
  supportsTransactionalDDL: true,
  driver: "sqlite",
};
