"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * lib/db/index.js choisit son driver une seule fois, au require() du module
 * (variable DB_DRIVER lue à ce moment-là), mais chaque driver garde ensuite
 * son état de connexion dans une variable de module (le `db` de
 * sqlite-driver.js). db.init() est un no-op si déjà connecté, donc pour
 * isoler chaque test sur son propre fichier SQLite on doit explicitement
 * fermer puis ré-ouvrir avec un nouveau chemin.
 *
 * Ces tests utilisent tous SQLite (DB_DRIVER n'est pas positionné à "mysql"
 * dans cet environnement), donc process.env.DB_DRIVER doit rester absent/
 * "sqlite" pour que require("../../lib/db") sélectionne le bon driver.
 */

async function freshDb() {
  const db = require("../../lib/db");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-test-"));
  const dbPath = path.join(dir, "monitor.db");

  await db.close(); // no-op si rien n'était ouvert
  process.env.DB_SQLITE_PATH = dbPath;
  await db.init();

  return { db, dbPath, dir };
}

async function cleanupDb({ db, dir }) {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { freshDb, cleanupDb };
