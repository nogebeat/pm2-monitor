"use strict";

/**
 * Dérive le statut des dépendances/nœuds à partir des health checks liés
 * (Phase 6), et calcule l'impact ("dépendances affectées") d'une panne.
 *
 * Aucune donnée de statut n'est stockée dans `service_dependencies` (voir
 * commentaire de tête de 019_service_dependencies.js) : tout est recalculé
 * en lecture ici, à partir de `store.list()` + `healthChecksStore.list()`.
 * Ce module ne fait QUE lire — jamais de justification suffisante ici pour
 * modifier le Global Status du dashboard (lib/routes/dashboard.js), qui
 * reste hors de portée de cette phase (voir prompt : "Ne modifie pas
 * arbitrairement le Global Status sans justification").
 */

const store = require("./store");
const { computeImpact: computeImpactFromEdges } = require("./graph");
const { listLocalProcessStatuses } = require("./process-status");

const STATUS_RANK = { UP: 0, UNKNOWN: 1, DEGRADED: 2, DOWN: 3 };

function worstStatus(a, b) {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

/**
 * Statut d'une dépendance :
 * - désactivée -> toujours "UNKNOWN" (jamais d'alarme ni d'impact propagé) ;
 * - un health check lié reste TOUJOURS prioritaire (explicitement configuré
 *   par l'utilisateur, donc plus précis que tout le reste) ;
 * - sinon, pour une dépendance de type PROCESS, le statut réel du process
 *   PM2 local portant le nom `target` (voir process-status.js) ;
 * - sinon "UNKNOWN" (dépendance purement déclarative, rien à en déduire).
 */
function dependencyStatus(dependency, checksById, processStatusesByName) {
  if (!dependency.enabled) return "UNKNOWN";
  if (dependency.healthCheckId) {
    const check = checksById.get(dependency.healthCheckId);
    return check ? check.status || "UNKNOWN" : "UNKNOWN";
  }
  if (dependency.type === "PROCESS" && processStatusesByName) {
    return processStatusesByName.get(dependency.target) || "UNKNOWN";
  }
  return "UNKNOWN";
}

/**
 * Construit le graphe complet (nœuds + arêtes) avec statut dérivé, pour les
 * vues "graphe"/"liste"/"statut" du frontend. `healthChecksStore` et
 * `listProcessStatuses` sont injectables (tests) — reprennent par défaut
 * lib/services/health-checks/store.js et process-status.js.
 *
 * `listProcessStatuses()` (pm2.list()) n'est appelé que si au moins une
 * dépendance de type PROCESS, activée et sans health check lié, existe —
 * aucun coût pour les installations qui n'utilisent pas ce type.
 */
async function buildGraphSnapshot({ healthChecksStore, listProcessStatuses } = {}) {
  const hcStore = healthChecksStore || require("../health-checks/store");

  const [dependencies, checks] = await Promise.all([store.list({}), hcStore.list()]);
  const checksById = new Map(checks.map((c) => [c.id, c]));

  const needsProcessStatus = dependencies.some((d) => d.enabled && d.type === "PROCESS" && !d.healthCheckId);
  const processStatusesByName = needsProcessStatus
    ? await (listProcessStatuses || listLocalProcessStatuses)()
    : new Map();

  const edges = dependencies.map((d) => ({
    ...d,
    status: dependencyStatus(d, checksById, processStatusesByName),
  }));

  const nodeNames = new Set();
  for (const d of dependencies) {
    nodeNames.add(d.source);
    nodeNames.add(d.target);
  }

  const nodes = [...nodeNames].sort().map((name) => {
    let status = "UNKNOWN";
    for (const e of edges) {
      if (e.source !== name && e.target !== name) continue;
      status = worstStatus(status, e.status);
    }
    return { name, status };
  });

  return { nodes, edges, generatedAt: Date.now() };
}

/**
 * "Dépendances affectées" si `serviceName` tombe. Par défaut, le statut réel
 * (dérivé des health checks liés) décide si `serviceName` est bien DOWN ;
 * `assumeDown: true` force le calcul même si le statut réel est différent
 * (utile pour explorer l'impact hypothétique d'un service depuis l'UI, ou
 * pour tester la fonction sans health check branché).
 *
 * Ne suit que les dépendances ACTIVÉES (enabled = true) — une dépendance
 * désactivée est ignorée du calcul de propagation, voir graph.js.
 * Les résultats restent des indices, jamais une causalité certaine (voir
 * prompt de phase, section "Incident") : c'est à l'appelant (route/UI) de
 * les présenter avec un vocabulaire du type "potentially affected".
 */
async function computeImpact(
  serviceName,
  { assumeDown = false, healthChecksStore, listProcessStatuses } = {},
) {
  const snapshot = await buildGraphSnapshot({ healthChecksStore, listProcessStatuses });
  const node = snapshot.nodes.find((n) => n.name === serviceName);
  const status = assumeDown ? "DOWN" : node ? node.status : "UNKNOWN";

  if (!assumeDown && status !== "DOWN") {
    return { service: serviceName, status, potentiallyAffected: [] };
  }

  const enabledEdges = snapshot.edges
    .filter((e) => e.enabled)
    .map((e) => ({ source: e.source, target: e.target }));
  const potentiallyAffected = computeImpactFromEdges(enabledEdges, serviceName);
  return { service: serviceName, status, potentiallyAffected };
}

module.exports = { STATUS_RANK, worstStatus, dependencyStatus, buildGraphSnapshot, computeImpact };
