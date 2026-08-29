"use strict";

/**
 * Résolution de la période d'un rapport (Phase 20 — Reports & Capacity
 * Planning). Fonction PURE (pas d'accès DB/horloge implicite : `now` est
 * injectable pour les tests, même convention que
 * lib/services/dashboard/global-status.js).
 *
 * Périodes prédéfinies volontairement "glissantes" (dernières 24h/7j/30j se
 * terminant à `now`), pas calées sur le calendrier (minuit local, lundi...) :
 * le reste du projet ne connaît aucune notion de fuseau horaire serveur
 * configurable (voir lib/history-store.js#query, mêmes plages "1h/6h/24h"
 * glissantes) — introduire un calage calendaire nécessiterait de choisir un
 * fuseau, ce qu'aucune autre fonctionnalité du monitor ne fait aujourd'hui.
 * `custom` reste le seul moyen d'obtenir une plage calée sur une date précise
 * (l'appelant fournit start/end explicitement).
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const PERIODS = ["daily", "weekly", "monthly", "custom"];

/**
 * @param {object} input
 * @param {string} input.period - "daily" | "weekly" | "monthly" | "custom"
 * @param {number|string} [input.start] - requis pour "custom" (epoch ms ou ISO)
 * @param {number|string} [input.end] - requis pour "custom" (epoch ms ou ISO), défaut = now
 * @param {number} [now] - epoch ms, défaut Date.now() (injectable pour les tests)
 * @returns {{ period: string, start: number, end: number }}
 */
function resolvePeriod(input = {}, now = Date.now()) {
  const period = input.period;
  if (!PERIODS.includes(period)) {
    throw new Error(`period invalide: "${period}". Attendu: ${PERIODS.join(", ")}.`);
  }

  if (period === "daily") return { period, start: now - DAY, end: now };
  if (period === "weekly") return { period, start: now - 7 * DAY, end: now };
  if (period === "monthly") return { period, start: now - 30 * DAY, end: now };

  // custom
  const start = toMs(input.start);
  const end = input.end !== undefined && input.end !== null && input.end !== "" ? toMs(input.end) : now;
  if (start === null || !Number.isFinite(start)) {
    throw new Error('start invalide pour period="custom" (epoch ms ou date ISO attendu).');
  }
  if (end === null || !Number.isFinite(end)) {
    throw new Error('end invalide pour period="custom" (epoch ms ou date ISO attendu).');
  }
  if (end <= start) {
    throw new Error("end doit être postérieur à start.");
  }
  return { period, start, end };
}

function toMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return value;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && String(value).trim() !== "") return asNumber;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = { PERIODS, resolvePeriod, HOUR, DAY };
