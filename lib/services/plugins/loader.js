"use strict";

/**
 * Découvre les plugins présents dans le dossier `plugins/` à la racine du
 * repo (voir plugins/README.md). Un plugin = un sous-dossier contenant un
 * `index.js` qui exporte le contrat décrit dans validate.js.
 *
 * SÉCURITÉ (voir prompt de phase, section Sécurité, et
 * docs/plugins/README.md#sécurité) : ce loader ne fait que `require()` du
 * code déjà présent SUR DISQUE, déposé là manuellement par l'opérateur
 * self-hosted (copie de fichiers, `git clone`, etc.) — il ne télécharge
 * jamais rien depuis un registre/une URL, n'exécute jamais de code reçu par
 * l'API, et ne fait aucun `npm install` pour un plugin. Un plugin est du
 * code Node exécuté avec les MÊMES privilèges que le process PM2 Monitor —
 * cette fonction ne fait qu'énumérer/charger, elle ne "sandboxe" rien (Node
 * ne le permet pas nativement) ; c'est le `context` restreint (context.js)
 * qui limite ce qu'un plugin BIEN INTENTIONNÉ peut faire facilement, pas
 * une protection contre du code malveillant.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_PLUGINS_DIR = path.join(__dirname, "..", "..", "..", "plugins");

/**
 * Dossier scanné pour les plugins. Surchageable via
 * PM2_MONITOR_PLUGINS_DIR (.env) — utile pour un layout de déploiement
 * personnalisé (voir DB_SQLITE_PATH pour la même convention), et pour les
 * tests (voir test/unit/plugins-index.test.js) qui pointent vers un
 * dossier temporaire plutôt que le vrai plugins/ du repo. Lu à l'appel
 * (pas au require du module) pour rester surchageable par les tests.
 */
function pluginsDir() {
  return process.env.PM2_MONITOR_PLUGINS_DIR || DEFAULT_PLUGINS_DIR;
}

/**
 * Énumère les sous-dossiers de plugins/ contenant un index.js.
 * @returns {{ name: string, dir: string, entry: string }[]}
 */
function discoverPluginDirs() {
  const PLUGINS_DIR = pluginsDir();
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(PLUGINS_DIR, entry.name);
      const entryFile = path.join(dir, "index.js");
      return { name: entry.name, dir, entry: entryFile };
    })
    .filter((p) => fs.existsSync(p.entry));
}

/**
 * Charge (require) le module d'un plugin découvert. Isolé volontairement
 * (try/catch) : une erreur de syntaxe/require dans le fichier d'UN plugin
 * ne doit jamais empêcher le chargement des autres ni le démarrage du
 * monitor (voir prompt de phase, section Tests — "isolation des erreurs").
 *
 * @returns {{ ok: true, plugin: object } | { ok: false, error: string }}
 */
function requirePlugin(pluginDir) {
  try {
    delete require.cache[require.resolve(pluginDir.entry)];
    const mod = require(pluginDir.entry);
    return { ok: true, plugin: mod };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { pluginsDir, discoverPluginDirs, requirePlugin };
