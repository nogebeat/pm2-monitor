"use strict";

/**
 * Exécution des trois types de sondes (voir docs/health-checks/README.md).
 * Fonctions pures autant que possible : chaque `run*()` prend une config déjà
 * validée (lib/services/health-checks/store.js) et retourne
 * `{ ok, statusCode, responseTimeMs, error }` — jamais de throw pour un échec
 * "normal" (timeout, connexion refusée, mauvais code retour) : ça reste un
 * résultat DOWN, pas une erreur de programmation. Seules des entrées
 * mal formées (déjà rejetées par store.validate()) devraient throw.
 *
 * Aucune dépendance ajoutée : http/https/net/child_process sont natifs à
 * Node. Les appels réseau sont ici derrière des fonctions injectables
 * (`httpRequestImpl`, `tcpConnectImpl`, `execFileImpl`) pour permettre aux
 * tests de les mocker sans jamais toucher au réseau (voir
 * test/unit/health-checks-runner.test.js et la règle "aucun appel réseau
 * réel en CI").
 */

const http = require("http");
const https = require("https");
const net = require("net");
const { execFile } = require("child_process");

/** Parse "200-299", "200,201,204" ou "200" en prédicat status -> bool. */
function parseExpectedStatus(spec) {
  const raw = String(spec || "200-299").trim();
  const clauses = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const predicates = clauses.map((clause) => {
    const range = clause.match(/^(\d{3})\s*-\s*(\d{3})$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      return (code) => code >= lo && code <= hi;
    }
    const exact = Number(clause);
    return (code) => code === exact;
  });
  if (!predicates.length) return (code) => code >= 200 && code < 300;
  return (code) => predicates.some((p) => p(code));
}

function defaultHttpRequest({ url, method, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      return resolve({ ok: false, error: `URL invalide : ${e.message}` });
    }
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(target, { method: method || "GET", timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => {
        // On ne garde qu'un extrait : la vérification de contenu n'a pas
        // besoin du corps complet, et ça évite de charger une réponse
        // potentiellement énorme en mémoire pour un simple health check.
        if (Buffer.concat(chunks).length < 65536) chunks.push(c);
      });
      res.on("end", () => {
        resolve({
          ok: true,
          statusCode: res.statusCode,
          responseTimeMs: Date.now() - started,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout", responseTimeMs: Date.now() - started });
    });
    req.on("error", (e) => {
      resolve({ ok: false, error: e.message, responseTimeMs: Date.now() - started });
    });
    req.end();
  });
}

function defaultTcpConnect({ host, port, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ ok: true, responseTimeMs: Date.now() - started }));
    socket.once("timeout", () =>
      finish({ ok: false, error: "timeout", responseTimeMs: Date.now() - started }),
    );
    socket.once("error", (e) =>
      finish({ ok: false, error: e.message, responseTimeMs: Date.now() - started }),
    );
    socket.connect(port, host);
  });
}

/**
 * Exécution "command" sécurisée : `execFile` (jamais `exec`/`shell: true`),
 * commande et arguments passés séparément — aucune concaténation de chaîne
 * ni interprétation shell, donc aucune injection possible via `command` ou
 * `commandArgs` même s'ils contiennent des métacaractères shell
 * (`; | & $() \`` …). Voir docs/health-checks/README.md#command pour le
 * détail de ce choix.
 */
function defaultExecFile({ command, args, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(command, args || [], { timeout: timeoutMs, shell: false, windowsHide: true }, (error) => {
      const responseTimeMs = Date.now() - started;
      if (error) {
        if (error.killed || error.signal === "SIGTERM") {
          return resolve({ ok: false, error: "timeout", responseTimeMs });
        }
        // execFile met le code de sortie non-nul dans error.code (nombre).
        const exitCode = typeof error.code === "number" ? error.code : null;
        return resolve({ ok: true, exitCode, responseTimeMs });
      }
      resolve({ ok: true, exitCode: 0, responseTimeMs });
    });
  });
}

async function runHttp(check, { httpRequestImpl = defaultHttpRequest } = {}) {
  const res = await httpRequestImpl({ url: check.url, method: check.method, timeoutMs: check.timeoutMs });
  if (!res.ok) {
    return { status: "DOWN", responseTimeMs: res.responseTimeMs ?? null, statusCode: null, error: res.error };
  }

  const expectPredicate = parseExpectedStatus(check.expectedStatus);
  const statusOk = expectPredicate(res.statusCode);
  const contentOk = check.expectedContent ? String(res.body || "").includes(check.expectedContent) : true;

  if (!statusOk) {
    return {
      status: "DOWN",
      responseTimeMs: res.responseTimeMs,
      statusCode: res.statusCode,
      error: `Code de statut inattendu : ${res.statusCode} (attendu : ${check.expectedStatus}).`,
    };
  }
  if (!contentOk) {
    return {
      status: "DOWN",
      responseTimeMs: res.responseTimeMs,
      statusCode: res.statusCode,
      error: "Contenu attendu introuvable dans la réponse.",
    };
  }

  const degraded = check.degradedThresholdMs && res.responseTimeMs > check.degradedThresholdMs;
  return {
    status: degraded ? "DEGRADED" : "UP",
    responseTimeMs: res.responseTimeMs,
    statusCode: res.statusCode,
    error: null,
  };
}

async function runTcp(check, { tcpConnectImpl = defaultTcpConnect } = {}) {
  const res = await tcpConnectImpl({ host: check.host, port: check.port, timeoutMs: check.timeoutMs });
  if (!res.ok) {
    return { status: "DOWN", responseTimeMs: res.responseTimeMs ?? null, statusCode: null, error: res.error };
  }
  const degraded = check.degradedThresholdMs && res.responseTimeMs > check.degradedThresholdMs;
  return {
    status: degraded ? "DEGRADED" : "UP",
    responseTimeMs: res.responseTimeMs,
    statusCode: null,
    error: null,
  };
}

async function runCommand(check, { execFileImpl = defaultExecFile } = {}) {
  const res = await execFileImpl({
    command: check.command,
    args: Array.isArray(check.commandArgs) ? check.commandArgs : [],
    timeoutMs: check.timeoutMs,
  });
  if (!res.ok) {
    return { status: "DOWN", responseTimeMs: res.responseTimeMs ?? null, statusCode: null, error: res.error };
  }
  const expected =
    check.expectedExitCode === undefined || check.expectedExitCode === null ? 0 : check.expectedExitCode;
  if (res.exitCode !== expected) {
    return {
      status: "DOWN",
      responseTimeMs: res.responseTimeMs,
      statusCode: String(res.exitCode),
      error: `Code de sortie inattendu : ${res.exitCode} (attendu : ${expected}).`,
    };
  }
  const degraded = check.degradedThresholdMs && res.responseTimeMs > check.degradedThresholdMs;
  return {
    status: degraded ? "DEGRADED" : "UP",
    responseTimeMs: res.responseTimeMs,
    statusCode: String(res.exitCode),
    error: null,
  };
}

/** Point d'entrée générique : dispatch selon check.type. `impls` permet l'injection pour les tests. */
async function runProbe(check, impls = {}) {
  switch (check.type) {
    case "http":
      return runHttp(check, impls);
    case "tcp":
      return runTcp(check, impls);
    case "command":
      return runCommand(check, impls);
    default:
      throw new Error(`Type de health check invalide : "${check.type}".`);
  }
}

module.exports = {
  parseExpectedStatus,
  runHttp,
  runTcp,
  runCommand,
  runProbe,
  defaultHttpRequest,
  defaultTcpConnect,
  defaultExecFile,
};
