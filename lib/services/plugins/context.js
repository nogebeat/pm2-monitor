"use strict";

/**
 * Construit le `context` exposé à `plugin.init(context)` / `plugin.onDisable(context)`.
 *
 * Volontairement MINIMAL et restreint (voir prompt de phase, section API —
 * "le context doit exposer uniquement les APIs nécessaires") :
 *   - logger  : logs préfixés par le nom du plugin, jamais un accès brut à console
 *               partagé avec le reste du monitor.
 *   - config  : lecture/écriture de la config PROPRE à ce plugin (scoping strict
 *               par nom — un plugin ne peut jamais lire/modifier la config d'un
 *               autre plugin), persistée via store.js. Jamais la DB brute.
 *   - meta    : identité du plugin lui-même (nom/version), pratique pour un plugin
 *               générique qui voudrait se logguer sans dupliquer son propre nom.
 *
 * Explicitement JAMAIS exposé (voir docs/plugins/README.md#sécurité) :
 * DB brute (lib/db), filesystem arbitraire, secrets (clés de chiffrement,
 * tokens, .env), accès au process Node lui-même (process.exit, require
 * arbitraire, child_process...). Un plugin qui veut plus doit passer par
 * une future extension explicite du contrat (voir validate.js), jamais en
 * contournant le context.
 */

const store = require("./store");

function buildPluginContext(plugin) {
  const prefix = `[plugin:${plugin.name}]`;

  return {
    logger: {
      info: (...args) => console.log(prefix, ...args),
      warn: (...args) => console.warn(prefix, ...args),
      error: (...args) => console.error(prefix, ...args),
    },
    config: {
      /** @returns {Promise<object>} la configuration actuelle de CE plugin (jamais celle d'un autre). */
      get: async () => {
        const record = await store.getByName(plugin.name);
        return record ? record.config : {};
      },
      /** Remplace intégralement la configuration de CE plugin. */
      set: async (config) => {
        const updated = await store.setConfig(plugin.name, config);
        return updated ? updated.config : {};
      },
    },
    meta: {
      name: plugin.name,
      version: plugin.version,
    },
  };
}

module.exports = { buildPluginContext };
