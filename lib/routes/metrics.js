"use strict";

/**
 * lib/routes/metrics.js — Phase 15 (Prometheus Metrics Export).
 *
 * GET /metrics — monté directement sur `app` (PAS sous /api, voir
 * lib/services/metrics/config.js pour le pourquoi). Compose des métriques
 * déjà disponibles ailleurs (system-stats, pm2.list/fmtProcess, alertStore,
 * healthChecksStore, serversStore) via lib/services/metrics/registry.js —
 * aucune nouvelle collecte, aucun nouveau scheduler.
 *
 * Accès contrôlé par lib/services/metrics/config.js (activation, token
 * bearer, restriction IP), PAS par le système de permissions par
 * utilisateur (lib/permissions.js) : un scraper Prometheus n'a pas de
 * session ni de compte PM2 Monitor. Voir docs/metrics/README.md#sécurité.
 */

const express = require("express");
const crypto = require("crypto");
const { resolveConfig } = require("../services/metrics/config");
const { buildMetricsText } = require("../services/metrics/registry");
const packageJson = require("../../package.json");

/** Compare deux chaînes en temps constant (évite un timing attack sur le token). */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Normalise une IPv4-mapped-IPv6 ("::ffff:127.0.0.1") vers sa forme IPv4, pour comparaison simple. */
function normalizeIp(ip) {
  if (typeof ip !== "string") return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function checkAccess(req, config) {
  if (config.allowedIps) {
    const ip = normalizeIp(req.ip);
    const allowed = config.allowedIps.some((entry) => normalizeIp(entry) === ip);
    if (!allowed) return { ok: false, status: 403, error: "IP non autorisée pour /metrics." };
  }
  if (config.token) {
    const header = req.get("authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match || !safeEqual(match[1], config.token)) {
      return { ok: false, status: 401, error: "Token invalide ou manquant pour /metrics." };
    }
  }
  return { ok: true };
}

/**
 * @param {object} deps
 * @param {object} deps.pm2 - instance module pm2 (singleton, voir lib/process-helpers.js)
 * @param {(p: object) => object} deps.fmtProcess - lib/process-helpers.js#fmtProcess
 * @param {() => object} deps.getSystemSnapshot - lib/system-stats.js#snapshot()
 * @param {{listActive: Function}} [deps.alertStore] - lib/services/alerts/alert-store.js
 * @param {{list: Function}} [deps.healthChecksStore] - lib/services/health-checks/store.js
 * @param {{list: Function}} deps.serversStore - lib/services/servers/store.js
 * @param {{isOnline: (serverKey: string) => boolean}} [deps.agentHub] - lib/realtime/agent-hub.js
 */
function createMetricsRouter({
  pm2,
  fmtProcess,
  getSystemSnapshot,
  alertStore,
  healthChecksStore,
  serversStore,
  agentHub,
}) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    const config = resolveConfig();
    if (!config.enabled) {
      return res.status(404).end();
    }

    const access = checkAccess(req, config);
    if (!access.ok) {
      res.set("Cache-Control", "no-store");
      return res.status(access.status).type("text/plain").send(access.error);
    }

    try {
      const servers = (await serversStore.list()).map((s) => {
        if (s.kind === "local") return { ...s, status: "ONLINE" };
        const live = agentHub && agentHub.isOnline(s.serverKey);
        if (live && s.status !== "ONLINE") return { ...s, status: "ONLINE" };
        return s;
      });

      const localProcesses = await new Promise((resolve, reject) => {
        pm2.list((err, list) => {
          if (err) return reject(err);
          resolve(list.map(fmtProcess));
        });
      });

      const remoteProcessesByServer = new Map();
      const remoteSystemByServer = new Map();
      for (const s of servers) {
        if (s.kind === "local") continue;
        // Phase 15 — Prometheus : `s.processes` vient de servers.last_processes
        // (migration 017), persisté à chaque register/heartbeat d'agent (voir
        // lib/services/servers/store.js#touchStatus) — survit à un redémarrage
        // du serveur central, contrairement à un cache mémoire.
        if (Array.isArray(s.processes) && s.processes.length) {
          remoteProcessesByServer.set(s.serverKey, s.processes);
        }
        if (s.snapshot) remoteSystemByServer.set(s.serverKey, s.snapshot);
      }

      const [alerts, healthChecks] = await Promise.all([
        alertStore ? alertStore.listActive() : Promise.resolve(null),
        healthChecksStore ? healthChecksStore.list() : Promise.resolve(null),
      ]);

      const text = buildMetricsText({
        localProcesses,
        localSystem: getSystemSnapshot ? getSystemSnapshot() : null,
        servers,
        remoteProcessesByServer,
        remoteSystemByServer,
        alerts,
        healthChecks,
        appVersion: packageJson.version,
      });

      res.set("Cache-Control", "no-store");
      res.type("text/plain; version=0.0.4; charset=utf-8").send(text);
    } catch (e) {
      console.error("Erreur de génération des métriques Prometheus :", e.message);
      res.set("Cache-Control", "no-store");
      res.status(500).type("text/plain").send(`# error generating metrics: ${e.message}\n`);
    }
  });

  return router;
}

module.exports = createMetricsRouter;
