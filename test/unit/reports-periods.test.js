"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolvePeriod, PERIODS, HOUR, DAY } = require("../../lib/services/reports/periods");

test("resolvePeriod() — daily/weekly/monthly sont des fenêtres glissantes se terminant à `now`", () => {
  const now = 1_000_000_000_000;

  const daily = resolvePeriod({ period: "daily" }, now);
  assert.equal(daily.end, now);
  assert.equal(daily.start, now - DAY);

  const weekly = resolvePeriod({ period: "weekly" }, now);
  assert.equal(weekly.start, now - 7 * DAY);

  const monthly = resolvePeriod({ period: "monthly" }, now);
  assert.equal(monthly.start, now - 30 * DAY);
});

test("resolvePeriod() — custom accepte start/end en epoch ms", () => {
  const now = 1_000_000_000_000;
  const result = resolvePeriod({ period: "custom", start: now - 5 * DAY, end: now - DAY }, now);
  assert.equal(result.start, now - 5 * DAY);
  assert.equal(result.end, now - DAY);
});

test("resolvePeriod() — custom accepte des dates ISO", () => {
  const result = resolvePeriod({ period: "custom", start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z" });
  assert.equal(result.start, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(result.end, Date.parse("2026-01-08T00:00:00.000Z"));
});

test("resolvePeriod() — custom sans end retombe sur `now`", () => {
  const now = 1_000_000_000_000;
  const result = resolvePeriod({ period: "custom", start: now - HOUR }, now);
  assert.equal(result.end, now);
});

test("resolvePeriod() — rejette une période inconnue", () => {
  assert.throws(() => resolvePeriod({ period: "yearly" }), /period invalide/);
});

test("resolvePeriod() — custom rejette start manquant ou end <= start", () => {
  assert.throws(() => resolvePeriod({ period: "custom", end: Date.now() }), /start invalide/);
  assert.throws(
    () => resolvePeriod({ period: "custom", start: 2000, end: 1000 }),
    /end doit être postérieur/,
  );
});

test("PERIODS liste les 4 périodes attendues", () => {
  assert.deepEqual(PERIODS, ["daily", "weekly", "monthly", "custom"]);
});
