"use strict";

/**
 * Point d'entrée haut niveau du Plugin System (Phase 21). Orchestre :
 *   - loader.js   : découverte/`require()` des plugins sur disque (plugins/)
 *   - registry.js : validation de forme + registre en mémoire
 *   - store.js    : état persisté (activé/désactivé, config)
 *   - context.js  : API restreinte passée à init()/onDisable()
 *
 * lib/routes/plugins.js et server.js ne connaissent que CE module — jamais
 * loader/registry/store/context directement (même découplage que
 * lib/services/notifications/manager.js vis-à-vis de registry.js).
 *
 * `loadAll()` est appelé une seule fois au démarrage (voir server.js, après
 * les migrations). Ajouter un nouveau dossier sous plugins/ nécessite un
 * redémarrage du process — volontaire : ré-exécuter `init()` d'un plugin
 * déjà actif sans redémarrage risquerait un double-enregistrement de ses
 * propres ressources (timers, listeners...) côté plugin, hors du contrôle
 * de PM2 Monitor. `enable()`/`disable()` restent possibles à chaud, eux,
 * car ils n'appellent init()/onDisable() qu'une seule fois chacun.
 *
 * ISOLATION DES ERREURS (voir prompt de phase) : aucune fonction de ce
 * module ne laisse jamais une exception d'un plugin remonter jusqu'à
 * server.js — un plugin qui plante à l'init reste simplement visible avec
 * status "error", le reste du monitor continue de tourner normalement.
 */

const loaderMod = require("./loader");
const { PluginRegistry } = require("./registry");
const store = require("./store");
const { buildPluginContext } = require("./context");
const { PLUGIN_API_VERSION, isCompatible } = require("./api-version");

const registry = new PluginRegistry();
/** @type {Map<string, object>} nom du plugin (= nom du dossier) -> entrée enrichie pour l'UI/API */
const entries = new Map();

function baseEntry(name, { status, error }) {
  return {
    name,
    version: null,
    pluginApiVersion: null,
    description: "",
    hasOnDisable: false,
    compatible: false,
    status,
    error,
    enabled: false,
    config: {},
    installedAt: null,
    updatedAt: null,
  };
}

async function activate(plugin) {
  try {
    await plugin.init(buildPluginContext(plugin));
    return { status: "active", error: null };
  } catch (e) {
    return { status: "error", error: e.message };
  }
}

/** Ne remonte jamais : une erreur dans onDisable() d'un plugin est loggée, pas propagée. */
async function deactivate(plugin) {
  if (typeof plugin.onDisable !== "function") return;
  try {
    await plugin.onDisable(buildPluginContext(plugin));
  } catch (e) {
    console.error(`[plugin:${plugin.name}] Erreur dans onDisable() (ignorée) :`, e.message);
  }
}

/**
 * Scanne plugins/, enregistre chaque plugin valide, initialise ceux activés.
 * Idempotent au sens "peut être rappelé" (ex: tests) : repart d'un registre
 * vide à chaque appel. Ne throw jamais — chaque erreur individuelle finit
 * dans l'entrée correspondante (status "invalid"/"incompatible"/"error").
 */
async function loadAll() {
  registry.clear();
  entries.clear();

  const dirs = loaderMod.discoverPluginDirs();

  for (const dir of dirs) {
    const required = loaderMod.requirePlugin(dir);
    if (!required.ok) {
      entries.set(dir.name, baseEntry(dir.name, { status: "invalid", error: required.error }));
      continue;
    }
    const plugin = required.plugin;

    if (plugin && plugin.name && plugin.name !== dir.name) {
      entries.set(
        dir.name,
        baseEntry(dir.name, {
          status: "invalid",
          error: `plugin.name ("${plugin.name}") doit correspondre au nom du dossier ("${dir.name}").`,
        }),
      );
      continue;
    }

    try {
      registry.register(plugin);
    } catch (e) {
      entries.set(dir.name, baseEntry(dir.name, { status: "invalid", error: e.message }));
      continue;
    }

    const compatible = isCompatible(plugin.pluginApiVersion);
    await store.ensureRow(plugin.name, { defaultEnabled: true });
    const record = await store.getByName(plugin.name);

    let status = "disabled";
    let error = null;
    if (!compatible) {
      status = "incompatible";
      error = `pluginApiVersion "${plugin.pluginApiVersion}" incompatible avec l'API courante ("${PLUGIN_API_VERSION}").`;
    } else if (record.enabled) {
      const result = await activate(plugin);
      status = result.status;
      error = result.error;
    }

    entries.set(plugin.name, {
      name: plugin.name,
      version: plugin.version,
      pluginApiVersion: plugin.pluginApiVersion,
      description: plugin.description || "",
      hasOnDisable: typeof plugin.onDisable === "function",
      compatible,
      status,
      error,
      enabled: record.enabled,
      config: record.config,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
    });
  }

  return list();
}

function list() {
  return Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function getEntry(name) {
  return entries.get(name) || null;
}

async function enable(name) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`Plugin "${name}" introuvable.`);
  if (!entry.compatible) {
    throw new Error(`Plugin "${name}" incompatible avec l'API courante — activation impossible.`);
  }
  if (entry.status === "active") return entry; // déjà actif, no-op

  const plugin = registry.get(name);
  const result = await activate(plugin);
  const record = await store.setEnabled(name, true);

  entry.enabled = true;
  entry.status = result.status;
  entry.error = result.error;
  entry.updatedAt = record.updatedAt;
  return entry;
}

async function disable(name) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`Plugin "${name}" introuvable.`);

  const plugin = registry.get(name);
  if (plugin && entry.status === "active") {
    await deactivate(plugin);
  }
  const record = await store.setEnabled(name, false);

  entry.enabled = false;
  entry.status = "disabled";
  entry.error = null;
  entry.updatedAt = record.updatedAt;
  return entry;
}

async function updateConfig(name, config) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`Plugin "${name}" introuvable.`);
  const record = await store.setConfig(name, config);
  entry.config = record.config;
  entry.updatedAt = record.updatedAt;
  return entry;
}

module.exports = {
  loadAll,
  list,
  getEntry,
  enable,
  disable,
  updateConfig,
  PLUGIN_API_VERSION,
  // Exposés pour les tests uniquement (voir test/unit/plugins-*.test.js) :
  // jamais utilisés par lib/routes/plugins.js ni server.js.
  _registry: registry,
};
