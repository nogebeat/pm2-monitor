"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { linearRegression, computeProjection, MIN_POINTS } = require("../../lib/services/reports/capacity");

const DAY = 24 * 60 * 60 * 1000;

test("linearRegression() — null si moins de MIN_POINTS points", () => {
  const points = Array.from({ length: MIN_POINTS - 1 }, (_, i) => ({ t: i, value: i }));
  assert.equal(linearRegression(points), null);
});

test("linearRegression() — null si tous les points sont au même instant (t constant)", () => {
  const points = [
    { t: 100, value: 1 },
    { t: 100, value: 2 },
    { t: 100, value: 3 },
  ];
  assert.equal(linearRegression(points), null);
});

test("linearRegression() — retrouve une droite parfaite (R²=1)", () => {
  // value = 2 * t + 10, exactement
  const points = [0, 1, 2, 3, 4].map((t) => ({ t, value: 2 * t + 10 }));
  const reg = linearRegression(points);
  assert.ok(reg);
  assert.ok(Math.abs(reg.slope - 2) < 1e-9);
  assert.ok(Math.abs(reg.intercept - 10) < 1e-9);
  assert.ok(Math.abs(reg.r2 - 1) < 1e-9);
});

test("computeProjection() — tendance croissante : projette une date de dépassement future", () => {
  const now = 10 * DAY;
  // RAM % qui monte de 50 à 70 sur 10 jours (2%/jour), seuil 80 => encore 5 jours
  const points = Array.from({ length: 11 }, (_, i) => ({ t: i * DAY, value: 50 + i * 2 }));
  const result = computeProjection(points, { threshold: 80, now });

  assert.equal(result.currentValue, 70);
  assert.ok(result.projectedAt > now);
  assert.ok(result.daysUntilThreshold > 0);
  assert.notEqual(result.confidence, "insufficient_data");
});

test("computeProjection() — déjà au-dessus du seuil : daysUntilThreshold = 0", () => {
  const now = 5 * DAY;
  const points = Array.from({ length: 6 }, (_, i) => ({ t: i * DAY, value: 85 + i }));
  const result = computeProjection(points, { threshold: 80, now });
  assert.equal(result.confidence, "already_exceeded");
  assert.equal(result.daysUntilThreshold, 0);
});

test("computeProjection() — tendance stable/décroissante : pas de date projetée", () => {
  const now = 5 * DAY;
  const points = Array.from({ length: 6 }, (_, i) => ({ t: i * DAY, value: 50 - i * 3 }));
  const result = computeProjection(points, { threshold: 80, now });
  assert.equal(result.projectedAt, null);
  assert.equal(result.daysUntilThreshold, null);
});

test("computeProjection() — pas assez de données : confidence 'insufficient_data'", () => {
  const result = computeProjection([{ t: 0, value: 10 }], { threshold: 80 });
  assert.equal(result.confidence, "insufficient_data");
  assert.equal(result.projectedAt, null);
});

test("computeProjection() — horizon trop lointain (pente quasi nulle) : 'beyond_horizon'", () => {
  const now = 10 * DAY;
  // Progression infinitésimale : le seuil ne serait atteint que dans des décennies
  const points = Array.from({ length: 11 }, (_, i) => ({ t: i * DAY, value: 10 + i * 0.0000001 }));
  const result = computeProjection(points, { threshold: 80, now });
  assert.equal(result.confidence, "beyond_horizon");
  assert.equal(result.projectedAt, null);
});

test("computeProjection() — jamais une certitude : renvoie toujours sampleCount et r2 pour qualifier la confiance", () => {
  const now = 10 * DAY;
  const points = Array.from({ length: 11 }, (_, i) => ({ t: i * DAY, value: 50 + i * 2 }));
  const result = computeProjection(points, { threshold: 80, now });
  assert.equal(result.sampleCount, 11);
  assert.ok(typeof result.r2 === "number");
  assert.ok(["low", "medium", "high"].includes(result.confidence));
});
