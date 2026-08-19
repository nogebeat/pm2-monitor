"use strict";

/**
 * Scoping optionnel "utilisateur -> serveurs autorisés" (table `user_servers`,
 * migration 012_servers.js). Volontairement séparé de lib/user-store.js
 * (qui gère users/permissions) pour rester dans lib/services/servers/ avec
 * le reste de la Phase 10, mais lu/écrit aux mêmes moments (voir
 * lib/routes/users.js) — pas un second magasin de vérité sur les users.
 *
 * Absence de lignes pour un user = aucune restriction (voit tous les
 * serveurs auxquels ses `permissions` habituelles donnent accès). Dès qu'au
 * moins un serveur est explicitement listé, l'utilisateur est restreint à
 * ce sous-ensemble — voir lib/permissions.js#hasServerAccess.
 */

const db = require("../../db");

async function listAllowedServerKeys(userId) {
  const rows = await db.all("SELECT server_key FROM user_servers WHERE user_id = ?", [userId]);
  return rows.map((r) => r.server_key);
}

/** Remplace l'ensemble des serveurs autorisés pour un user. `serverKeys = []` retire toute restriction. */
async function replaceAllowedServers(userId, serverKeys) {
  await db.run("DELETE FROM user_servers WHERE user_id = ?", [userId]);
  const now = Date.now();
  for (const serverKey of serverKeys || []) {
    if (!serverKey) continue;
    await db.run(
      db.driver === "mysql"
        ? "INSERT IGNORE INTO user_servers (user_id, server_key, created_at) VALUES (?, ?, ?)"
        : "INSERT OR IGNORE INTO user_servers (user_id, server_key, created_at) VALUES (?, ?, ?)",
      [userId, serverKey, now],
    );
  }
}

module.exports = { listAllowedServerKeys, replaceAllowedServers };
