#!/usr/bin/env node
"use strict";

/**
 * CLI de gestion des migrations DB.
 *
 * Usage :
 *   node bin/migrate.js status
 *   node bin/migrate.js up               # applique toutes les migrations en attente
 *   node bin/migrate.js up --to 002_job_queue
 *   node bin/migrate.js down             # annule la dernière migration appliquée
 *   node bin/migrate.js down --steps 3   # annule les 3 dernières
 *
 * Utilise la même configuration que le serveur (.env à la racine du projet :
 * DB_DRIVER, DB_SQLITE_PATH, DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME).
 */

const fs = require("fs");
const path = require("path");

loadDotEnv();

function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (!m) return;
      const key = m[1];
      let val = (m[2] || "").trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    });
}

const db = require("../lib/db");
const migrator = require("../lib/db/migrator");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--to") opts.to = rest[++i];
    else if (rest[i] === "--steps") opts.steps = Number(rest[++i]);
  }
  return { command, opts };
}

function fmtDate(ts) {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

async function printStatus() {
  const { applied, pending } = await migrator.status();
  console.log(`\nMigrations appliquées (${applied.length}) :`);
  if (!applied.length) console.log("  (aucune)");
  for (const m of applied) console.log(`  ✔ ${m.version}  ${m.description || ""}`);

  console.log(`\nMigrations en attente (${pending.length}) :`);
  if (!pending.length) console.log("  (aucune — la base est à jour)");
  for (const m of pending) console.log(`  · ${m.version}  ${m.description || ""}`);
  console.log("");
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));

  if (!command || !["up", "down", "status"].includes(command)) {
    console.error("Usage: node bin/migrate.js <up|down|status> [--to <version>] [--steps <n>]");
    process.exitCode = 1;
    return;
  }

  await db.init();

  try {
    if (command === "status") {
      await printStatus();
    } else if (command === "up") {
      const applied = await migrator.up({ to: opts.to });
      if (!applied.length) {
        console.log("Rien à appliquer, la base est déjà à jour.");
      } else {
        console.log(`Migrations appliquées :`);
        for (const v of applied) console.log(`  ✔ ${v}`);
      }
    } else if (command === "down") {
      const steps = opts.steps || 1;
      const reverted = await migrator.down({ steps });
      if (!reverted.length) {
        console.log("Rien à annuler, aucune migration appliquée.");
      } else {
        console.log(`Migrations annulées :`);
        for (const v of reverted) console.log(`  ↩ ${v}`);
      }
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("Erreur de migration :", err.message);
  process.exitCode = 1;
});
