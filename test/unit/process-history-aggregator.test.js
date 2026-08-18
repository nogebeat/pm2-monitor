"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeStats,
  percentile,
  aggregateSamples,
  aggregateRollupBuckets,
} = require("../../lib/services/process-history/aggregator");

test("computeStats()", async (t) => {
  await t.test("avg/min/max/p95 sur une série simple", () => {
    const stats = computeStats([10, 20, 30, 40, 50]);
    assert.equal(stats.avg, 30);
    assert.equal(stats.min, 10);
    assert.equal(stats.max, 50);
    // p95 sur 5 valeurs, interpolation linéaire (rang = 0.95*4 = 3.8)
    assert.equal(stats.p95, 48);
  });

  await t.test("ignore les null/undefined", () => {
    const stats = computeStats([10, null, 20, undefined, 30]);
    assert.equal(stats.avg, 20);
    assert.equal(stats.min, 10);
    assert.equal(stats.max, 30);
  });

  await t.test("tableau vide -> tout null, ne plante pas", () => {
    const stats = computeStats([]);
    assert.deepEqual(stats, { avg: null, min: null, max: null, p95: null });
  });

  await t.test("une seule valeur", () => {
    const stats = computeStats([42]);
    assert.deepEqual(stats, { avg: 42, min: 42, max: 42, p95: 42 });
  });
});

test("percentile()", async (t) => {
  await t.test("p50 = médiane sur une série impaire", () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  });

  await t.test("tableau vide -> null", () => {
    assert.equal(percentile([], 95), null);
  });
});

test("aggregateSamples()", async (t) => {
  await t.test("agrège cpu/memory + restart_count (max + delta)", () => {
    const samples = [
      { cpu: 10, memory: 100e6, restartCount: 2, instances: 1 },
      { cpu: 20, memory: 200e6, restartCount: 2, instances: 1 },
      { cpu: 30, memory: 300e6, restartCount: 4, instances: 2 },
    ];
    const agg = aggregateSamples(samples);
    assert.equal(agg.cpu.avg, 20);
    assert.equal(agg.cpu.min, 10);
    assert.equal(agg.cpu.max, 30);
    assert.equal(agg.memory.avg, 200e6);
    assert.equal(agg.restartCountMax, 4, "garde le compteur le plus haut vu dans le bucket");
    assert.equal(agg.restartDelta, 2, "delta = redémarrages survenus pendant le bucket");
    assert.equal(agg.instancesAvg, 1.3, "arrondi à 1 décimale comme les autres agrégats");
    assert.equal(agg.sampleCount, 3);
  });

  await t.test("restart_count constant -> delta = 0 (pas de redémarrage)", () => {
    const samples = [
      { cpu: 1, memory: 1, restartCount: 5 },
      { cpu: 1, memory: 1, restartCount: 5 },
    ];
    const agg = aggregateSamples(samples);
    assert.equal(agg.restartDelta, 0);
    assert.equal(agg.restartCountMax, 5);
  });

  await t.test("tableau vide -> stats null, sampleCount 0", () => {
    const agg = aggregateSamples([]);
    assert.equal(agg.cpu.avg, null);
    assert.equal(agg.restartCountMax, null);
    assert.equal(agg.sampleCount, 0);
  });
});

test("aggregateRollupBuckets()", async (t) => {
  await t.test("ré-agrège des buckets medium en un bucket long (moyenne pondérée par sample_count)", () => {
    const buckets = [
      {
        cpu: { avg: 10, min: 5, max: 15, p95: 14 },
        memory: { avg: 100, min: 50, max: 150, p95: 140 },
        instancesAvg: 1,
        restartCountMax: 3,
        restartDelta: 1,
        sampleCount: 10,
      },
      {
        cpu: { avg: 30, min: 20, max: 40, p95: 38 },
        memory: { avg: 300, min: 200, max: 400, p95: 380 },
        instancesAvg: 2,
        restartCountMax: 5,
        restartDelta: 2,
        sampleCount: 10,
      },
    ];
    const agg = aggregateRollupBuckets(buckets);

    // poids égaux (10/10) -> moyenne simple
    assert.equal(agg.cpu.avg, 20);
    assert.equal(agg.cpu.min, 5, "min des min, exact (pas une approximation)");
    assert.equal(agg.cpu.max, 40, "max des max, exact");
    assert.equal(agg.memory.avg, 200);
    assert.equal(agg.restartCountMax, 5, "compteur monotone -> le plus haut des deux buckets");
    assert.equal(agg.restartDelta, 3, "somme des redémarrages sur la période totale");
    assert.equal(agg.sampleCount, 20);
  });

  await t.test("pondère correctement quand les buckets n'ont pas le même sample_count", () => {
    const buckets = [
      {
        cpu: { avg: 0, min: 0, max: 0, p95: 0 },
        memory: { avg: 0, min: 0, max: 0, p95: 0 },
        instancesAvg: 1,
        restartCountMax: 0,
        restartDelta: 0,
        sampleCount: 90,
      },
      {
        cpu: { avg: 100, min: 100, max: 100, p95: 100 },
        memory: { avg: 100, min: 100, max: 100, p95: 100 },
        instancesAvg: 1,
        restartCountMax: 0,
        restartDelta: 0,
        sampleCount: 10,
      },
    ];
    const agg = aggregateRollupBuckets(buckets);
    assert.equal(agg.cpu.avg, 10, "90% de poids sur le bucket à 0 -> moyenne pondérée proche de 0, pas 50");
  });

  await t.test("tableau vide -> ne plante pas", () => {
    const agg = aggregateRollupBuckets([]);
    assert.equal(agg.cpu.avg, null);
    assert.equal(agg.sampleCount, 0);
  });
});
