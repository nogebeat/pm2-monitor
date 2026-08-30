"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LogStore } = require("../../lib/log-store");

/**
 * Tests unitaires de lib/log-store.js — en particulier les ajouts de la
 * Phase 12 (Log Explorer) : recherche multi-process/multi-serveur
 * (searchMulti), garde-fous anti-ReDoS, bornes de sécurité (scan/candidats),
 * contexte avant/après, et rétrocompatibilité du nommage de fichier local
 * (search()/appendPacket() historiques, utilisés par lib/routes/logs.js,
 * restent inchangés — voir aussi test d'intégration log-explorer-api.test.js
 * pour le routeur).
 */

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-logstore-"));
  return { store: new LogStore(dir), dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("LogStore — rétrocompatibilité du nommage local", async (t) => {
  await t.test("appendPacket() sans serverKey écrit le même nom de fichier qu'avant la Phase 12", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(3, "api", "out", "hello world\n", Date.now());
      const files = fs.readdirSync(dir);
      assert.deepEqual(files, ["proc-3-api.jsonl"]);
    } finally {
      cleanup(dir);
    }
  });

  await t.test("appendPacket() avec serverKey='local' est identique au défaut", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(3, "api", "out", "hello\n", Date.now(), "local");
      const files = fs.readdirSync(dir);
      assert.deepEqual(files, ["proc-3-api.jsonl"]);
    } finally {
      cleanup(dir);
    }
  });

  await t.test("appendPacket() avec un serverKey distant utilise un espace de nommage séparé", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(3, "api", "out", "hello\n", Date.now(), "srv-eu-1");
      const files = fs.readdirSync(dir);
      assert.deepEqual(files, ["proc-remote-srv-eu-1-3-api.jsonl"]);
    } finally {
      cleanup(dir);
    }
  });

  await t.test("search() (une seule instance) retrouve toujours les logs locaux existants", () => {
    const { store, dir } = makeStore();
    try {
      const ts = Date.now();
      store.appendPacket(3, "api", "out", "démarrage ok\n", ts);
      const { results, total, error } = store.search(3, "api", {});
      assert.equal(error, null);
      assert.equal(total, 1);
      assert.equal(results[0].text, "démarrage ok");
    } finally {
      cleanup(dir);
    }
  });
});

test("LogStore#searchMulti — multi-process / multi-serveur", async (t) => {
  await t.test("agrège plusieurs process et plusieurs serveurs, triés chronologiquement", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(1, "api", "out", "api local ligne 1\n", 1000);
      store.appendPacket(2, "worker", "out", "worker local ligne 1\n", 2000);
      store.appendPacket(1, "api", "out", "api distant ligne 1\n", 1500, "srv-eu-1");

      const { results, total, error } = store.searchMulti(
        [
          { serverKey: "local", name: "api" },
          { serverKey: "local", name: "worker" },
          { serverKey: "srv-eu-1", name: "api" },
        ],
        { sort: "asc" },
      );

      assert.equal(error, null);
      assert.equal(total, 3);
      assert.deepEqual(
        results.map((r) => r.text),
        ["api local ligne 1", "api distant ligne 1", "worker local ligne 1"],
      );
      assert.deepEqual(results[0].source, { serverKey: "local", name: "api" });
      assert.deepEqual(results[1].source, { serverKey: "srv-eu-1", name: "api" });
    } finally {
      cleanup(dir);
    }
  });

  await t.test("regroupe toutes les instances (pm_id) d'un même process en mode cluster", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(0, "api", "out", "instance 0\n", 1000);
      store.appendPacket(1, "api", "out", "instance 1\n", 1001);
      store.appendPacket(2, "api", "out", "instance 2\n", 1002);

      const { results, total } = store.searchMulti([{ serverKey: "local", name: "api" }], { sort: "asc" });
      assert.equal(total, 3);
      assert.deepEqual(
        results.map((r) => r.text),
        ["instance 0", "instance 1", "instance 2"],
      );
    } finally {
      cleanup(dir);
    }
  });

  await t.test("filtre par type, niveau et plage temporelle", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(1, "api", "out", "info tout va bien\n", 1000);
      store.appendPacket(1, "api", "err", "Error: crash au démarrage\n", 2000);
      store.appendPacket(1, "api", "out", "info tardif\n", 5000);

      const byType = store.searchMulti([{ serverKey: "local", name: "api" }], { type: "err" });
      assert.equal(byType.total, 1);
      assert.equal(byType.results[0].text, "Error: crash au démarrage");

      const byLevel = store.searchMulti([{ serverKey: "local", name: "api" }], { level: "error" });
      assert.equal(byLevel.total, 1);

      const byRange = store.searchMulti([{ serverKey: "local", name: "api" }], { from: 1500, to: 2500 });
      assert.equal(byRange.total, 1);
      assert.equal(byRange.results[0].text, "Error: crash au démarrage");
    } finally {
      cleanup(dir);
    }
  });

  await t.test("recherche texte (insensible à la casse) et recherche regex", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(1, "api", "out", "Connexion établie\n", 1000);
      store.appendPacket(1, "api", "out", "connexion refusée port 5432\n", 2000);

      const text = store.searchMulti([{ serverKey: "local", name: "api" }], { query: "CONNEXION" });
      assert.equal(text.total, 2);

      const rx = store.searchMulti([{ serverKey: "local", name: "api" }], {
        query: "port \\d+",
        regex: true,
      });
      assert.equal(rx.total, 1);
      assert.match(rx.results[0].text, /port 5432/);
    } finally {
      cleanup(dir);
    }
  });

  await t.test("regex invalide renvoie une erreur explicite, pas d'exception", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(1, "api", "out", "quelque chose\n", 1000);
      const { error, results } = store.searchMulti([{ serverKey: "local", name: "api" }], {
        query: "(unclosed",
        regex: true,
      });
      assert.ok(error);
      assert.deepEqual(results, []);
    } finally {
      cleanup(dir);
    }
  });

  await t.test("regex catastrophique (groupes quantifiés imbriqués) refusée sans être évaluée", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(1, "api", "out", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!\n", 1000);
      const { error } = store.searchMulti([{ serverKey: "local", name: "api" }], {
        query: "(a+)+$",
        regex: true,
      });
      assert.ok(error);
      assert.match(error, /catastrophique/i);
    } finally {
      cleanup(dir);
    }
  });

  await t.test("regex trop longue est refusée", () => {
    const { store, dir } = makeStore();
    try {
      const { error } = store.searchMulti([{ serverKey: "local", name: "api" }], {
        query: "a".repeat(500),
        regex: true,
      });
      assert.ok(error);
      assert.match(error, /longue/i);
    } finally {
      cleanup(dir);
    }
  });

  await t.test("pagination (limit/offset) et tri desc par défaut", () => {
    const { store, dir } = makeStore();
    try {
      for (let i = 0; i < 10; i++) {
        store.appendPacket(1, "api", "out", `ligne ${i}\n`, 1000 + i);
      }
      const page1 = store.searchMulti([{ serverKey: "local", name: "api" }], { limit: 3, offset: 0 });
      assert.equal(page1.total, 10);
      assert.deepEqual(
        page1.results.map((r) => r.text),
        ["ligne 9", "ligne 8", "ligne 7"],
      );
      const page2 = store.searchMulti([{ serverKey: "local", name: "api" }], { limit: 3, offset: 3 });
      assert.deepEqual(
        page2.results.map((r) => r.text),
        ["ligne 6", "ligne 5", "ligne 4"],
      );
    } finally {
      cleanup(dir);
    }
  });

  await t.test("contexte : lignes avant/après la ligne trouvée, dans la même source", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(1, "api", "out", "l0\n", 1000);
      store.appendPacket(1, "api", "out", "l1\n", 1001);
      store.appendPacket(1, "api", "out", "BOOM\n", 1002);
      store.appendPacket(1, "api", "out", "l3\n", 1003);
      store.appendPacket(1, "api", "out", "l4\n", 1004);

      const { results } = store.searchMulti([{ serverKey: "local", name: "api" }], {
        query: "BOOM",
        context: 2,
        sort: "asc",
      });
      assert.equal(results.length, 1);
      assert.deepEqual(
        results[0].before.map((r) => r.text),
        ["l0", "l1"],
      );
      assert.deepEqual(
        results[0].after.map((r) => r.text),
        ["l3", "l4"],
      );
    } finally {
      cleanup(dir);
    }
  });

  await t.test(
    "un sélecteur sans aucun fichier ne fait pas planter la recherche (résultat vide pour lui)",
    () => {
      const { store, dir } = makeStore();
      try {
        store.appendPacket(1, "api", "out", "présent\n", 1000);
        const { results, total } = store.searchMulti(
          [
            { serverKey: "local", name: "api" },
            { serverKey: "local", name: "inexistant" },
            { serverKey: "srv-jamais-vu", name: "api" },
          ],
          {},
        );
        assert.equal(total, 1);
        assert.equal(results.length, 1);
      } finally {
        cleanup(dir);
      }
    },
  );

  await t.test("grand volume : la borne de lignes scannées (maxScanLines) protège la recherche", () => {
    const { store, dir } = makeStore();
    try {
      for (let i = 0; i < 200; i++) {
        store.appendPacket(1, "api", "out", `ligne ${i}\n`, 1000 + i);
      }
      const { total, truncated, scanned } = store.searchMulti([{ serverKey: "local", name: "api" }], {
        maxScanLines: 50,
      });
      assert.equal(truncated, true);
      assert.ok(scanned <= 51, `scanned=${scanned} devrait s'arrêter juste après la borne`);
      assert.ok(total < 200, "total ne doit pas dépasser ce qui a réellement été scanné");
    } finally {
      cleanup(dir);
    }
  });

  await t.test("grand volume : la borne de candidats (maxCandidates) protège le tri/la pagination", () => {
    const { store, dir } = makeStore();
    try {
      for (let i = 0; i < 100; i++) {
        store.appendPacket(1, "api", "out", `ligne ${i}\n`, 1000 + i);
      }
      const { total, truncated, results } = store.searchMulti([{ serverKey: "local", name: "api" }], {
        maxCandidates: 10,
        limit: 10,
      });
      assert.equal(total, 100); // le comptage total reste correct...
      assert.equal(truncated, true); // ...mais on signale que tout n'a pas pu être conservé pour le tri
      assert.equal(results.length, 10);
    } finally {
      cleanup(dir);
    }
  });

  await t.test("mode streaming (onMatch) : n'accumule rien, s'arrête à maxMatches", () => {
    const { store, dir } = makeStore();
    try {
      for (let i = 0; i < 30; i++) {
        store.appendPacket(1, "api", "out", `ligne ${i}\n`, 1000 + i);
      }
      const seen = [];
      const { truncated, total } = store.searchMulti([{ serverKey: "local", name: "api" }], {
        maxMatches: 5,
        onMatch: (row) => seen.push(row.text),
      });
      assert.equal(seen.length, 5);
      assert.equal(total, 5);
      assert.equal(truncated, true);
    } finally {
      cleanup(dir);
    }
  });
});

test("LogStore — clear() / clearAll()", async (t) => {
  await t.test(
    "clear() supprime le fichier actif ET les archives d'UNE instance, laisse les autres intactes",
    () => {
      const { store, dir } = makeStore();
      try {
        // Instance ciblée : un actif + une archive déjà compressée.
        store.appendPacket(1, "api", "out", "ligne active\n", Date.now());
        fs.writeFileSync(path.join(dir, "proc-1-api-2026-01-01T00-00-00-000Z.jsonl.gz"), "archive");
        // Autre process : ne doit pas être touché.
        store.appendPacket(2, "worker", "out", "autre process\n", Date.now());

        const { removed } = store.clear("local", 1, "api");
        assert.equal(removed, 2);

        const remaining = fs.readdirSync(dir).sort();
        assert.deepEqual(remaining, ["proc-2-worker.jsonl"]);
      } finally {
        cleanup(dir);
      }
    },
  );

  await t.test("clear() sur une instance sans fichiers ne fait rien (removed: 0)", () => {
    const { store, dir } = makeStore();
    try {
      const { removed } = store.clear("local", 99, "inconnu");
      assert.equal(removed, 0);
    } finally {
      cleanup(dir);
    }
  });

  await t.test("clearAll() supprime tous les process/serveurs confondus", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(1, "api", "out", "a\n", Date.now());
      store.appendPacket(2, "worker", "out", "b\n", Date.now());
      store.appendPacket(3, "api", "out", "c\n", Date.now(), "remote-1");
      fs.writeFileSync(path.join(dir, "proc-1-api-2026-01-01T00-00-00-000Z.jsonl.gz"), "archive");

      const { removed } = store.clearAll();
      assert.equal(removed, 4);
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
      cleanup(dir);
    }
  });
});
