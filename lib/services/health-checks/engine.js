"use strict";

/**
 * HealthCheckEngine — exécute une sonde (runner.js), fait évoluer le statut
 * (UP/DOWN/DEGRADED/UNKNOWN) et alimente le moteur d'alertes existant
 * (lib/services/alerts/engine.js) — pas de deuxième système d'alerte.
 *
 * Statuts et transitions :
 *   UNKNOWN : état initial, avant la première exécution (ou check désactivé).
 *   UP       : la sonde a réussi et le temps de réponse est sous le seuil
 *              "dégradé" (ou aucun seuil configuré).
 *   DEGRADED : la sonde a réussi mais le temps de réponse dépasse
 *              `degradedThresholdMs`.
 *   DOWN     : la sonde a échoué (timeout, connexion refusée, code de statut/
 *              sortie inattendu, contenu attendu absent…).
 * Le statut affiché est toujours celui de la dernière exécution (pas de
 * lissage) — voir `consecutiveFailures`/`consecutiveSuccesses`, qui eux
 * s'accumulent et servent de base à `rule.durationSeconds` côté Alert Engine
 * (N échecs consécutifs ≈ durationSeconds = N × intervalSeconds, voir
 * docs/health-checks/README.md#alert-engine).
 *
 * Intégration Alert Engine : chaque exécution appelle
 * alertEngine.evaluate(rule, healthCheck.name, status) pour toute règle
 * `alert_rules` activée avec target_type="health_check" ciblant ce check
 * (target_value = nom du check, ou "*" pour tous). C'est exactement le même
 * mécanisme que evaluateProcessReadings()/evaluateSystemReading() dans
 * lib/services/alerts/engine.js — aucune modification de ce fichier n'a été
 * nécessaire, `evaluate()` étant déjà générique sur (rule, target, value).
 */

const { runProbe } = require("./runner");

class HealthCheckEngine {
  constructor({ store, ruleStore, alertEngine, now, onAlertResult } = {}) {
    this.store = store || require("./store");
    this.ruleStore = ruleStore || require("../alerts/alert-rules-store");
    this.alertEngine = alertEngine || require("../alerts").engine;
    this.now = now || (() => Date.now());
    // Callback optionnel appelé pour chaque résultat d'evaluate() renvoyé par
    // feedAlertEngine() (transition trigger/active/resolved ou null) — permet
    // à server.js de brancher le dispatch de notifications (comme pour
    // evaluateProcessReadings/evaluateSystemReading) sans que ce module ait
    // besoin de connaître lib/services/notifications/.
    this.onAlertResult = typeof onAlertResult === "function" ? onAlertResult : null;
  }

  /**
   * Exécute une sonde pour `check` (objet retourné par store.getById/list, ou
   * un objet équivalent pour "run test" sur une config pas encore
   * enregistrée) et retourne le résultat brut, SANS toucher au store ni aux
   * alertes. Utilisé par `run()` et par l'endpoint "run test" de l'API.
   */
  async probe(check, impls) {
    return runProbe(check, impls);
  }

  /**
   * Exécute la sonde pour un health check déjà enregistré, persiste le
   * nouveau statut/compteurs, puis notifie l'Alert Engine. C'est la méthode
   * appelée par le scheduler périodique (server.js) et par "run test" quand
   * on veut aussi que le résultat soit conservé.
   */
  async run(checkId, impls) {
    const check = await this.store.getById(checkId);
    if (!check) throw new Error("Health check introuvable.");
    if (!check.enabled) return null;

    const result = await this.probe(check, impls);

    const consecutiveFailures = result.status === "DOWN" ? check.consecutiveFailures + 1 : 0;
    const consecutiveSuccesses = result.status === "DOWN" ? 0 : check.consecutiveSuccesses + 1;

    const updated = await this.store.recordResult(checkId, {
      status: result.status,
      responseTimeMs: result.responseTimeMs,
      statusCode: result.statusCode,
      error: result.error,
      consecutiveFailures,
      consecutiveSuccesses,
    });

    await this.feedAlertEngine(updated);
    return updated;
  }

  /** Évalue toutes les règles d'alerte "health_check" activées ciblant ce check. */
  async feedAlertEngine(check) {
    if (!this.alertEngine || this.alertsEnabled === false) return [];
    const rules = await this.ruleStore.listEnabledByTargetType("health_check");
    const results = [];
    for (const rule of rules) {
      if (rule.targetValue && rule.targetValue !== "*" && rule.targetValue !== check.name) continue;
      const result = await this.alertEngine.evaluate(rule, check.name, check.status);
      if (this.onAlertResult) this.onAlertResult(result);
      results.push(result);
    }
    return results;
  }

  /** Exécute tous les checks activés et dus (interval écoulé depuis lastCheckAt). Appelé par le scheduler. */
  async runDueChecks(now = this.now()) {
    const checks = await this.store.list({ enabledOnly: true });
    const due = checks.filter((c) => {
      if (!c.lastCheckAt) return true;
      return now - c.lastCheckAt >= c.intervalSeconds * 1000;
    });
    const results = [];
    for (const check of due) {
      try {
        results.push(await this.run(check.id));
      } catch (e) {
        console.error(`Erreur d'exécution du health check "${check.name}" :`, e.message);
      }
    }
    return results;
  }

  start(intervalMs = 5000) {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.runDueChecks().catch((e) => console.error("Erreur du scheduler de health checks :", e.message));
    }, intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { HealthCheckEngine };
