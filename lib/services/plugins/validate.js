"use strict";

/**
 * Contrat minimal d'un plugin (Phase 21) :
 *
 *   module.exports = {
 *     name: "mon-plugin",              // string, identifiant unique (slug)
 *     version: "1.0.0",                // string, version du PLUGIN lui-même
 *     pluginApiVersion: "1.0.0",       // string, version de l'API PM2 Monitor visée
 *     description: "…",                // string, optionnel
 *     init(context) { … },             // fonction, appelée à l'activation
 *     onDisable(context) { … },        // fonction, optionnel, appelée à la désactivation
 *   }
 *
 * Volontairement minimal (voir prompt de phase, section API) : pas de
 * `type` de plugin pour l'instant (notification provider/health check/
 * metrics/…) — juste un point d'entrée générique `init(context)`. Les
 * types spécialisés viendront étendre ce contrat dans une phase ultérieure
 * sans le casser (un plugin actuel resterait valide).
 */

const NAME_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/;

/** @returns {string[]} liste d'erreurs (vide = plugin valide structurellement). */
function validatePluginShape(plugin) {
  const errors = [];

  if (!plugin || typeof plugin !== "object") {
    return ["Le plugin doit exporter un objet (module.exports = { ... })."];
  }
  if (typeof plugin.name !== "string" || !NAME_RE.test(plugin.name)) {
    errors.push(
      "plugin.name requis : chaîne en minuscules, chiffres, tirets/underscores (2 à 64 caractères).",
    );
  }
  if (typeof plugin.version !== "string" || !plugin.version.trim()) {
    errors.push('plugin.version requis (string, ex: "1.0.0").');
  }
  if (typeof plugin.pluginApiVersion !== "string" || !plugin.pluginApiVersion.trim()) {
    errors.push('plugin.pluginApiVersion requis (string, ex: "1.0.0").');
  }
  if (typeof plugin.init !== "function") {
    errors.push("plugin.init(context) requis (function).");
  }
  if (plugin.onDisable !== undefined && typeof plugin.onDisable !== "function") {
    errors.push("plugin.onDisable(context) doit être une fonction si fourni.");
  }
  if (plugin.description !== undefined && typeof plugin.description !== "string") {
    errors.push("plugin.description doit être une chaîne si fournie.");
  }

  return errors;
}

module.exports = { validatePluginShape, NAME_RE };
