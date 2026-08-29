"use strict";

/**
 * Classement des process les plus problématiques (Phase 20, section
 * "Process ranking"). Fonction PURE : prend en entrée les statistiques déjà
 * calculées par aggregator.js (une ligne par process) et ne fait que trier —
 * aucun accès DB ici, même séparation que lib/services/incidents/correlation.js
 * (logique pure) vs incident-store.js (accès DB).
 */

/**
 * @typedef {object} ProcessRankingEntry
 * @property {string} processName
 * @property {string} serverKey
 * @property {number} crashes
 * @property {number} restarts
 * @property {number|null} cpuAvg
 * @property {number|null} memoryAvg
 * @property {number} downtimeMs
 * @property {number} alertCount
 */

const CRITERIA = ["crashes", "restarts", "cpu", "ram", "downtime", "alertCount"];

const ACCESSORS = {
  crashes: (e) => e.crashes || 0,
  restarts: (e) => e.restarts || 0,
  cpu: (e) => e.cpuAvg ?? -Infinity,
  ram: (e) => e.memoryAvg ?? -Infinity,
  downtime: (e) => e.downtimeMs || 0,
  alertCount: (e) => e.alertCount || 0,
};

/**
 * @param {ProcessRankingEntry[]} entries
 * @param {object} [opts]
 * @param {number} [opts.limit] - défaut 10
 * @returns {{ [criterion: string]: ProcessRankingEntry[] }} un classement top-N par critère
 */
function rankByAllCriteria(entries, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 10);
  const result = {};
  for (const criterion of CRITERIA) {
    result[criterion] = rankBy(entries, criterion, limit);
  }
  return result;
}

/** Top-N process pour UN critère donné, ordre décroissant. */
function rankBy(entries, criterion, limit = 10) {
  if (!CRITERIA.includes(criterion)) {
    throw new Error(`Critère de classement invalide: "${criterion}". Attendu: ${CRITERIA.join(", ")}.`);
  }
  const accessor = ACCESSORS[criterion];
  return [...(entries || [])]
    .filter((e) => Number.isFinite(accessor(e)) && accessor(e) !== -Infinity)
    .sort((a, b) => accessor(b) - accessor(a))
    .slice(0, limit);
}

module.exports = { CRITERIA, rankByAllCriteria, rankBy };
