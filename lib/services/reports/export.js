"use strict";

/**
 * Export d'un rapport (Phase 20, section "Export"). Deux formats minimum
 * requis : JSON (le rapport complet, tel que retourné par
 * aggregator.js#generateReport, sans transformation) et CSV (une ligne par
 * process — la partie du rapport qui se prête naturellement à un tableau ;
 * les sections résumé/capacity planning restent disponibles via le format
 * JSON, plus adapté à leur forme imbriquée).
 *
 * Pas de dépendance PDF ajoutée (voir prompt de phase : "PDF uniquement si
 * une solution propre existe déjà ou si la dépendance est raisonnable") —
 * aucune bibliothèque de génération PDF n'est déjà présente dans ce projet
 * (voir package.json), et en ajouter une uniquement pour l'export CSV/JSON
 * déjà couvert n'est pas justifié par la tâche.
 */

const CSV_COLUMNS = [
  ["processName", "process"],
  ["serverKey", "server"],
  ["availabilityPercent", "availability_percent"],
  ["crashes", "crashes"],
  ["restarts", "restarts"],
  ["cpuAvg", "cpu_avg_percent"],
  ["memoryAvg", "memory_avg_bytes"],
  ["downtimeMs", "downtime_ms"],
  ["alertCount", "alert_count"],
];

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** CSV du tableau `processes` du rapport (une ligne par process). */
function toCSV(report) {
  const header = CSV_COLUMNS.map(([, label]) => label).join(",");
  const rows = (report.processes || []).map((p) =>
    CSV_COLUMNS.map(([key]) => csvEscape(p[key])).join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

/** JSON du rapport complet — aucune perte d'information (summary, ranking, capacity planning). */
function toJSON(report) {
  return JSON.stringify(report, null, 2);
}

const FORMATS = ["json", "csv"];

function exportReport(report, format) {
  if (!FORMATS.includes(format)) {
    throw new Error(`Format d'export invalide: "${format}". Attendu: ${FORMATS.join(", ")}.`);
  }
  if (format === "csv") {
    return { contentType: "text/csv; charset=utf-8", filename: "report.csv", body: toCSV(report) };
  }
  return { contentType: "application/json; charset=utf-8", filename: "report.json", body: toJSON(report) };
}

module.exports = { FORMATS, CSV_COLUMNS, toCSV, toJSON, exportReport };
