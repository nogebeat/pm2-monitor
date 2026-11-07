"use strict";

/**
 * lib/services/docker/client.js — Docker Monitoring (Phase 22).
 *
 * Client HTTP minimal vers l'API Docker Engine, via le socket Unix local
 * (`/var/run/docker.sock` par défaut, voir DOCKER_SOCKET_PATH). Volontairement
 * écrit à la main avec le module `http` natif plutôt qu'avec une dépendance
 * (`dockerode`) : Node supporte nativement les requêtes HTTP sur socket Unix
 * (`http.request({ socketPath, path })`), donc aucune dépendance
 * supplémentaire n'est nécessaire pour ça — même choix que
 * lib/services/metrics/format.js (formatteur Prometheus écrit à la main
 * plutôt que `prom-client`) et lib/log-store.js (recherche/regex maison
 * plutôt qu'un moteur de recherche externe).
 *
 * Ce module ne connaît QUE le transport HTTP brut : aucune mise en forme
 * (voir format.js), aucun décodage de flux de logs (voir log-demux.js),
 * aucune notion de disponibilité/cache (voir index.js). Chaque fonction
 * peut rejeter (réseau, timeout, JSON invalide, statut HTTP >= 400) —
 * c'est aux appelants de gérer ces erreurs (jamais laissées non gérées,
 * voir section 11 du prompt maître : Docker indisponible ne doit jamais
 * faire tomber PM2 Monitor).
 */

const http = require("http");

const DEFAULT_SOCKET_PATH = "/var/run/docker.sock";
const DEFAULT_TIMEOUT_MS = 3000;

/** Requête brute : résout { statusCode, body(Buffer) }, ne lève jamais sur un statut HTTP d'erreur. */
function request(
  path,
  { method = "GET", timeoutMs = DEFAULT_TIMEOUT_MS, socketPath = DEFAULT_SOCKET_PATH } = {},
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        // Host arbitraire : Docker ne vérifie pas cet en-tête sur une connexion
        // socket Unix (pas de virtual hosting côté daemon), Node l'exige juste
        // pour construire une requête HTTP/1.1 valide.
        headers: { Host: "docker" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Docker socket : délai dépassé après ${timeoutMs}ms (${path})`));
    });
    req.end();
  });
}

/** Comme request(), mais parse le corps en JSON et rejette sur un statut >= 400 (message Docker si présent). */
async function requestJson(path, options) {
  const { statusCode, body } = await request(path, options);
  let data = null;
  if (body.length) {
    try {
      data = JSON.parse(body.toString("utf8"));
    } catch (e) {
      throw new Error(`Réponse Docker invalide (${path}) : ${e.message}`);
    }
  }
  if (statusCode >= 400) {
    const message = (data && data.message) || `Docker a répondu ${statusCode} (${path})`;
    const err = new Error(message);
    err.statusCode = statusCode;
    throw err;
  }
  return data;
}

/**
 * Ouvre une requête en mode FLUX : la réponse (`http.IncomingMessage`) est
 * retournée sans être consommée, pour un usage de type `/logs?follow=1`.
 * L'appelant est responsable de lire (`res.on("data", ...)`) et de fermer
 * (`res.destroy()`) ce flux — voir index.js#subscribeToLogs, seul point du
 * projet qui garde une connexion Docker ouverte dans la durée.
 */
function openStream(path, { socketPath = DEFAULT_SOCKET_PATH } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: "GET", headers: { Host: "docker" } }, (res) => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let message = `Docker a répondu ${res.statusCode} (${path})`;
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (parsed && parsed.message) message = parsed.message;
          } catch (e) {
            /* corps d'erreur non-JSON : on garde le message générique */
          }
          const err = new Error(message);
          err.statusCode = res.statusCode;
          reject(err);
        });
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
    req.end();
  });
}

/** true si le daemon Docker répond sur le socket, false pour toute autre situation (jamais de rejet). */
async function ping({ socketPath, timeoutMs = 1500 } = {}) {
  try {
    const { statusCode } = await request("/_ping", { socketPath, timeoutMs });
    return statusCode >= 200 && statusCode < 300;
  } catch (e) {
    return false;
  }
}

function listContainers({ socketPath } = {}) {
  return requestJson("/containers/json?all=true&size=false", { socketPath });
}

function inspectContainer(id, { socketPath } = {}) {
  return requestJson(`/containers/${encodeURIComponent(id)}/json`, { socketPath });
}

/** Un seul échantillon de stats (pas de flux) — voir format.js#computeCpuPercent pour pourquoi un seul appel ne suffit pas au calcul CPU. */
function statsOnce(id, { socketPath } = {}) {
  return requestJson(`/containers/${encodeURIComponent(id)}/stats?stream=false`, {
    socketPath,
    timeoutMs: 5000,
  });
}

/** Historique récent des logs (pas de flux) — corps potentiellement multiplexé, voir log-demux.js. */
function logsTail(id, { stdout = true, stderr = true, timestamps = true, tail = 200, socketPath } = {}) {
  const qs = new URLSearchParams({
    stdout: stdout ? "1" : "0",
    stderr: stderr ? "1" : "0",
    timestamps: timestamps ? "1" : "0",
    tail: String(tail),
  });
  return request(`/containers/${encodeURIComponent(id)}/logs?${qs.toString()}`, {
    socketPath,
    timeoutMs: 5000,
  });
}

/** Flux de logs en direct (follow=1) — voir openStream() ci-dessus pour le contrat de fermeture. */
function openLogStream(id, { stdout = true, stderr = true, timestamps = true, since, socketPath } = {}) {
  const qs = new URLSearchParams({
    stdout: stdout ? "1" : "0",
    stderr: stderr ? "1" : "0",
    timestamps: timestamps ? "1" : "0",
    follow: "1",
    tail: "0",
  });
  if (since) qs.set("since", String(since));
  return openStream(`/containers/${encodeURIComponent(id)}/logs?${qs.toString()}`, { socketPath });
}

module.exports = {
  DEFAULT_SOCKET_PATH,
  ping,
  listContainers,
  inspectContainer,
  statsOnce,
  logsTail,
  openLogStream,
};
