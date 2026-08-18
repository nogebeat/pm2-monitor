"use strict";

/**
 * lib/services/dashboard/global-status.js
 *
 * Phase 8 — calcul de l'état de santé global du serveur, à partir de tout
 * ce que le monitor sait déjà (metrics système, process, alertes, health
 * checks). Fonction **pure** : aucun accès DB/réseau/horloge ici, seulement
 * des objets déjà chargés en entrée — testée en isolation dans
 * test/unit/global-status.test.js (voir section 9 du prompt maître, "LÉGER"
 * mais ciblé sur cette fonction).
 *
 * ---------------------------------------------------------------------------
 * RÈGLES DE CALCUL (documentées ici ET dans docs/dashboard/README.md —
 * garder les deux synchronisés si l'une change) :
 * ---------------------------------------------------------------------------
 *
 * Le statut est le pire (`CRITICAL` > `WARNING` > `HEALTHY`) parmi toutes
 * les conditions ci-dessous. Dès qu'une condition CRITICAL est vraie, le
 * calcul s'arrête (peu importe le reste) : CRITICAL prime toujours sur
 * WARNING.
 *
 * CRITICAL si au moins une des conditions suivantes :
 *   - une alerte active de sévérité "critical" existe (`state` "active" ou
 *     "acknowledged" — un accusé de réception marque "vu", pas "résolu" :
 *     il ne change donc pas le statut global) ;
 *   - au moins un health check est `DOWN` ;
 *   - au moins un process est `errored`/`crashed` (au sens PM2 : un process
 *     qui a épuisé ses tentatives de redémarrage automatique) ;
 *   - CPU système ≥ 90 %, RAM ≥ 90 %, Disque ≥ 90 %, ou température CPU
 *     ≥ 85 °C (seuils par défaut, voir `DEFAULT_THRESHOLDS`).
 *
 * WARNING (si aucune condition CRITICAL) si au moins une des conditions
 * suivantes :
 *   - une alerte active de sévérité "warning" existe ;
 *   - au moins un health check est `DEGRADED` (répond, mais lentement/hors
 *     seuil) ou `UNKNOWN` (jamais encore vérifié avec succès) ;
 *   - au moins un process est en cours de redémarrage (`restarting`,
 *     l'état transitoire PM2 `launching`) ;
 *   - CPU ≥ 70 %, RAM ≥ 75 %, Disque ≥ 80 %, ou température ≥ 70 °C.
 *
 * HEALTHY sinon.
 *
 * Un système sans aucune donnée disponible (ex: metrics système non
 * lisibles sur la plateforme, `null`) est traité comme neutre pour ce
 * signal précis (n'élève pas le statut) plutôt que comme une erreur — la
 * donnée manquante ne doit jamais, à elle seule, déclencher un faux
 * CRITICAL/WARNING.
 */

const STATUS = { HEALTHY: "HEALTHY", WARNING: "WARNING", CRITICAL: "CRITICAL" };

const DEFAULT_THRESHOLDS = {
  cpu: { warning: 70, critical: 90 },
  memory: { warning: 75, critical: 90 },
  disk: { warning: 80, critical: 90 },
  temperature: { warning: 70, critical: 85 },
};

/**
 * @param {object} input
 * @param {object} [input.system] - snapshot lib/system-stats.js#snapshot() (ou un
 *   sous-ensemble équivalent : { cpu, mem:{percent}, disk:{percent}, temp:{celsius} })
 * @param {object} [input.processes] - overview lib/services/dashboard/index.js#calculateProcessOverview()
 *   ({ total, online, stopped, errored, crashed, restarting })
 * @param {Array}  [input.alerts] - alertes actives (lib/services/alerts/alert-store.js#listActive()),
 *   chaque élément avec au moins { severity, state }
 * @param {Array}  [input.healthChecks] - lib/services/health-checks/store.js#list(),
 *   chaque élément avec au moins { status, enabled }
 * @param {object} [input.thresholds] - surcharge partielle de DEFAULT_THRESHOLDS
 * @returns {"HEALTHY"|"WARNING"|"CRITICAL"}
 */
function calculateGlobalStatus(input = {}) {
  return calculateGlobalStatusDetailed(input).status;
}

/**
 * Même calcul que calculateGlobalStatus(), mais retourne aussi la liste des
 * raisons retenues (utilisé par l'API/dashboard pour expliquer le statut à
 * l'utilisateur — voir GET /api/dashboard). `status` reste la seule valeur
 * garantie par le contrat de la Phase 8 (section 6 du prompt maître).
 */
function calculateGlobalStatusDetailed({ system, processes, alerts, healthChecks, thresholds } = {}) {
  const t = mergeThresholds(thresholds);
  const criticalReasons = [];
  const warningReasons = [];

  const activeAlerts = Array.isArray(alerts) ? alerts : [];
  const checks = Array.isArray(healthChecks) ? healthChecks : [];

  // --- Alertes -------------------------------------------------------------
  const openStates = new Set(["active", "acknowledged"]);
  const criticalAlertCount = activeAlerts.filter(
    (a) => a && openStates.has(a.state) && a.severity === "critical",
  ).length;
  const warningAlertCount = activeAlerts.filter(
    (a) => a && openStates.has(a.state) && a.severity === "warning",
  ).length;
  if (criticalAlertCount > 0) {
    criticalReasons.push(`${criticalAlertCount} alerte(s) critique(s) active(s)`);
  }
  if (warningAlertCount > 0) {
    warningReasons.push(`${warningAlertCount} alerte(s) warning active(s)`);
  }

  // --- Health checks ---------------------------------------------------------
  const enabledChecks = checks.filter((c) => c && c.enabled !== false);
  const downChecks = enabledChecks.filter((c) => c.status === "DOWN").length;
  const degradedChecks = enabledChecks.filter((c) => c.status === "DEGRADED").length;
  const unknownChecks = enabledChecks.filter((c) => c.status === "UNKNOWN").length;
  if (downChecks > 0) {
    criticalReasons.push(`${downChecks} health check(s) DOWN`);
  }
  if (degradedChecks > 0) {
    warningReasons.push(`${degradedChecks} health check(s) DEGRADED`);
  }
  if (unknownChecks > 0) {
    warningReasons.push(`${unknownChecks} health check(s) UNKNOWN`);
  }

  // --- Process ---------------------------------------------------------------
  const p = processes || {};
  const failedProcesses = Number(p.errored || 0) + Number(p.crashed || 0);
  const restartingProcesses = Number(p.restarting || 0);
  if (failedProcesses > 0) {
    criticalReasons.push(`${failedProcesses} process en erreur/crash`);
  }
  if (restartingProcesses > 0) {
    warningReasons.push(`${restartingProcesses} process en cours de redémarrage`);
  }

  // --- Metrics système ---------------------------------------------------
  const cpu = numericOrNull(system && system.cpu);
  const memPercent = numericOrNull(system && system.mem && system.mem.percent);
  const diskPercent = numericOrNull(system && system.disk && system.disk.percent);
  const tempCelsius = numericOrNull(system && system.temp && system.temp.celsius);

  checkThreshold(cpu, t.cpu, "CPU", criticalReasons, warningReasons);
  checkThreshold(memPercent, t.memory, "RAM", criticalReasons, warningReasons);
  checkThreshold(diskPercent, t.disk, "Disque", criticalReasons, warningReasons);
  checkThreshold(tempCelsius, t.temperature, "Température CPU", criticalReasons, warningReasons, "°C");

  if (criticalReasons.length > 0) {
    return { status: STATUS.CRITICAL, reasons: criticalReasons };
  }
  if (warningReasons.length > 0) {
    return { status: STATUS.WARNING, reasons: warningReasons };
  }
  return { status: STATUS.HEALTHY, reasons: [] };
}

function checkThreshold(value, thresholdPair, label, criticalReasons, warningReasons, unit = "%") {
  if (value === null) return; // donnée indisponible : signal neutre, n'élève jamais le statut
  if (value >= thresholdPair.critical) {
    criticalReasons.push(`${label} à ${value}${unit} (seuil critique ${thresholdPair.critical}${unit})`);
  } else if (value >= thresholdPair.warning) {
    warningReasons.push(`${label} à ${value}${unit} (seuil warning ${thresholdPair.warning}${unit})`);
  }
}

function numericOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function mergeThresholds(overrides) {
  if (!overrides) return DEFAULT_THRESHOLDS;
  return {
    cpu: { ...DEFAULT_THRESHOLDS.cpu, ...(overrides.cpu || {}) },
    memory: { ...DEFAULT_THRESHOLDS.memory, ...(overrides.memory || {}) },
    disk: { ...DEFAULT_THRESHOLDS.disk, ...(overrides.disk || {}) },
    temperature: { ...DEFAULT_THRESHOLDS.temperature, ...(overrides.temperature || {}) },
  };
}

module.exports = { STATUS, DEFAULT_THRESHOLDS, calculateGlobalStatus, calculateGlobalStatusDetailed };
