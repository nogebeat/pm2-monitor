"use strict";

/**
 * Tampon circulaire en mémoire, très simple : {t, value} bornés par âge et
 * par nombre de points. Utilisé UNIQUEMENT comme filet de sécurité par
 * lib/services/anomaly-detection/service.js pour les métriques cpu/memory
 * d'un process, quand l'historique persistant
 * (lib/services/process-history/) est indisponible ou momentanément
 * insuffisant (service désactivé, ou tout juste démarré) — voir
 * "Limites connues" dans docs/anomaly-detection/README.md.
 *
 * Ce n'est PAS un second système de collecte : rien n'est jamais persisté
 * ici, la fenêtre reste bornée à `maxAgeMs`/`maxPoints`, et dès que
 * process-history redevient disponible avec assez d'échantillons, il
 * reprend automatiquement le dessus (voir service.js#_readProcessNumeric).
 */
class RingBuffer {
  constructor({ maxAgeMs, maxPoints = 2000 } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.maxPoints = maxPoints;
    this.points = [];
  }

  /** Étend la fenêtre si une règle avec un `windowMs` plus large la référence ensuite. */
  ensureMaxAge(maxAgeMs) {
    if (maxAgeMs > this.maxAgeMs) this.maxAgeMs = maxAgeMs;
  }

  push(t, value) {
    if (typeof value !== "number" || Number.isNaN(value)) return;
    this.points.push({ t, value });
    this._prune(t);
  }

  _prune(now) {
    const cutoff = now - this.maxAgeMs;
    while (this.points.length && this.points[0].t < cutoff) this.points.shift();
    while (this.points.length > this.maxPoints) this.points.shift();
  }

  /** Valeurs strictement antérieures à `t` (exclut l'échantillon qu'on est en train d'évaluer). */
  valuesBefore(t) {
    return this.points.filter((p) => p.t < t).map((p) => p.value);
  }
}

module.exports = { RingBuffer };
