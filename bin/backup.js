#!/usr/bin/env node
"use strict";

/**
 * CLI de backup/restauration de la configuration PM2 Monitor (Phase 19).
 * Même style que bin/manage-users.js / bin/migrate.js : charge le .env de
 * la racine du projet, appelle directement lib/services/backup/ (pas de
 * requête HTTP — utilisable en SSH sans que le serveur web tourne).
 *
 * Usage :
 *   node bin/backup.js export [--out fichier.json] [--sections a,b,c] [--include-secrets]
 *   node bin/backup.js validate <fichier.json> [--on-conflict skip|overwrite]
 *   node bin/backup.js restore <fichier.json> [--on-conflict skip|overwrite] [--yes]
 *
 * `restore` affiche toujours le résumé de validation en premier et demande
 * confirmation ("tapez OUI") avant d'écrire quoi que ce soit, sauf si
 * `--yes` est passé (scripts d'automatisation) — même esprit que
 * bin/manage-users.js pour les opérations destructives.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

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
const backupService = require("../lib/services/backup");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") opts.out = rest[++i];
    else if (a === "--sections") opts.sections = rest[++i].split(",").filter(Boolean);
    else if (a === "--include-secrets") opts.includeSecrets = true;
    else if (a === "--on-conflict") opts.onConflict = rest[++i];
    else if (a === "--yes") opts.yes = true;
    else opts._.push(a);
  }
  return { command, opts };
}

function printSummary(summary) {
  for (const s of summary) {
    const bits = [`+${s.created} créés`, `${s.updated} mis à jour`, `${s.skipped} ignorés/conflits`];
    console.log(`  · ${s.label} (${s.section}) — ${bits.join(", ")}`);
    for (const c of s.conflicts) {
      console.log(`      ⚠ ${c.key} — ${c.reason}`);
    }
  }
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toUpperCase() === "OUI");
    });
  });
}

async function cmdExport(opts) {
  const backup = await backupService.createBackup({
    sections: opts.sections,
    includeSecrets: !!opts.includeSecrets,
  });
  const json = JSON.stringify(backup, null, 2);
  if (opts.out) {
    fs.writeFileSync(opts.out, json, "utf8");
    console.log(`Backup écrit dans ${opts.out} (${(json.length / 1024).toFixed(1)} Ko).`);
  } else {
    process.stdout.write(json + "\n");
  }
}

function readBackupFile(filePath) {
  if (!filePath) throw new Error("Fichier de backup requis.");
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

async function cmdValidate(opts) {
  const backup = readBackupFile(opts._[0]);
  const result = await backupService.validateBackup(backup, { onConflict: opts.onConflict });
  console.log(
    `Backup valide (formatVersion=${result.formatVersion}, créé le ${new Date(result.metadata.createdAt).toISOString()}).`,
  );
  if (result.unknownSections.length) {
    console.log(`Sections inconnues de cette version (ignorées) : ${result.unknownSections.join(", ")}`);
  }
  printSummary(result.summary);
  if (result.hasConflicts) {
    console.log("\n⚠ Des conflits ont été détectés — voir le détail ci-dessus.");
  }
}

async function cmdRestore(opts) {
  const backup = readBackupFile(opts._[0]);
  const preview = await backupService.validateBackup(backup, { onConflict: opts.onConflict });
  console.log(`Résumé de la restauration à venir (formatVersion=${preview.formatVersion}) :`);
  printSummary(preview.summary);

  if (!opts.yes) {
    const ok = await confirm('\nConfirmer la restauration ? Tapez "OUI" pour continuer : ');
    if (!ok) {
      console.log("Annulé.");
      return;
    }
  }

  const result = await backupService.restoreBackup(backup, {
    onConflict: opts.onConflict,
    confirm: true,
  });
  console.log("\nRestauration terminée :");
  printSummary(result.summary);
  if (result.generatedPasswords.length) {
    console.log("\nMots de passe temporaires générés (à transmettre puis faire changer) :");
    for (const { username, password } of result.generatedPasswords) {
      console.log(`  ${username} : ${password}`);
    }
  }
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (!command || !["export", "validate", "restore"].includes(command)) {
    console.error("Usage: node bin/backup.js <export|validate|restore> [options]");
    process.exitCode = 1;
    return;
  }

  await db.init();
  try {
    if (command === "export") await cmdExport(opts);
    else if (command === "validate") await cmdValidate(opts);
    else if (command === "restore") await cmdRestore(opts);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("Erreur :", err.message);
  process.exitCode = 1;
});
