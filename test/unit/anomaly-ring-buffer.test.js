"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RingBuffer } = require("../../lib/services/anomaly-detection/ring-buffer");

test("RingBuffer — push()/valuesBefore() : exclut le point au même timestamp", () => {
  const buf = new RingBuffer({ maxAgeMs: 60000 });
  buf.push(1000, 10);
  buf.push(2000, 20);
  assert.deepEqual(buf.valuesBefore(2000), [10], "le point à t=2000 lui-même est exclu");
  assert.deepEqual(buf.valuesBefore(3000), [10, 20]);
});

test("RingBuffer — élague les points plus vieux que maxAgeMs", () => {
  const buf = new RingBuffer({ maxAgeMs: 5000 });
  buf.push(0, 1);
  buf.push(3000, 2);
  buf.push(10000, 3); // à ce moment, cutoff = 10000 - 5000 = 5000 : les points à t=0 et t=3000 sont purgés
  assert.deepEqual(buf.valuesBefore(20000), [3]);
});

test("RingBuffer — borne le nombre de points à maxPoints", () => {
  const buf = new RingBuffer({ maxAgeMs: 10_000_000, maxPoints: 3 });
  for (let i = 0; i < 10; i++) buf.push(i * 1000, i);
  assert.equal(buf.points.length, 3);
  assert.deepEqual(
    buf.points.map((p) => p.value),
    [7, 8, 9],
  );
});

test("RingBuffer — ignore les valeurs non numériques (NaN/undefined)", () => {
  const buf = new RingBuffer({ maxAgeMs: 60000 });
  buf.push(1000, NaN);
  buf.push(2000, undefined);
  buf.push(3000, 42);
  assert.deepEqual(buf.valuesBefore(4000), [42]);
});

test("RingBuffer — ensureMaxAge() n'étend jamais vers le bas", () => {
  const buf = new RingBuffer({ maxAgeMs: 10000 });
  buf.ensureMaxAge(5000);
  assert.equal(buf.maxAgeMs, 10000, "une fenêtre plus courte ne doit jamais réduire la rétention existante");
  buf.ensureMaxAge(20000);
  assert.equal(buf.maxAgeMs, 20000, "une règle avec une fenêtre plus large étend la rétention");
});
