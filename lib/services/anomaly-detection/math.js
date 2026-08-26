"use strict";

/**
 * Fonctions statistiques pures — aucune dépendance DB/PM2, testables isolément.
 * Volontairement des méthodes simples et explicables (moyenne mobile,
 * écart-type, z-score), comme demandé par la tâche : pas de modèle ML.
 */

/** Moyenne arithmétique. `[]` -> null (pas de division par zéro silencieuse). */
function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Écart-type (population, pas échantillon corrigé — cohérent avec un usage "baseline", pas inférentiel). */
function stddev(values, avg = mean(values)) {
  if (!Array.isArray(values) || values.length === 0 || avg === null) return null;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * z-score signé de `value` par rapport à une baseline (moyenne + écart-type).
 * Cas particulier écart-type = 0 (baseline parfaitement constante) : tout
 * écart, même minime, serait mathématiquement "infiniment" anormal — on
 * plafonne au lieu de renvoyer Infinity, pour rester exploitable par
 * l'appelant (comparaison à un seuil de sensibilité fini).
 */
const ZERO_STDDEV_CAP = 8;
function zScore(value, avg, sd) {
  if (avg === null || avg === undefined || sd === null || sd === undefined) return null;
  if (sd === 0) {
    if (value === avg) return 0;
    return value > avg ? ZERO_STDDEV_CAP : -ZERO_STDDEV_CAP;
  }
  return (value - avg) / sd;
}

/**
 * Approximation de la fonction d'erreur (Abramowitz & Stegun 7.1.26),
 * précision ~1.5e-7 — largement suffisante pour une confiance affichée à
 * l'utilisateur (pas un calcul scientifique).
 */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Confiance approximative (%) qu'un écart de |z| écarts-types ne soit PAS
 * du bruit, sous hypothèse (simplificatrice) de distribution normale —
 * cf. règle des 68-95-99.7. Bornée à [0, 99.9] pour éviter d'afficher
 * "100% de confiance" (jamais vrai en pratique avec un échantillon fini).
 */
function confidenceFromZScore(z) {
  if (z === null || z === undefined || Number.isNaN(z)) return null;
  const twoTailed = erf(Math.abs(z) / Math.SQRT2);
  return Math.min(99.9, Math.round(twoTailed * 1000) / 10);
}

/** Variation en % entre deux valeurs (période courante vs période précédente). null si référence nulle/absente. */
function percentChange(current, previous) {
  if (previous === null || previous === undefined || previous === 0) return null;
  if (current === null || current === undefined) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

module.exports = { mean, stddev, zScore, confidenceFromZScore, percentChange, ZERO_STDDEV_CAP };
