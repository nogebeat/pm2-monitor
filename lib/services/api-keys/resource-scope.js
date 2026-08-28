"use strict";

/**
 * lib/services/api-keys/resource-scope.js — Phase 18 (suite).
 *
 * Vérifie les scopes de ressource "environment"/"group" d'une clé API
 * (`resourceScopes.environments` / `resourceScopes.groups`) — complète
 * lib/permissions.js#apiKeyCanPerform(), qui reste volontairement pur et
 * synchrone (voir son en-tête de fichier) et ne vérifie que
 * `resourceScopes.processes`. Ce module fait le lookup DB nécessaire via
 * lib/services/process-organization/, donc ne peut pas vivre dans
 * lib/permissions.js sans lui faire perdre cette propriété.
 *
 * Convention : comme `resourceScopes.processes`/`servers`, ces listes
 * contiennent des NOMS (pas des identifiants numériques) — cohérent avec la
 * façon dont le reste du projet référence déjà environnements/groupes par
 * nom (voir lib/services/process-organization/store.js#getOrganizationForProcess,
 * utilisé de la même façon par le Routing Engine des notifications). Une
 * liste absente/vide = pas de restriction sur ce critère ; si les deux
 * listes sont fournies, les deux doivent être satisfaites (restrictions
 * additives, pas des alternatives) — cohérent avec la façon dont
 * `resourceScopes.processes` restreint déjà indépendamment.
 *
 * Toujours résolu sur le serveur "local" (paramètre par défaut de
 * process-organization/store.js) : les deux seuls appelants
 * (lib/process-helpers.js#withAppPermission et
 * lib/routes/processes.js#GET /processes) opèrent sur le PM2 local
 * uniquement — voir leur propre documentation.
 */

const orgStore = require("../process-organization/store");

async function processResourceScopeAllows(apiKeyAuth, appName) {
  if (!apiKeyAuth || !appName) return true;
  const rs = apiKeyAuth.resourceScopes;
  if (!rs) return true;

  const requiredEnvironments = Array.isArray(rs.environments) ? rs.environments : [];
  const requiredGroups = Array.isArray(rs.groups) ? rs.groups : [];
  if (!requiredEnvironments.length && !requiredGroups.length) return true;

  const org = await orgStore.getOrganizationForProcess(appName);

  if (requiredEnvironments.length && !(org.environment && requiredEnvironments.includes(org.environment))) {
    return false;
  }
  if (requiredGroups.length && !org.groups.some((g) => requiredGroups.includes(g))) {
    return false;
  }
  return true;
}

module.exports = { processResourceScopeAllows };
