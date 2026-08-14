"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const auditStore = require("../../lib/services/audit/audit-store");

/**
 * Tests unitaires du store de persistance de l'audit log (migration
 * 011_audit_log). Pas de logique de sanitization testée ici (voir
 * audit-sanitize.test.js) : `create()` fait confiance à l'appelant, comme
 * documenté en tête de audit-store.js.
 */

test("audit-store — create/getById round-trip", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("create() puis getById() retrouve la même entrée", async () => {
    const created = await auditStore.create({
      timestamp: Date.now(),
      userId: 1,
      username: "admin",
      action: "process.restart",
      target: "api",
      targetType: "process",
      server: "host-1",
      status: "success",
      ip: "127.0.0.1",
      metadata: { pid: 123 },
    });
    assert.ok(created.id);
    const fetched = await auditStore.getById(created.id);
    assert.equal(fetched.action, "process.restart");
    assert.equal(fetched.status, "success");
    assert.equal(fetched.username, "admin");
    assert.deepEqual(fetched.metadata, { pid: 123 });
  });

  await t.test("getById() sur un id inexistant renvoie null", async () => {
    const fetched = await auditStore.getById(999999);
    assert.equal(fetched, null);
  });

  await t.test("create() avec metadata null : lu comme null (pas d'erreur JSON)", async () => {
    const created = await auditStore.create({
      timestamp: Date.now(),
      userId: null,
      username: null,
      action: "login",
      status: "failed",
    });
    const fetched = await auditStore.getById(created.id);
    assert.equal(fetched.metadata, null);
    assert.equal(fetched.userId, null);
  });

  await cleanupDb(dbCtx);
});

test("audit-store — list() : pagination, filtres, tri", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  const base = Date.now();
  const entries = [
    { action: "login", status: "success", username: "alice", target: null, targetType: null },
    { action: "login", status: "failed", username: "bob", target: null, targetType: null },
    { action: "process.restart", status: "success", username: "alice", target: "api", targetType: "process" },
    { action: "process.stop", status: "denied", username: "bob", target: "worker", targetType: "process" },
    { action: "pm2.kill", status: "success", username: "alice", target: null, targetType: null },
  ];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    await auditStore.create({
      timestamp: base + i * 1000,
      userId: e.username === "alice" ? 1 : 2,
      username: e.username,
      action: e.action,
      target: e.target,
      targetType: e.targetType,
      server: "host-1",
      status: e.status,
      ip: "127.0.0.1",
      metadata: null,
    });
  }

  await t.test("list() sans filtre : tri du plus récent au plus ancien, total correct", async () => {
    const result = await auditStore.list({});
    assert.equal(result.total, 5);
    assert.equal(result.items.length, 5);
    assert.equal(result.items[0].action, "pm2.kill"); // dernier inséré = ts le plus élevé
    assert.equal(result.items[4].action, "login");
  });

  await t.test("list() — pagination (limit/offset), bornée à MAX_LIMIT", async () => {
    const page1 = await auditStore.list({ limit: 2, offset: 0 });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.limit, 2);
    const page2 = await auditStore.list({ limit: 2, offset: 2 });
    assert.equal(page2.items.length, 2);
    assert.notDeepEqual(page1.items[0].id, page2.items[0].id);

    const overLimit = await auditStore.list({ limit: 99999 });
    assert.equal(overLimit.limit, auditStore.MAX_LIMIT);
  });

  await t.test("list() — filtre par username", async () => {
    const result = await auditStore.list({ username: "alice" });
    assert.equal(result.total, 3);
    assert.ok(result.items.every((i) => i.username === "alice"));
  });

  await t.test("list() — filtre par action", async () => {
    const result = await auditStore.list({ action: "login" });
    assert.equal(result.total, 2);
  });

  await t.test("list() — filtre par status", async () => {
    const result = await auditStore.list({ status: "denied" });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].action, "process.stop");
  });

  await t.test("list() — filtre par target/targetType", async () => {
    const result = await auditStore.list({ target: "api", targetType: "process" });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].action, "process.restart");
  });

  await t.test("list() — filtre par date range (startTs/endTs)", async () => {
    const result = await auditStore.list({ startTs: base + 1000, endTs: base + 3000 });
    assert.equal(result.total, 3);
  });

  await t.test("list() — filtres combinés qui ne matchent rien", async () => {
    const result = await auditStore.list({ username: "alice", status: "denied" });
    assert.equal(result.total, 0);
    assert.deepEqual(result.items, []);
  });

  await cleanupDb(dbCtx);
});

test("audit-store — purgeOlderThan()", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  const base = Date.now();
  for (let i = 0; i < 4; i++) {
    await auditStore.create({
      timestamp: base + i * 1000,
      userId: 1,
      username: "alice",
      action: "login",
      status: "success",
      ip: "127.0.0.1",
      metadata: null,
    });
  }

  await t.test("purgeOlderThan() supprime uniquement ce qui est avant le cutoff", async () => {
    const deleted = await auditStore.purgeOlderThan(base + 2000);
    assert.equal(deleted, 2);
    const remaining = await auditStore.list({});
    assert.equal(remaining.total, 2);
    assert.ok(remaining.items.every((i) => i.timestamp >= base + 2000));
  });

  await t.test("purgeOlderThan() avec un cutoff invalide ne supprime rien", async () => {
    const deleted = await auditStore.purgeOlderThan(NaN);
    assert.equal(deleted, 0);
  });

  await cleanupDb(dbCtx);
});
