"use strict";

/**
 * Routes REST de la timeline d'événements (lib/services/events/). Toute la
 * logique métier vit dans le service (règle "ne mets pas toute la logique
 * dans server.js") : ce module ne fait que valider la requête HTTP, appeler
 * le service, et formater la réponse — même découpage que
 * lib/routes/alerts.js.
 *
 * Monté dans server.js via `app.use("/api/events", require("./lib/routes/events")(eventsService))`.
 * Prend le service en paramètre (plutôt qu'un singleton importé comme
 * lib/services/alerts/index.js) car EventsService lit process.env à la
 * construction et doit donc être instancié par server.js après
 * loadDotEnv() — même contrainte que ProcessHistoryService, voir son
 * commentaire dans lib/services/process-history/index.js.
 *
 * `events_read` est une permission GLOBALE (pas par app) : comme
 * `alerts_read`, la lecture de la timeline n'est pas décomposée par app dans
 * cette phase — voir docs/events/README.md ("Permissions").
 */

const express = require("express");
const auth = require("../auth");
const { EVENT_TYPES, SEVERITY_BY_TYPE } = require("../services/events");

const SEVERITIES = [...new Set(Object.values(SEVERITY_BY_TYPE))];

function createEventsRouter(eventsService) {
  const router = express.Router();

  router.get("/", auth.requirePermission("events_read"), async (req, res) => {
    try {
      const { process: processName, type, severity, start, end, limit, offset } = req.query;

      if (type && !EVENT_TYPES.includes(type)) {
        return res.status(400).json({ error: `type invalide: "${type}". Attendu: ${EVENT_TYPES.join(", ")}.` });
      }
      if (severity && !SEVERITIES.includes(severity)) {
        return res.status(400).json({ error: `severity invalide: "${severity}". Attendu: ${SEVERITIES.join(", ")}.` });
      }

      const result = await eventsService.list({
        process: processName || undefined,
        type: type || undefined,
        severity: severity || undefined,
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

  // Catalogue (types/sévérités valides) : construit le filtre côté frontend
  // sans dupliquer la liste, même schéma que GET /api/alerts/catalog.
  router.get("/catalog", auth.requirePermission("events_read"), (req, res) => {
    res.json({ types: EVENT_TYPES, severities: SEVERITIES, severityByType: SEVERITY_BY_TYPE });
  });

  return router;
}

module.exports = createEventsRouter;
