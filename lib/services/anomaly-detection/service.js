"use strict";

/**
 * AnomalyDetectionService — orchestre la détection statistique et
 * l'alimente dans le moteur d'alertes EXISTANT (lib/services/alerts/engine.js)
 * comme un nouveau type de signal, comme demandé par la tâche
 * ("Une anomalie peut alimenter Alert Engine comme nouveau type de signal.
 * Ne crée pas un deuxième moteur d'alertes.") :
 *
 *  - Pour chaque règle d'anomalie activée, on calcule un z-score (detector.js)
 *    à partir d'un historique déjà collecté ailleurs (readers.js), avec un
 *    filet de sécurité en mémoire (ring-buffer.js) pour cpu/memory process
 *    quand l'historique persistant est indisponible/insuffisant.
 *  - Ce z-score est ensuite passé à `alertEngine.evaluate(rule, target, value)`
 *    — la même méthode que pour une règle d'alerte classique — via une
 *    "règle virtuelle" construite à la volée (jamais stockée dans
 *    `alert_rules`) : operator=">", threshold=sensibilité, value=|z-score|.
 *    L'engine gère alors lui-même trigger/active/resolved/acknowledge,
 *    déduplication et cooldown, EXACTEMENT comme pour cpu/memory/restart_count
 *    classiques — aucune logique de cycle de vie d'alerte dupliquée ici.
 *  - Le résultat (transition d'alerte ou null) part vers
 *    dispatchAlertTransition (lib/alert-dispatch.js) comme n'importe quelle
 *    autre alerte : notifications, websocket dashboard, auto-healing,
 *    corrélation d'incidents fonctionnent donc automatiquement, sans code
 *    supplémentaire (voir lib/polling.js pour le branchement).
 *  - Pendant qu'une occurrence reste ouverte, sa sévérité peut être
 *    escaladée (jamais rétrogradée) si le z-score continue de s'aggraver —
 *    voir _escalateSeverityIfNeeded(), qui réutilise alertStore.update()
 *    (aucune logique de cycle de vie ajoutée dans engine.js).
 *
 * La "règle virtuelle" a `id: null` : elle n'est PAS insérée dans
 * `alert_rules` (colonne `alerts.rule_id` a une contrainte de clé étrangère
 * vers cette table — y mettre l'id d'une `anomaly_rules` casserait cette
 * contrainte). L'unicité de déduplication par règle d'anomalie est assurée
 * autrement : le nom de métrique synthétique embarque l'id de la règle
 * d'anomalie (`${metric}_anomaly_${rule.id}`), donc deux règles distinctes
 * sur la même cible/métrique ne se marchent jamais dessus.
 */

const { detectAnomaly, explainDetection } = require("./detector");
const { readSystemSeries, readProcessNumericSeries, readCountSeries, isCountMetric } = require("./readers");
const { RingBuffer } = require("./ring-buffer");

const METRIC_LABELS = {
  cpu: "CPU",
  memory: "Mémoire",
  disk: "Disque",
  restart_rate: "Taux de restart",
  crash_rate: "Taux de crash",
  event_rate: "Taux d'événements",
};
const METRIC_UNITS = { cpu: "%", memory: " Mo", disk: "%" };

// Escalade de sévérité (voir _escalateSeverityIfNeeded) : jamais rétrogradée
// tant que l'occurrence reste ouverte, seulement remontée si le z-score
// s'aggrave nettement par rapport à la sensibilité configurée.
const SEVERITY_ORDER = ["info", "warning", "critical"];
const ESCALATE_TO_CRITICAL_RATIO = 2; // |z| >= 2x la sensibilité -> critical

function buildSyntheticRule(rule) {
  return {
    id: null, // volontairement null (voir en-tête de fichier) : jamais stocké dans alert_rules
    name: rule.name,
    enabled: true,
    targetType: rule.targetType,
    targetValue: rule.targetValue,
    metric: `${rule.metric}_anomaly_${rule.id}`,
    operator: ">",
    threshold: rule.sensitivity,
    durationSeconds: 0,
    severity: rule.severity,
    cooldownSeconds: rule.cooldownSeconds,
  };
}

/** Sévérité "méritée" par l'ampleur actuelle de l'écart, sans jamais descendre sous rule.severity. */
function severityForZScore(absZScore, sensitivity, baseSeverity) {
  if (sensitivity > 0 && absZScore >= sensitivity * ESCALATE_TO_CRITICAL_RATIO) return "critical";
  return baseSeverity;
}

const OPEN_STATES = ["trigger", "active", "acknowledged"];

class AnomalyDetectionService {
  constructor({ ruleStore, detectionStore, alertEngine, historyStore, processHistoryStore, eventStore, now } = {}) {
    this.ruleStore = ruleStore || require("./rules-store");
    this.detectionStore = detectionStore || require("./detections-store");
    this.alertEngine = alertEngine || require("../alerts").engine;
    this.historyStore = historyStore || null; // injecté depuis server.js (lib/history-store.js)
    this.processHistoryStore = processHistoryStore || null; // injecté (lib/services/process-history/store.js)
    this.eventStore = eventStore || null; // injecté (lib/services/events/event-store.js)
    this.now = now || (() => Date.now());
    // Filet de sécurité cpu/memory process (voir ring-buffer.js) : une
    // RingBuffer par clé "metric:targetValue", jamais persistée.
    this._processFallbackBuffers = new Map();
  }

  /** Évalue toutes les règles "system" activées contre un snapshot lib/system-stats.js. */
  async evaluateSystemReading(snapshot) {
    const rules = await this.ruleStore.listEnabledByTargetType("system");
    const results = [];
    for (const rule of rules) {
      const reading = isCountMetric(rule.metric)
        ?  
          await readCountSeries({
            rule,
            targetType: "system",
            targetValue: null,
            eventStore: this.eventStore,
            now: this.now(),
          })
        : readSystemSeries({ rule, snapshot, historyStore: this.historyStore, now: this.now() });
       
      const result = await this._evaluateReading(rule, "system", reading);
      if (result) results.push(result);
    }
    return results;
  }

  /** Évalue toutes les règles "process" activées contre une liste de process formatés (fmtProcess()). */
  async evaluateProcessReadings(processList) {
    const rules = await this.ruleStore.listEnabledByTargetType("process");
    const results = [];
    for (const rule of rules) {
      const targets =
        rule.targetValue && rule.targetValue !== "*"
          ? processList.filter((p) => p.name === rule.targetValue)
          : processList;
      for (const proc of targets) {
        const reading = isCountMetric(rule.metric)
          ?  
            await readCountSeries({
              rule,
              targetType: "process",
              targetValue: proc.name,
              eventStore: this.eventStore,
              now: this.now(),
            })
          :  
            await this._readProcessNumericWithFallback(rule, proc);
         
        const result = await this._evaluateReading(rule, proc.name, reading);
        if (result) results.push(result);
      }
    }
    return results;
  }

  /**
   * cpu/memory process : `readProcessNumericSeries` (process-history, DB)
   * en source principale ; si indisponible ou en-dessous de `minSamples`,
   * complète avec un historique en mémoire, alimenté par cette même
   * méthode à chaque appel (voir ring-buffer.js — jamais un second système
   * de collecte persistante, juste un filet de sécurité local au process).
   */
  async _readProcessNumericWithFallback(rule, proc) {
    const now = this.now();
    const reading = await readProcessNumericSeries({
      rule,
      proc,
      processHistoryStore: this.processHistoryStore,
      now,
    });
    if (!reading || reading.value === null || reading.value === undefined) return reading;

    const key = `${rule.metric}:${proc.name}`;
    let buffer = this._processFallbackBuffers.get(key);
    if (!buffer) {
      buffer = new RingBuffer({ maxAgeMs: rule.windowMs });
      this._processFallbackBuffers.set(key, buffer);
    } else {
      buffer.ensureMaxAge(rule.windowMs);
    }
    buffer.push(now, reading.value);

    if (reading.history.length >= rule.minSamples) return reading; // process-history a assez d'échantillons, on l'utilise tel quel

    const fallbackHistory = buffer.valuesBefore(now);
    if (fallbackHistory.length <= reading.history.length) return reading; // le filet n'apporte rien de plus
    return { ...reading, history: fallbackHistory, usedFallback: true };
  }

  /**
   * Escalade (jamais ne rétrograde) la sévérité d'une occurrence encore
   * ouverte si le z-score actuel la justifie. Réutilise alertStore.update()
   * (voir lib/services/alerts/alert-store.js) : aucune logique de transition
   * d'état ajoutée, engine.js reste inchangé.
   */
  async _escalateSeverityIfNeeded(alert, detection, rule) {
    if (!alert || !OPEN_STATES.includes(alert.state)) return alert;
    const deserved = severityForZScore(detection.absZScore, rule.sensitivity, rule.severity);
    const currentIdx = SEVERITY_ORDER.indexOf(alert.severity);
    const deservedIdx = SEVERITY_ORDER.indexOf(deserved);
    if (deservedIdx <= currentIdx) return alert; // jamais de rétrogradation automatique
    const updated = await this.alertEngine.alertStore.update(alert.id, { severity: deserved });
    return updated || alert;
  }

  /**
   * @param {object} rule - ligne anomaly_rules
   * @param {string} target - "system" ou nom de process
   * @param {?{value:number, history:number[], previousPeriodValue:?number}} reading
   */
  async _evaluateReading(rule, target, reading) {
    // Métrique indisponible sur cette plateforme/ce process, ou aucun store
    // injecté : on saute complètement (même contrat que collector.js).
    if (!reading || reading.value === null || reading.value === undefined) return null;

    const detection = detectAnomaly({
      value: reading.value,
      history: reading.history,
      sensitivity: rule.sensitivity,
      minSamples: rule.minSamples,
      previousPeriodValue: reading.previousPeriodValue,
    });
    // Données insuffisantes (moins de minSamples échantillons dans la
    // fenêtre, même après le filet de sécurité éventuel) : JAMAIS de
    // déclenchement dans ce cas (exigence explicite de la tâche) — on ne
    // fait même pas remonter l'absence de signal au moteur d'alertes (pas
    // d'evaluate() du tout), pour ne jamais résoudre par erreur une
    // anomalie réellement active faute de données momentanée.
    if (!detection) return null;

    const syntheticRule = buildSyntheticRule(rule);
    let alert = await this.alertEngine.evaluate(syntheticRule, target, Number(detection.absZScore.toFixed(2)));

    if (detection.anomalous) {
      alert = await this._escalateSeverityIfNeeded(alert, detection, rule);

      let explanation = explainDetection(detection, {
        metricLabel: METRIC_LABELS[rule.metric] || rule.metric,
        unit: METRIC_UNITS[rule.metric] || "",
      });
      if (reading.usedFallback) {
        explanation += " (baseline calculée à partir d'un historique en mémoire : process-history insuffisant.)";
      }
      await this.detectionStore.create({
        ruleId: rule.id,
        alertId: alert ? alert.id : null,
        targetType: rule.targetType,
        targetValue: target,
        metric: rule.metric,
        value: detection.value,
        baseline: detection.baseline,
        stddev: detection.stddev,
        zscore: detection.zscore,
        confidencePct: detection.confidencePct,
        direction: detection.direction,
        sampleCount: detection.sampleCount,
        method: reading.usedFallback ? "zscore_fallback" : "zscore",
        explanation,
        createdAt: this.now(),
      });
    }

    return alert;
  }
}

module.exports = { AnomalyDetectionService, buildSyntheticRule, METRIC_LABELS, METRIC_UNITS, severityForZScore };
