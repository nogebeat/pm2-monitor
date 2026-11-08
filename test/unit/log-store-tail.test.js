"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LogStore } = require("../../lib/log-store");

/** LogStore#tail — les DERNIÈRES lignes (search() renvoie, lui, les premières). */

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-logtail-"));
  return { store: new LogStore(dir), dir };
}

test("LogStore#tail", async (t) => {
  await t.test("renvoie les dernières lignes dans l'ordre chronologique, out et err mêlés", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(0, "app", "out", "l1\nl2\n", 1);
      store.appendPacket(0, "app", "err", "boom\n", 2);
      store.appendPacket(0, "app", "out", "l3\n", 3);
      const rows = store.tail(0, "app", { limit: 3 });
      assert.deepEqual(
        rows.map((r) => `${r.type}:${r.text}`),
        ["out:l2", "err:boom", "out:l3"],
      );
      assert.deepEqual(
        rows.map((r) => r.t),
        [1, 2, 3],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("process inconnu ou vide -> []", () => {
    const { store, dir } = makeStore();
    try {
      assert.deepEqual(store.tail(42, "nope", { limit: 10 }), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("fichier plus gros que la fenêtre de lecture : première ligne coupée ignorée", () => {
    const { store, dir } = makeStore();
    try {
      for (let i = 0; i < 400; i++) store.appendPacket(1, "big", "out", `ligne ${i}\n`, i);
      const file = store._activePath("local", 1, "big");
      const rows = store._readLinesTail(file, 2000);
      assert.ok(rows.length > 0 && rows.length < 400);
      assert.equal(rows[rows.length - 1].text, "ligne 399");
      // toutes les lignes lues sont des JSON complets
      assert.ok(rows.every((r) => typeof r.text === "string" && /^ligne \d+$/.test(r.text)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("clear() vide aussi tail()", () => {
    const { store, dir } = makeStore();
    try {
      store.appendPacket(2, "x", "out", "a\n", 1);
      assert.equal(store.tail(2, "x").length, 1);
      store.clear("local", 2, "x");
      assert.deepEqual(store.tail(2, "x"), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
