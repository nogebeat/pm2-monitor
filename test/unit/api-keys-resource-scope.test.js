"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const orgStore = require("../../lib/services/process-organization/store");
const { processResourceScopeAllows } = require("../../lib/services/api-keys/resource-scope");

/**
 * Tests unitaires du scope de ressource "environment"/"group" d'une clé API
 * (Phase 18 suite — résolution du problème connu "resourceScopes.environments
 * / .groups acceptés mais non appliqués"). Complète
 * test/unit/rbac-roles-scopes.test.js (qui couvre le scope "processes",
 * synchrone et sans DB) et test/unit/api-keys-store.test.js.
 */
test("api-keys/resource-scope — processResourceScopeAllows()", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  const prod = await orgStore.createEnvironment({ name: "production" });
  const staging = await orgStore.createEnvironment({ name: "staging" });
  const backend = await orgStore.createGroup({ name: "backend" });
  const frontend = await orgStore.createGroup({ name: "frontend" });

  await orgStore.assignProcess({
    processName: "api-prod",
    environmentId: prod.id,
    groups: [backend.id],
  });
  await orgStore.assignProcess({
    processName: "web-staging",
    environmentId: staging.id,
    groups: [frontend.id],
  });
  await orgStore.assignProcess({
    processName: "unassigned-app",
  });

  await t.test("clé/appName absents -> true (rien à vérifier)", async () => {
    assert.equal(await processResourceScopeAllows(null, "api-prod"), true);
    assert.equal(await processResourceScopeAllows({ resourceScopes: { environments: ["production"] } }, null), true);
  });

  await t.test("sans resourceScopes -> true (pas de restriction)", async () => {
    assert.equal(await processResourceScopeAllows({ scopes: ["processes:read"] }, "api-prod"), true);
  });

  await t.test("resourceScopes.environments : autorise l'environnement listé", async () => {
    const key = { resourceScopes: { environments: ["production"] } };
    assert.equal(await processResourceScopeAllows(key, "api-prod"), true);
    assert.equal(await processResourceScopeAllows(key, "web-staging"), false);
  });

  await t.test("resourceScopes.environments : refuse un process sans environnement assigné", async () => {
    const key = { resourceScopes: { environments: ["production"] } };
    assert.equal(await processResourceScopeAllows(key, "unassigned-app"), false);
  });

  await t.test("resourceScopes.groups : autorise un des groupes listés", async () => {
    const key = { resourceScopes: { groups: ["backend"] } };
    assert.equal(await processResourceScopeAllows(key, "api-prod"), true);
    assert.equal(await processResourceScopeAllows(key, "web-staging"), false);
  });

  await t.test("environments + groups combinés : les deux doivent être satisfaits (ET logique)", async () => {
    const key = { resourceScopes: { environments: ["production"], groups: ["frontend"] } };
    // api-prod est bien en "production" mais pas dans "frontend" -> refusé
    assert.equal(await processResourceScopeAllows(key, "api-prod"), false);
  });

  await t.test("resourceScopes.processes (autre critère) n'interfère pas avec cette vérification", async () => {
    const key = { resourceScopes: { processes: ["api-prod"], environments: ["production"] } };
    assert.equal(await processResourceScopeAllows(key, "api-prod"), true);
  });

  await cleanupDb(dbCtx);
});
