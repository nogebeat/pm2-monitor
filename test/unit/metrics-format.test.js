"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  escapeLabelValue,
  formatLabels,
  formatValue,
  createWriter,
} = require("../../lib/services/metrics/format");

test("escapeLabelValue() échappe backslash, guillemets et retours à la ligne", () => {
  assert.equal(escapeLabelValue('a"b'), 'a\\"b');
  assert.equal(escapeLabelValue("a\\b"), "a\\\\b");
  assert.equal(escapeLabelValue("a\nb"), "a\\nb");
  assert.equal(escapeLabelValue(null), "");
  assert.equal(escapeLabelValue(undefined), "");
});

test('formatLabels() produit la syntaxe {k="v",...} et ignore null/undefined', () => {
  assert.equal(formatLabels({ a: "1", b: "2" }), '{a="1",b="2"}');
  assert.equal(formatLabels({ a: "1", b: null, c: undefined }), '{a="1"}');
  assert.equal(formatLabels({}), "");
  assert.equal(formatLabels(undefined), "");
});

test("formatValue() gère les cas spéciaux (NaN, Infinity, null)", () => {
  assert.equal(formatValue(42), "42");
  assert.equal(formatValue(null), "0");
  assert.equal(formatValue(undefined), "0");
  assert.equal(formatValue(NaN), "0");
  assert.equal(formatValue(Infinity), "+Inf");
  assert.equal(formatValue(-Infinity), "-Inf");
});

test("createWriter() n'écrit HELP/TYPE qu'une seule fois par nom de métrique", () => {
  const w = createWriter();
  w.metric("pm2_monitor_x", "gauge", "desc", { a: "1" }, 1);
  w.metric("pm2_monitor_x", "gauge", "desc", { a: "2" }, 2);
  const text = w.toString();
  assert.equal((text.match(/# HELP pm2_monitor_x/g) || []).length, 1);
  assert.equal((text.match(/# TYPE pm2_monitor_x/g) || []).length, 1);
  assert.match(text, /pm2_monitor_x\{a="1"\} 1/);
  assert.match(text, /pm2_monitor_x\{a="2"\} 2/);
});

test("createWriter() sample() sans labels produit une ligne sans accolades", () => {
  const w = createWriter();
  w.declare("pm2_monitor_up", "gauge", "up");
  w.sample("pm2_monitor_up", {}, 1);
  assert.match(w.toString(), /^pm2_monitor_up 1$/m);
});
