"use strict";

/**
 * Timeline d'un incident (table `incident_timeline`, migration 016).
 *
 * Deux sources de données, jamais mélangées en écriture :
 *
 *  - des lignes NATIVES, propres à l'incident (changement d'état,
 *    acquittement, silence créé) : append() les écrit ici.
 *  - des lignes DÉRIVÉES, résolues à la LECTURE seulement en interrogeant
 *    les tables déjà existantes (alerts, process_events,
 *    notification_history, auto_healing_audit) — jamais copiées/dupliquées
 *    dans `incident_timeline` (voir prompt de phase : "Réutiliser les
 *    données existantes... Ne duplique pas inutilement les événements").
 *
 * list() fusionne les deux et trie par horodatage.
 */

const db = require("../../db");
const alertStore = require("../alerts/alert-store");
const eventStore = require("../events/event-store");
const autoHealingAuditStore = require("../auto-healing/audit-store");

function rowToEntry(row) {
  if (!row) return null;
  let metadata = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch (e) {
      metadata = null;
    }
  }
  return {
    id: `native:${row.id}`,
    incidentId: row.incident_id,
    ts: Number(row.ts),
    type: row.type,
    refTable: row.ref_table,
    refId: row.ref_id,
    actorUserId: row.actor_user_id,
    summary: row.summary,
    metadata,
    createdAt: Number(row.created_at),
  };
}

/**
 * @param {number} incidentId
 * @param {object} entry
 * @param {string} entry.type - ex: "state_change", "acknowledge", "silence_created"
 * @param {string} [entry.refTable]
 * @param {number} [entry.refId]
 * @param {number|null} [entry.actorUserId]
 * @param {string} [entry.summary]
 * @param {object} [entry.metadata]
 * @param {number} [entry.ts] - défaut Date.now()
 */
async function append(incidentId, entry) {
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO incident_timeline
      (incident_id, ts, type, ref_table, ref_id, actor_user_id, summary, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      incidentId,
      entry.ts || now,
      entry.type,
      entry.refTable || null,
      entry.refId !== undefined ? entry.refId : null,
      entry.actorUserId !== undefined ? entry.actorUserId : null,
      entry.summary || null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      now,
    ],
  );
  const row = await db.get("SELECT * FROM incident_timeline WHERE id = ?", [result.lastID]);
  return rowToEntry(row);
}

async function listNative(incidentId) {
  const rows = await db.all("SELECT * FROM incident_timeline WHERE incident_id = ? ORDER BY ts ASC, id ASC", [
    incidentId,
  ]);
  return rows.map(rowToEntry);
}

/**
 * Résout les entrées "alerte déclenchée"/"alerte résolue"/"health check" à
 * partir des alertes déjà rattachées à l'incident (table `alerts`,
 * lib/services/alerts/alert-store.js) — aucune donnée dupliquée, seule la
 * référence (incident_alerts.alert_id) est stockée. Retourne aussi la liste
 * des alertes elles-mêmes : réutilisée par list() pour dériver l'ensemble
 * des process concernés (voir deriveProcessEventEntries/deriveAutoHealingEntries
 * ci-dessous), qui ne doit pas se limiter au seul process de la toute
 * première alerte de l'incident quand une corrélation par GROUPE
 * (lib/services/incidents/correlation.js) a rattaché des alertes portant
 * sur d'autres process du même groupe.
 */
async function deriveAlertEntries(alertIds) {
  const entries = [];
  const alerts = [];
  for (const alertId of alertIds) {
    const alert = await alertStore.getById(alertId);
    if (!alert) continue;
    alerts.push(alert);
    const kind = alert.targetType === "health_check" ? "health_check" : "alert_triggered";
    entries.push({
      id: `alert:${alert.id}:triggered`,
      ts: alert.triggeredAt || alert.conditionMetAt || alert.createdAt,
      type: kind,
      refTable: "alerts",
      refId: alert.id,
      summary: `${alert.ruleName || alert.metric} — ${alert.targetValue || "system"} (${alert.severity})`,
      metadata: { severity: alert.severity, metric: alert.metric, value: alert.value },
    });
    if (alert.state === "resolved" && alert.resolvedAt) {
      entries.push({
        id: `alert:${alert.id}:resolved`,
        ts: alert.resolvedAt,
        type: "resolution",
        refTable: "alerts",
        refId: alert.id,
        summary: `${alert.ruleName || alert.metric} — résolue`,
        metadata: { severity: alert.severity, metric: alert.metric },
      });
    }
  }
  return { entries, alerts };
}

/**
 * Noms de process distincts parmi les alertes rattachées (targetType
 * "process" uniquement) — union du process "principal" de l'incident et de
 * tout autre process qu'une corrélation par groupe y aurait rattaché.
 */
function distinctProcessNames(incident, alerts) {
  const names = new Set();
  if (incident.targetType === "process" && incident.targetValue) names.add(incident.targetValue);
  for (const alert of alerts) {
    if (alert.targetType === "process" && alert.targetValue) names.add(alert.targetValue);
  }
  return [...names];
}

/**
 * Événements PM2 (process_events) survenus sur l'un des process de
 * l'incident (voir distinctProcessNames) pendant sa durée de vie.
 */
async function deriveProcessEventEntries({ processNames, startTs, endTs }) {
  if (!processNames.length) return [];
  try {
    const results = await Promise.all(
      processNames.map((processName) =>
        eventStore.list({ process: processName, startTs, endTs: endTs || Date.now(), limit: 100 }),
      ),
    );
    const seen = new Set();
    const entries = [];
    for (const { items } of results) {
      for (const ev of items) {
        if (seen.has(ev.id)) continue; // dédoublonne si un événement matcherait plusieurs requêtes
        seen.add(ev.id);
        entries.push({
          id: `process_event:${ev.id}`,
          ts: ev.timestamp,
          type: "process_event",
          refTable: "process_events",
          refId: ev.id,
          summary: `${ev.process} — ${ev.type}${ev.exitCode !== null ? ` (exit ${ev.exitCode})` : ""}`,
          metadata: { severity: ev.severity, eventType: ev.type },
        });
      }
    }
    return entries;
  } catch (e) {
    console.error("Erreur de résolution des événements PM2 (timeline incident) :", e.message);
    return [];
  }
}

/** Notifications envoyées pour les alertes rattachées (notification_history.alert_id). */
async function deriveNotificationEntries(alertIds) {
  if (!alertIds.length) return [];
  try {
    const placeholders = alertIds.map(() => "?").join(", ");
    const rows = await db.all(
      `SELECT * FROM notification_history WHERE alert_id IN (${placeholders}) ORDER BY ts ASC`,
      alertIds,
    );
    return rows.map((row) => ({
      id: `notification:${row.id}`,
      ts: Number(row.ts),
      type: "notification",
      refTable: "notification_history",
      refId: row.id,
      summary: `Notification — ${row.status}${row.error_code ? ` (${row.error_code})` : ""}`,
      metadata: { status: row.status, providerId: row.provider_id },
    }));
  } catch (e) {
    console.error("Erreur de résolution des notifications (timeline incident) :", e.message);
    return [];
  }
}

/**
 * Tentatives d'Auto-Healing (auto_healing_audit) sur l'un des process de
 * l'incident (voir distinctProcessNames) pendant sa durée de vie.
 */
async function deriveAutoHealingEntries({ processNames, startTs, endTs }) {
  if (!processNames.length) return [];
  try {
    const from = startTs;
    const to = endTs || Date.now();
    const results = await Promise.all(
      processNames.map((processName) => autoHealingAuditStore.list({ processName, limit: 200 })),
    );
    const seen = new Set();
    const entries = [];
    for (const items of results) {
      for (const row of items) {
        if (seen.has(row.id)) continue;
        if (row.createdAt < from || row.createdAt > to) continue;
        seen.add(row.id);
        entries.push({
          id: `auto_healing:${row.id}`,
          ts: row.createdAt,
          type: "auto_healing",
          refTable: "auto_healing_audit",
          refId: row.id,
          summary: `Auto-Healing — ${row.action} (${row.result})`,
          metadata: { action: row.action, result: row.result, reason: row.reason },
        });
      }
    }
    return entries;
  } catch (e) {
    console.error("Erreur de résolution de l'audit Auto-Healing (timeline incident) :", e.message);
    return [];
  }
}

/**
 * Timeline complète et triée d'un incident : lignes natives (état, ack,
 * silence) + lignes dérivées (alerte, événement PM2, notification,
 * auto-healing), sans aucune duplication en base. Les entrées "événement
 * PM2"/"auto-healing" couvrent TOUS les process rattachés à l'incident (pas
 * seulement celui de sa toute première alerte), pour rester cohérentes avec
 * une corrélation par groupe (lib/services/incidents/correlation.js).
 */
async function list(incident, alertIds) {
  const startTs = incident.openedAt;
  const endTs = incident.resolvedAt || Date.now();

  const [native, { entries: alertEntries, alerts }, notificationEntries] = await Promise.all([
    listNative(incident.id),
    deriveAlertEntries(alertIds),
    deriveNotificationEntries(alertIds),
  ]);

  const processNames = distinctProcessNames(incident, alerts);
  const [processEventEntries, autoHealingEntries] = await Promise.all([
    deriveProcessEventEntries({ processNames, startTs, endTs }),
    deriveAutoHealingEntries({ processNames, startTs, endTs }),
  ]);

  return [
    ...native,
    ...alertEntries,
    ...processEventEntries,
    ...notificationEntries,
    ...autoHealingEntries,
  ].sort((a, b) => a.ts - b.ts);
}

module.exports = { append, listNative, list };
