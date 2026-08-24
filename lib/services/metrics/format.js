"use strict";

/**
 * lib/services/metrics/format.js — Phase 15.
 *
 * Petites fonctions pures pour produire le format d'exposition Prometheus
 * (text-based, version 0.0.4 — https://prometheus.io/docs/instrumenting/exposition_formats/).
 * Volontairement écrit à la main plutôt que via une dépendance (prom-client) :
 * PM2 Monitor ne fait tourner aucun Registry/Collector Prometheus en continu,
 * seulement une conversion ponctuelle de métriques déjà calculées à chaque
 * scrape — un formatteur texte minimal suffit, pas besoin d'une dépendance
 * supplémentaire pour ça (voir règles communes : "N'ajoute une dépendance
 * que si elle est réellement nécessaire").
 */

/** Échappe une valeur de label selon la grammaire Prometheus (`\`, `"`, `\n`). */
function escapeLabelValue(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

/** @param {Record<string,string|number|null|undefined>} labels */
function formatLabels(labels) {
  const keys = Object.keys(labels || {}).filter((k) => labels[k] !== undefined && labels[k] !== null);
  if (!keys.length) return "";
  return `{${keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(",")}}`;
}

function formatValue(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "0";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

/**
 * Un accumulateur simple : `HELP`/`TYPE` écrits une seule fois par nom de
 * métrique (peu importe le nombre de séries), puis une ligne par série.
 * Ordre de sortie = ordre d'appel de metric()/help imbriqués — suffisant
 * pour un format texte non ordonné par spec.
 */
function createWriter() {
  const declared = new Set();
  const lines = [];

  /**
   * @param {string} name - nom de métrique Prometheus (snake_case, préfixé pm2_monitor_)
   * @param {"gauge"|"counter"} type
   * @param {string} help - description, une phrase
   */
  function declare(name, type, help) {
    if (declared.has(name)) return;
    declared.add(name);
    lines.push(`# HELP ${name} ${help.replace(/\n/g, " ")}`);
    lines.push(`# TYPE ${name} ${type}`);
  }

  /**
   * @param {string} name
   * @param {Record<string,string|number>} labels
   * @param {number} value
   */
  function sample(name, labels, value) {
    lines.push(`${name}${formatLabels(labels)} ${formatValue(value)}`);
  }

  /** Déclare puis écrit une seule série (raccourci pour les métriques à faible cardinalité). */
  function metric(name, type, help, labels, value) {
    declare(name, type, help);
    sample(name, labels, value);
  }

  function toString() {
    return `${lines.join("\n")}\n`;
  }

  return { declare, sample, metric, toString };
}

module.exports = { escapeLabelValue, formatLabels, formatValue, createWriter };
