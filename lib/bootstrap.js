"use strict";

/**
 * lib/bootstrap.js
 *
 * Deux étapes de démarrage extraites telles quelles de server.js :
 *  - loadDotEnv() : parseur .env minimal (pas de dépendance dotenv), doit
 *    être appelé avant toute lecture de process.env par le reste de l'appli.
 *  - ensureBootstrapAdmin() : migration douce depuis l'ancien mode
 *    mono-utilisateur / création du premier compte admin.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const userStore = require("./user-store");

function loadDotEnv(rootDir) {
  const envPath = path.join(rootDir, ".env");
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

async function ensureBootstrapAdmin() {
  const n = await userStore.countUsers();
  if (n > 0) return;

  // Migration depuis l'ancien système (.env PM2_MONITOR_USER/PM2_MONITOR_PASS)
  // ou génération d'un compte admin par défaut, pour ne pas laisser une
  // installation existante sans accès après mise à jour.
  const legacyUser = process.env.PM2_MONITOR_USER || "admin";
  const legacyPass = process.env.PM2_MONITOR_PASS || crypto.randomBytes(9).toString("base64");

  await userStore.createUser({ username: legacyUser, password: legacyPass, isAdmin: true });

  console.warn(
    `\n👤  Aucun utilisateur trouvé : un compte administrateur a été créé.\n` +
      `   Identifiant : ${legacyUser}\n` +
      (process.env.PM2_MONITOR_PASS ? "" : `   Mot de passe (généré, à noter) : ${legacyPass}\n`) +
      `   Gère les comptes ensuite depuis l'UI (menu utilisateurs) ou via ` +
      `\`node bin/manage-users.js\`.\n`,
  );
}

module.exports = { loadDotEnv, ensureBootstrapAdmin };
