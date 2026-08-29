"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { toCSV, toJSON, exportReport, FORMATS } = require("../../lib/services/reports/export");

const SAMPLE_REPORT = {
  period: { period: "daily", start: 1000, end: 2000 },
  summary: { availabilityPercent: 99.5, crashes: 1 },
  processes: [
    {
      processName: "api",
      serverKey: "local",
      availabilityPercent: 99.5,
      crashes: 1,
      restarts: 3,
      cpuAvg: 12.3,
      memoryAvg: 1048576,
      downtimeMs: 500,
      alertCount: 2,
    },
    {
      processName: "wei,rd \"name\"",
      serverKey: "local",
      availabilityPercent: null,
      crashes: 0,
      restarts: 0,
      cpuAvg: null,
      memoryAvg: null,
      downtimeMs: 0,
      alertCount: 0,
    },
  ],
};

test("toJSON() — sérialise le rapport complet sans perte", () => {
  const json = toJSON(SAMPLE_REPORT);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, SAMPLE_REPORT);
});

test("toCSV() — une ligne d'en-tête + une ligne par process", () => {
  const csv = toCSV(SAMPLE_REPORT);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 3); // header + 2 process
  assert.match(lines[0], /^process,server,availability_percent/);
  assert.match(lines[1], /^api,local,99\.5,1,3,12\.3,1048576,500,2$/);
});

test("toCSV() — échappe les valeurs contenant une virgule ou des guillemets", () => {
  const csv = toCSV(SAMPLE_REPORT);
  assert.match(csv, /"wei,rd ""name"""/);
});

test("toCSV() — gère un rapport sans process (rien à exporter)", () => {
  const csv = toCSV({ processes: [] });
  assert.equal(csv.trim().split("\n").length, 1); // seulement l'en-tête
});

test("exportReport() — json/csv retournent le bon content-type et un body non vide", () => {
  for (const format of FORMATS) {
    const { contentType, filename, body } = exportReport(SAMPLE_REPORT, format);
    assert.ok(contentType.includes(format === "json" ? "json" : "csv"));
    assert.ok(filename.endsWith(`.${format}`));
    assert.ok(body.length > 0);
  }
});

test("exportReport() — rejette un format inconnu", () => {
  assert.throws(() => exportReport(SAMPLE_REPORT, "pdf"), /Format d'export invalide/);
});
