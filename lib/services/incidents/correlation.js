"use strict";

/**
 * Corrélation déterministe (PAS d'IA, voir prompt de phase) : décide si une
 * alerte qui vient de se déclencher rejoint un incident déjà ouvert, ou en
 * ouvre un nouveau.
 *
 * Critères (dans cet ordre, le premier qui matche gagne) :
 *  1. même process (target_value) + même type de problème (metric), sur un
 *     incident ouvert (non RESOLVED) mis à jour dans la fenêtre temporelle
 *     (config.correlationWindowMs) — cas le plus fréquent (ex: CPU haut qui
 *     re-déclenche sur le même process avant que l'incident précédent ne
 *     soit résolu).
 *  2. même groupe de process (lib/services/process-organization/) + même
 *     type de problème, sur un incident ouvert dans la fenêtre — capture le
 *     cas "plusieurs process du même groupe tombent en même temps" (ex: tous
 *     les workers d'une queue).
 *  3. sinon : nouvel incident.
 *
 * "même serveur" (section Correlation du prompt de phase) est vérifié
 * implicitement : l'Alert Engine est mono-hôte (voir
 * lib/services/notifications/routing/engine.js, commentaire de tête sur
 * `conditions.server`), donc toute alerte de ce process partage déjà le même
 * serveur. Le champ existe néanmoins en vue d'une future Phase multi-serveur
 * pour l'Alert Engine lui-même.
 */

const incidentStore = require("./incident-store");
const { resolveConfig } = require("./config");

function buildCorrelationKey(targetType, targetValue, metric) {
  return `${targetType}:${targetValue || "system"}:${metric}`;
}

function incidentTitle(alert) {
  const target = alert.targetValue || "système";
  return `${alert.ruleName || alert.metric} — ${target}`;
}

class IncidentCorrelator {
  /**
   * @param {{ store?: import("./incident-store"), processOrgStore?: object, env?: object }} deps
   */
  constructor({ store, processOrgStore, env } = {}) {
    this.store = store || incidentStore;
    // Optionnel (comme processOrgStore dans RoutingEngine) : sans lui, le
    // critère "même groupe" ne s'applique jamais (repli sûr : corrélation
    // par process uniquement).
    this.processOrgStore = processOrgStore || null;
    this.config = resolveConfig(env || process.env);
  }

  async _resolveGroups(processName) {
    if (!this.processOrgStore || !processName) return [];
    try {
      const org = await this.processOrgStore.getOrganizationForProcess(processName);
      return (org && org.groups) || [];
    } catch (e) {
      console.error("Erreur de résolution des groupes de process (corrélation incident) :", e.message);
      return [];
    }
  }

  /**
   * Cherche, parmi les incidents ouverts sur la même métrique (fenêtre
   * temporelle comprise), un candidat dont le process partage au moins un
   * groupe avec celui de l'alerte — comparaison faite groupe par groupe
   * (pas via une clé de corrélation stockée, puisque l'appartenance à un
   * groupe est une relation N-N évaluée au moment de la corrélation, voir
   * lib/services/process-organization/).
   */
  async _findByGroup(alert, sinceTs) {
    if (alert.targetType !== "process" || !alert.targetValue) return null;
    const alertGroups = await this._resolveGroups(alert.targetValue);
    if (!alertGroups.length) return null;

    const candidates = await this.store.listOpenCandidatesByMetric("process", alert.metric, sinceTs);
    for (const candidate of candidates) {
      if (candidate.targetValue === alert.targetValue) continue; // déjà couvert par la clé directe
      const candidateGroups = await this._resolveGroups(candidate.targetValue);
      if (candidateGroups.some((g) => alertGroups.includes(g))) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * @param {object} alert - occurrence d'alerte tout juste passée "active" (alert-store.js#rowToAlert)
   * @returns {Promise<{incident: object, created: boolean}>}
   */
  async attach(alert) {
    const now = Date.now();
    const sinceTs = now - this.config.correlationWindowMs;

    const directKey = buildCorrelationKey(alert.targetType, alert.targetValue, alert.metric);
    let incident = await this.store.findOpenByCorrelationKey(directKey, sinceTs);

    if (!incident) {
      incident = await this._findByGroup(alert, sinceTs);
    }

    if (incident) {
      await this.store.linkAlert(incident.id, alert.id);
      incident = await this.store.bumpSeverity(incident.id, alert.severity);
      return { incident, created: false };
    }

    incident = await this.store.create({
      title: incidentTitle(alert),
      severity: alert.severity,
      targetType: alert.targetType,
      targetValue: alert.targetValue,
      metric: alert.metric,
      correlationKey: directKey,
      firstAlertId: alert.id,
    });
    await this.store.linkAlert(incident.id, alert.id);
    return { incident, created: true };
  }
}

module.exports = { IncidentCorrelator, buildCorrelationKey };
