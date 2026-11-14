#!/usr/bin/env node
"use strict";

/**
 * CLI de sauvegarde / restauration de la base autour d'une mise à jour — appelé
 * par `deploy.sh update`. Même style que bin/migrate.js : charge le .env de la
 * racine du projet et utilise la même configuration que le serveur
 * (DB_DRIVER, DB_SQLITE_PATH, DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME).
 *
 * Usage :
 *   node bin/db-snapshot.js check
 *       Les prérequis d'une sauvegarde sont-ils réunis ? (code 0/1, causes sur stderr)
 *   node bin/db-snapshot.js backup --out-dir <dossier> [--label <texte>]
 *       Crée une sauvegarde ; écrit UNIQUEMENT son chemin sur stdout.
 *   node bin/db-snapshot.js restore <fichier> [--out-dir <dossier>]
 *       Restaure une sauvegarde. L'APPLICATION DOIT ÊTRE ARRÊTÉE avant.
 *   node bin/db-snapshot.js prune --out-dir <dossier> [--keep <n>] [--protect <fichier>]
 *       Ne garde que les <n> sauvegardes les plus récentes (défaut 5).
 *
 * Détails et raisons de conception : lib/db/snapshot.js.
 */

const fs = require("fs");
const path = require("path");

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

loadDotEnv();

const snapshot = require("../lib/db/snapshot");

const ROOT_DIR = path.join(__dirname, "..");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { positional: [], protect: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out-dir") opts.outDir = rest[++i];
    else if (a === "--label") opts.label = rest[++i];
    else if (a === "--keep") opts.keep = Number(rest[++i]);
    else if (a === "--protect") opts.protect.push(rest[++i]);
    else opts.positional.push(a);
  }
  return { command, opts };
}

function usage() {
  console.error(
    "Usage: node bin/db-snapshot.js <check|backup|restore|prune> [options] — voir l'en-tête du fichier.",
  );
  process.exitCode = 1;
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (!["check", "backup", "restore", "prune"].includes(command || "")) return usage();

  const config = snapshot.configFromEnv();

  if (command === "check") {
    const { ok, problems } = snapshot.checkPrerequisites(config, { rootDir: ROOT_DIR });
    if (!ok) {
      console.error(problems.join(","));
      process.exitCode = 1;
    }
    return undefined;
  }

  if (!opts.outDir && command !== "restore") return usage();

  if (command === "backup") {
    const file = await snapshot.createSnapshot({
      config,
      rootDir: ROOT_DIR,
      outDir: path.resolve(opts.outDir),
      label: opts.label,
    });
    console.log(file);
  } else if (command === "restore") {
    const file = opts.positional[0];
    if (!file) return usage();
    const outDir = path.resolve(opts.outDir || path.dirname(file));
    const { keptCopy } = await snapshot.restoreSnapshot({
      config,
      rootDir: ROOT_DIR,
      outDir,
      file: path.resolve(file),
    });
    console.error(
      keptCopy
        ? `Base restaurée. État défaillant conservé dans : ${keptCopy}`
        : "Base restaurée (aucune copie de l'état défaillant).",
    );
  } else if (command === "prune") {
    const removed = snapshot.pruneSnapshots({
      outDir: path.resolve(opts.outDir),
      keep: Number.isFinite(opts.keep) ? opts.keep : 5,
      protect: opts.protect,
    });
    for (const f of removed) console.error(`Ancienne sauvegarde supprimée : ${f}`);
  }
  return undefined;
}

main().catch((err) => {
  console.error(`Erreur : ${err.message}`);
  process.exitCode = 1;
});
