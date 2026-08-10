"use strict";

// Le schéma n'est plus créé ici : il est désormais géré par le système de
// migrations versionnées (lib/db/migrator.js + lib/db/migrations/). Ce
// driver ne fait que gérer le pool de connexions et l'exécution des requêtes.

let pool = null;

// Connexion dédiée utilisée pendant une transaction (migrations). Tant
// qu'elle est active, run()/get()/all() l'utilisent au lieu du pool, pour
// que toutes les requêtes d'une même migration passent par la même
// connexion MySQL (indispensable pour qu'une transaction ait un sens : le
// pool distribue sinon chaque requête sur une connexion différente).
let txConn = null;

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
}

async function run(sql, params = []) {
  const conn = txConn || pool;
  const [result] = await conn.execute(sql, params);
  return { lastID: result.insertId, changes: result.affectedRows };
}

async function get(sql, params = []) {
  const conn = txConn || pool;
  const [rows] = await conn.execute(sql, params);
  return rows[0];
}

async function all(sql, params = []) {
  const conn = txConn || pool;
  const [rows] = await conn.execute(sql, params);
  return rows;
}

// --- Transactions (utilisées par le système de migrations) ---------------
//
// Attention : MySQL/InnoDB effectue un COMMIT implicite à chaque instruction
// DDL (CREATE TABLE, DROP TABLE, ALTER TABLE…). Une migration purement DDL
// n'est donc pas réellement annulable en cas d'échec en milieu d'exécution
// (limitation MySQL, pas de notre système). C'est pourquoi les migrations
// sont écrites de façon idempotente (IF NOT EXISTS / IF EXISTS) : on peut
// toujours relancer `migration up` sans risque après un échec partiel.
// Les instructions DML (INSERT/UPDATE/DELETE), elles, restent bien
// transactionnelles et sont annulées par rollback().

async function beginTransaction() {
  txConn = await pool.getConnection();
  await txConn.beginTransaction();
}

async function commit() {
  if (!txConn) return;
  await txConn.commit();
  txConn.release();
  txConn = null;
}

async function rollback() {
  if (!txConn) return;
  try {
    await txConn.rollback();
  } catch (e) {
    // Rien à annuler : on ignore pour ne pas masquer l'erreur d'origine.
  }
  txConn.release();
  txConn = null;
}

async function close() {
  if (pool) await pool.end();
  pool = null;
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
  supportsTransactionalDDL: false,
  driver: "mysql",
};
