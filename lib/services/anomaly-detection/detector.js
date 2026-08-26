"use strict";

/**
 * Cœur de la détection : transforme une valeur observée + un historique en
 * verdict statistique. Fonction pure (pas de DB, pas d'horloge implicite) —
 * testable avec de simples tableaux de nombres (voir
 * test/unit/anomaly-detector.test.js).
 *
 * Méthode : z-score par rapport à une baseline (moyenne mobile + écart-type)
 * calculée sur l'historique fourni, complété d'une comparaison à la période
 * précédente (percentChange) à titre d'information supplémentaire dans
 * l'explication — la décision elle-même reste basée sur le z-score, plus
 * robuste au bruit qu'une simple comparaison à un seul point précédent.
 *
 * Ne déclenche JAMAIS sur des données insuffisantes : si `history.length <
 * minSamples`, retourne `null` (pas de verdict du tout), à charge de
 * l'appelant de ne rien évaluer dans ce cas — voir service.js.
 */

const { mean, stddev, zScore, confidenceFromZScore, percentChange } = require("./math");

/**
 * @param {object} params
 * @param {number} params.value - valeur observée à évaluer
 * @param {number[]} params.history - échantillons historiques (baseline), value exclue
 * @param {number} params.sensitivity - seuil de z-score (écarts-types) à partir duquel anomalous=true
 * @param {number} params.minSamples - échantillons minimum requis dans `history`
 * @param {number|null} [params.previousPeriodValue] - valeur agrégée de la période précédente (comparaison complémentaire)
 * @returns {?object} null si données insuffisantes, sinon le verdict complet
 */
function detectAnomaly({ value, history, sensitivity, minSamples, previousPeriodValue = null }) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (!Array.isArray(history)) return null;

  const clean = history.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (clean.length < Math.max(1, Number(minSamples) || 1)) return null; // données insuffisantes -> pas de verdict

  const baseline = mean(clean);
  const sd = stddev(clean, baseline);
  const rawZ = zScore(value, baseline, sd);
  const absZ = Math.abs(rawZ);
  const effectiveSensitivity = Number(sensitivity) || 0;

  return {
    value,
    baseline,
    stddev: sd,
    zscore: rawZ,
    absZScore: absZ,
    sampleCount: clean.length,
    direction: rawZ >= 0 ? "above" : "below",
    anomalous: absZ >= effectiveSensitivity,
    confidencePct: confidenceFromZScore(rawZ),
    previousPeriodChangePct: percentChange(value, previousPeriodValue),
  };
}

/**
 * Explication en langage naturel, toujours produite pour une détection
 * anormale (exigence explicite de la tâche : "toujours expliquer pourquoi").
 * `metricLabel`/`unit` restent volontairement simples (pas d'i18n ici — même
 * choix que les autres messages générés côté serveur, ex: lib/services/
 * alerts/, l'i18n frontend ne traduit que les libellés d'UI statiques).
 */
function explainDetection(detection, { metricLabel, unit = "" } = {}) {
  if (!detection) return "";
  const dir = detection.direction === "above" ? "au-dessus" : "en-dessous";
  const fmt = (n) => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
  const conf = detection.confidencePct !== null ? `${fmt(detection.confidencePct)}%` : "n/d";

  return (
    `${metricLabel} à ${fmt(detection.value)}${unit} est ${dir} de la baseline historique ` +
    `(moyenne ${fmt(detection.baseline)}${unit}, écart-type ${fmt(detection.stddev)}${unit}, ` +
    `${detection.sampleCount} échantillons) — écart de ${fmt(detection.absZScore)} écarts-types (z-score), ` +
    `confiance statistique ~${conf}.`
  );
}

module.exports = { detectAnomaly, explainDetection };
