"use strict";

/**
 * Sélectionne le driver de base de données selon DB_DRIVER (.env) :
 *   - "sqlite" (défaut) : fichier local, aucune dépendance externe → marche partout,
 *     recommandé pour la plupart des installations open source.
 *   - "mysql" : pour ceux qui ont déjà un serveur MySQL/MariaDB et préfèrent
 *     centraliser users/permissions dedans.
 *
 * Les deux drivers exposent la même interface async : init(), run(), get(), all(), close().
 */

const driverName = (process.env.DB_DRIVER || "sqlite").toLowerCase();

let impl;
if (driverName === "mysql") {
  impl = require("./mysql-driver");
} else if (driverName === "sqlite") {
  impl = require("./sqlite-driver");
} else {
  throw new Error(`DB_DRIVER invalide: "${process.env.DB_DRIVER}". Valeurs acceptées: sqlite, mysql.`);
}

function init() {
  return impl.init({
    sqlitePath: process.env.DB_SQLITE_PATH,
    mysqlHost: process.env.DB_HOST,
    mysqlPort: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    mysqlUser: process.env.DB_USER,
    mysqlPass: process.env.DB_PASS,
    mysqlDatabase: process.env.DB_NAME,
  });
}

module.exports = {
  init,
  run: (...args) => impl.run(...args),
  get: (...args) => impl.get(...args),
  all: (...args) => impl.all(...args),
  close: (...args) => impl.close(...args),
  driver: impl.driver,
};
