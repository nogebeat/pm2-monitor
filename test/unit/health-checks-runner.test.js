"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseExpectedStatus,
  runHttp,
  runTcp,
  runCommand,
  runProbe,
} = require("../../lib/services/health-checks/runner");

/**
 * Tous les appels réseau/process sont mockés via l'injection `impls`
 * (httpRequestImpl/tcpConnectImpl/execFileImpl) : aucun accès réseau réel,
 * conformément à la règle CI. Voir lib/services/health-checks/runner.js.
 */

test("parseExpectedStatus() — plage, liste, valeur unique, défaut", () => {
  const range = parseExpectedStatus("200-299");
  assert.equal(range(200), true);
  assert.equal(range(299), true);
  assert.equal(range(300), false);

  const list = parseExpectedStatus("200,201,204");
  assert.equal(list(201), true);
  assert.equal(list(202), false);

  const exact = parseExpectedStatus("200");
  assert.equal(exact(200), true);
  assert.equal(exact(201), false);

  const dflt = parseExpectedStatus();
  assert.equal(dflt(200), true);
  assert.equal(dflt(404), false);
});

test("runHttp() — HTTP 200 -> UP", async () => {
  const httpRequestImpl = async () => ({ ok: true, statusCode: 200, responseTimeMs: 20, body: "" });
  const check = { url: "http://example.test", method: "GET", timeoutMs: 5000, expectedStatus: "200-299" };
  const result = await runHttp(check, { httpRequestImpl });
  assert.equal(result.status, "UP");
  assert.equal(result.statusCode, 200);
});

test("runHttp() — HTTP 500 -> DOWN", async () => {
  const httpRequestImpl = async () => ({ ok: true, statusCode: 500, responseTimeMs: 15, body: "" });
  const check = { url: "http://example.test", method: "GET", timeoutMs: 5000, expectedStatus: "200-299" };
  const result = await runHttp(check, { httpRequestImpl });
  assert.equal(result.status, "DOWN");
  assert.equal(result.statusCode, 500);
  assert.match(result.error, /statut inattendu/i);
});

test("runHttp() — timeout -> DOWN", async () => {
  const httpRequestImpl = async () => ({ ok: false, error: "timeout", responseTimeMs: 5000 });
  const check = { url: "http://example.test", method: "GET", timeoutMs: 5000, expectedStatus: "200-299" };
  const result = await runHttp(check, { httpRequestImpl });
  assert.equal(result.status, "DOWN");
  assert.equal(result.error, "timeout");
  assert.equal(result.statusCode, null);
});

test("runHttp() — réponse lente (> degradedThresholdMs) -> DEGRADED", async () => {
  const httpRequestImpl = async () => ({ ok: true, statusCode: 200, responseTimeMs: 900, body: "" });
  const check = {
    url: "http://example.test",
    method: "GET",
    timeoutMs: 5000,
    expectedStatus: "200-299",
    degradedThresholdMs: 500,
  };
  const result = await runHttp(check, { httpRequestImpl });
  assert.equal(result.status, "DEGRADED");
});

test("runHttp() — contenu attendu absent -> DOWN", async () => {
  const httpRequestImpl = async () => ({ ok: true, statusCode: 200, responseTimeMs: 20, body: "tout va bien" });
  const check = {
    url: "http://example.test",
    method: "GET",
    timeoutMs: 5000,
    expectedStatus: "200-299",
    expectedContent: "OK",
  };
  const result = await runHttp(check, { httpRequestImpl });
  assert.equal(result.status, "DOWN");
  assert.match(result.error, /contenu attendu/i);
});

test("runHttp() — contenu attendu présent -> UP", async () => {
  const httpRequestImpl = async () => ({ ok: true, statusCode: 200, responseTimeMs: 20, body: "status: OK" });
  const check = {
    url: "http://example.test",
    method: "GET",
    timeoutMs: 5000,
    expectedStatus: "200-299",
    expectedContent: "OK",
  };
  const result = await runHttp(check, { httpRequestImpl });
  assert.equal(result.status, "UP");
});

test("runTcp() — connexion réussie -> UP", async () => {
  const tcpConnectImpl = async () => ({ ok: true, responseTimeMs: 5 });
  const check = { host: "db.internal", port: 5432, timeoutMs: 3000 };
  const result = await runTcp(check, { tcpConnectImpl });
  assert.equal(result.status, "UP");
});

test("runTcp() — connexion refusée -> DOWN", async () => {
  const tcpConnectImpl = async () => ({ ok: false, error: "ECONNREFUSED", responseTimeMs: 2 });
  const check = { host: "db.internal", port: 5432, timeoutMs: 3000 };
  const result = await runTcp(check, { tcpConnectImpl });
  assert.equal(result.status, "DOWN");
  assert.equal(result.error, "ECONNREFUSED");
});

test("runTcp() — lent (> degradedThresholdMs) -> DEGRADED", async () => {
  const tcpConnectImpl = async () => ({ ok: true, responseTimeMs: 2000 });
  const check = { host: "db.internal", port: 5432, timeoutMs: 3000, degradedThresholdMs: 1000 };
  const result = await runTcp(check, { tcpConnectImpl });
  assert.equal(result.status, "DEGRADED");
});

test("runTcp() — timeout -> DOWN", async () => {
  const tcpConnectImpl = async () => ({ ok: false, error: "timeout", responseTimeMs: 3000 });
  const check = { host: "db.internal", port: 5432, timeoutMs: 3000 };
  const result = await runTcp(check, { tcpConnectImpl });
  assert.equal(result.status, "DOWN");
  assert.equal(result.error, "timeout");
});

test("runCommand() — code de sortie attendu -> UP", async () => {
  const execFileImpl = async () => ({ ok: true, exitCode: 0, responseTimeMs: 10 });
  const check = { command: "/usr/bin/true", commandArgs: [], timeoutMs: 3000, expectedExitCode: 0 };
  const result = await runCommand(check, { execFileImpl });
  assert.equal(result.status, "UP");
  assert.equal(result.statusCode, "0");
});

test("runCommand() — code de sortie inattendu -> DOWN", async () => {
  const execFileImpl = async () => ({ ok: true, exitCode: 1, responseTimeMs: 10 });
  const check = { command: "/usr/bin/false", commandArgs: [], timeoutMs: 3000, expectedExitCode: 0 };
  const result = await runCommand(check, { execFileImpl });
  assert.equal(result.status, "DOWN");
  assert.match(result.error, /code de sortie inattendu/i);
});

test("runCommand() — timeout -> DOWN", async () => {
  const execFileImpl = async () => ({ ok: false, error: "timeout", responseTimeMs: 3000 });
  const check = { command: "/bin/sleep", commandArgs: ["99"], timeoutMs: 3000, expectedExitCode: 0 };
  const result = await runCommand(check, { execFileImpl });
  assert.equal(result.status, "DOWN");
  assert.equal(result.error, "timeout");
});

test("runCommand() — args passés séparément à execFile, jamais interpolés dans une chaîne shell", async () => {
  let received;
  const execFileImpl = async (opts) => {
    received = opts;
    return { ok: true, exitCode: 0, responseTimeMs: 5 };
  };
  const check = {
    command: "/usr/bin/curl",
    commandArgs: ["-s", "http://x; rm -rf /"], // métacaractères shell dans un argument
    timeoutMs: 3000,
    expectedExitCode: 0,
  };
  await runCommand(check, { execFileImpl });
  // L'argument malveillant doit arriver tel quel, en tant qu'élément du tableau `args`,
  // jamais concaténé dans une chaîne `command` — c'est ce qui empêche l'injection shell.
  assert.equal(received.command, "/usr/bin/curl");
  assert.deepEqual(received.args, ["-s", "http://x; rm -rf /"]);
});

test("runProbe() — dispatch selon check.type", async () => {
  const httpRequestImpl = async () => ({ ok: true, statusCode: 200, responseTimeMs: 1, body: "" });
  const r = await runProbe(
    { type: "http", url: "http://x", method: "GET", timeoutMs: 1000, expectedStatus: "200-299" },
    { httpRequestImpl }
  );
  assert.equal(r.status, "UP");
});

test("runProbe() — type invalide -> throw", async () => {
  await assert.rejects(() => runProbe({ type: "ftp" }, {}), /type de health check invalide/i);
});
