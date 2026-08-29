"use strict";

/**
 * Résolution du "scope" (quels process sont couverts) d'un rapport (Phase
 * 20 — Reports & Capacity Planning), à partir des filtres UI (serveur,
 * environnement, groupe, process) et de la visibilité de l'utilisateur.
 *
 * Aucune nouvelle notion de filtrage : réutilise
 * lib/services/process-organization/store.js (tags/environnements/groupes,
 * Phase 13) pour environment/group, lib/services/process-history/store.js +
 * lib/services/events/event-store.js pour découvrir quels process ont de
 * l'historique connu (raw/rollup), et lib/permissions.js (hasPermission
 * "view" par app, hasServerAccess par serveur) pour ne jamais faire
 * apparaître dans un rapport un process que l'utilisateur ne peut pas voir
 * — même filet de sécurité que lib/process-helpers.js#visibleProcesses.
 *
 * `serverKey` par défaut : lib/services/process-organization/store.js#DEFAULT_SERVER_KEY ("local").
 */

const processHistoryStore = require("../process-history/store");
const processOrgStore = require("../process-organization/store");
const permissions = require("../../permissions");

const DEFAULT_SERVER_KEY = processOrgStore.DEFAULT_SERVER_KEY || "local";

function keyOf(serverKey, processName) {
  return `${serverKey || DEFAULT_SERVER_KEY}\u0000${processName}`;
}

/**
 * Union des couples (process_name, server_key) connus par au moins une
 * source d'historique — c'est le catalogue "candidat" avant filtrage.
 */
async function listKnownProcessKeys() {
  const [rawKeys, mediumKeys, longKeys, assignments] = await Promise.all([
    processHistoryStore.listRawProcessKeys(),
    processHistoryStore.listRollupProcessKeys("medium"),
    processHistoryStore.listRollupProcessKeys("long"),
    processOrgStore.listAssignments(),
  ]);

  const byKey = new Map();
  for (const list of [rawKeys, mediumKeys, longKeys]) {
    for (const { processName, serverKey } of list) {
      byKey.set(keyOf(serverKey, processName), { processName, serverKey: serverKey || DEFAULT_SERVER_KEY });
    }
  }
  for (const a of assignments) {
    byKey.set(keyOf(a.serverKey, a.processName), {
      processName: a.processName,
      serverKey: a.serverKey || DEFAULT_SERVER_KEY,
    });
  }
  return Array.from(byKey.values());
}

/**
 * @param {object} filters
 * @param {string} [filters.serverKey] - filtre exact sur le serveur PM2 (Phase 10)
 * @param {string} [filters.process] - filtre exact sur un process précis (nom)
 * @param {string} [filters.environment] - nom d'environnement (Phase 13, process-organization)
 * @param {string} [filters.group] - nom de groupe (Phase 13)
 * @param {string[]} [filters.liveProcessNames] - process actuellement listés par PM2 (server.js#fmtProcess),
 *   inclus même sans historique persistant encore accumulé (rapport "vide" plutôt qu'absent).
 * @param {object} [user] - req.user, pour filtrer par visibilité (lib/permissions.js#hasPermission "view",
 *   #hasServerAccess). Si omis (contexte sans auth, PM2_MONITOR_DISABLE_AUTH=1), aucun filtrage n'est appliqué.
 * @returns {Promise<Array<{processName: string, serverKey: string}>>}
 */
async function resolveProcessScope(filters = {}, user = null) {
  const { serverKey, process: processFilter, environment, group, liveProcessNames = [] } = filters;

  let candidates = await listKnownProcessKeys();
  for (const name of liveProcessNames) {
    const key = keyOf(DEFAULT_SERVER_KEY, name);
    if (!candidates.some((c) => keyOf(c.serverKey, c.processName) === key)) {
      candidates.push({ processName: name, serverKey: DEFAULT_SERVER_KEY });
    }
  }

  if (processFilter) {
    candidates = candidates.filter((c) => c.processName === processFilter);
  }
  if (serverKey) {
    candidates = candidates.filter((c) => c.serverKey === serverKey);
  }

  if (environment || group) {
    const kept = [];
    for (const c of candidates) {
      const org = await processOrgStore.getOrganizationForProcess(c.processName, c.serverKey);
      if (environment && org.environment !== environment) continue;
      if (group && !org.groups.includes(group)) continue;
      kept.push(c);
    }
    candidates = kept;
  }

  if (user) {
    candidates = candidates.filter(
      (c) =>
        permissions.hasPermission(user, c.processName, "view") &&
        permissions.hasServerAccess(user, c.serverKey),
    );
  }

  // Ordre déterministe (utile pour les tests et un affichage stable).
  candidates.sort(
    (a, b) => a.processName.localeCompare(b.processName) || a.serverKey.localeCompare(b.serverKey),
  );
  return candidates;
}

module.exports = { DEFAULT_SERVER_KEY, listKnownProcessKeys, resolveProcessScope };
