"use strict";

/**
 * lib/routes/docker.js — Docker Monitoring (Phase 22).
 *
 * API REST, mêmes conventions que lib/routes/processes.js/logs.js (un
 * routeur par domaine, monté sous /api/docker dans server.js).
 *
 * Toutes ces routes lisent le cache du poller partagé
 * (lib/services/docker/index.js#getLastSnapshot) — AUCUNE ne déclenche un
 * nouvel appel Docker par requête HTTP (section 12 du prompt maître).
 *
 * Strictement en LECTURE SEULE : aucune action de mutation Docker (start/
 * stop/restart/kill/remove/exec...) n'est exposée ici, volontairement
 * (section 15 du prompt maître — Docker Monitoring est un monitoring, pas
 * un contrôle).
 */

const express = require("express");
const auth = require("../auth");
const dockerService = require("../services/docker");

function createDockerRouter() {
  const router = express.Router();

  router.get("/status", auth.requirePermission("docker_read"), (req, res) => {
    const snapshot = dockerService.getLastSnapshot();
    res.json({
      enabled: dockerService.ENABLED,
      available: snapshot.available,
      checkedAt: snapshot.checkedAt,
      pollIntervalMs: dockerService.POLL_INTERVAL_MS,
    });
  });

  router.get("/containers", auth.requirePermission("docker_read"), (req, res) => {
    const snapshot = dockerService.getLastSnapshot();
    res.json({
      available: snapshot.available,
      checkedAt: snapshot.checkedAt,
      containers: snapshot.containers,
    });
  });

  // Accepte aussi un ID court (préfixe), comme le fait `docker` en CLI.
  router.get("/containers/:id", auth.requirePermission("docker_read"), async (req, res) => {
    const snapshot = dockerService.getLastSnapshot();
    const cached = snapshot.containers.find((c) => c.id === req.params.id || c.id.startsWith(req.params.id));
    if (cached) return res.json(cached);
    if (!snapshot.available) {
      return res.status(503).json({ error: "Docker indisponible." });
    }
    try {
      const fresh = await dockerService.fetchContainerFresh(req.params.id);
      res.json(fresh);
    } catch (e) {
      res.status(404).json({ error: "Conteneur introuvable." });
    }
  });

  // Historique récent des logs (comme /api/processes/:id/logs/tail) — le
  // direct passe par Socket.IO ("docker:subscribe-logs"), pas par cette route.
  router.get("/containers/:id/logs", auth.requirePermission("docker_logs"), async (req, res) => {
    const tail = Math.max(1, Math.min(2000, Number(req.query.tail) || 200));
    try {
      const results = await dockerService.fetchLogsTail(req.params.id, { tail });
      res.json({ results });
    } catch (e) {
      res.status(404).json({ error: e.message || "Conteneur introuvable ou logs indisponibles." });
    }
  });

  return router;
}

module.exports = createDockerRouter;
