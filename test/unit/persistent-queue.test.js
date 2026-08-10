"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

test("PersistentQueue", async (t) => {
  let ctx;

  t.beforeEach(async () => {
    ctx = await freshDb();
    const migrator = require("../../lib/db/migrator");
    await migrator.up();
  });

  t.afterEach(async () => {
    await cleanupDb(ctx);
  });

  await t.test("job creation: add() persiste un job en attente", async () => {
    const { createQueue } = require("../../lib/services/queue");
    const q = createQueue("test-queue");
    const id = await q.add({ hello: "world" });
    assert.ok(id > 0);

    const job = await q.getJob(id);
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 0);
    assert.deepEqual(job.payload, { hello: "world" });
  });

  await t.test("job persistence: le job existe directement en base (table jobs)", async () => {
    const { createQueue } = require("../../lib/services/queue");
    const db = require("../../lib/db");
    const q = createQueue("test-queue");
    await q.add({ n: 1 });

    const rows = await db.all("SELECT * FROM jobs WHERE queue_name = ?", ["test-queue"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
  });

  await t.test("processOne(): traite un job avec succès et le retire de la file", async () => {
    const { createQueue } = require("../../lib/services/queue");
    const q = createQueue("test-queue");
    await q.add({ n: 42 });

    const seen = [];
    const processed = await q.processOne(async (payload) => {
      seen.push(payload);
    });

    assert.ok(processed);
    assert.deepEqual(seen, [{ n: 42 }]);
    assert.equal(await q.getJob(processed.id), null, "le job doit avoir été supprimé après succès");
  });

  await t.test("processOne(): file vide retourne null sans planter", async () => {
    const { createQueue } = require("../../lib/services/queue");
    const q = createQueue("empty-queue");
    const result = await q.processOne(async () => {});
    assert.equal(result, null);
  });

  await t.test("failed job + retry: échec repasse en pending avec attempts incrémenté", async () => {
    const { createQueue } = require("../../lib/services/queue");
    const q = createQueue("test-queue", { backoffMs: 0, maxAttempts: 3 });
    const id = await q.add({ n: 1 });

    await q.processOne(async () => {
      throw new Error("échec simulé");
    });

    const job = await q.getJob(id);
    assert.equal(job.status, "pending", "doit repasser en pending pour être retenté");
    assert.equal(job.attempts, 1);
    assert.equal(job.lastError, "échec simulé");
  });

  await t.test("failed job: après max_attempts échecs, le job passe en 'failed' et n'est plus repris", async () => {
    const { createQueue } = require("../../lib/services/queue");
    const q = createQueue("test-queue", { backoffMs: 0, maxAttempts: 2 });
    const id = await q.add({ n: 1 });

    await q.processOne(async () => {
      throw new Error("échec 1");
    });
    await q.processOne(async () => {
      throw new Error("échec 2");
    });

    const job = await q.getJob(id);
    assert.equal(job.status, "failed");
    assert.equal(job.attempts, 2);

    // Un job "failed" ne doit plus être repris par processOne()
    const next = await q.processOne(async () => {
      throw new Error("ne devrait pas être appelé");
    });
    assert.equal(next, null);
  });

  await t.test("delayed job: un job avec delayMs n'est pas traité avant son heure", async () => {
    const { createQueue } = require("../../lib/services/queue");
    const q = createQueue("test-queue");
    await q.add({ n: 1 }, { delayMs: 60_000 }); // dans 1 minute

    const result = await q.processOne(async () => {
      throw new Error("ne devrait pas être appelé, job différé");
    });
    assert.equal(result, null, "le job différé ne doit pas être éligible tout de suite");
  });

  await t.test("recoverStaleActiveJobs(): remet en pending les jobs restés 'active'", async () => {
    const { createQueue } = require("../../lib/services/queue");
    const db = require("../../lib/db");
    const q = createQueue("test-queue");
    const id = await q.add({ n: 1 });

    // Simule un crash en plein traitement : le job reste marqué "active".
    await db.run("UPDATE jobs SET status = 'active' WHERE id = ?", [id]);
    let job = await q.getJob(id);
    assert.equal(job.status, "active");

    const recovered = await q.recoverStaleActiveJobs();
    assert.equal(recovered, 1);

    job = await q.getJob(id);
    assert.equal(job.status, "pending");
  });

  await t.test(
    "process restart: job créé, DB fermée/rouverte (simulation redémarrage), le job existe toujours et est traité",
    async () => {
      const { createQueue } = require("../../lib/services/queue");
      const db = require("../../lib/db");

      // 1. Process A : crée un job, ne le traite pas, "s'arrête" (ferme la DB).
      const dbPath = ctx.dbPath;
      const queueA = createQueue("restart-queue");
      const id = await queueA.add({ task: "survive-restart" });
      await db.close();

      // 2. "Redémarrage" : on rouvre la même base de données (même fichier).
      process.env.DB_SQLITE_PATH = dbPath;
      await db.init();

      // 3. Process B : le job doit toujours exister...
      const queueB = createQueue("restart-queue");
      const job = await queueB.getJob(id);
      assert.ok(job, "le job doit avoir survécu au redémarrage");
      assert.equal(job.status, "pending");

      // ...et être traité normalement.
      const seen = [];
      const processed = await queueB.processOne(async (payload) => seen.push(payload));
      assert.ok(processed);
      assert.deepEqual(seen, [{ task: "survive-restart" }]);
    }
  );
});
