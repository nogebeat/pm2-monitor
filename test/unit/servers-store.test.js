"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const store = require("../../lib/services/servers/store");

/**
 * Tests unitaires du registre de serveurs (migration 012_servers, Phase 10
 * — Multi-server / Remote PM2). Même style que test/unit/audit-store.test.js :
 * DB SQLite temporaire par test, migrations appliquées, store appelé
 * directement (pas de HTTP ici — voir test/integration/servers-api.test.js
 * pour l'API REST, et test/integration/agent-hub.test.js pour le socket).
 */

test("servers/store — enregistrement d'un agent", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("create() génère une server_key + un token en clair, statut PENDING", async () => {
    const { server, token } = await store.create({ name: "Agent A", hostname: "a.example.com" });
    assert.ok(server.serverKey.startsWith("srv_"));
    assert.equal(server.status, "PENDING");
    assert.equal(server.kind, "agent");
    assert.equal(server.hasToken, true);
    assert.ok(
      token && token.length > 20,
      "le token en clair doit être renvoyé une seule fois, à la création",
    );
  });

  await t.test("le token en clair n'est plus jamais exposé par list()/getByKey()", async () => {
    const { server } = await store.create({ name: "Agent B" });
    const fetched = await store.getByKey(server.serverKey);
    assert.equal(fetched.hasToken, true);
    assert.equal(fetched.token, undefined);
  });

  await t.test("create() sans nom échoue", async () => {
    await assert.rejects(() => store.create({ name: "" }), /nom/i);
  });

  await t.test("create() avec un environnement invalide échoue", async () => {
    await assert.rejects(
      () => store.create({ name: "Agent C", environment: "n'importe quoi" }),
      /Environnement/i,
    );
  });

  await cleanupDb(dbCtx);
});

test("servers/store — authentification agent (verifyAgentToken)", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("un token valide pour le bon serverKey est accepté", async () => {
    const { server, token } = await store.create({ name: "Agent D" });
    const verified = await store.verifyAgentToken(server.serverKey, token);
    assert.ok(verified);
    assert.equal(verified.serverKey, server.serverKey);
  });

  await t.test("un token incorrect est rejeté", async () => {
    const { server } = await store.create({ name: "Agent E" });
    const verified = await store.verifyAgentToken(server.serverKey, "mauvais-token");
    assert.equal(verified, null);
  });

  await t.test("un serverKey inconnu est rejeté", async () => {
    const verified = await store.verifyAgentToken("srv_inconnu", "peu-importe");
    assert.equal(verified, null);
  });

  await t.test("un serveur désactivé refuse toute authentification, même avec le bon token", async () => {
    const { server, token } = await store.create({ name: "Agent F" });
    await store.setEnabled(server.serverKey, false);
    const verified = await store.verifyAgentToken(server.serverKey, token);
    assert.equal(verified, null);
  });

  await t.test("après régénération, l'ancien token est rejeté et le nouveau accepté", async () => {
    const { server, token: oldToken } = await store.create({ name: "Agent G" });
    const { token: newToken } = await store.regenerateToken(server.serverKey);
    assert.notEqual(oldToken, newToken);
    assert.equal(await store.verifyAgentToken(server.serverKey, oldToken), null);
    assert.ok(await store.verifyAgentToken(server.serverKey, newToken));
  });

  await cleanupDb(dbCtx);
});

test("servers/store — heartbeat / statut / détection offline", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("touchStatus(ONLINE) met à jour last_seen_at et le snapshot", async () => {
    const { server } = await store.create({ name: "Agent H" });
    await store.touchStatus(server.serverKey, {
      status: "ONLINE",
      agentVersion: "1.2.3",
      protocolVersion: "1.0",
      snapshot: { cpu: 12 },
    });
    const updated = await store.getByKey(server.serverKey);
    assert.equal(updated.status, "ONLINE");
    assert.equal(updated.agentVersion, "1.2.3");
    assert.ok(updated.lastSeen);
    assert.deepEqual(updated.snapshot, { cpu: 12 });
  });

  await t.test("markStaleOffline() bascule OFFLINE un agent dont le heartbeat a expiré", async () => {
    const { server } = await store.create({ name: "Agent I" });
    await store.touchStatus(server.serverKey, { status: "ONLINE" });

    // Simule un heartbeat vieux de 1h en réécrivant last_seen_at directement.
    const db = require("../../lib/db");
    await db.run("UPDATE servers SET last_seen_at = ? WHERE server_key = ?", [
      Date.now() - 3600000,
      server.serverKey,
    ]);

    const staleKeys = await store.markStaleOffline(10000); // timeout de 10s
    assert.ok(staleKeys.includes(server.serverKey));

    const updated = await store.getByKey(server.serverKey);
    assert.equal(updated.status, "OFFLINE");
  });

  await t.test("markStaleOffline() ne touche pas un agent avec un heartbeat récent", async () => {
    const { server } = await store.create({ name: "Agent J" });
    await store.touchStatus(server.serverKey, { status: "ONLINE" });

    const staleKeys = await store.markStaleOffline(60000); // timeout large
    assert.ok(!staleKeys.includes(server.serverKey));

    const updated = await store.getByKey(server.serverKey);
    assert.equal(updated.status, "ONLINE");
  });

  await t.test("markStaleOffline() ne touche jamais le serveur local (kind='local')", async () => {
    await store.ensureLocalServer();
    const db = require("../../lib/db");
    await db.run("UPDATE servers SET last_seen_at = ? WHERE server_key = 'local'", [Date.now() - 3600000]);

    await store.markStaleOffline(1000);
    const local = await store.getByKey("local");
    assert.equal(local.status, "ONLINE");
  });

  await cleanupDb(dbCtx);
});

test("servers/store — serveur local (ensureLocalServer)", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("crée automatiquement le serveur local, sans configuration", async () => {
    const local = await store.ensureLocalServer();
    assert.equal(local.serverKey, "local");
    assert.equal(local.kind, "local");
    assert.equal(local.status, "ONLINE");
    assert.equal(local.hasToken, false);
  });

  await t.test("est idempotent : un second appel ne recrée pas la ligne", async () => {
    const first = await store.ensureLocalServer();
    const second = await store.ensureLocalServer();
    assert.equal(first.id, second.id);
    const all = await store.list();
    assert.equal(all.filter((s) => s.kind === "local").length, 1);
  });

  await t.test("le serveur local ne peut pas être désactivé", async () => {
    await store.ensureLocalServer();
    await assert.rejects(() => store.setEnabled("local", false), /local ne peut pas être désactivé/i);
  });

  await t.test("le serveur local ne peut pas être supprimé", async () => {
    await store.ensureLocalServer();
    await assert.rejects(() => store.remove("local"), /local ne peut pas être supprimé/i);
  });

  await cleanupDb(dbCtx);
});

test("servers/store — serveurs en double / unicité", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test(
    "deux serveurs peuvent partager le même nom (server_key reste l'identité unique)",
    async () => {
      const a = await store.create({ name: "Prod" });
      const b = await store.create({ name: "Prod" });
      assert.notEqual(a.server.serverKey, b.server.serverKey);
      const all = await store.list();
      assert.equal(all.filter((s) => s.name === "Prod").length, 2);
    },
  );

  await t.test("server_key généré n'entre jamais en collision sur un grand nombre de créations", async () => {
    const keys = new Set();
    for (let i = 0; i < 25; i++) {
      const { server } = await store.create({ name: `Bulk ${i}` });
      keys.add(server.serverKey);
    }
    assert.equal(keys.size, 25);
  });

  await cleanupDb(dbCtx);
});

test("servers/store — CRUD standard (update/enable/disable/remove)", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("update() modifie nom/hostname/environment", async () => {
    const { server } = await store.create({ name: "Avant" });
    const updated = await store.update(server.serverKey, { name: "Après", environment: "staging" });
    assert.equal(updated.name, "Après");
    assert.equal(updated.environment, "staging");
  });

  await t.test("update() sur un serverKey inconnu renvoie null", async () => {
    assert.equal(await store.update("srv_inconnu", { name: "x" }), null);
  });

  await t.test("setEnabled(false) puis setEnabled(true)", async () => {
    const { server } = await store.create({ name: "Togglable" });
    const disabled = await store.setEnabled(server.serverKey, false);
    assert.equal(disabled.enabled, false);
    const enabled = await store.setEnabled(server.serverKey, true);
    assert.equal(enabled.enabled, true);
  });

  await t.test("remove() supprime le serveur et son scoping utilisateur associé", async () => {
    const userScope = require("../../lib/services/servers/user-scope");
    const { server } = await store.create({ name: "À supprimer" });

    // Injecte un user minimal pour tester la cascade de scoping.
    const db = require("../../lib/db");
    await db.run("INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)", [
      "scopetest",
      "hash",
      0,
      Date.now(),
    ]);
    const userRow = await db.get("SELECT id FROM users WHERE username = 'scopetest'", []);
    await userScope.replaceAllowedServers(userRow.id, [server.serverKey]);

    assert.ok(await store.remove(server.serverKey));
    assert.equal(await store.getByKey(server.serverKey), null);
    assert.deepEqual(await userScope.listAllowedServerKeys(userRow.id), []);
  });

  await t.test("remove() sur un serverKey inconnu renvoie false", async () => {
    assert.equal(await store.remove("srv_inconnu"), false);
  });

  await cleanupDb(dbCtx);
});
