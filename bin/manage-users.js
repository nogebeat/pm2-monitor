#!/usr/bin/env node
"use strict";

/**
 * CLI de gestion des utilisateurs / permissions, utile pour :
 *  - le premier déploiement (créer l'admin sans passer par l'UI web)
 *  - les scripts d'automatisation / deploy.sh
 *  - dépanner un accès perdu en SSH
 *
 * Usage :
 *   node bin/manage-users.js list
 *   node bin/manage-users.js create <username> <password> [--admin]
 *   node bin/manage-users.js passwd <username> <newPassword>
 *   node bin/manage-users.js delete <username>
 *   node bin/manage-users.js grant <username> <appName|*> <action|*>
 *   node bin/manage-users.js revoke <username> <appName|*> <action|*>
 *   node bin/manage-users.js promote <username>   (donne le rôle admin)
 *   node bin/manage-users.js demote <username>    (retire le rôle admin)
 *   node bin/manage-users.js role <username> <admin|operator|viewer|auditor>  (Phase 18 — applique un rôle prédéfini)
 */

const path = require("path");
const fs = require("fs");

// Charge le .env comme server.js (fonctionne même si le process n'a pas encore été lancé)
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
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
const userStore = require("../lib/user-store");
const { APP_ACTIONS, GLOBAL_ACTIONS, ROLES } = require("../lib/permissions");

function usageAndExit() {
  console.log(fs.readFileSync(__filename, "utf8").split("Usage :")[1].split("*/")[0].trim());
  process.exit(1);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) usageAndExit();

  await db.init();

  try {
    switch (cmd) {
      case "list": {
        const users = await userStore.listUsers();
        if (!users.length) {
          console.log("Aucun utilisateur.");
          break;
        }
        users.forEach((u) => {
          console.log(`\n#${u.id} ${u.username}${u.isAdmin ? "  [admin]" : ""}`);
          if (!u.isAdmin) {
            if (!u.permissions.length) console.log("   (aucune permission)");
            u.permissions.forEach((p) => console.log(`   - ${p.appName} : ${p.action}`));
          }
        });
        break;
      }

      case "create": {
        const [username, password] = args;
        if (!username || !password) usageAndExit();
        const isAdmin = args.includes("--admin");
        const user = await userStore.createUser({ username, password, isAdmin });
        console.log(`Utilisateur créé : #${user.id} ${user.username}${isAdmin ? " [admin]" : ""}`);
        break;
      }

      case "passwd": {
        const [username, password] = args;
        if (!username || !password) usageAndExit();
        const row = await userStore.getByUsername(username);
        if (!row) throw new Error(`Utilisateur "${username}" introuvable.`);
        await userStore.setPassword(row.id, password);
        console.log(`Mot de passe mis à jour pour ${username}.`);
        break;
      }

      case "delete": {
        const [username] = args;
        if (!username) usageAndExit();
        const row = await userStore.getByUsername(username);
        if (!row) throw new Error(`Utilisateur "${username}" introuvable.`);
        await userStore.deleteUser(row.id);
        console.log(`Utilisateur ${username} supprimé.`);
        break;
      }

      case "grant":
      case "revoke": {
        const [username, appName, action] = args;
        if (!username || !appName || !action) usageAndExit();
        if (action !== "*" && !APP_ACTIONS[action] && !GLOBAL_ACTIONS[action]) {
          throw new Error(
            `Action inconnue "${action}". Actions par app: ${Object.keys(APP_ACTIONS).join(", ")}. ` +
              `Actions globales: ${Object.keys(GLOBAL_ACTIONS).join(", ")}.`,
          );
        }
        const row = await userStore.getByUsername(username);
        if (!row) throw new Error(`Utilisateur "${username}" introuvable.`);
        await userStore[cmd](row.id, appName, action);
        console.log(`${cmd === "grant" ? "Accordé" : "Retiré"} : ${username} → ${appName} / ${action}`);
        break;
      }

      case "promote": {
        const [username] = args;
        if (!username) usageAndExit();
        const row = await userStore.getByUsername(username);
        if (!row) throw new Error(`Utilisateur "${username}" introuvable.`);
        await userStore.setAdmin(row.id, true);
        console.log(`${username} est maintenant administrateur.`);
        break;
      }

      case "demote": {
        const [username] = args;
        if (!username) usageAndExit();
        const row = await userStore.getByUsername(username);
        if (!row) throw new Error(`Utilisateur "${username}" introuvable.`);
        await userStore.setAdmin(row.id, false);
        console.log(`${username} n'est plus administrateur.`);
        break;
      }

      case "role": {
        // Phase 18 — Advanced RBAC : applique un rôle prédéfini (remplace
        // is_admin + toutes les permissions existantes de l'utilisateur par
        // celles du rôle, voir lib/user-store.js#applyRole).
        const [username, roleName] = args;
        if (!username || !roleName) usageAndExit();
        if (!ROLES[roleName]) {
          throw new Error(
            `Rôle inconnu "${roleName}". Rôles disponibles : ${Object.keys(ROLES).join(", ")}.`,
          );
        }
        const row = await userStore.getByUsername(username);
        if (!row) throw new Error(`Utilisateur "${username}" introuvable.`);
        await userStore.applyRole(row.id, roleName);
        console.log(`${username} a maintenant le rôle "${ROLES[roleName].label}".`);
        break;
      }

      default:
        usageAndExit();
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
