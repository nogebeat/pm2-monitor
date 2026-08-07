"use strict";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(191) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    is_admin TINYINT(1) NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS permissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    app_name VARCHAR(191) NOT NULL,
    action VARCHAR(64) NOT NULL,
    created_at BIGINT NOT NULL,
    UNIQUE KEY uniq_perm (user_id, app_name, action),
    CONSTRAINT fk_perm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

let pool = null;

async function init(config) {
  if (pool) return;

  let mysql;
  try {
    mysql = require("mysql2/promise");
  } catch (e) {
    throw new Error(
      "Le driver MySQL requiert la dépendance 'mysql2'. Lance `npm install` à la racine du projet."
    );
  }

  pool = mysql.createPool({
    host: config.mysqlHost || "127.0.0.1",
    port: config.mysqlPort || 3306,
    user: config.mysqlUser || "root",
    password: config.mysqlPass || "",
    database: config.mysqlDatabase || "pm2_monitor",
    waitForConnections: true,
    connectionLimit: 5,
  });

  for (const stmt of SCHEMA_STATEMENTS) {
    await pool.query(stmt);
  }
}

async function run(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return { lastID: result.insertId, changes: result.affectedRows };
}

async function get(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows[0];
}

async function all(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function close() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { init, run, get, all, close, driver: "mysql" };
