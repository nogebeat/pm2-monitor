"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildBacklog, splitNativeTimestamp, olderNativeLines } = require("../../lib/log-backlog");

/**
 * Historique affiché à la sélection d'un process : stdout et stderr doivent
 * apparaître dans l'ordre réel quand on le connaît (LogStore), et ne jamais
 * être dupliqués quand on complète avec les fichiers natifs PM2.
 */

const row = (t, type, text) => ({ t, type, text });

test("splitNativeTimestamp — préfixes PM2 `time: true`", async (t) => {
  await t.test("sépare un horodatage 'YYYY-MM-DD HH:mm:ss: '", () => {
    const r = splitNativeTimestamp("2026-11-07 10:00:00: serveur prêt");
    assert.equal(r.text, "serveur prêt");
    assert.equal(r.at, Date.parse("2026-11-07 10:00:00"));
  });

  await t.test("gère ISO avec millisecondes et fuseau", () => {
    const r = splitNativeTimestamp("2026-11-07T10:00:00.123Z: ok");
    assert.equal(r.at, Date.parse("2026-11-07T10:00:00.123Z"));
    assert.equal(r.text, "ok");
  });

  await t.test("laisse intacte une ligne sans horodatage (et retire le \\r final)", () => {
    const r = splitNativeTimestamp("hello world\r");
    assert.deepEqual(r, { at: null, text: "hello world" });
  });
});

test("buildBacklog — LogStore présent : ordre réel stdout/stderr", async (t) => {
  await t.test("entremêle out et err comme ils se sont produits, avec horodatage", () => {
    const { results, source } = buildBacklog({
      outLines: ["a", "c"],
      errLines: ["b"],
      storeRows: [row(1, "out", "a"), row(2, "err", "b"), row(3, "out", "c")],
      limit: 200,
    });
    assert.equal(source, "store");
    assert.deepEqual(
      results.map((r) => `${r.type}:${r.text}:${r.at}`),
      ["out:a:1", "err:b:2", "out:c:3"],
    );
  });

  await t.test("régression : une vieille erreur n'est plus placée APRÈS les lignes stdout récentes", () => {
    // Avant : tout stdout puis tout stderr -> la fin de liste = vieilles erreurs.
    const { results } = buildBacklog({
      outLines: ["out récent"],
      errLines: ["vieille erreur"],
      storeRows: [row(10, "err", "vieille erreur"), row(20, "out", "out récent")],
      limit: 200,
    });
    assert.equal(results[results.length - 1].text, "out récent");
  });

  await t.test("complète avec les lignes natives plus anciennes, sans doublon", () => {
    const { results } = buildBacklog({
      outLines: ["vieux1", "vieux2", "a", "c"],
      errLines: ["b"],
      storeRows: [row(1, "out", "a"), row(2, "err", "b"), row(3, "out", "c")],
      limit: 200,
    });
    assert.deepEqual(
      results.map((r) => r.text),
      ["vieux1", "vieux2", "a", "b", "c"],
    );
    assert.deepEqual(
      results.slice(0, 2).map((r) => r.at),
      [null, null],
    );
  });

  await t.test("flux absent du LogStore : ses lignes natives sont considérées plus anciennes", () => {
    const { results } = buildBacklog({
      outLines: ["a"],
      errLines: ["erreur d'hier"],
      storeRows: [row(5, "out", "a")],
      limit: 200,
    });
    assert.deepEqual(
      results.map((r) => r.text),
      ["erreur d'hier", "a"],
    );
  });

  await t.test("désalignement LogStore/fichier natif : on n'ajoute rien (pas de doublons)", () => {
    const { results } = buildBacklog({
      outLines: ["x", "y", "z"],
      errLines: [],
      storeRows: [row(1, "out", "a"), row(2, "out", "b")],
      limit: 200,
    });
    assert.deepEqual(
      results.map((r) => r.text),
      ["a", "b"],
    );
  });

  await t.test("respecte la limite (garde les plus récentes)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, "out", `l${i}`));
    const { results } = buildBacklog({ outLines: [], errLines: [], storeRows: rows, limit: 3 });
    assert.deepEqual(
      results.map((r) => r.text),
      ["l7", "l8", "l9"],
    );
  });
});

test("buildBacklog — LogStore vide : repli sur les fichiers natifs", async (t) => {
  await t.test("sans horodatage : stdout puis stderr, source 'native'", () => {
    const { results, source } = buildBacklog({
      outLines: ["o1", "o2"],
      errLines: ["e1"],
      storeRows: [],
      limit: 200,
    });
    assert.equal(source, "native");
    assert.deepEqual(
      results.map((r) => `${r.type}:${r.text}:${r.at}`),
      ["out:o1:null", "out:o2:null", "err:e1:null"],
    );
  });

  await t.test("avec horodatages PM2 (`time: true`) : trié chronologiquement", () => {
    const { results } = buildBacklog({
      outLines: ["2026-11-07 10:00:00: o1", "2026-11-07 10:00:05: o2"],
      errLines: ["2026-11-07 10:00:02: e1"],
      storeRows: [],
      limit: 200,
    });
    assert.deepEqual(
      results.map((r) => r.text),
      ["o1", "e1", "o2"],
    );
  });

  await t.test("tout vide -> liste vide", () => {
    const { results } = buildBacklog({ outLines: [], errLines: [], storeRows: [], limit: 200 });
    assert.deepEqual(results, []);
  });
});

test("olderNativeLines — garde-fous", async (t) => {
  const rows = (...texts) => texts.map((text) => ({ type: "out", text, at: null }));

  await t.test("LogStore plus long que la fenêtre native : rien de plus ancien", () => {
    assert.deepEqual(olderNativeLines(rows("a"), ["x", "a"]), []);
  });

  await t.test("suffixe identique : retire exactement ce suffixe", () => {
    assert.deepEqual(
      olderNativeLines(rows("1", "2", "3"), ["2", "3"]).map((r) => r.text),
      ["1"],
    );
  });
});
