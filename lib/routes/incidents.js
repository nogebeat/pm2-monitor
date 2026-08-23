"use strict";

/**
 * Routes REST d'Incident Management & Alert Silencing (Phase 14). Même
 * découpage que lib/routes/alerts.js : la logique métier vit dans
 * lib/services/incidents/ (stores + corrélateur), ce module ne fait que
 * valider la requête HTTP, appeler le service, formater la réponse, et
 * auditer les actions sensibles (transitions d'incident, création/
 * annulation de silence — voir docs/audit/README.md, section 1).
 *
 * Monté dans server.js via `app.use("/api/incidents", require("./lib/routes/incidents")())`.
 */

const express = require("express");
const auth = require("../auth");
const { incidentStore, timelineStore, silenceStore } = require("../services/incidents");
const { recordEvent, ACTIONS } = require("../services/audit");

const MINUTE = 60 * 1000;

function notFound(res, message) {
  return res.status(404).json({ error: message });
}

function createIncidentsRouter() {
  const router = express.Router();

  // --- Incidents -----------------------------------------------------------

  router.get("/", auth.requirePermission("incidents_read"), async (req, res) => {
    try {
      const { status, severity, targetType, targetValue, limit, offset } = req.query;
      res.json(
        await incidentStore.list({
          status: status || undefined,
          severity: severity || undefined,
          targetType: targetType || undefined,
          targetValue: targetValue || undefined,
          limit: limit ? Number(limit) : undefined,
          offset: offset ? Number(offset) : undefined,
        }),
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Catalogue (états valides, types de cible/scope) : construction des
  // filtres et formulaires côté frontend, même schéma que GET /api/alerts/catalog.
  router.get("/catalog", auth.requirePermission("incidents_read"), (req, res) => {
    res.json({
      states: incidentStore.STATES,
      allowedTransitions: incidentStore.ALLOWED_TRANSITIONS,
      silenceScopeTypes: silenceStore.SCOPE_TYPES,
      silenceTypes: silenceStore.SILENCE_TYPES,
    });
  });

  // --- Silences --------------------------------------------------------------
  // Déclarées AVANT "/:id" (comme /catalog ci-dessus) : "/silences" est un
  // chemin littéral à un seul segment, il serait sinon capturé par le
  // paramètre ":id". Montées sous /incidents/silences : les silences sont
  // gérées depuis l'UI Incidents (bouton "silence" sur un incident/une
  // alerte), pas une fonctionnalité indépendante — voir prompt de phase,
  // section UI.

  router.get("/silences", auth.requirePermission("incidents_read"), async (req, res) => {
    try {
      const activeOnly = req.query.active === "1";
      res.json(await silenceStore.list({ activeOnly }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Résout `expiresAt` à partir de `silenceType` :
   *  - "duration" : `durationMinutes` (ex: 30) -> now + 30 * 60_000
   *  - "until"    : `until` (epoch ms ou chaîne ISO) tel quel
   * Validé une seconde fois par silence-store.js#create (défense en
   * profondeur, comme le reste des routes de ce fichier).
   */
  function resolveExpiresAt(body) {
    if (body.silenceType === "until") {
      const ts = typeof body.until === "number" ? body.until : Date.parse(body.until);
      if (!Number.isFinite(ts)) throw new Error("`until` invalide : date attendue.");
      return ts;
    }
    const minutes = Number(body.durationMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error("`durationMinutes` requis et positif pour un silence temporaire.");
    }
    return Date.now() + minutes * MINUTE;
  }

  router.post("/silences", auth.requirePermission("incidents_manage"), async (req, res) => {
    try {
      const body = req.body || {};
      const expiresAt = resolveExpiresAt(body);
      const silence = await silenceStore.create({
        scopeType: body.scopeType,
        scopeValue: body.scopeValue !== undefined && body.scopeValue !== null ? String(body.scopeValue) : "",
        silenceType: body.silenceType,
        expiresAt,
        reason: body.reason,
        createdBy: req.user ? req.user.id : null,
      });
      recordEvent({
        user: req.user,
        action: ACTIONS.INCIDENT_SILENCE_CREATE,
        target: `${silence.scopeType}:${silence.scopeValue}`,
        targetType: "alert_silence",
        status: "success",
        ip: req.ip,
        metadata: { silenceId: silence.id, scopeType: silence.scopeType, expiresAt: silence.expiresAt },
      });
      res.status(201).json(silence);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.INCIDENT_SILENCE_CREATE,
        targetType: "alert_silence",
        status: "failed",
        ip: req.ip,
        metadata: { error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/silences/:id", auth.requirePermission("incidents_manage"), async (req, res) => {
    const id = Number(req.params.id);
    try {
      const existing = await silenceStore.getById(id);
      if (!existing) return notFound(res, "Silence introuvable.");
      const cancelled = await silenceStore.cancel(id);
      recordEvent({
        user: req.user,
        action: ACTIONS.INCIDENT_SILENCE_DELETE,
        target: `${existing.scopeType}:${existing.scopeValue}`,
        targetType: "alert_silence",
        status: "success",
        ip: req.ip,
        metadata: { silenceId: id },
      });
      res.json(cancelled);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.INCIDENT_SILENCE_DELETE,
        target: String(id),
        targetType: "alert_silence",
        status: "failed",
        ip: req.ip,
        metadata: { error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  });

  // --- Incidents (détail) ----------------------------------------------------

  router.get("/:id", auth.requirePermission("incidents_read"), async (req, res) => {
    try {
      const incident = await incidentStore.getById(Number(req.params.id));
      if (!incident) return notFound(res, "Incident introuvable.");
      const alertIds = await incidentStore.listAlertIds(incident.id);
      res.json({ ...incident, alertIds });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/:id/timeline", auth.requirePermission("incidents_read"), async (req, res) => {
    try {
      const incident = await incidentStore.getById(Number(req.params.id));
      if (!incident) return notFound(res, "Incident introuvable.");
      const alertIds = await incidentStore.listAlertIds(incident.id);
      res.json(await timelineStore.list(incident, alertIds));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Une seule fonction pour les quatre transitions manuelles (acknowledge/
   * investigate/mitigate/resolve) : même état cible que
   * incident-store.js#transition, même action d'audit (ACTIONS.INCIDENT_STATE_CHANGE,
   * le détail départ/arrivée part en metadata) — voir commentaire de tête
   * de fichier de lib/services/audit/index.js#ACTIONS.
   */
  function transitionTo(nextStatus, timelineType) {
    return async (req, res) => {
      const id = Number(req.params.id);
      try {
        const before = await incidentStore.getById(id);
        if (!before) return notFound(res, "Incident introuvable.");
        const updated = await incidentStore.transition(id, nextStatus, {
          userId: req.user ? req.user.id : null,
        });
        await timelineStore.append(id, {
          type: timelineType,
          actorUserId: req.user ? req.user.id : null,
          summary: `${before.status} → ${nextStatus}${req.user ? ` (${req.user.username})` : ""}`,
        });
        recordEvent({
          user: req.user,
          action: ACTIONS.INCIDENT_STATE_CHANGE,
          target: String(id),
          targetType: "incident",
          status: "success",
          ip: req.ip,
          metadata: { from: before.status, to: nextStatus },
        });
        res.json(updated);
      } catch (e) {
        recordEvent({
          user: req.user,
          action: ACTIONS.INCIDENT_STATE_CHANGE,
          target: String(id),
          targetType: "incident",
          status: "failed",
          ip: req.ip,
          metadata: { to: nextStatus, error: e.message },
        });
        const notFoundErr = /introuvable/i.test(e.message);
        res.status(notFoundErr ? 404 : 400).json({ error: e.message });
      }
    };
  }

  router.post(
    "/:id/acknowledge",
    auth.requirePermission("incidents_manage"),
    transitionTo("ACKNOWLEDGED", "acknowledge"),
  );
  router.post(
    "/:id/investigate",
    auth.requirePermission("incidents_manage"),
    transitionTo("INVESTIGATING", "state_change"),
  );
  router.post(
    "/:id/mitigate",
    auth.requirePermission("incidents_manage"),
    transitionTo("MITIGATED", "state_change"),
  );
  router.post(
    "/:id/resolve",
    auth.requirePermission("incidents_manage"),
    transitionTo("RESOLVED", "resolution"),
  );

  return router;
}

module.exports = createIncidentsRouter;
