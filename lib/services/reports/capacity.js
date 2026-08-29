"use strict";

/**
 * Capacity Planning (Phase 20) — projections simples basées sur l'historique
 * déjà collecté (aucune nouvelle collecte de données). Méthode statistique
 * volontairement EXPLICABLE plutôt que "boîte noire" (voir prompt de phase :
 * "Utiliser des méthodes statistiques explicables") : régression linéaire
 * simple (moindres carrés) sur la série {t, value}, comme un humain la
 * tracerait à la main sur un graphique. Pas de modèle de saisonnalité, pas
 * de lissage exponentiel, pas de dépendance externe — juste une droite.
 *
 * Fonctions PURES (aucun accès DB ici, voir aggregator.js pour la lecture
 * des séries depuis process-history/history-store) — testables en isolation,
 * même approche que lib/services/dashboard/global-status.js.
 *
 * Une projection n'est JAMAIS présentée comme une certitude (voir prompt de
 * phase) : `computeProjection()` retourne toujours, en plus de la date
 * projetée, la pente, le nombre de points utilisés et le coefficient de
 * détermination (R²) — pour que l'UI/l'API puisse qualifier la fiabilité
 * ("tendance faible", "peu de données"...) plutôt que d'afficher une seule
 * date comme un fait acquis.
 */

const MIN_POINTS = 3; // en dessous, une droite n'a aucun sens statistique

/**
 * Régression linéaire simple (moindres carrés) : value ≈ slope * t + intercept.
 * `t` est utilisé tel quel (pas de normalisation) : les appelants passent
 * des epoch ms, ce qui reste numériquement stable en JS (Number) pour les
 * plages de temps couvertes par ce projet (jusqu'à 365 jours, voir
 * process-history/config.js#longRetentionMs).
 *
 * @param {Array<{t: number, value: number}>} points
 * @returns {{slope: number, intercept: number, r2: number}|null} null si pas assez de points ou t constant
 */
function linearRegression(points) {
  const clean = (points || []).filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.value));
  if (clean.length < MIN_POINTS) return null;

  const n = clean.length;
  const sumT = clean.reduce((a, p) => a + p.t, 0);
  const sumV = clean.reduce((a, p) => a + p.value, 0);
  const meanT = sumT / n;
  const meanV = sumV / n;

  let num = 0;
  let den = 0;
  for (const p of clean) {
    num += (p.t - meanT) * (p.value - meanV);
    den += (p.t - meanT) * (p.t - meanT);
  }
  if (den === 0) return null; // tous les points au même instant : pas de tendance calculable

  const slope = num / den;
  const intercept = meanV - slope * meanT;

  // R² : proportion de la variance de `value` expliquée par la droite.
  let ssRes = 0;
  let ssTot = 0;
  for (const p of clean) {
    const predicted = slope * p.t + intercept;
    ssRes += (p.value - predicted) ** 2;
    ssTot += (p.value - meanV) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  return { slope, intercept, r2 };
}

/**
 * Projette la date à laquelle `value` atteindrait `threshold`, en
 * prolongeant la droite de régression au-delà du dernier point observé.
 *
 * @param {Array<{t: number, value: number}>} points - série chronologique (ex: RAM % dans le temps)
 * @param {object} [opts]
 * @param {number} [opts.threshold] - seuil à projeter (défaut 80, même unité que `value`)
 * @param {number} [opts.now] - epoch ms de référence pour "dans N jours" (défaut Date.now())
 * @param {number} [opts.maxHorizonMs] - au-delà, la projection est jugée non significative
 *   (défaut 2 ans : extrapoler une droite sur 30j d'historique à 20 ans n'a aucun sens)
 * @returns {object} voir description des champs ci-dessous
 */
function computeProjection(points, opts = {}) {
  const threshold = opts.threshold ?? 80;
  const now = opts.now ?? Date.now();
  const maxHorizonMs = opts.maxHorizonMs ?? 2 * 365 * 24 * 60 * 60 * 1000;

  const clean = (points || []).filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.value));
  const lastPoint = clean.length ? clean.reduce((a, b) => (b.t > a.t ? b : a)) : null;
  const currentValue = lastPoint ? lastPoint.value : null;

  const reg = linearRegression(clean);

  const base = {
    threshold,
    sampleCount: clean.length,
    currentValue,
    slope: reg ? reg.slope : null, // unité de value / ms — voir slopePerDay pour une valeur lisible
    slopePerDay: reg ? reg.slope * 24 * 60 * 60 * 1000 : null,
    r2: reg ? Math.round(reg.r2 * 1000) / 1000 : null,
    projectedAt: null,
    daysUntilThreshold: null,
    confidence: "insufficient_data",
  };

  if (!reg) return base;

  if (currentValue !== null && currentValue >= threshold) {
    // Déjà au-dessus du seuil : pas de "date future" à projeter, on le signale tel quel.
    return { ...base, projectedAt: now, daysUntilThreshold: 0, confidence: "already_exceeded" };
  }

  if (reg.slope <= 0) {
    // Tendance stable ou décroissante : aucun dépassement projeté à partir de cette droite.
    return { ...base, confidence: reg.r2 >= 0.3 ? "stable_or_decreasing" : "insufficient_data" };
  }

  // t tel que slope * t + intercept = threshold
  const tThreshold = (threshold - reg.intercept) / reg.slope;
  const horizonMs = tThreshold - now;

  if (!Number.isFinite(horizonMs) || horizonMs < 0 || horizonMs > maxHorizonMs) {
    return { ...base, confidence: "beyond_horizon" };
  }

  const daysUntilThreshold = Math.round((horizonMs / (24 * 60 * 60 * 1000)) * 10) / 10;

  // Confiance qualitative — jamais présentée comme une certitude (voir en-tête
  // de fichier) : R² faible ou peu de points => confiance "low", jamais "high"
  // même si la droite semble propre, sous MIN_POINTS + quelques marges.
  let confidence = "low";
  if (reg.r2 >= 0.6 && clean.length >= 10) confidence = "high";
  else if (reg.r2 >= 0.3 && clean.length >= 5) confidence = "medium";

  return { ...base, projectedAt: Math.round(tThreshold), daysUntilThreshold, confidence };
}

module.exports = { MIN_POINTS, linearRegression, computeProjection };
