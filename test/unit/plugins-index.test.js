"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Tests de lib/services/plugins/index.js#loadAll() (Phase 21). Pointe
 * PM2_MONITOR_PLUGINS_DIR vers un dossier temporaire rempli de plugins
 * fabriqués pour l'occasion (valide, invalide, incompatible, dont init()
 * plante) — jamais le vrai dossier plugins/ du repo, pour rester isolé et
 * déterministe. require.cache est vidé à chaque test (fichiers recréés à
 * chaque fois avec le même chemin, Node ne re-lirait pas le disque sinon).
 */

function writePlugin(dir, name, content) {
  const pluginDir = path.join(dir, name);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.js"), content, "utf8");
}

function freshPluginsService() {
  delete require.cache[require.resolve("../../lib/services/plugins")];
  delete require.cache[require.resolve("../../lib/services/plugins/loader")];
  delete require.cache[require.resolve("../../lib/services/plugins/registry")];
  delete require.cache[require.resolve("../../lib/services/plugins/store")];
  delete require.cache[require.resolve("../../lib/services/plugins/context")];
  return require("../../lib/services/plugins");
}

test("plugins/index — loadAll() / enable() / disable()", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-plugins-"));
  process.env.PM2_MONITOR_PLUGINS_DIR = tmpDir;

  await t.test("plugin valide et activé par défaut -> status active", async () => {
    writePlugin(
      tmpDir,
      "good-plugin",
      `module.exports = {
        name: "good-plugin",
        version: "1.0.0",
        pluginApiVersion: "1.0.0",
        init: async (ctx) => { ctx.logger.info("loaded"); },
      };`,
    );
    const plugins = freshPluginsService();
    const list = await plugins.loadAll();
    const entry = list.find((p) => p.name === "good-plugin");
    assert.ok(entry);
    assert.equal(entry.status, "active");
    assert.equal(entry.enabled, true);
    assert.equal(entry.compatible, true);
    assert.equal(entry.error, null);
  });

  await t.test(
    "plugin dont le fichier est syntaxiquement invalide -> status invalid, ne bloque pas les autres",
    async () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      writePlugin(tmpDir, "broken-syntax", `this is not valid javascript {{{`);
      writePlugin(
        tmpDir,
        "sibling-ok",
        `module.exports = {
        name: "sibling-ok",
        version: "1.0.0",
        pluginApiVersion: "1.0.0",
        init: async () => {},
      };`,
      );
      const plugins = freshPluginsService();
      const list = await plugins.loadAll();

      const broken = list.find((p) => p.name === "broken-syntax");
      assert.ok(broken);
      assert.equal(broken.status, "invalid");
      assert.ok(broken.error);

      const sibling = list.find((p) => p.name === "sibling-ok");
      assert.equal(sibling.status, "active");
    },
  );

  await t.test("plugin structurellement invalide (contrat incomplet) -> status invalid", async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    writePlugin(tmpDir, "incomplete", `module.exports = { name: "incomplete" };`);
    const plugins = freshPluginsService();
    const list = await plugins.loadAll();
    const entry = list.find((p) => p.name === "incomplete");
    assert.equal(entry.status, "invalid");
    assert.match(entry.error, /version requis|pluginApiVersion requis|init/);
  });

  await t.test("plugin.name différent du nom du dossier -> status invalid", async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    writePlugin(
      tmpDir,
      "folder-name",
      `module.exports = {
        name: "different-name",
        version: "1.0.0",
        pluginApiVersion: "1.0.0",
        init: async () => {},
      };`,
    );
    const plugins = freshPluginsService();
    const list = await plugins.loadAll();
    const entry = list.find((p) => p.name === "folder-name");
    assert.equal(entry.status, "invalid");
    assert.match(entry.error, /doit correspondre au nom du dossier/);
  });

  await t.test("plugin incompatible (MAJOR différent) -> status incompatible, jamais activé", async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    writePlugin(
      tmpDir,
      "future-plugin",
      `module.exports = {
        name: "future-plugin",
        version: "1.0.0",
        pluginApiVersion: "99.0.0",
        init: async () => { global.__initCalled = true; },
      };`,
    );
    const plugins = freshPluginsService();
    const list = await plugins.loadAll();
    const entry = list.find((p) => p.name === "future-plugin");
    assert.equal(entry.status, "incompatible");
    assert.equal(entry.compatible, false);
    assert.equal(global.__initCalled, undefined); // init() jamais appelé
  });

  await t.test("init() qui plante -> status error, isolé (ne fait pas tomber loadAll)", async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    writePlugin(
      tmpDir,
      "crashy",
      `module.exports = {
        name: "crashy",
        version: "1.0.0",
        pluginApiVersion: "1.0.0",
        init: async () => { throw new Error("boom"); },
      };`,
    );
    writePlugin(
      tmpDir,
      "sibling-fine",
      `module.exports = {
        name: "sibling-fine",
        version: "1.0.0",
        pluginApiVersion: "1.0.0",
        init: async () => {},
      };`,
    );
    const plugins = freshPluginsService();
    const list = await plugins.loadAll();

    const crashy = list.find((p) => p.name === "crashy");
    assert.equal(crashy.status, "error");
    assert.match(crashy.error, /boom/);

    const sibling = list.find((p) => p.name === "sibling-fine");
    assert.equal(sibling.status, "active");
  });

  await t.test("enable()/disable() appellent init()/onDisable() et persistent l'état", async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    writePlugin(
      tmpDir,
      "toggle-me",
      `let initCount = 0, disableCount = 0;
      module.exports = {
        name: "toggle-me",
        version: "1.0.0",
        pluginApiVersion: "1.0.0",
        init: async () => { initCount++; global.__toggleInitCount = initCount; },
        onDisable: async () => { disableCount++; global.__toggleDisableCount = disableCount; },
      };`,
    );
    const plugins = freshPluginsService();
    await plugins.loadAll(); // activé par défaut -> init() déjà appelé une fois
    assert.equal(global.__toggleInitCount, 1);

    const disabled = await plugins.disable("toggle-me");
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.status, "disabled");
    assert.equal(global.__toggleDisableCount, 1);

    const enabled = await plugins.enable("toggle-me");
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.status, "active");
    assert.equal(global.__toggleInitCount, 2);
  });

  await t.test("enable() sur un plugin incompatible échoue explicitement", async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    writePlugin(
      tmpDir,
      "incompatible-toggle",
      `module.exports = {
        name: "incompatible-toggle",
        version: "1.0.0",
        pluginApiVersion: "2.0.0",
        init: async () => {},
      };`,
    );
    const plugins = freshPluginsService();
    await plugins.loadAll();
    await assert.rejects(() => plugins.enable("incompatible-toggle"), /incompatible/);
  });

  await t.test("enable()/disable()/updateConfig() sur un plugin inconnu échoue explicitement", async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const plugins = freshPluginsService();
    await plugins.loadAll();
    await assert.rejects(() => plugins.enable("ghost"), /introuvable/);
    await assert.rejects(() => plugins.disable("ghost"), /introuvable/);
    await assert.rejects(() => plugins.updateConfig("ghost", {}), /introuvable/);
  });

  await t.test("updateConfig() persiste et est reflété dans list()", async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    writePlugin(
      tmpDir,
      "configurable",
      `module.exports = {
        name: "configurable",
        version: "1.0.0",
        pluginApiVersion: "1.0.0",
        init: async () => {},
      };`,
    );
    const plugins = freshPluginsService();
    await plugins.loadAll();
    const updated = await plugins.updateConfig("configurable", { threshold: 42 });
    assert.deepEqual(updated.config, { threshold: 42 });
    const entry = plugins.getEntry("configurable");
    assert.deepEqual(entry.config, { threshold: 42 });
  });

  t.after(async () => {
    delete process.env.PM2_MONITOR_PLUGINS_DIR;
    delete global.__initCalled;
    delete global.__toggleInitCount;
    delete global.__toggleDisableCount;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await cleanupDb(dbCtx);
  });
});
