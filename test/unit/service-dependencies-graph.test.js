"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectCycle,
  computeImpact,
  buildAdjacency,
} = require("../../lib/services/service-dependencies/graph");

/**
 * Tests unitaires purs du graphe de dépendances (Phase 17). Pas de DB ici,
 * juste des tableaux d'arêtes `{ source, target }` — même style que
 * test/unit/anomaly-ring-buffer.test.js (calcul pur testé isolément).
 */

test("service-dependencies/graph — buildAdjacency()", async (t) => {
  await t.test("construit l'adjacence directe et inverse", () => {
    const { forward, reverse } = buildAdjacency([
      { source: "API", target: "PostgreSQL" },
      { source: "API", target: "Redis" },
      { source: "Worker", target: "Redis" },
    ]);
    assert.deepEqual(forward.get("API").sort(), ["PostgreSQL", "Redis"]);
    assert.deepEqual(forward.get("Worker"), ["Redis"]);
    assert.deepEqual(reverse.get("Redis").sort(), ["API", "Worker"]);
    assert.deepEqual(reverse.get("PostgreSQL"), ["API"]);
  });
});

test("service-dependencies/graph — detectCycle()", async (t) => {
  await t.test("aucun cycle sur un graphe en couches simple", () => {
    const edges = [
      { source: "Frontend", target: "API" },
      { source: "API", target: "PostgreSQL" },
      { source: "API", target: "Redis" },
    ];
    assert.equal(detectCycle(edges, { source: "Worker", target: "Redis" }), null);
  });

  await t.test("détecte un cycle direct (A -> B, ajout de B -> A)", () => {
    const edges = [{ source: "A", target: "B" }];
    const cycle = detectCycle(edges, { source: "B", target: "A" });
    assert.ok(cycle);
    assert.deepEqual(cycle, ["B", "A", "B"]);
  });

  await t.test("détecte un cycle transitif (A -> B -> C, ajout de C -> A)", () => {
    const edges = [
      { source: "A", target: "B" },
      { source: "B", target: "C" },
    ];
    const cycle = detectCycle(edges, { source: "C", target: "A" });
    assert.ok(cycle);
    assert.equal(cycle[0], "C");
    assert.equal(cycle[cycle.length - 1], "C");
  });

  await t.test("refuse une dépendance sur soi-même (A -> A)", () => {
    assert.deepEqual(detectCycle([], { source: "A", target: "A" }), ["A", "A"]);
  });

  await t.test("n'est pas perturbé par des arêtes sans rapport", () => {
    const edges = [
      { source: "X", target: "Y" },
      { source: "Frontend", target: "API" },
    ];
    assert.equal(detectCycle(edges, { source: "API", target: "PostgreSQL" }), null);
  });
});

test("service-dependencies/graph — computeImpact()", async (t) => {
  await t.test("aucune dépendance : aucun impact", () => {
    assert.deepEqual(computeImpact([], "PostgreSQL"), []);
  });

  await t.test("impact direct uniquement", () => {
    const edges = [
      { source: "API", target: "PostgreSQL" },
      { source: "Worker", target: "PostgreSQL" },
    ];
    const affected = computeImpact(edges, "PostgreSQL")
      .map((a) => a.name)
      .sort();
    assert.deepEqual(affected, ["API", "Worker"]);
  });

  await t.test("impact transitif : Frontend -> API -> PostgreSQL, distance croissante", () => {
    const edges = [
      { source: "Frontend", target: "API" },
      { source: "API", target: "PostgreSQL" },
    ];
    const affected = computeImpact(edges, "PostgreSQL");
    const byName = Object.fromEntries(affected.map((a) => [a.name, a]));
    assert.equal(byName.API.distance, 1);
    assert.equal(byName.Frontend.distance, 2);
    assert.deepEqual(byName.Frontend.path, ["Frontend", "API", "PostgreSQL"]);
  });

  await t.test("une dépendance désactivée n'est pas dans les arêtes fournies -> pas de propagation", () => {
    // status.js filtre déjà enabled=true avant d'appeler computeImpact ; ici
    // on vérifie juste que computeImpact() ne suit que ce qu'on lui donne.
    const edges = [{ source: "API", target: "PostgreSQL" }]; // Worker->PostgreSQL exclu (désactivée)
    const affected = computeImpact(edges, "PostgreSQL").map((a) => a.name);
    assert.deepEqual(affected, ["API"]);
  });

  await t.test("service sans dépendant : impact vide", () => {
    const edges = [{ source: "API", target: "PostgreSQL" }];
    assert.deepEqual(computeImpact(edges, "Frontend"), []);
  });
});
