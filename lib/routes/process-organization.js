"use strict";

/**
 * Routes REST de l'organisation des process (Phase 13 — Tags, Environments &
 * Process Groups). Même découpage que lib/routes/health-checks.js : la
 * logique métier vit dans lib/services/process-organization/store.js, ce
 * module ne fait que valider la requête HTTP, appeler le store, auditer les
 * écritures (recordEvent) et formater la réponse.
 *
 * Monté dans server.js via
 * `app.use("/api/process-organization", require("./lib/routes/process-organization")())`.
 *
 * Toutes les routes exigent `process_org_read` (lecture) ou
 * `process_org_manage` (écriture) — voir lib/permissions.js. Action globale,
 * pas de scoping par app (comme servers_read/servers_manage).
 */

const express = require("express");
const auth = require("../auth");
const { store } = require("../services/process-organization");
const { recordEvent, ACTIONS } = require("../services/audit");

function audit(req, { op, targetType, target, metadata, status = "success" }) {
  recordEvent({
    user: req.user,
    action: ACTIONS.PROCESS_ORG_CHANGE,
    target,
    targetType,
    status,
    ip: req.ip,
    metadata: { op, ...(metadata || {}) },
  });
}

function createProcessOrganizationRouter() {
  const router = express.Router();

  // --- Tags ------------------------------------------------------------

  router.get("/tags", auth.requirePermission("process_org_read"), async (req, res) => {
    try {
      res.json(await store.listTags());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/tags", auth.requirePermission("process_org_manage"), async (req, res) => {
    try {
      const tag = await store.createTag(req.body || {});
      audit(req, { op: "tag_create", targetType: "tag", target: tag.name, metadata: { tagId: tag.id } });
      res.status(201).json(tag);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.put("/tags/:id", auth.requirePermission("process_org_manage"), async (req, res) => {
    try {
      const updated = await store.updateTag(Number(req.params.id), req.body || {});
      if (!updated) return res.status(404).json({ error: "Tag introuvable." });
      audit(req, {
        op: "tag_update",
        targetType: "tag",
        target: updated.name,
        metadata: { tagId: updated.id },
      });
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/tags/:id", auth.requirePermission("process_org_manage"), async (req, res) => {
    try {
      const deleted = await store.removeTag(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Tag introuvable." });
      audit(req, { op: "tag_delete", targetType: "tag", target: String(req.params.id) });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Environnements ----------------------------------------------------

  router.get("/environments", auth.requirePermission("process_org_read"), async (req, res) => {
    try {
      res.json(await store.listEnvironments());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/environments", auth.requirePermission("process_org_manage"), async (req, res) => {
    try {
      const env = await store.createEnvironment(req.body || {});
      audit(req, {
        op: "environment_create",
        targetType: "environment",
        target: env.name,
        metadata: { environmentId: env.id },
      });
      res.status(201).json(env);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.put("/environments/:id", auth.requirePermission("process_org_manage"), async (req, res) => {
    try {
      const updated = await store.updateEnvironment(Number(req.params.id), req.body || {});
      if (!updated) return res.status(404).json({ error: "Environnement introuvable." });
      audit(req, {
        op: "environment_update",
        targetType: "environment",
        target: updated.name,
        metadata: { environmentId: updated.id },
      });
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/environments/:id", auth.requirePermission("process_org_manage"), async (req, res) => {
    try {
      const deleted = await store.removeEnvironment(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Environnement introuvable." });
      audit(req, { op: "environment_delete", targetType: "environment", target: String(req.params.id) });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Groupes -------------------------------------------------------------

  router.get("/groups", auth.requirePermission("process_org_read"), async (req, res) => {
    try {
      res.json(await store.listGroups());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/groups", auth.requirePermission("process_org_manage"), async (req, res) => {
    try {
      const group = await store.createGroup(req.body || {});
      audit(req, {
        op: "group_create",
        targetType: "process_group",
        target: group.name,
        metadata: { groupId: group.id },
      });
      res.status(201).json(group);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.put("/groups/:id", auth.requirePermission("process_org_manage"), async (req, res) => {
    try {
      const updated = await store.updateGroup(Number(req.params.id), req.body || {});
      if (!updated) return res.status(404).json({ error: "Groupe introuvable." });
      audit(req, {
        op: "group_update",
        targetType: "process_group",
        target: updated.name,
        metadata: { groupId: updated.id },
      });
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/groups/:id", auth.requirePermission("process_org_manage"), async (req, res) => {
    try {
      const deleted = await store.removeGroup(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Groupe introuvable." });
      audit(req, { op: "group_delete", targetType: "process_group", target: String(req.params.id) });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Associations --------------------------------------------------------

  // Toute l'organisation connue (tags/environnements/groupes appliqués),
  // groupée par process — construit les filtres et la vue groupe côté UI en
  // un seul aller-retour (voir store.js#listAssignments).
  router.get("/assignments", auth.requirePermission("process_org_read"), async (req, res) => {
    try {
      res.json(await store.listAssignments());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Organisation d'UN process précis (utilisé par le formulaire d'assignation).
  router.get("/assignments/:processName", auth.requirePermission("process_org_read"), async (req, res) => {
    try {
      const serverKey = req.query.serverKey || store.DEFAULT_SERVER_KEY;
      res.json(await store.getOrganizationForProcess(req.params.processName, serverKey));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Applique tags + environnement + groupes pour un process en un seul appel
  // (body: { serverKey?, tagIds?: number[], environmentId?: number|null, groups?: number[] }).
  router.put("/assignments/:processName", auth.requirePermission("process_org_manage"), async (req, res) => {
    try {
      const { serverKey, tagIds, environmentId, groups } = req.body || {};
      const result = await store.assignProcess({
        processName: req.params.processName,
        serverKey: serverKey || store.DEFAULT_SERVER_KEY,
        tagIds,
        environmentId,
        groups,
      });
      audit(req, {
        op: "assign",
        targetType: "process",
        target: req.params.processName,
        metadata: { serverKey: serverKey || store.DEFAULT_SERVER_KEY, tagIds, environmentId, groups },
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete(
    "/assignments/:processName",
    auth.requirePermission("process_org_manage"),
    async (req, res) => {
      try {
        const serverKey = req.query.serverKey || store.DEFAULT_SERVER_KEY;
        await store.clearProcess(req.params.processName, serverKey);
        audit(req, {
          op: "clear",
          targetType: "process",
          target: req.params.processName,
          metadata: { serverKey },
        });
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  return router;
}

module.exports = createProcessOrganizationRouter;
