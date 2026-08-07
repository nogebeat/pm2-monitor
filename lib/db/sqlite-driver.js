"use strict";

const fs = require("fs");
const path = require("path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_name TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, app_name, action)
);
`;

let db = null;

function init(config) {
  if (db) return Promise.resolve();

  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (e) {
    throw new Error(
      "Le driver SQLite requiert la dépendance 'better-sqlite3'. Lance `npm install` à la racine du projet."
    );
  }

  const dbPath = config.sqlitePath || path.join(__dirname, "..", "..", "data", "monitor.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

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

function close() {
  if (db) db.close();
  db = null;
}

module.exports = { init, run, get, all, close, driver: "sqlite" };
