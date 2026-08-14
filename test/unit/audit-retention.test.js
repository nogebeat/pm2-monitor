"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const { AuditRetentionService } = require("../../lib/services/audit");
const auditStore = require("../../lib/services/audit/audit-store");

/**
 * lib/services/audit/index.js#AuditRetentionService — purge par rétention,
 * optionnelle et désactivée par défaut (voir lib/services/audit/config.js
 * et docs/audit/README.md#rétention). Même schéma de test que
 * test/unit/... pour EventsService (purge par intervalle), mais ciblé sur
 * purgeOnce() en synchrone : pas besoin de tester le setInterval réel ici.
 */

test("AuditRetentionService — désactivée par défaut (AUDIT_RETENTION_MS absent)", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("purgeOnce() est un no-op si retentionMs vaut 0", async () => {
    await auditStore.create({
      timestamp: Date.now() - 1000 * 60 * 60 * 24 * 365, // il y a 1 an
      userId: 1,
      username: "alice",
      action: "login",
      status: "success",
      metadata: null,
    });
    const service = new AuditRetentionService({}); // env vide = retentionMs par défaut (0)
    assert.equal(service.config.retentionMs, 0);
    const deleted = await service.purgeOnce();
    assert.equal(deleted, 0);
    const remaining = await auditStore.list({});
    assert.equal(remaining.total, 1, "rien ne doit être supprimé par défaut");
  });

  await t.test("start() ne démarre pas de timer si retentionMs vaut 0", () => {
    const service = new AuditRetentionService({});
    service.start();
    assert.equal(service._maintenanceTimer, null);
    service.stop(); // ne doit pas throw même sans timer démarré
  });

  await cleanupDb(dbCtx);
});

test("AuditRetentionService — purge active quand AUDIT_RETENTION_MS est défini", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  const RETENTION_MS = 1000 * 60 * 60 * 24 * 30; // 30 jours
  const now = Date.now();

  await auditStore.create({
    timestamp: now - RETENTION_MS - 1000, // juste avant le cutoff : doit être purgé
    userId: 1,
    username: "old",
    action: "login",
    status: "success",
    metadata: null,
  });
  await auditStore.create({
    timestamp: now - 1000, // récent : ne doit pas être purgé
    userId: 1,
    username: "recent",
    action: "login",
    status: "success",
    metadata: null,
  });

  await t.test("purgeOnce() supprime uniquement ce qui dépasse la rétention", async () => {
    const service = new AuditRetentionService({ AUDIT_RETENTION_MS: String(RETENTION_MS) });
    assert.equal(service.config.retentionMs, RETENTION_MS);
    const deleted = await service.purgeOnce(now);
    assert.equal(deleted, 1);
    const remaining = await auditStore.list({});
    assert.equal(remaining.total, 1);
    assert.equal(remaining.items[0].username, "recent");
  });

  await t.test("start()/stop() démarrent puis arrêtent un timer sans erreur", () => {
    const service = new AuditRetentionService({ AUDIT_RETENTION_MS: String(RETENTION_MS) });
    service.start();
    assert.ok(service._maintenanceTimer);
    service.stop();
    assert.equal(service._maintenanceTimer, null);
  });

  await cleanupDb(dbCtx);
});
