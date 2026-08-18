"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

/**
 * Test de volume (exigé par la phase 3) : simule une collecte réaliste sur
 * plusieurs processus pendant plusieurs jours, puis vérifie que rollup +
 * purge empêchent une explosion disque — pas juste "la purge fonctionne sur
 * 2 lignes" (déjà couvert par test/unit/process-history-store.test.js et
 * process-history-rollup.test.js), mais un ordre de grandeur réaliste.
 */
test("Volume — collecte réaliste (10 process x 24h @15s) + maintenance", async (t) => {
  const dbCtx = await freshDb();
  const migrator = require("../../lib/db/migrator");
  await migrator.up();
  const store = require("../../lib/services/process-history/store");
  const { runMaintenance } = require("../../lib/services/process-history/rollup");

  const PROCESS_COUNT = 10;
  const COLLECT_INTERVAL_MS = 15_000;
  const HOURS = 24;
  const now = Date.parse("2026-01-02T00:00:00Z");
  const start = now - HOURS * 3600 * 1000;

  await t.test("insertion en volume : pas d'erreur, ordre de grandeur attendu", async () => {
    const names = Array.from({ length: PROCESS_COUNT }, (_, i) => `app-${i}`);
    let totalInserted = 0;
    for (let ts = start; ts < now; ts += COLLECT_INTERVAL_MS) {
      const samples = names.map((name) => ({
        processName: name,
        ts,
        cpu: Math.random() * 100,
        memory: Math.floor(Math.random() * 200 * 1024 * 1024),
        restartCount: 0,
        instances: 1,
        status: "online",
        uptimeMs: ts - start,
      }));
      await store.insertRawBatch(samples);
      totalInserted += samples.length;
    }
    const expected = PROCESS_COUNT * Math.ceil((HOURS * 3600 * 1000) / COLLECT_INTERVAL_MS);
    assert.equal(totalInserted, expected);
  });

  await t.test("maintenance (rollup + purge) : la table raw ne garde que la rétention courte", async () => {
    const config = {
      mediumBucketMs: 3600 * 1000, // horaire
      longBucketMs: 24 * 3600 * 1000, // journalier
      shortRetentionMs: 6 * 3600 * 1000, // ne garde que les 6 dernières heures de raw
      mediumRetentionMs: 30 * 24 * 3600 * 1000,
      longRetentionMs: 365 * 24 * 3600 * 1000,
    };
    const report = await runMaintenance(config, now);
    assert.ok(
      report.rawPurged > 0,
      "la purge doit avoir supprimé les échantillons raw hors rétention courte",
    );

    const remainingRaw = await store.queryRaw({ processName: "app-0", start: 0, end: now });
    const oldestAllowed = now - config.shortRetentionMs;
    assert.ok(
      remainingRaw.every((r) => r.ts >= oldestAllowed),
      "aucune ligne raw ne doit survivre au-delà de shortRetentionMs après la purge",
    );
    // 6h de rétention à 15s -> au plus 6*3600/15 = 1440 points par process, pas 24h complètes.
    assert.ok(remainingRaw.length <= 1440 + 1, `raw restant borné (${remainingRaw.length} points)`);
  });

  await t.test("les buckets 'medium' couvrent l'historique complet malgré la purge du raw", async () => {
    const rollup = await store.queryRollup({
      processName: "app-0",
      resolution: "medium",
      start: 0,
      end: now,
    });
    // 24h de collecte -> jusqu'à 24 buckets horaires complets pour ce process.
    assert.ok(rollup.length >= 20, `attendu ~24 buckets horaires, obtenu ${rollup.length}`);
  });

  await t.test("taille du fichier DB reste raisonnable pour un petit VPS", async () => {
    const stat = fs.statSync(dbCtx.dbPath);
    // ~10 process x 6h de raw (1440 pts) + rollups horaires/journaliers sur 24h : quelques Mo au grand maximum.
    assert.ok(
      stat.size < 20 * 1024 * 1024,
      `DB size = ${(stat.size / 1024 / 1024).toFixed(2)} Mo, attendu < 20 Mo`,
    );
  });

  await t.test("query() reste rapide même après ce volume", async () => {
    const { ProcessHistoryService } = require("../../lib/services/process-history");
    const svc = new ProcessHistoryService({ PROCESS_HISTORY_ENABLED: "1" });
    const t0 = Date.now();
    const result = await svc.query({ processName: "app-0", start, end: now });
    const elapsed = Date.now() - t0;
    assert.ok(result.points.length <= svc.config.maxPoints, "downsampling respecte maxPoints");
    assert.ok(elapsed < 1000, `query() a pris ${elapsed}ms, attendu < 1000ms`);
  });

  await cleanupDb(dbCtx);
});
