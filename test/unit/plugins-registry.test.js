"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePluginShape } = require("../../lib/services/plugins/validate");
const { PluginRegistry } = require("../../lib/services/plugins/registry");
const { PLUGIN_API_VERSION, isCompatible } = require("../../lib/services/plugins/api-version");

function validPlugin(overrides = {}) {
  return {
    name: "my-plugin",
    version: "1.0.0",
    pluginApiVersion: "1.0.0",
    description: "Un plugin de test.",
    init: async () => {},
    ...overrides,
  };
}

test("plugins/validate — validatePluginShape()", async (t) => {
  await t.test("plugin valide -> aucune erreur", () => {
    assert.deepEqual(validatePluginShape(validPlugin()), []);
  });

  await t.test("plugin valide sans description/onDisable (optionnels) -> aucune erreur", () => {
    const p = validPlugin();
    delete p.description;
    assert.deepEqual(validatePluginShape(p), []);
  });

  await t.test("name manquant ou invalide", () => {
    assert.ok(validatePluginShape(validPlugin({ name: undefined })).length);
    assert.ok(validatePluginShape(validPlugin({ name: "Invalid Name!" })).length);
    assert.ok(validatePluginShape(validPlugin({ name: "a" })).length); // trop court
  });

  await t.test("version manquante", () => {
    assert.ok(validatePluginShape(validPlugin({ version: undefined })).length);
    assert.ok(validatePluginShape(validPlugin({ version: "" })).length);
  });

  await t.test("pluginApiVersion manquante", () => {
    assert.ok(validatePluginShape(validPlugin({ pluginApiVersion: undefined })).length);
  });

  await t.test("init manquant ou pas une fonction", () => {
    assert.ok(validatePluginShape(validPlugin({ init: undefined })).length);
    assert.ok(validatePluginShape(validPlugin({ init: "not a function" })).length);
  });

  await t.test("onDisable fourni mais pas une fonction -> erreur", () => {
    assert.ok(validatePluginShape(validPlugin({ onDisable: "nope" })).length);
  });

  await t.test("plugin non-objet -> erreur unique", () => {
    assert.equal(validatePluginShape(null).length, 1);
    assert.equal(validatePluginShape("string").length, 1);
  });

  await t.test("plusieurs erreurs cumulées", () => {
    const errors = validatePluginShape({});
    assert.ok(errors.length >= 3); // name, version, pluginApiVersion, init
  });
});

test("plugins/api-version — isCompatible()", async (t) => {
  await t.test("même MAJOR -> compatible", () => {
    assert.equal(isCompatible("1.0.0"), true);
    assert.equal(isCompatible("1.9.3"), true);
  });

  await t.test("MAJOR différent -> incompatible", () => {
    assert.equal(isCompatible("2.0.0"), false);
    assert.equal(isCompatible("0.9.0"), false);
  });

  await t.test("version invalide/absente -> incompatible", () => {
    assert.equal(isCompatible(""), false);
    assert.equal(isCompatible(undefined), false);
    assert.equal(isCompatible("abc"), false);
  });

  await t.test("PLUGIN_API_VERSION est bien défini", () => {
    assert.match(PLUGIN_API_VERSION, /^\d+\.\d+\.\d+$/);
  });
});

test("plugins/registry — PluginRegistry", async (t) => {
  await t.test("register() puis get()/has()/list()", () => {
    const registry = new PluginRegistry();
    const plugin = validPlugin();
    registry.register(plugin);

    assert.equal(registry.has("my-plugin"), true);
    assert.equal(registry.get("my-plugin"), plugin);
    assert.deepEqual(registry.list(), [plugin]);
    assert.equal(registry.get("unknown"), null);
    assert.equal(registry.has("unknown"), false);
  });

  await t.test("register() refuse un plugin structurellement invalide", () => {
    const registry = new PluginRegistry();
    assert.throws(() => registry.register({ name: "bad" }), /Plugin invalide/);
  });

  await t.test("register() refuse un nom déjà pris", () => {
    const registry = new PluginRegistry();
    registry.register(validPlugin());
    assert.throws(() => registry.register(validPlugin({ description: "autre instance" })), /déjà enregistré/);
  });

  await t.test("unregister() puis clear()", () => {
    const registry = new PluginRegistry();
    registry.register(validPlugin());
    assert.equal(registry.unregister("my-plugin"), true);
    assert.equal(registry.has("my-plugin"), false);
    assert.equal(registry.unregister("my-plugin"), false);

    registry.register(validPlugin({ name: "another" }));
    registry.clear();
    assert.deepEqual(registry.list(), []);
  });
});
