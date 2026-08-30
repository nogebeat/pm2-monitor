"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const store = require("../../lib/services/plugins/store");

/**
 * Tests unitaires du store de persistance des plugins (migration 022,
 * Phase 21). Même style que test/unit/service-dependencies-store.test.js :
 * DB SQLite temporaire par test, migrations appliquées, store appelé
 * directement.
 */

test("plugins/store — persistance activé/désactivé + config", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("ensureRow() crée la ligne à la première découverte", async () => {
    const record = await store.ensureRow("hello-world", { defaultEnabled: true });
    assert.equal(record.name, "hello-world");
    assert.equal(record.enabled, true);
    assert.deepEqual(record.config, {});
    assert.ok(record.installedAt);
    assert.ok(record.updatedAt);
  });

  await t.test("ensureRow() est idempotent — n'écrase jamais un état déjà choisi", async () => {
    await store.ensureRow("idempotent-plugin", { defaultEnabled: true });
    await store.setEnabled("idempotent-plugin", false);
    await store.setConfig("idempotent-plugin", { keep: true });

    const record = await store.ensureRow("idempotent-plugin", { defaultEnabled: true });
    assert.equal(record.enabled, false);
    assert.deepEqual(record.config, { keep: true });
  });

  await t.test("ensureRow() respecte defaultEnabled: false", async () => {
    const record = await store.ensureRow("disabled-by-default", { defaultEnabled: false });
    assert.equal(record.enabled, false);
  });

  await t.test("getByName() sur un plugin inconnu -> null", async () => {
    assert.equal(await store.getByName("does-not-exist"), null);
  });

  await t.test("setEnabled() active/désactive et persiste", async () => {
    await store.ensureRow("toggle-plugin", { defaultEnabled: false });
    let record = await store.setEnabled("toggle-plugin", true);
    assert.equal(record.enabled, true);

    record = await store.setEnabled("toggle-plugin", false);
    assert.equal(record.enabled, false);
  });

  await t.test("setEnabled() sur un plugin inconnu -> null", async () => {
    assert.equal(await store.setEnabled("does-not-exist", true), null);
  });

  await t.test("setConfig() remplace intégralement la config", async () => {
    await store.ensureRow("config-plugin", { defaultEnabled: true });
    await store.setConfig("config-plugin", { a: 1, b: "two" });
    let record = await store.getByName("config-plugin");
    assert.deepEqual(record.config, { a: 1, b: "two" });

    await store.setConfig("config-plugin", { c: 3 }); // remplace, ne fusionne pas
    record = await store.getByName("config-plugin");
    assert.deepEqual(record.config, { c: 3 });
  });

  await t.test("setConfig() rejette une config non-objet", async () => {
    await store.ensureRow("bad-config-plugin", { defaultEnabled: true });
    await assert.rejects(() => store.setConfig("bad-config-plugin", "not an object"), /doit être un objet/);
  });

  await t.test("list() retourne tous les plugins triés par nom", async () => {
    await store.ensureRow("zzz-plugin", { defaultEnabled: true });
    await store.ensureRow("aaa-plugin", { defaultEnabled: true });
    const names = (await store.list()).map((r) => r.name);
    const sorted = [...names].sort();
    assert.deepEqual(names, sorted);
    assert.ok(names.includes("zzz-plugin"));
    assert.ok(names.includes("aaa-plugin"));
  });

  await t.test("remove() supprime la ligne", async () => {
    await store.ensureRow("removable-plugin", { defaultEnabled: true });
    assert.equal(await store.remove("removable-plugin"), true);
    assert.equal(await store.getByName("removable-plugin"), null);
    assert.equal(await store.remove("removable-plugin"), false);
  });

  t.after(async () => {
    await cleanupDb(dbCtx);
  });
});
