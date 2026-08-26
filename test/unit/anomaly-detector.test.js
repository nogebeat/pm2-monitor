"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectAnomaly, explainDetection } = require("../../lib/services/anomaly-detection/detector");

// Historique "normal" : bruit léger autour de 50, jamais d'anomalie flagrante.
const NORMAL_HISTORY = [48, 50, 52, 49, 51, 50, 47, 53, 50, 49, 51, 48];

test("detectAnomaly() — données normales -> pas d'anomalie", () => {
  const d = detectAnomaly({ value: 51, history: NORMAL_HISTORY, sensitivity: 3, minSamples: 10 });
  assert.ok(d, "un verdict doit être produit (assez d'échantillons)");
  assert.equal(d.anomalous, false);
});

test("detectAnomaly() — donnée anormale (pic net) -> anomalie détectée avec direction 'above'", () => {
  const d = detectAnomaly({ value: 150, history: NORMAL_HISTORY, sensitivity: 3, minSamples: 10 });
  assert.ok(d);
  assert.equal(d.anomalous, true);
  assert.equal(d.direction, "above");
  assert.ok(d.absZScore >= 3);
  assert.ok(d.confidencePct > 90);
});

test("detectAnomaly() — chute anormale -> anomalie détectée avec direction 'below'", () => {
  const d = detectAnomaly({ value: -50, history: NORMAL_HISTORY, sensitivity: 3, minSamples: 10 });
  assert.ok(d);
  assert.equal(d.anomalous, true);
  assert.equal(d.direction, "below");
});

test("detectAnomaly() — données insuffisantes -> null (jamais de déclenchement)", () => {
  const tooFew = [50, 51, 49]; // 3 échantillons < minSamples
  const d = detectAnomaly({ value: 999, history: tooFew, sensitivity: 3, minSamples: 10 });
  assert.equal(d, null, "moins de minSamples échantillons -> aucun verdict, jamais d'anomalie");
});

test("detectAnomaly() — historique vide -> null", () => {
  assert.equal(detectAnomaly({ value: 50, history: [], sensitivity: 3, minSamples: 10 }), null);
});

test("detectAnomaly() — valeur manquante (null/NaN) -> null, jamais de faux positif", () => {
  assert.equal(detectAnomaly({ value: null, history: NORMAL_HISTORY, sensitivity: 3, minSamples: 10 }), null);
  assert.equal(
    detectAnomaly({ value: undefined, history: NORMAL_HISTORY, sensitivity: 3, minSamples: 10 }),
    null,
  );
  assert.equal(detectAnomaly({ value: NaN, history: NORMAL_HISTORY, sensitivity: 3, minSamples: 10 }), null);
});

test("detectAnomaly() — bruit (valeurs qui varient mais restent sous le seuil de sensibilité)", () => {
  // Historique volontairement plus dispersé : le bruit ne doit pas
  // déclencher tant que le z-score reste sous la sensibilité configurée.
  const noisy = [10, 40, 20, 55, 15, 45, 25, 50, 12, 48, 30, 42];
  const d = detectAnomaly({ value: 60, history: noisy, sensitivity: 3, minSamples: 10 });
  assert.ok(d);
  // 60 reste dans l'ordre de grandeur d'un historique très dispersé : ne
  // doit pas franchir un seuil de sensibilité élevé (3 écarts-types).
  assert.equal(d.anomalous, false, "une valeur dans la plage du bruit historique ne doit pas être une fausse alerte");
});

test("detectAnomaly() — sensibilité plus basse détecte des écarts plus fins (moins conservateur)", () => {
  const d = detectAnomaly({ value: 65, history: NORMAL_HISTORY, sensitivity: 1, minSamples: 10 });
  assert.ok(d);
  assert.equal(d.anomalous, true);
});

test("detectAnomaly() — écart-type nul dans l'historique (baseline constante)", () => {
  const flat = new Array(12).fill(50);
  const same = detectAnomaly({ value: 50, history: flat, sensitivity: 3, minSamples: 10 });
  assert.equal(same.anomalous, false, "valeur identique à une baseline totalement constante -> pas d'anomalie");

  const spike = detectAnomaly({ value: 80, history: flat, sensitivity: 3, minSamples: 10 });
  assert.equal(spike.anomalous, true, "tout écart par rapport à une baseline constante est anormal");
  assert.ok(Number.isFinite(spike.zscore), "jamais Infinity, même avec écart-type nul");
});

test("explainDetection() — toujours une explication non vide pour une détection anormale", () => {
  const d = detectAnomaly({ value: 150, history: NORMAL_HISTORY, sensitivity: 3, minSamples: 10 });
  const text = explainDetection(d, { metricLabel: "CPU", unit: "%" });
  assert.ok(text.length > 20);
  assert.ok(text.includes("CPU"));
  assert.ok(text.includes("écarts-types"));
});

test("explainDetection() — détection nulle -> chaîne vide, jamais d'erreur", () => {
  assert.equal(explainDetection(null), "");
});
