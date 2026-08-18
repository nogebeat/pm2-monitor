"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Teste EventsService de bout en bout contre une vraie DB SQLite temporaire :
 * recordFromPacket() (= ce que server.js appelle dans bus.on("process:event"))
 * puis list() (= ce que consomme GET /api/events, voir lib/routes/events.js).
 * Même approche que test/integration/process-history-api.test.js : le
 * contrat service <-> DB, pas le transport HTTP (couvert séparément par
 * test/integration/events-api.test.js).
 */
test("EventsService — recordFromPacket() puis list()", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();

  const { EventsService } = require("../../lib/services/events");

  function packet(event, process = {}) {
    return { event, process: { name: "api", pm_id: 0, status: "online", restart_time: 0, ...process } };
  }

  await t.test("recordFromPacket() normalise, persiste, et attribue un id", async () => {
    const svc = new EventsService({ EVENTS_ENABLED: "1" });
    const stored = await svc.recordFromPacket(packet("start"), 1_000_000);
    assert.ok(stored);
    assert.ok(stored.id);
    assert.equal(stored.type, "started");
    assert.equal(stored.process, "api");
    assert.equal(stored.timestamp, 1_000_000);
  });

  await t.test("recordFromPacket() renvoie null pour un packet ignoré (ex: delete)", async () => {
    const svc = new EventsService({ EVENTS_ENABLED: "1" });
    const stored = await svc.recordFromPacket(packet("delete"), 1_000_001);
    assert.equal(stored, null);
  });

  await t.test("service désactivé -> recordFromPacket() ne persiste rien", async () => {
    const svc = new EventsService({ EVENTS_ENABLED: "0" });
    const stored = await svc.recordFromPacket(packet("start"), 1_000_002);
    assert.equal(stored, null);
  });

  await t.test("list() : pagination par défaut bornée, tri du plus récent au plus ancien", async () => {
    const svc = new EventsService({ EVENTS_ENABLED: "1" });
    for (let i = 0; i < 5; i++) {
      await svc.recordFromPacket(packet("restart", { name: "paginated-app" }), 2_000_000 + i);
    }
    const result = await svc.list({ process: "paginated-app", limit: 3, offset: 0 });
    assert.equal(result.items.length, 3);
    assert.equal(result.total, 5);
    assert.equal(result.limit, 3);
    assert.ok(result.items[0].timestamp > result.items[1].timestamp, "tri décroissant par timestamp");

    const page2 = await svc.list({ process: "paginated-app", limit: 3, offset: 3 });
    assert.equal(page2.items.length, 2);
    assert.equal(page2.total, 5);
  });

  await t.test(
    "list() : jamais toute l'historique en une seule requête (limit borné au maximum)",
    async () => {
      const svc = new EventsService({ EVENTS_ENABLED: "1" });
      const result = await svc.list({ process: "paginated-app", limit: 999999 });
      const { MAX_LIMIT } = require("../../lib/services/events/event-store");
      assert.ok(result.limit <= MAX_LIMIT);
    },
  );

  await t.test("list() : filtre par type et par severity", async () => {
    const svc = new EventsService({ EVENTS_ENABLED: "1" });
    await svc.recordFromPacket(packet("start", { name: "filter-app" }), 3_000_000);
    await svc.recordFromPacket(packet("exit", { name: "filter-app", exit_code: 1 }), 3_000_001);

    const started = await svc.list({ process: "filter-app", type: "started" });
    assert.equal(started.items.length, 1);
    assert.equal(started.items[0].type, "started");

    const critical = await svc.list({ process: "filter-app", severity: "critical" });
    assert.equal(critical.items.length, 1);
    assert.equal(critical.items[0].type, "crashed");
  });

  await t.test("list() : filtre par plage de dates (startTs/endTs)", async () => {
    const svc = new EventsService({ EVENTS_ENABLED: "1" });
    await svc.recordFromPacket(packet("start", { name: "range-app" }), 4_000_000);
    await svc.recordFromPacket(packet("stop", { name: "range-app" }), 4_000_500);
    await svc.recordFromPacket(packet("restart", { name: "range-app" }), 4_001_000);

    const inRange = await svc.list({ process: "range-app", startTs: 4_000_100, endTs: 4_000_600 });
    assert.equal(inRange.items.length, 1);
    assert.equal(inRange.items[0].type, "stopped");
  });

  await t.test("purgeOnce() supprime les événements plus anciens que la rétention configurée", async () => {
    const svc = new EventsService({ EVENTS_ENABLED: "1", EVENTS_RETENTION_MS: "1000" });
    await svc.recordFromPacket(packet("start", { name: "purge-app" }), 5_000_000);
    const now = 5_000_000 + 5000; // bien après la rétention (1000ms)
    const deleted = await svc.purgeOnce(now);
    assert.ok(deleted >= 1);
    const remaining = await svc.list({ process: "purge-app" });
    assert.equal(remaining.items.length, 0);
  });

  await cleanupDb(dbCtx);
});
