"use strict";

/**
 * Persistance de la table `anomaly_detections` : une ligne par détection
 * anormale effective (pas une par tick évalué — voir service.js), portant
 * tout le détail statistique nécessaire à l'affichage ("historique" demandé
 * par la tâche : métrique, valeur, baseline, confiance, explication).
 *
 * Aucune logique de décision ici (voir detector.js) : uniquement des
 * lectures/écritures, même séparation que lib/services/alerts/alert-store.js.
 */

const db = require("../../db");

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

function rowToDetection(row) {
  if (!row) return null;
  return {
    id: row.id,
    ruleId: row.rule_id,
    alertId: row.alert_id,
    targetType: row.target_type,
    targetValue: row.target_value,
    metric: row.metric,
    value: row.value !== null && row.value !== undefined ? Number(row.value) : null,
    baseline: row.baseline !== null && row.baseline !== undefined ? Number(row.baseline) : null,
    stddev: row.stddev !== null && row.stddev !== undefined ? Number(row.stddev) : null,
    zscore: row.zscore !== null && row.zscore !== undefined ? Number(row.zscore) : null,
    confidencePct:
      row.confidence_pct !== null && row.confidence_pct !== undefined ? Number(row.confidence_pct) : null,
    direction: row.direction,
    sampleCount: Number(row.sample_count) || 0,
    method: row.method,
    explanation: row.explanation,
    createdAt: Number(row.created_at),
  };
}

async function create(fields) {
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO anomaly_detections
      (rule_id, alert_id, target_type, target_value, metric, value, baseline, stddev, zscore,
       confidence_pct, direction, sample_count, method, explanation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.ruleId !== undefined ? fields.ruleId : null,
      fields.alertId !== undefined ? fields.alertId : null,
      fields.targetType,
      fields.targetValue || null,
      fields.metric,
      fields.value !== undefined && fields.value !== null ? Number(fields.value) : null,
      fields.baseline !== undefined && fields.baseline !== null ? Number(fields.baseline) : null,
      fields.stddev !== undefined && fields.stddev !== null ? Number(fields.stddev) : null,
      fields.zscore !== undefined && fields.zscore !== null ? Number(fields.zscore) : null,
      fields.confidencePct !== undefined && fields.confidencePct !== null
        ? Number(fields.confidencePct)
        : null,
      fields.direction || null,
      fields.sampleCount !== undefined ? Number(fields.sampleCount) : 0,
      fields.method || "zscore",
      fields.explanation || null,
      fields.createdAt || now,
    ],
  );
  return getById(result.lastID);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM anomaly_detections WHERE id = ?", [id]);
  return rowToDetection(row);
}

function buildWhere({ ruleId, alertId, targetType, targetValue, metric, startTs, endTs }) {
  const clauses = [];
  const params = [];
  if (ruleId !== undefined && ruleId !== null) {
    clauses.push("rule_id = ?");
    params.push(ruleId);
  }
  if (alertId !== undefined && alertId !== null) {
    clauses.push("alert_id = ?");
    params.push(alertId);
  }
  if (targetType) {
    clauses.push("target_type = ?");
    params.push(targetType);
  }
  if (targetValue) {
    clauses.push("target_value = ?");
    params.push(targetValue);
  }
  if (metric) {
    clauses.push("metric = ?");
    params.push(metric);
  }
  if (Number.isFinite(startTs)) {
    clauses.push("created_at >= ?");
    params.push(startTs);
  }
  if (Number.isFinite(endTs)) {
    clauses.push("created_at <= ?");
    params.push(endTs);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/**
 * Historique paginé, filtrable — même contrat que
 * lib/services/events/event-store.js#list (pagination obligatoire).
 * @returns {{ items: object[], total: number, limit: number, offset: number }}
 */
async function list({
  ruleId,
  alertId,
  targetType,
  targetValue,
  metric,
  startTs,
  endTs,
  limit = DEFAULT_LIMIT,
  offset = 0,
} = {}) {
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const { where, params } = buildWhere({ ruleId, alertId, targetType, targetValue, metric, startTs, endTs });

  const rows = await db.all(
    `SELECT * FROM anomaly_detections ${where} ORDER BY created_at DESC, id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  );
  const countRow = await db.get(`SELECT COUNT(*) AS n FROM anomaly_detections ${where}`, params);

  return {
    items: rows.map(rowToDetection),
    total: countRow ? Number(countRow.n) : 0,
    limit: safeLimit,
    offset: safeOffset,
  };
}

async function purgeOlderThan(cutoffTs) {
  const result = await db.run("DELETE FROM anomaly_detections WHERE created_at < ?", [cutoffTs]);
  return result.changes;
}

module.exports = { MAX_LIMIT, DEFAULT_LIMIT, create, getById, list, purgeOlderThan };
