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

test("providers/index.js — providers réels du projet (Phase 5B)", async (t) => {
  const providers = require("../../lib/services/notifications/providers");

  await t.test("les 5 providers attendus sont bien exportés", () => {
    const types = providers.map((p) => p.type).sort();
    assert.deepEqual(types, ["discord", "email", "slack", "telegram", "webhook"]);
  });

  await t.test("chaque provider valide sa config minimale et rejette une config vide", () => {
    for (const provider of providers) {
      const errors = provider.validateConfig({});
      assert.ok(Array.isArray(errors) && errors.length > 0, `${provider.type} doit rejeter {}`);
    }
  });

  await t.test("chaque provider rejette send() avec une config invalide, sans exception (résultat normalisé)", async () => {
    for (const provider of providers) {
      const result = await provider.send({}, {});
      assert.equal(result.success, false, `${provider.type} doit échouer proprement`);
      assert.equal(result.errorCode, "INVALID_CONFIG");
      assert.equal(typeof result.safeMessage, "string");
    }
  });

  await t.test("chaque provider implémente réellement validateConfig()/test()/send() (voir Phase 5B — providers spécifiques testés dans notifications-providers.test.js)", () => {
    for (const provider of providers) {
      assert.equal(typeof provider.validateConfig, "function");
      assert.equal(typeof provider.test, "function");
      assert.equal(typeof provider.send, "function");
    }
  });
});

test("NotificationManager", async (t) => {
  await t.test("listProviderTypes() délègue au registry (Phase 5B : implemented: true)", () => {
    const registry = new ProviderRegistry();
    registry.registerProvider(new NotificationProvider("dummy", "Dummy"));
    const manager = new NotificationManager({ registry });
    assert.deepEqual(manager.listProviderTypes(), [{ type: "dummy", label: "Dummy", implemented: true }]);
  });

  await t.test("validateProviderConfig() renvoie une erreur pour un type inconnu", () => {
    const registry = new ProviderRegistry();
    const manager = new NotificationManager({ registry });
    const errors = manager.validateProviderConfig("does-not-exist", {});
    assert.ok(errors.some((e) => /inconnu/.test(e)));
  });

  await t.test("send() (orchestration multi-provider) reste hors scope de la Phase 5B", async () => {
    const registry = new ProviderRegistry();
    const manager = new NotificationManager({ registry });
    await assert.rejects(() => manager.send(), /Phase 5B/);
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
