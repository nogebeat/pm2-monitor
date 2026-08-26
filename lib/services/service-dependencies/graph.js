"use strict";

/**
 * Fonctions pures sur le graphe de dépendances (Phase 17). Aucune I/O ici
 * (pas de `db`, pas de `require("./store")`) : ce module ne manipule que des
 * tableaux d'arêtes `{ source, target }` déjà chargés par l'appelant — même
 * séparation que lib/services/anomaly-detection/math.js (calcul pur, testé
 * indépendamment du store).
 *
 * Convention : une arête `source -> target` signifie "source dépend de
 * target". Si `target` tombe, tout ce qui dépend de lui (directement ou
 * transitivement) est *potentiellement* affecté — voir computeImpact().
 */

/** Construit l'adjacence directe (source -> [targets]) et inverse (target -> [sources]). */
function buildAdjacency(edges) {
  const forward = new Map();
  const reverse = new Map();
  for (const { source, target } of edges) {
    if (!forward.has(source)) forward.set(source, []);
    forward.get(source).push(target);
    if (!reverse.has(target)) reverse.set(target, []);
    reverse.get(target).push(source);
  }
  return { forward, reverse };
}

/**
 * Vérifie si l'ajout de `candidate` (`{ source, target }`) à `edges`
 * introduirait un cycle. Retourne le chemin du cycle (tableau de noms,
 * `[candidate.target, ..., candidate.source, candidate.target]`) si oui,
 * `null` sinon.
 *
 * Principe : un cycle apparaît si, en partant de `candidate.target`, on peut
 * déjà atteindre `candidate.source` en suivant les arêtes existantes (dans
 * ce cas, ajouter source -> target boucle). DFS simple, le graphe de
 * dépendances reste petit (déclaratif, pas de génération automatique).
 */
function detectCycle(edges, candidate) {
  const { forward } = buildAdjacency(edges);
  const { source, target } = candidate;
  if (source === target) return [source, target];

  const visited = new Set();
  const path = [];

  function dfs(node) {
    if (node === source) {
      path.push(node);
      return true;
    }
    if (visited.has(node)) return false;
    visited.add(node);
    path.push(node);
    for (const next of forward.get(node) || []) {
      if (dfs(next)) return true;
    }
    path.pop();
    return false;
  }

  if (dfs(target)) {
    return [source, ...path];
  }
  return null;
}

/**
 * Services potentiellement affectés si `target` tombe : tous les nœuds qui
 * dépendent de `target`, directement ou transitivement (remontée de
 * l'adjacence inverse). Ne suit que les arêtes fournies — l'appelant filtre
 * déjà sur `enabled = true` (voir status.js), une dépendance désactivée ne
 * doit pas propager d'impact.
 *
 * Retourne un tableau `{ name, distance, path }` trié par distance
 * croissante (impact direct d'abord), `path` étant la chaîne de dépendance
 * depuis `name` jusqu'à `target` (utile pour l'UI : "pourquoi ce service
 * est-il affecté ?").
 */
function computeImpact(edges, targetName) {
  const { reverse } = buildAdjacency(edges);
  const result = [];
  const seen = new Set([targetName]);
  let frontier = [{ name: targetName, path: [targetName] }];
  let distance = 0;

  while (frontier.length) {
    distance += 1;
    const next = [];
    for (const node of frontier) {
      for (const dependent of reverse.get(node.name) || []) {
        if (seen.has(dependent)) continue; // graphe validé sans cycle, mais défensif
        seen.add(dependent);
        const path = [dependent, ...node.path];
        result.push({ name: dependent, distance, path });
        next.push({ name: dependent, path });
      }
    }
    frontier = next;
  }

  return result;
}

module.exports = { buildAdjacency, detectCycle, computeImpact };
