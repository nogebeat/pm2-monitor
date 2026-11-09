"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseVersion,
  parseReleaseTag,
  compareVersions,
  classifyUpdate,
} = require("../../lib/services/updates/semver");

test("parseReleaseTag — seules les versions stables vX.Y.Z sont des releases", async (t) => {
  await t.test("accepte vMAJOR.MINOR.PATCH", () => {
    assert.deepEqual(parseReleaseTag("v4.1.2"), { major: 4, minor: 1, patch: 2, pre: null });
  });
  for (const bad of [
    "4.1.2",
    "v4.1",
    "v4.1.2-rc1",
    "v4.1.2+build",
    "latest",
    "",
    null,
    undefined,
    "v4.1.2 ",
    "vx.y.z",
  ]) {
    await t.test(`rejette ${JSON.stringify(bad)}`, () => assert.equal(parseReleaseTag(bad), null));
  }
});

test("parseVersion — version installée (package.json)", async (t) => {
  await t.test("accepte avec ou sans v et les pré-versions", () => {
    assert.equal(parseVersion("4.1.2").minor, 1);
    assert.equal(parseVersion("v4.2.0-beta.1").pre, "beta.1");
  });
  await t.test("rejette les valeurs invalides", () => {
    assert.equal(parseVersion("abc"), null);
    assert.equal(parseVersion("4.1"), null);
  });
});

test("compareVersions", async (t) => {
  const v = (s) => parseVersion(s);
  await t.test("ordonne majeur, mineur, patch", () => {
    assert.ok(compareVersions(v("5.0.0"), v("4.9.9")) > 0);
    assert.ok(compareVersions(v("4.2.0"), v("4.1.9")) > 0);
    assert.ok(compareVersions(v("4.1.3"), v("4.1.2")) > 0);
    assert.equal(compareVersions(v("4.1.2"), v("4.1.2")), 0);
  });
  await t.test("compare numériquement (4.10.0 > 4.9.0)", () => {
    assert.ok(compareVersions(v("4.10.0"), v("4.9.0")) > 0);
  });
  await t.test("une pré-version est inférieure à la version finale", () => {
    assert.ok(compareVersions(v("4.2.0-beta.1"), v("4.2.0")) < 0);
  });
});

test("classifyUpdate", async (t) => {
  const v = (s) => parseVersion(s);
  await t.test("patch / minor / major", () => {
    assert.equal(classifyUpdate(v("4.1.2"), v("4.1.3")), "patch");
    assert.equal(classifyUpdate(v("4.1.2"), v("4.2.0")), "minor");
    assert.equal(classifyUpdate(v("4.1.2"), v("5.0.0")), "major");
  });
  await t.test("null si égale ou plus ancienne", () => {
    assert.equal(classifyUpdate(v("4.1.2"), v("4.1.2")), null);
    assert.equal(classifyUpdate(v("4.1.2"), v("4.0.9")), null);
  });
  await t.test("la version installée en pré-version voit sa version finale comme mise à jour", () => {
    assert.equal(classifyUpdate(v("4.2.0-beta.1"), v("4.2.0")), "patch");
  });
});
