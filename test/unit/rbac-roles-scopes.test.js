"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ROLES,
  ALL_ROLE_NAMES,
  ALL_APP_ACTIONS,
  ALL_GLOBAL_ACTIONS,
  API_KEY_SCOPES,
  ALL_API_KEY_SCOPES,
  ACTION_TO_API_KEY_SCOPE,
  SENSITIVE_API_KEY_SCOPES,
  isSensitiveApiKeyScope,
  hasScope,
  apiKeyCanPerform,
  hasPermission,
  apiKeyHasServerAccess,
} = require("../../lib/permissions");

/**
 * Tests unitaires Phase 18 (Advanced RBAC & API Keys) : rôles prédéfinis et
 * scopes de clé API. Volontairement séparé de tout accès DB — voir
 * test/unit/api-keys-store.test.js pour le store, et
 * test/integration/api-keys-security.test.js pour les scénarios de sécurité
 * bout-en-bout demandés par le prompt de phase (clé invalide/expirée/
 * révoquée/scope insuffisant/suffisant, absence du secret, permissions
 * utilisateur inchangées).
 */

test("ROLES — rôles prédéfinis", async (t) => {
  await t.test("catalogue attendu : admin/operator/viewer/auditor", () => {
    assert.deepEqual(ALL_ROLE_NAMES.sort(), ["admin", "auditor", "operator", "viewer"]);
  });

  await t.test("le rôle admin n'expose aucune permission explicite (is_admin suffit)", () => {
    assert.equal(ROLES.admin.isAdmin, true);
    assert.deepEqual(ROLES.admin.permissions, []);
  });

  await t.test("toute action des permissions de rôle existe bien dans le catalogue", () => {
    for (const role of Object.values(ROLES)) {
      for (const p of role.permissions) {
        const known = ALL_APP_ACTIONS.includes(p.action) || ALL_GLOBAL_ACTIONS.includes(p.action);
        assert.ok(known, `action inconnue dans un rôle : ${p.action}`);
      }
    }
  });

  await t.test("un utilisateur avec les permissions du rôle operator peut restart mais pas delete", () => {
    const user = { isAdmin: false, permissions: ROLES.operator.permissions };
    assert.equal(hasPermission(user, "any-app", "restart"), true);
    assert.equal(hasPermission(user, "any-app", "delete"), false);
  });

  await t.test("un utilisateur avec les permissions du rôle viewer peut view/logs mais rien d'autre", () => {
    const user = { isAdmin: false, permissions: ROLES.viewer.permissions };
    assert.equal(hasPermission(user, "any-app", "view"), true);
    assert.equal(hasPermission(user, "any-app", "logs"), true);
    assert.equal(hasPermission(user, "any-app", "restart"), false);
    assert.equal(hasPermission(user, "any-app", "manage_users"), false);
  });

  await t.test("un utilisateur avec les permissions du rôle auditor a audit_read mais pas view", () => {
    const user = { isAdmin: false, permissions: ROLES.auditor.permissions };
    assert.equal(hasPermission(user, "any-app", "audit_read"), true);
    assert.equal(hasPermission(user, "any-app", "view"), false);
  });

  await t.test(
    "appliquer un rôle ne casse pas hasPermission() pour les permissions octroyées à la main (même mécanisme)",
    () => {
      const handCrafted = { isAdmin: false, permissions: [{ appName: "api-prod", action: "restart" }] };
      assert.equal(hasPermission(handCrafted, "api-prod", "restart"), true);
      assert.equal(hasPermission(handCrafted, "api-prod", "stop"), false);
    },
  );
});

test("API_KEY_SCOPES — catalogue et sensibilité", async (t) => {
  await t.test("catalogue attendu", () => {
    assert.deepEqual(
      ALL_API_KEY_SCOPES.sort(),
      [
        "alerts:read",
        "alerts:write",
        "logs:read",
        "metrics:read",
        "notifications:test",
        "processes:read",
        "processes:restart",
        "servers:read",
      ].sort(),
    );
    for (const scope of ALL_API_KEY_SCOPES) {
      assert.ok(API_KEY_SCOPES[scope], `scope sans description : ${scope}`);
    }
  });

  await t.test("les scopes dangereux sont marqués sensibles", () => {
    assert.deepEqual(SENSITIVE_API_KEY_SCOPES.sort(), ["alerts:write", "notifications:test", "processes:restart"].sort());
    assert.equal(isSensitiveApiKeyScope("alerts:write"), true);
    assert.equal(isSensitiveApiKeyScope("notifications:test"), true);
    assert.equal(isSensitiveApiKeyScope("processes:restart"), true);
    assert.equal(isSensitiveApiKeyScope("metrics:read"), false);
  });

  await t.test("chaque scope correspond à au moins une action interne mappée", () => {
    const mappedScopes = new Set(Object.values(ACTION_TO_API_KEY_SCOPE));
    for (const scope of ALL_API_KEY_SCOPES) {
      assert.ok(mappedScopes.has(scope), `aucune action ne mappe vers le scope ${scope}`);
    }
  });
});

test("hasScope()", async (t) => {
  await t.test("clé nulle/absente -> false", () => {
    assert.equal(hasScope(null, "metrics:read"), false);
    assert.equal(hasScope(undefined, "metrics:read"), false);
  });

  await t.test("scope présent -> true, scope absent -> false", () => {
    const key = { scopes: ["metrics:read", "logs:read"] };
    assert.equal(hasScope(key, "metrics:read"), true);
    assert.equal(hasScope(key, "alerts:write"), false);
  });

  await t.test("aucun wildcard '*' pour les clés API (refus explicite, contrairement aux permissions humaines)", () => {
    const key = { scopes: ["*"] };
    assert.equal(hasScope(key, "metrics:read"), false);
  });
});

test("apiKeyCanPerform()", async (t) => {
  await t.test("scope suffisant sur une action mappée -> true", () => {
    const key = { scopes: ["metrics:read"] };
    assert.equal(apiKeyCanPerform(key, null, "system"), true);
  });

  await t.test("scope insuffisant -> false", () => {
    const key = { scopes: ["logs:read"] };
    assert.equal(apiKeyCanPerform(key, null, "system"), false);
  });

  await t.test("action non exposée aux clés API (ex: manage_users) -> toujours false, même avec tous les scopes", () => {
    const key = { scopes: ALL_API_KEY_SCOPES };
    assert.equal(apiKeyCanPerform(key, null, "manage_users"), false);
    assert.equal(apiKeyCanPerform(key, "any-app", "stop"), false);
    assert.equal(apiKeyCanPerform(key, "any-app", "delete"), false);
  });

  await t.test("scope de ressource 'processes' : restreint aux process listés", () => {
    const key = { scopes: ["processes:read"], resourceScopes: { processes: ["api-prod"] } };
    assert.equal(apiKeyCanPerform(key, "api-prod", "view"), true);
    assert.equal(apiKeyCanPerform(key, "api-staging", "view"), false);
  });

  await t.test("sans resourceScopes.processes : accès à toutes les apps pour le scope détenu", () => {
    const key = { scopes: ["processes:read"] };
    assert.equal(apiKeyCanPerform(key, "n-importe-quelle-app", "view"), true);
  });

  await t.test("action globale (appName=null) ignore resourceScopes.processes", () => {
    const key = { scopes: ["alerts:read"], resourceScopes: { processes: ["api-prod"] } };
    assert.equal(apiKeyCanPerform(key, null, "alerts_read"), true);
  });

  await t.test("scope processes:restart (Phase 18 suite) : seule mutation exposée, marquée sensible", () => {
    const key = { scopes: ["processes:restart"] };
    assert.equal(apiKeyCanPerform(key, "api-prod", "restart"), true);
    assert.equal(isSensitiveApiKeyScope("processes:restart"), true);
    // Toujours pas d'accès à stop/reload/delete même avec ce scope.
    assert.equal(apiKeyCanPerform(key, "api-prod", "stop"), false);
  });

  await t.test("scope servers:read (Phase 18 suite) : action globale servers_read", () => {
    const key = { scopes: ["servers:read"] };
    assert.equal(apiKeyCanPerform(key, null, "servers_read"), true);
    const noScope = { scopes: ["metrics:read"] };
    assert.equal(apiKeyCanPerform(noScope, null, "servers_read"), false);
  });
});

test("apiKeyHasServerAccess() (Phase 18 suite — scope de ressource serveur)", async (t) => {
  await t.test("clé nulle/absente -> false", () => {
    assert.equal(apiKeyHasServerAccess(null, "srv-1"), false);
    assert.equal(apiKeyHasServerAccess(undefined, "srv-1"), false);
  });

  await t.test("sans resourceScopes.servers : accès à tous les serveurs", () => {
    const key = { scopes: ["servers:read"] };
    assert.equal(apiKeyHasServerAccess(key, "n-importe-quel-serveur"), true);
  });

  await t.test("avec resourceScopes.servers : restreint aux serveurs listés", () => {
    const key = { scopes: ["servers:read"], resourceScopes: { servers: ["srv-1"] } };
    assert.equal(apiKeyHasServerAccess(key, "srv-1"), true);
    assert.equal(apiKeyHasServerAccess(key, "srv-2"), false);
  });
});
