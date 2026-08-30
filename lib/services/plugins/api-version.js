"use strict";

/**
 * Version de l'API exposée aux plugins (lib/services/plugins/context.js).
 *
 * Un plugin déclare le `pluginApiVersion` avec lequel il a été écrit
 * (`module.exports.pluginApiVersion`). Règle de compatibilité volontairement
 * simple pour une API en version 1 : seul le MAJOR doit correspondre (même
 * convention que semver côté "breaking change" : un changement mineur/patch
 * de cette API reste rétro-compatible, un changement de MAJOR ne l'est pas
 * — ex: retirer une clé de `context` exposée aux plugins). Voir
 * docs/plugins/README.md#compatibility.
 */
const PLUGIN_API_VERSION = "1.0.0";

function major(version) {
  const m = String(version || "").match(/^(\d+)/);
  return m ? m[1] : null;
}

/** true si un plugin déclarant `pluginApiVersion` peut être chargé avec cette version de l'API. */
function isCompatible(pluginApiVersion) {
  const requested = major(pluginApiVersion);
  return requested !== null && requested === major(PLUGIN_API_VERSION);
}

module.exports = { PLUGIN_API_VERSION, isCompatible };
