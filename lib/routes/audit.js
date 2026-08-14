"use strict";

/**
 * Routes REST de l'audit log (lib/services/audit/). Même découpage que
 * lib/routes/events.js : la logique métier (pagination, filtres) vit dans
 * audit-store.js, ce module ne fait que valider la requête HTTP, appliquer
 * les permissions, et formater la réponse.
 *
 * Monté dans server.js via `app.use("/api/audit", require("./lib/routes/audit")())`.
 *
 * Permissions (section 7 du prompt maître) : `audit_read`, permission
 * GLOBALE (comme `alerts_read`/`events_read`) — voir lib/permissions.js.
 * Il n'existe volontairement AUCUN filtre qui permettrait à un utilisateur
 * de contourner cette permission : `GET /api/audit` est protégé dans son
 * ensemble par `auth.requirePermission("audit_read")`, il n'y a pas de
 * filtrage "par app" à côté duquel un utilisateur pourrait passer (l'audit
 * log n'est pas décomposé par app, exactement comme la timeline
 * d'événements ou l'historique des alertes).
 */

const express = require("express");
const auth = require("../auth");
const { auditStore, ACTIONS, STATUS } = require("../services/audit");

const STATUSES = Object.values(STATUS);

function createAuditRouter() {
  const router = express.Router();

  router.get("/", auth.requirePermission("audit_read"), async (req, res) => {
    try {
      const { user, username, action, status, target, targetType, start, end, limit, offset } = req.query;

      if (status && !STATUSES.includes(status)) {
        return res.status(400).json({ error: `status invalide: "${status}". Attendu: ${STATUSES.join(", ")}.` });
      }

      const result = await auditStore.list({
        userId: user !== undefined ? Number(user) : undefined,
        username: username || undefined,
        action: action || undefined,
        status: status || undefined,
        target: target || undefined,
        targetType: targetType || undefined,
        startTs: start !== undefined ? Number(start) : undefined,
        endTs: end !== undefined ? Number(end) : undefined,
        limit: limit !== undefined ? Number(limit) : undefined,
        offset: offset !== undefined ? Number(offset) : undefined,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/:id", auth.requirePermission("audit_read"), async (req, res) => {
    try {
      const entry = await auditStore.getById(Number(req.params.id));
      if (!entry) return res.status(404).json({ error: "Entrée d'audit introuvable." });
      res.json(entry);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Catalogue des actions/statuts connus : construit le filtre côté frontend
  // sans dupliquer la liste, même schéma que GET /api/events/catalog.
  router.get("/catalog", auth.requirePermission("audit_read"), (req, res) => {
    res.json({ actions: ACTIONS, statuses: STATUSES });
  });

  return router;
}

module.exports = createAuditRouter;
