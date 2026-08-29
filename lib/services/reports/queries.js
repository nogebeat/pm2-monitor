"use strict";

/**
 * Lectures agrégées, en lecture seule, sur les tables déjà existantes
 * (`alerts`, `incidents`, `notification_history`, `auto_healing_audit`,
 * `health_checks`) pour construire un rapport sur une période — même
 * principe que lib/services/backup/sections.js (Phase 19), qui lit
 * plusieurs domaines directement via lib/db plutôt que de dupliquer la
 * logique métier de chaque store, parce que les stores existants
 * (alert-store.js#listHistory, incident-store.js#list,
 * auto-healing/audit-store.js#list...) n'exposent pas la combinaison de
 * filtres (plage de temps + scope de process) dont un rapport a besoin.
 *
 * Aucune écriture ici, et aucune nouvelle table : ce module ne fait que
 * lire ce que les moteurs existants (Alert Engine, Incidents, Notifications,
 * Auto-Healing) ont déjà persisté.
 */

const db = require("../../db");

/** IN (...) avec placeholders, ou une clause toujours fausse si la liste est vide. */
function inClause(column, values) {
  if (!values || !values.length) return { sql: "0", params: [] };
  return { sql: `${column} IN (${values.map(() => "?").join(", ")})`, params: values.slice() };
}

/**
 * Alertes déclenchées pendant [start, end]. Filtrées par process quand
 * `processNames` est fourni : une alerte cible un process
 * (target_type='process') reste dans le scope seulement si son
 * target_value est dans la liste ; les alertes système/health-check
 * (target_type != 'process') ne sont jamais exclues par un filtre process
 * (elles n'ont pas de notion de process).
 */
async function alertsInPeriod({ start, end, processNames } = {}) {
  const params = [start, end];
  let sql = `SELECT * FROM alerts WHERE triggered_at IS NOT NULL AND triggered_at >= ? AND triggered_at <= ?`;
  if (processNames && processNames.length) {
    const clause = inClause("target_value", processNames);
    sql += ` AND (target_type != 'process' OR (${clause.sql}))`;
    params.push(...clause.params);
  }
  sql += ` ORDER BY triggered_at ASC`;
  return db.all(sql, params);
}

/** Incidents ouverts pendant [start, end], mêmes règles de filtrage process que alertsInPeriod(). */
async function incidentsInPeriod({ start, end, processNames } = {}) {
  const params = [start, end];
  let sql = `SELECT * FROM incidents WHERE opened_at >= ? AND opened_at <= ?`;
  if (processNames && processNames.length) {
    const clause = inClause("target_value", processNames);
    sql += ` AND (target_type != 'process' OR (${clause.sql}))`;
    params.push(...clause.params);
  }
  sql += ` ORDER BY opened_at ASC`;
  return db.all(sql, params);
}

/**
 * Notifications envoyées pendant [start, end]. Rattachées à un process via
 * l'alerte qui les a déclenchées (`notification_history.alert_id ->
 * alerts.target_value`, voir 006_notifications.js) — une notification sans
 * alerte (ex: test manuel) reste incluse tant qu'aucun filtre process n'est
 * demandé, ou exclue sinon (elle ne peut pas être attribuée à un process).
 */
async function notificationsInPeriod({ start, end, processNames } = {}) {
  const params = [start, end];
  let sql = `
    SELECT nh.*, a.target_type AS alert_target_type, a.target_value AS alert_target_value
    FROM notification_history nh
    LEFT JOIN alerts a ON a.id = nh.alert_id
    WHERE nh.ts >= ? AND nh.ts <= ?`;
  if (processNames && processNames.length) {
    const clause = inClause("a.target_value", processNames);
    sql += ` AND a.target_type = 'process' AND (${clause.sql})`;
    params.push(...clause.params);
  }
  sql += ` ORDER BY nh.ts ASC`;
  return db.all(sql, params);
}

/** Tentatives Auto-Healing pendant [start, end], filtrées par process_name (colonne directe). */
async function autoHealingInPeriod({ start, end, processNames } = {}) {
  const params = [start, end];
  let sql = `SELECT * FROM auto_healing_audit WHERE created_at >= ? AND created_at <= ?`;
  if (processNames && processNames.length) {
    const clause = inClause("process_name", processNames);
    sql += ` AND (${clause.sql})`;
    params.push(...clause.params);
  }
  sql += ` ORDER BY created_at ASC`;
  return db.all(sql, params);
}

module.exports = { alertsInPeriod, incidentsInPeriod, notificationsInPeriod, autoHealingInPeriod };
