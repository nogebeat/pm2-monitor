"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ProviderRegistry } = require("../../lib/services/notifications/registry");
const { NotificationManager } = require("../../lib/services/notifications/manager");
const { NotificationProvider } = require("../../lib/services/notifications/types");
const secretsCrypto = require("../../lib/services/notifications/utils/crypto");

test("ProviderRegistry", async (t) => {
  await t.test("registerProvider() puis getProvider() renvoie le même provider", () => {
    const registry = new ProviderRegistry();
    const provider = new NotificationProvider("dummy", "Dummy");
    registry.registerProvider(provider);
    assert.equal(registry.getProvider("dummy"), provider);
  });

  await t.test("getProvider() sur un type inconnu renvoie null (pas d'exception)", () => {
    const registry = new ProviderRegistry();
    assert.equal(registry.getProvider("does-not-exist"), null);
  });

  await t.test("hasProvider() reflète l'enregistrement", () => {
    const registry = new ProviderRegistry();
    assert.equal(registry.hasProvider("dummy"), false);
    registry.registerProvider(new NotificationProvider("dummy", "Dummy"));
    assert.equal(registry.hasProvider("dummy"), true);
  });

  await t.test("listProviders() renvoie tous les providers enregistrés", () => {
    const registry = new ProviderRegistry();
    registry.registerProvider(new NotificationProvider("a", "A"));
    registry.registerProvider(new NotificationProvider("b", "B"));
    const types = registry.listProviders().map((p) => p.type);
    assert.deepEqual(types.sort(), ["a", "b"]);
  });

  await t.test("registerProvider() refuse un doublon de type", () => {
    const registry = new ProviderRegistry();
    registry.registerProvider(new NotificationProvider("dummy", "Dummy"));
    assert.throws(() => registry.registerProvider(new NotificationProvider("dummy", "Dummy 2")), /déjà enregistré/);
  });

  await t.test("registerProvider() refuse un provider sans type", () => {
    const registry = new ProviderRegistry();
    assert.throws(() => registry.registerProvider({}), /type manquant/);
  });
});

test("providers/index.js — placeholders réels du projet", async (t) => {
  const placeholders = require("../../lib/services/notifications/providers");

  await t.test("les 5 providers attendus sont bien exportés", () => {
    const types = placeholders.map((p) => p.type).sort();
    assert.deepEqual(types, ["discord", "email", "slack", "telegram", "webhook"]);
  });

  await t.test("chaque placeholder valide sa config minimale et rejette une config vide", () => {
    for (const provider of placeholders) {
      const errors = provider.validateConfig({});
      assert.ok(Array.isArray(errors) && errors.length > 0, `${provider.type} doit rejeter {}`);
    }
  });

  await t.test("chaque placeholder lève une erreur explicite sur send() (non implémenté Phase 5A)", async () => {
    for (const provider of placeholders) {
      await assert.rejects(() => provider.send({}, {}), /non implémenté/);
    }
  });
});

test("NotificationManager", async (t) => {
  await t.test("listProviderTypes() délègue au registry, marque tout non implémenté", () => {
    const registry = new ProviderRegistry();
    registry.registerProvider(new NotificationProvider("dummy", "Dummy"));
    const manager = new NotificationManager({ registry });
    assert.deepEqual(manager.listProviderTypes(), [{ type: "dummy", label: "Dummy", implemented: false }]);
  });

  await t.test("validateProviderConfig() renvoie une erreur pour un type inconnu", () => {
    const registry = new ProviderRegistry();
    const manager = new NotificationManager({ registry });
    const errors = manager.validateProviderConfig("does-not-exist", {});
    assert.ok(errors.some((e) => /inconnu/.test(e)));
  });

  await t.test("send() n'est pas implémenté en Phase 5A", async () => {
    const registry = new ProviderRegistry();
    const manager = new NotificationManager({ registry });
    await assert.rejects(() => manager.send(), /non implémenté en Phase 5A/);
  });

  await t.test("constructeur exige un registry", () => {
    assert.throws(() => new NotificationManager({}), /registry requis/);
  });
});

test("utils/crypto — chiffrement des secrets de provider", async (t) => {
  await t.test("encrypt() puis decrypt() redonne la valeur d'origine", () => {
    const secret = { webhookUrl: "https://discord.com/api/webhooks/xxx/yyy" };
    const encrypted = secretsCrypto.encrypt(secret);
    assert.equal(typeof encrypted, "string");
    assert.deepEqual(secretsCrypto.decrypt(encrypted), secret);
  });

  await t.test("la valeur chiffrée ne contient pas le secret en clair", () => {
    const encrypted = secretsCrypto.encrypt({ botToken: "super-secret-token-12345" });
    assert.ok(!encrypted.includes("super-secret-token-12345"));
  });

  await t.test("encrypt(null) et decrypt(null) renvoient null", () => {
    assert.equal(secretsCrypto.encrypt(null), null);
    assert.equal(secretsCrypto.decrypt(null), null);
  });

  await t.test("deux chiffrements de la même valeur donnent des sorties différentes (IV aléatoire)", () => {
    const a = secretsCrypto.encrypt({ x: 1 });
    const b = secretsCrypto.encrypt({ x: 1 });
    assert.notEqual(a, b);
  });

  await t.test("decrypt() sur une valeur corrompue lève une erreur explicite", () => {
    assert.throws(() => secretsCrypto.decrypt("not:a:validpayload"), /Impossible de déchiffrer|invalide/);
  });
});
