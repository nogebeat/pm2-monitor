"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const store = require("../../lib/services/process-organization/store");

/**
 * Tests unitaires du service d'organisation des process (migration
 * 015_process_organization, Phase 13 — Tags, Environments & Process
 * Groups). Même style que test/unit/servers-store.test.js : DB SQLite
 * temporaire par test, migrations appliquées, store appelé directement (pas
 * de HTTP ici — voir test/integration/process-organization-api.test.js pour
 * l'API REST).
 */

test("process-organization/store — tags", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("createTag() puis listTags()", async () => {
    const tag = await store.createTag({ name: "production", color: "#ff0000" });
    assert.ok(tag.id);
    assert.equal(tag.name, "production");
    assert.equal(tag.color, "#ff0000");
    const all = await store.listTags();
    assert.ok(all.some((t2) => t2.id === tag.id));
  });

  await t.test("createTag() sans nom échoue", async () => {
    await assert.rejects(() => store.createTag({}), /requis/);
  });

  await t.test("createTag() refuse un doublon (contrainte UNIQUE)", async () => {
    await store.createTag({ name: "backend" });
    await assert.rejects(() => store.createTag({ name: "backend" }), /existe déjà/);
  });

  await t.test("updateTag() renomme, removeTag() supprime", async () => {
    const tag = await store.createTag({ name: "worker" });
    const updated = await store.updateTag(tag.id, { name: "workers", color: "#00ff00" });
    assert.equal(updated.name, "workers");
    assert.equal(updated.color, "#00ff00");

    const removed = await store.removeTag(tag.id);
    assert.equal(removed, true);
    assert.equal(await store.getTagById(tag.id), null);
  });

  await t.test("updateTag()/removeTag() sur un id inconnu : pas d'exception, résultat vide", async () => {
    assert.equal(await store.updateTag(999999, { name: "x" }), null);
    assert.equal(await store.removeTag(999999), false);
  });

  t.after(() => cleanupDb(dbCtx));
});

test("process-organization/store — environnements", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("ensureDefaults() seed production/staging/development, idempotent", async () => {
    await store.ensureDefaults();
    const names = (await store.listEnvironments()).map((e) => e.name).sort();
    assert.deepEqual(names, ["development", "production", "staging"]);

    // Un environnement supprimé par l'utilisateur ne doit pas revenir tout
    // seul (ensureDefaults ne "recrée" que ce qui est absent au moment de
    // l'appel, mais ne force jamais la présence de tous les défauts après
    // suppression volontaire) — ici on vérifie juste l'idempotence simple :
    // rejouer ensureDefaults() sans rien avoir supprimé ne duplique rien.
    await store.ensureDefaults();
    const namesAfter = (await store.listEnvironments()).map((e) => e.name).sort();
    assert.deepEqual(namesAfter, ["development", "production", "staging"]);
  });

  await t.test("createEnvironment() personnalisé ('custom')", async () => {
    const env = await store.createEnvironment({ name: "qa", color: "#abcdef" });
    assert.equal(env.name, "qa");
    const all = await store.listEnvironments();
    assert.ok(all.some((e) => e.name === "qa"));
  });

  await t.test("createEnvironment() refuse un doublon", async () => {
    await store.createEnvironment({ name: "canary" });
    await assert.rejects(() => store.createEnvironment({ name: "canary" }), /existe déjà/);
  });

  await t.test("updateEnvironment()/removeEnvironment()", async () => {
    const env = await store.createEnvironment({ name: "temp-env" });
    const updated = await store.updateEnvironment(env.id, { name: "temp-env-renamed" });
    assert.equal(updated.name, "temp-env-renamed");
    assert.equal(await store.removeEnvironment(env.id), true);
  });

  t.after(() => cleanupDb(dbCtx));
});

test("process-organization/store — groupes", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("createGroup() puis listGroups()", async () => {
    const group = await store.createGroup({ name: "E-commerce", description: "Stack e-commerce" });
    assert.equal(group.name, "E-commerce");
    assert.equal(group.description, "Stack e-commerce");
    const all = await store.listGroups();
    assert.ok(all.some((g) => g.id === group.id));
  });

  await t.test("createGroup() refuse un doublon", async () => {
    await store.createGroup({ name: "Infra" });
    await assert.rejects(() => store.createGroup({ name: "Infra" }), /existe déjà/);
  });

  t.after(() => cleanupDb(dbCtx));
});

test("process-organization/store — associations process <-> tags/environnement/groupes", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  let tagProd, tagCritical, envProduction, groupEcommerce;

  t.before(async () => {
    tagProd = await store.createTag({ name: "production" });
    tagCritical = await store.createTag({ name: "critical" });
    envProduction = await store.createEnvironment({ name: "production" });
    groupEcommerce = await store.createGroup({ name: "E-commerce" });
  });

  await t.test("setProcessTags() puis getTagsForProcess()", async () => {
    await store.setProcessTags("api-prod", [tagProd.id, tagCritical.id]);
    const tags = await store.getTagsForProcess("api-prod");
    assert.deepEqual(tags.map((t2) => t2.name).sort(), ["critical", "production"]);
  });

  await t.test("setProcessTags() remplace l'ensemble précédent (pas un ajout)", async () => {
    await store.setProcessTags("api-prod", [tagProd.id]);
    const tags = await store.getTagsForProcess("api-prod");
    assert.deepEqual(
      tags.map((t2) => t2.name),
      ["production"],
    );
  });

  await t.test("setProcessTags([]) retire tous les tags", async () => {
    await store.setProcessTags("api-prod", []);
    assert.deepEqual(await store.getTagsForProcess("api-prod"), []);
  });

  await t.test("setProcessEnvironment() assigne un environnement unique", async () => {
    await store.setProcessEnvironment("api-prod", envProduction.id);
    const env = await store.getEnvironmentForProcess("api-prod");
    assert.equal(env.name, "production");
  });

  await t.test("setProcessEnvironment(null) retire l'environnement", async () => {
    await store.setProcessEnvironment("api-prod", null);
    assert.equal(await store.getEnvironmentForProcess("api-prod"), null);
  });

  await t.test("setProcessGroups() : un process peut appartenir à plusieurs groupes", async () => {
    const groupOther = await store.createGroup({ name: "Autre" });
    await store.setProcessGroups("api-prod", [groupEcommerce.id, groupOther.id]);
    const groups = await store.getGroupsForProcess("api-prod");
    assert.deepEqual(groups.map((g) => g.name).sort(), ["Autre", "E-commerce"]);
  });

  await t.test("deux process de même nom sur deux serveurs différents restent indépendants", async () => {
    await store.setProcessTags("worker", [tagProd.id], "local");
    await store.setProcessTags("worker", [tagCritical.id], "srv_remote");

    const localTags = await store.getTagsForProcess("worker", "local");
    const remoteTags = await store.getTagsForProcess("worker", "srv_remote");
    assert.deepEqual(
      localTags.map((t2) => t2.name),
      ["production"],
    );
    assert.deepEqual(
      remoteTags.map((t2) => t2.name),
      ["critical"],
    );
  });

  await t.test("assignProcess() applique tags + environnement + groupes en un seul appel", async () => {
    const result = await store.assignProcess({
      processName: "payments",
      tagIds: [tagCritical.id],
      environmentId: envProduction.id,
      groups: [groupEcommerce.id],
    });
    assert.deepEqual(result.tags, ["critical"]);
    assert.equal(result.environment, "production");
    assert.deepEqual(result.groups, ["E-commerce"]);
  });

  await t.test("getOrganizationForProcess() agrège tags/environnement/groupes", async () => {
    const org = await store.getOrganizationForProcess("payments");
    assert.deepEqual(org, { tags: ["critical"], environment: "production", groups: ["E-commerce"] });
  });

  await t.test("getOrganizationForProcess() sur un process sans association : tout vide/null", async () => {
    const org = await store.getOrganizationForProcess("unknown-process");
    assert.deepEqual(org, { tags: [], environment: null, groups: [] });
  });

  await t.test("clearProcess() retire toutes les associations d'un process", async () => {
    await store.clearProcess("payments");
    const org = await store.getOrganizationForProcess("payments");
    assert.deepEqual(org, { tags: [], environment: null, groups: [] });
  });

  await t.test(
    "listAssignments() renvoie l'organisation de tous les process ayant au moins une association",
    async () => {
      await store.setProcessTags("api-prod", [tagProd.id]);
      const all = await store.listAssignments();
      const apiProd = all.find((a) => a.processName === "api-prod" && a.serverKey === "local");
      assert.ok(apiProd);
      assert.deepEqual(
        apiProd.tags.map((t2) => t2.name),
        ["production"],
      );
    },
  );

  await t.test("suppression d'un tag retire ses associations (ON DELETE CASCADE)", async () => {
    const tag = await store.createTag({ name: "temp-tag" });
    await store.setProcessTags("cascade-test", [tag.id]);
    assert.deepEqual(
      (await store.getTagsForProcess("cascade-test")).map((t2) => t2.name),
      ["temp-tag"],
    );

    await store.removeTag(tag.id);
    assert.deepEqual(await store.getTagsForProcess("cascade-test"), []);
  });

  await t.test("suppression d'un environnement retire l'association process -> environnement", async () => {
    const env = await store.createEnvironment({ name: "temp-cascade-env" });
    await store.setProcessEnvironment("cascade-env-test", env.id);
    assert.ok(await store.getEnvironmentForProcess("cascade-env-test"));

    await store.removeEnvironment(env.id);
    assert.equal(await store.getEnvironmentForProcess("cascade-env-test"), null);
  });

  await t.test("suppression d'un groupe retire ses associations", async () => {
    const group = await store.createGroup({ name: "temp-cascade-group" });
    await store.setProcessGroups("cascade-group-test", [group.id]);
    assert.deepEqual(
      (await store.getGroupsForProcess("cascade-group-test")).map((g) => g.name),
      ["temp-cascade-group"],
    );

    await store.removeGroup(group.id);
    assert.deepEqual(await store.getGroupsForProcess("cascade-group-test"), []);
  });

  t.after(() => cleanupDb(dbCtx));
});
