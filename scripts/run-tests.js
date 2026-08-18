#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/**
 * Lance `node --test` avec une liste explicite de fichiers *.test.js,
 * énumérés à la main en JS pur (fs.readdirSync récursif).
 *
 * Pourquoi ne pas simplement faire `node --test test/unit/` ou
 * `node --test "test/unit/**\/*.test.js"` ?
 * Les deux se sont révélés non fiables selon la version de Node et l'OS :
 *  - le glob `**` dépend d'un support expérimental qui varie d'une version
 *    à l'autre (fonctionne sur certaines patch versions, pas d'autres) ;
 *  - passer un simple chemin de répertoire est documenté comme devant
 *    fonctionner (récursion automatique), mais échoue avec
 *    "Cannot find module" sur plusieurs versions 22.x observées en
 *    pratique (y compris en CI GitHub Actions).
 *
 * Passer une liste de fichiers explicite à `node --test` est en revanche
 * documenté et stable depuis l'introduction du test runner — c'est la
 * seule surface d'API qu'on peut traiter comme garantie.
 */

function collectTestFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      results.push(full);
    }
  }
  return results;
}

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("Usage: node scripts/run-tests.js <dir1> [dir2 ...]");
  process.exit(1);
}

const files = dirs.flatMap((d) => collectTestFiles(d)).sort();

if (!files.length) {
  console.error(`Aucun fichier *.test.js trouvé sous : ${dirs.join(", ")}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
