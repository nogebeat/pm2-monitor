"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { hasServerAccess, visibleServers } = require("../../lib/permissions");

/**
 * Tests unitaires du scoping "utilisateur -> serveurs autorisés" (Phase 10
 * — Multi-server / Remote PM2). Volontairement séparé de tout accès DB :
 * hasServerAccess()/visibleServers() ne font que lire user.allowedServerKeys
 * (déjà chargé par lib/user-store.js) — voir test/unit/servers-store.test.js
 * pour le store en base, et test/integration/servers-api.test.js pour le
 * comportement bout-en-bout à travers l'API.
 */

const SERVERS = [
  { serverKey: "local", name: "Local" },
  { serverKey: "srv_a", name: "A" },
  { serverKey: "srv_b", name: "B" },
];

test("hasServerAccess()", async (t) => {
  await t.test("un admin a accès à n'importe quel serveur", () => {
    assert.equal(hasServerAccess({ isAdmin: true }, "srv_a"), true);
    assert.equal(hasServerAccess({ isAdmin: true }, "srv_inconnu"), true);
  });

  await t.test("sans restriction explicite (liste vide/absente) : accès à tout", () => {
    assert.equal(hasServerAccess({ isAdmin: false, allowedServerKeys: [] }, "srv_a"), true);
    assert.equal(hasServerAccess({ isAdmin: false }, "srv_a"), true);
  });

  await t.test("avec une restriction explicite : accès uniquement aux serveurs listés", () => {
    const user = { isAdmin: false, allowedServerKeys: ["srv_a"] };
    assert.equal(hasServerAccess(user, "srv_a"), true);
    assert.equal(hasServerAccess(user, "srv_b"), false);
    assert.equal(hasServerAccess(user, "local"), false);
  });

  await t.test("aucun utilisateur : accès refusé", () => {
    assert.equal(hasServerAccess(null, "srv_a"), false);
  });
});

test("visibleServers()", async (t) => {
  await t.test("un admin voit tous les serveurs", () => {
    const visible = visibleServers({ isAdmin: true }, SERVERS);
    assert.deepEqual(
      visible.map((s) => s.serverKey),
      ["local", "srv_a", "srv_b"],
    );
  });

  await t.test("un utilisateur restreint ne voit que son sous-ensemble", () => {
    const user = { isAdmin: false, allowedServerKeys: ["srv_b"] };
    const visible = visibleServers(user, SERVERS);
    assert.deepEqual(
      visible.map((s) => s.serverKey),
      ["srv_b"],
    );
  });

  await t.test("un utilisateur sans restriction voit tout, comme un admin", () => {
    const user = { isAdmin: false, allowedServerKeys: [] };
    const visible = visibleServers(user, SERVERS);
    assert.equal(visible.length, 3);
  });

  await t.test("aucun utilisateur : liste vide", () => {
    assert.deepEqual(visibleServers(null, SERVERS), []);
  });
});
