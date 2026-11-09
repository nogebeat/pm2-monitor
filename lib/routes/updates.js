"use strict";

/**
 * lib/routes/updates.js — Vérification des mises à jour (Phase 23, étape 1 :
 * LECTURE SEULE), monté sous /api/updates dans server.js.
 *
 * Aucune route ne déclenche une mise à jour : on informe (version installée,
 * release disponible, diagnostic de l'installation, commande à lancer soi-même).
 * Tout est protégé par `updates_read` — action globale, réservée à l'humain
 * (absente des scopes de clés API) : le diagnostic révèle le chemin
 * d'installation, la branche suivie et l'utilisateur système du service.
 */

const express = require("express");
const auth = require("../auth");

function createUpdatesRouter({ updateService }) {
  const router = express.Router();

  router.get("/status", auth.requirePermission("updates_read"), (req, res) => {
    res.json(updateService.getStatus());
  });

  // Revérifier maintenant (limité à 1 par minute, voir lib/services/updates/index.js).
  router.post("/check", auth.requirePermission("updates_read"), async (req, res) => {
    const outcome = await updateService.check({ force: true });
    res.json({ ...updateService.getStatus(), throttled: outcome.throttled === true });
  });

  router.get("/diagnostics", auth.requirePermission("updates_read"), async (req, res) => {
    try {
      res.json(await updateService.getDiagnostics({ force: req.query.refresh === "1" }));
    } catch (e) {
      res.status(500).json({ error: "Diagnostic indisponible." });
    }
  });

  return router;
}

module.exports = createUpdatesRouter;
