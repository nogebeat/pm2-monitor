"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const store = require("../../lib/services/api-keys/store");

/**
 * Tests unitaires du store de clés API (migration 020_rbac_api_keys.js,
 * Phase 18 — Advanced RBAC & API Keys). Même style que
 * test/unit/servers-store.test.js : DB SQLite temporaire par test,
 * migrations appliquées, store appelé directement (pas de HTTP ici — voir
 * test/integration/api-keys-api.test.js pour l'API REST et
 * test/integration/api-keys-security.test.js pour les scénarios de
 * sécurité demandés par le prompt de phase).
 */

test("api-keys/store — création, vérification, révocation", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("create() génère un secret en clair (une seule fois) + un préfixe pmk_", async () => {
    const { apiKey, secret } = await store.create({ name: "CI runner", scopes: ["metrics:read"] });
    assert.ok(secret.startsWith("pmk_"));
    assert.ok(apiKey.keyPrefix.startsWith("pmk_"));
    assert.equal(apiKey.name, "CI runner");
    assert.deepEqual(apiKey.scopes, ["metrics:read"]);
    assert.equal(apiKey.revokedAt, null);
    assert.equal(apiKey.lastUsedAt, null);
  });

  await t.test("le secret en clair n'est jamais réexposé par list()/getById()", async () => {
    const { apiKey } = await store.create({ name: "Sans secret exposé", scopes: ["logs:read"] });
    const fetched = await store.getById(apiKey.id);
    assert.equal(fetched.secret, undefined);
    assert.equal(fetched.hash, undefined);
    assert.equal(fetched.keyHash, undefined);
    const listed = await store.list();
    for (const k of listed) {
      assert.equal(k.secret, undefined);
      assert.equal(k.hash, undefined);
      assert.equal(k.keyHash, undefined);
    }
  });

  await t.test("create() sans scope échoue", async () => {
    await assert.rejects(() => store.create({ name: "Vide", scopes: [] }));
  });

  await t.test("create() sans nom échoue", async () => {
    await assert.rejects(() => store.create({ name: "", scopes: ["metrics:read"] }));
  });

  await t.test("verify() : clé valide -> objet clé, sans hash", async () => {
    const { secret } = await store.create({ name: "Valide", scopes: ["processes:read"] });
    const result = await store.verify(secret);
    assert.ok(result);
    assert.equal(result.name, "Valide");
    assert.equal(result.hash, undefined);
  });

  await t.test("verify() : clé invalide (inconnue) -> null", async () => {
    assert.equal(await store.verify("pmk_ceci_nexiste_pas"), null);
  });

  await t.test("verify() : entrée malformée / vide -> null (jamais d'exception)", async () => {
    assert.equal(await store.verify(""), null);
    assert.equal(await store.verify(null), null);
    assert.equal(await store.verify("not-a-key-at-all"), null);
  });

  await t.test("verify() : clé expirée -> null", async () => {
    const { secret } = await store.create({
      name: "Expirée",
      scopes: ["metrics:read"],
      expiresAt: Date.now() - 1000,
    });
    assert.equal(await store.verify(secret), null);
  });

  await t.test("verify() : clé révoquée -> null", async () => {
    const { apiKey, secret } = await store.create({ name: "À révoquer", scopes: ["metrics:read"] });
    assert.ok(await store.verify(secret)); // valide avant révocation
    const revoked = await store.revoke(apiKey.id);
    assert.ok(revoked.revokedAt > 0);
    assert.equal(await store.verify(secret), null);
  });

  await t.test("verify() met à jour last_used_at", async () => {
    const { apiKey, secret } = await store.create({ name: "Utilisée", scopes: ["metrics:read"] });
    assert.equal(apiKey.lastUsedAt, null);
    await store.verify(secret);
    // last_used_at est mis à jour en arrière-plan (voir store.js#verify) —
    // on relit après un court délai pour laisser la promesse se résoudre.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fetched = await store.getById(apiKey.id);
    assert.ok(fetched.lastUsedAt > 0);
  });

  await t.test("update() : modifie les scopes sans jamais toucher au secret", async () => {
    const { apiKey, secret } = await store.create({ name: "À modifier", scopes: ["metrics:read"] });
    const updated = await store.update(apiKey.id, { scopes: ["metrics:read", "logs:read"] });
    assert.deepEqual(updated.scopes, ["metrics:read", "logs:read"]);
    // le secret original doit continuer à fonctionner (update() ne le régénère jamais)
    const result = await store.verify(secret);
    assert.ok(result);
  });

  await t.test("update() : scopes vide échoue", async () => {
    const { apiKey } = await store.create({ name: "X", scopes: ["metrics:read"] });
    await assert.rejects(() => store.update(apiKey.id, { scopes: [] }));
  });

  await t.test("revoke() est idempotent", async () => {
    const { apiKey } = await store.create({ name: "Double révocation", scopes: ["metrics:read"] });
    const first = await store.revoke(apiKey.id);
    const second = await store.revoke(apiKey.id);
    assert.equal(first.revokedAt, second.revokedAt);
  });

  await cleanupDb(dbCtx);
});
