"use strict";

/**
 * AlertEngine — cœur métier du moteur d'alertes. Indépendant de l'UI, de
 * Express et de PM2 : il consomme des règles (alert-rules-store) et des
 * "lectures" de métriques déjà extraites (collector.js), et produit/fait
 * évoluer des occurrences d'alerte (alert-store).
 *
 * États d'une occurrence (voir docs/alerts/README.md pour le diagramme) :
 *
 *   (aucune ligne) --condition vraie--> trigger --durée atteinte--> active --condition fausse--> resolved
 *                                          |                          |
 *                                     condition fausse            acknowledge()
 *                                    (jamais déclenchée,               |
 *                                     ligne supprimée,                 v
 *                                     pas de bruit)               acknowledged --condition fausse--> resolved
 *
 * - `trigger` : condition vraie depuis condition_met_at, mais duration_seconds
 *   pas encore écoulée. Existe uniquement pour porter ce compte à rebours ;
 *   si la condition redevient fausse avant l'échéance, la ligne est
 *   supprimée (l'alerte n'a jamais "vraiment" eu lieu).
 * - `active` : alerte réellement déclenchée (durée atteinte). C'est l'état
 *   consommé par les futurs providers de notification (phase suivante).
 * - `acknowledged` : comme `active`, mais un utilisateur a accusé réception.
 *   Continue d'être suivie (la valeur/le dernier vu sont mis à jour), sans
 *   jamais créer de nouvelle occurrence tant que la même condition persiste.
 * - `resolved` : condition redevenue fausse. Ligne conservée pour
 *   l'historique, porte `cooldown_until` pour empêcher un re-déclenchement
 *   immédiat (anti-flapping).
 */

const defaultRuleStore = require("./alert-rules-store");
const defaultAlertStore = require("./alert-store");
const { readSystemMetric, readProcessMetric } = require("./collector");

const OPERATORS = [">", ">=", "<", "<=", "==", "!="];

/**
 * Compare `value` à `threshold` avec `operator`. Comparaison numérique si les
 * deux valeurs sont des nombres valides (cas standard : CPU/RAM/disque/temp/
 * restart_count), sinon comparaison de chaînes (cas du statut process :
 * "stopped" == "stopped").
 */
function compare(value, operator, threshold) {
  if (!OPERATORS.includes(operator)) {
    throw new Error(`Opérateur invalide: "${operator}". Attendu: ${OPERATORS.join(", ")}.`);
  }
  const numValue = Number(value);
  const numThreshold = Number(threshold);
  const bothNumeric =
    value !== null &&
    value !== "" &&
    threshold !== null &&
    threshold !== "" &&
    !Number.isNaN(numValue) &&
    !Number.isNaN(numThreshold);

  const a = bothNumeric ? numValue : String(value);
  const b = bothNumeric ? numThreshold : String(threshold);

  switch (operator) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    default:
      return false; // inatteignable (validé plus haut)
  }
}

function buildDedupKey(ruleId, targetType, targetValue, metric) {
  return `${ruleId}:${targetType}:${targetValue || "system"}:${metric}`;
}

class AlertEngine {
  constructor({ ruleStore, alertStore, now } = {}) {
    this.ruleStore = ruleStore || defaultRuleStore;
    this.alertStore = alertStore || defaultAlertStore;
    this.now = now || (() => Date.now());
  }

  // --- Évaluation ----------------------------------------------------------

  /**
   * Évalue une règle pour une cible et une valeur observée données.
   * C'est le point d'entrée principal ; trigger/resolve/acknowledge restent
   * appelables isolément (ex: ACK vient de l'API, pas de evaluate()).
   * Retourne l'occurrence résultante (ou null si rien ne change : règle
   * désactivée, condition fausse sans occurrence ouverte, cooldown actif…).
   */
  async evaluate(rule, target, value) {
    if (!rule || !rule.enabled) return null;
    if (value === null || value === undefined) return null;

    const now = this.now();
    const conditionMet = compare(value, rule.operator, rule.threshold);
    const dedupKey = buildDedupKey(rule.id, rule.targetType, target, rule.metric);
    const open = await this.deduplicate(dedupKey);

    if (conditionMet) {
      return this._handleConditionMet(rule, target, value, dedupKey, open, now);
    }
    return this._handleConditionCleared(rule, dedupKey, open, now);
  }

  async _handleConditionMet(rule, target, value, dedupKey, open, now) {
    if (!open) {
      const stillCoolingDown = await this.cooldown(dedupKey, now);
      if (stillCoolingDown) return null;

      return this.alertStore.create({
        ruleId: rule.id,
        ruleName: rule.name,
        dedupKey,
        targetType: rule.targetType,
        targetValue: target,
        metric: rule.metric,
        operator: rule.operator,
        threshold: rule.threshold,
        severity: rule.severity,
        state: "trigger",
        value,
        conditionMetAt: now,
        lastSeenAt: now,
      });
    }

    if (open.state === "trigger") {
      const durationMs = Math.max(0, Number(rule.durationSeconds) || 0) * 1000;
      const elapsed = now - open.conditionMetAt;
      if (elapsed >= durationMs) {
        return this.trigger(open.id, { value, now });
      }
      return this.alertStore.touch(open.id, { value: String(value), lastSeenAt: now });
    }

    // active / acknowledged : condition toujours vraie -> pas de nouvelle
    // alerte (c'est la déduplication + l'anti-spam), on met juste à jour.
    return this.alertStore.touch(open.id, { value: String(value), lastSeenAt: now });
  }

  async _handleConditionCleared(rule, dedupKey, open, now) {
    if (!open) return null;

    if (open.state === "trigger") {
      // La condition n'a jamais tenu assez longtemps : ce n'était pas une
      // vraie alerte, on l'oublie plutôt que de polluer l'historique.
      await this.alertStore.remove(open.id);
      return null;
    }

    // active / acknowledged -> resolved
    return this.resolve(open.id, { now, cooldownSeconds: rule.cooldownSeconds });
  }

  // --- Transitions explicites (utilisables directement, ex: par l'API) -----

  /** trigger -> active. Marque l'alerte comme réellement déclenchée. */
  async trigger(alertId, { value, now } = {}) {
    const ts = now ?? this.now();
    return this.alertStore.update(alertId, {
      state: "active",
      triggeredAt: ts,
      lastSeenAt: ts,
      ...(value !== undefined ? { value: String(value) } : {}),
    });
  }

  /** active|acknowledged -> resolved. Pose le cooldown avant un futur re-déclenchement. */
  async resolve(alertId, { now, cooldownSeconds = 0 } = {}) {
    const ts = now ?? this.now();
    return this.alertStore.update(alertId, {
      state: "resolved",
      resolvedAt: ts,
      lastSeenAt: ts,
      cooldownUntil: ts + Math.max(0, Number(cooldownSeconds) || 0) * 1000,
    });
  }

  /** active -> acknowledged. Idempotent si déjà acquittée. Rejette sur trigger/resolved. */
  async acknowledge(alertId, user) {
    const alert = await this.alertStore.getById(alertId);
    if (!alert) throw new Error("Alerte introuvable.");
    if (alert.state === "acknowledged") return alert; // idempotent
    if (alert.state !== "active") {
      throw new Error(`Seule une alerte "active" peut être acquittée (état actuel : "${alert.state}").`);
    }
    const now = this.now();
    return this.alertStore.update(alertId, {
      state: "acknowledged",
      acknowledgedAt: now,
      acknowledgedBy: user && user.id !== undefined ? user.id : null,
    });
  }

  // --- Déduplication / cooldown (isolables, aussi utilisées en interne) ----

  /** L'occurrence "ouverte" (trigger/active/acknowledged) pour cette clé, ou null. */
  async deduplicate(dedupKey) {
    return this.alertStore.findOpenByDedupKey(dedupKey);
  }

  /** true si une nouvelle occurrence est actuellement bloquée par le cooldown de la précédente. */
  async cooldown(dedupKey, now = this.now()) {
    const last = await this.alertStore.findLastResolvedByDedupKey(dedupKey);
    if (!last || !last.cooldownUntil) return false;
    return now < last.cooldownUntil;
  }

  // --- Boucle d'évaluation périodique (appelée depuis server.js) -----------

  /** Évalue toutes les règles "system" activées contre un snapshot lib/system-stats.js. */
  async evaluateSystemReading(snapshot) {
    const rules = await this.ruleStore.listEnabledByTargetType("system");
    const results = [];
    for (const rule of rules) {
      const value = readSystemMetric(snapshot, rule.metric);
      if (value === null || value === undefined) continue;
      results.push(await this.evaluate(rule, "system", value));
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
        const value = readProcessMetric(proc, rule.metric);
        if (value === null || value === undefined) continue;
        results.push(await this.evaluate(rule, proc.name, value));
      }
    }
    return results;
  }
}

module.exports = { AlertEngine, compare, buildDedupKey, OPERATORS };
