"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const store = require("../../lib/services/service-dependencies/store");
const healthChecksStore = require("../../lib/services/health-checks/store");

/**
 * Tests unitaires du store de dépendances de service (migration
 * 019_service_dependencies, Phase 17 — Service Dependency Map). Même style
 * que test/unit/process-organization-store.test.js : DB SQLite temporaire
 * par test, migrations appliquées, store appelé directement (pas de HTTP
 * ici — voir test/integration/service-dependencies-api.test.js pour l'API
 * REST).
 */

async function makeTcpCheck(overrides = {}) {
  return healthChecksStore.create({
    name: overrides.name || "redis-tcp",
    type: "tcp",
    host: "127.0.0.1",
    port: 6379,
    ...overrides,
  });
}

test("service-dependencies/store — CRUD de base", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("create() puis getById()", async () => {
    const dep = await store.create({ source: "API", target: "PostgreSQL", type: "DATABASE" });
    assert.ok(dep.id);
    assert.equal(dep.source, "API");
    assert.equal(dep.target, "PostgreSQL");
    assert.equal(dep.type, "DATABASE");
    assert.equal(dep.enabled, true);
    assert.equal(dep.healthCheckId, null);

    const fetched = await store.getById(dep.id);
    assert.deepEqual(fetched, dep);
  });

  await t.test("create() sans source/target échoue", async () => {
    await assert.rejects(() => store.create({ target: "X", type: "TCP" }), /source requis/);
    await assert.rejects(() => store.create({ source: "X", type: "TCP" }), /target requis/);
  });

  await t.test("create() avec type invalide échoue", async () => {
    await assert.rejects(
      () => store.create({ source: "A", target: "B", type: "FTP" }),
      /type invalide/,
    );
  });

  await t.test("create() refuse une dépendance sur soi-même", async () => {
    await assert.rejects(
      () => store.create({ source: "API", target: "API", type: "CUSTOM" }),
      /différents/,
    );
  });

  await t.test("create() refuse un doublon (source, target, type)", async () => {
    await store.create({ source: "Worker", target: "Redis", type: "REDIS" });
    await assert.rejects(
      () => store.create({ source: "Worker", target: "Redis", type: "REDIS" }),
      /existe déjà/,
    );
  });

  await t.test("même (source, target) avec un type différent est autorisé", async () => {
    const dep = await store.create({ source: "Frontend", target: "API", type: "HTTP" });
    assert.ok(dep.id);
    const dep2 = await store.create({ source: "Frontend", target: "API", type: "CUSTOM" });
    assert.ok(dep2.id);
  });

  await t.test("update() modifie les champs, setEnabled() bascule enabled", async () => {
    const dep = await store.create({ source: "Svc-A", target: "Svc-B", type: "CUSTOM" });
    const updated = await store.update(dep.id, { description: "lien critique" });
    assert.equal(updated.description, "lien critique");

    const disabled = await store.setEnabled(dep.id, false);
    assert.equal(disabled.enabled, false);
    const reenabled = await store.setEnabled(dep.id, true);
    assert.equal(reenabled.enabled, true);
  });

  await t.test("update()/setEnabled() sur un id inconnu : pas d'exception, résultat vide", async () => {
    assert.equal(await store.update(999999, { description: "x" }), null);
    assert.equal(await store.setEnabled(999999, true), null);
  });

  await t.test("remove() supprime, list() reflète", async () => {
    const dep = await store.create({ source: "Svc-C", target: "Svc-D", type: "CUSTOM" });
    const removed = await store.remove(dep.id);
    assert.equal(removed, true);
    assert.equal(await store.getById(dep.id), null);
    assert.equal(await store.remove(999999), false);
  });

  t.after(() => cleanupDb(dbCtx));
});

test("service-dependencies/store — détection de cycle", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("chaîne simple sans cycle : Frontend -> API -> PostgreSQL", async () => {
    await store.create({ source: "Frontend", target: "API", type: "HTTP" });
    await store.create({ source: "API", target: "PostgreSQL", type: "DATABASE" });
    const all = await store.list({});
    assert.equal(all.length, 2);
  });

  await t.test("refuse une dépendance qui boucle (PostgreSQL -> Frontend)", async () => {
    await assert.rejects(
      () => store.create({ source: "PostgreSQL", target: "Frontend", type: "CUSTOM" }),
      /cycle/,
    );
  });

  await t.test("update() qui introduirait un cycle est aussi refusé", async () => {
    // Frontend -> API -> PostgreSQL existe déjà (t.test précédent). Une
    // dépendance sans rapport (Standalone -> Something), une fois redirigée
    // vers PostgreSQL -> Frontend, boucle exactement comme la création
    // directe testée ci-dessus.
    const isolated = await store.create({ source: "Standalone", target: "Something", type: "CUSTOM" });
    await assert.rejects(
      () => store.update(isolated.id, { source: "PostgreSQL", target: "Frontend" }),
      /cycle/,
    );
  });

  t.after(() => cleanupDb(dbCtx));
});

test("service-dependencies/store — lien avec un health check existant", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("create() avec healthCheckId valide", async () => {
    const check = await makeTcpCheck();
    const dep = await store.create({
      source: "API",
      target: "Redis",
      type: "REDIS",
      healthCheckId: check.id,
    });
    assert.equal(dep.healthCheckId, check.id);
  });

  await t.test("supprimer le health check ne supprime pas la dépendance (ON DELETE SET NULL)", async () => {
    const check = await makeTcpCheck({ name: "postgres-tcp" });
    const dep = await store.create({
      source: "Worker",
      target: "PostgreSQL",
      type: "DATABASE",
      healthCheckId: check.id,
    });

    await healthChecksStore.remove(check.id);

    const stillThere = await store.getById(dep.id);
    assert.ok(stillThere, "la dépendance doit survivre à la suppression du health check");
    assert.equal(stillThere.healthCheckId, null);
  });

  await t.test("listByHealthCheckId() ne retourne que les dépendances activées liées à ce check", async () => {
    const check = await makeTcpCheck({ name: "shared-check" });
    const active = await store.create({
      source: "API",
      target: "SharedTarget",
      type: "CUSTOM",
      healthCheckId: check.id,
    });
    const disabled = await store.create({
      source: "Worker",
      target: "SharedTarget2",
      type: "CUSTOM",
      healthCheckId: check.id,
    });
    await store.setEnabled(disabled.id, false);

    const linked = await store.listByHealthCheckId(check.id);
    assert.deepEqual(
      linked.map((d) => d.id),
      [active.id],
    );
  });

  t.after(() => cleanupDb(dbCtx));
});

test("service-dependencies/store — listNodeNames()", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("retourne les noms distincts (source + target)", async () => {
    await store.create({ source: "Frontend", target: "API", type: "HTTP" });
    await store.create({ source: "API", target: "PostgreSQL", type: "DATABASE" });
    const names = await store.listNodeNames();
    assert.deepEqual(names, ["API", "Frontend", "PostgreSQL"]);
  });

  t.after(() => cleanupDb(dbCtx));
});
