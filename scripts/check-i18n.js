#!/usr/bin/env node
/**
 * Vérifie que les fichiers de traduction fr.json et en.json ont exactement
 * les mêmes clés (à plat, via dot-notation). Utilisé en CI pour éviter
 * qu'une langue prenne du retard sur l'autre (clé manquante = repli
 * silencieux sur fallbackLocale en prod, ce qui masque l'oubli).
 *
 * Usage: node scripts/check-i18n.js
 */
const fs = require("fs");
const path = require("path");

const LOCALES_DIR = path.join(__dirname, "..", "frontend", "src", "i18n", "locales");
const FILES = ["fr.json", "en.json"];

function flattenKeys(obj, prefix = "") {
  let keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys = keys.concat(flattenKeys(v, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

const keysByFile = {};
for (const file of FILES) {
  const filePath = path.join(LOCALES_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.error(`✗ Fichier introuvable : ${filePath}`);
    process.exit(1);
  }
  const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
  keysByFile[file] = new Set(flattenKeys(content));
}

const [fileA, fileB] = FILES;
const setA = keysByFile[fileA];
const setB = keysByFile[fileB];

const onlyInA = [...setA].filter((k) => !setB.has(k));
const onlyInB = [...setB].filter((k) => !setA.has(k));

if (onlyInA.length === 0 && onlyInB.length === 0) {
  console.log(`✓ ${fileA} et ${fileB} ont exactement les mêmes clés (${setA.size} clés).`);
  process.exit(0);
}

if (onlyInA.length) {
  console.error(`✗ Clés présentes dans ${fileA} mais absentes de ${fileB} :`);
  onlyInA.forEach((k) => console.error(`  - ${k}`));
}
if (onlyInB.length) {
  console.error(`✗ Clés présentes dans ${fileB} mais absentes de ${fileA} :`);
  onlyInB.forEach((k) => console.error(`  - ${k}`));
}
process.exit(1);
