"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mean,
  stddev,
  zScore,
  confidenceFromZScore,
  percentChange,
} = require("../../lib/services/anomaly-detection/math");

test("mean() — moyenne arithmétique, [] -> null", () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(mean([]), null);
  assert.equal(mean([5]), 5);
});

test("stddev() — écart-type population", () => {
  assert.equal(stddev([2, 4, 4, 4, 5, 5, 7, 9]), 2);
  assert.equal(stddev([5, 5, 5, 5]), 0);
  assert.equal(stddev([]), null);
});

test("zScore() — cas normal", () => {
  assert.equal(zScore(10, 5, 5), 1);
  assert.equal(zScore(0, 5, 5), -1);
  assert.equal(zScore(5, 5, 5), 0);
});

test("zScore() — écart-type nul (baseline parfaitement constante)", () => {
  assert.equal(zScore(5, 5, 0), 0, "valeur identique à une baseline constante -> pas d'anomalie");
  assert.ok(
    zScore(10, 5, 0) > 0,
    "au-dessus d'une baseline constante -> z positif plafonné, jamais Infinity",
  );
  assert.ok(Number.isFinite(zScore(10, 5, 0)));
  assert.ok(zScore(0, 5, 0) < 0, "en-dessous d'une baseline constante -> z négatif plafonné");
});

test("confidenceFromZScore() — croissante avec |z|, bornée sous 100", () => {
  const c1 = confidenceFromZScore(1);
  const c3 = confidenceFromZScore(3);
  const c5 = confidenceFromZScore(5);
  assert.ok(c1 < c3 && c3 < c5);
  assert.ok(c5 < 100);
  assert.equal(confidenceFromZScore(null), null);
});

test("percentChange() — variation en %, null si référence absente/nulle", () => {
  assert.equal(percentChange(120, 100), 20);
  assert.equal(percentChange(80, 100), -20);
  assert.equal(percentChange(100, 0), null);
  assert.equal(percentChange(100, null), null);
  assert.equal(percentChange(null, 100), null);
});
