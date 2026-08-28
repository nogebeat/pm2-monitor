"use strict";

/**
 * lib/routes/backup.js — Phase 19 (Backup & Restore).
 *
 * Toute la logique (format, export, validation, restauration transactionnelle)
 * vit dans lib/services/backup/ ; ce routeur ne fait que valider la requête
 * HTTP, appeler le service, et auditer (voir docs/audit/README.md, section 1 :
 * export ET restauration sont des actions sensibles, toujours auditées).
 *
 * Monté dans server.js via `app.use("/api/backup", require("./lib/routes/backup")())`.
 *
 * Permissions (lib/permissions.js) :
 *  - GET /sections, POST /export      -> backup_export
 *  - POST /validate                   -> backup_restore (lecture seule, aucune écriture)
 *  - POST /restore                    -> backup_restore + req.user.isAdmin (une restauration peut
 *    recréer des comptes/permissions, voir lib/services/backup/sections.js#usersSection —
 *    même garde-fou que manage_users côté lib/routes/users.js).
 */

const express = require("express");
const auth = require("../auth");
const backupService = require("../services/backup");
const { recordEvent, ACTIONS, STATUS } = require("../services/audit");

function createBackupRouter() {
  const router = express.Router();

  router.get("/sections", auth.requirePermission("backup_export"), (req, res) => {
    res.json({
      sections: backupService.listSectionsCatalog(),
      formatVersion: backupService.FORMAT_VERSION,
      secretsAvailable: backupService.secretsConfigured(),
    });
  });

  router.post("/export", auth.requirePermission("backup_export"), async (req, res) => {
    try {
      const { sections, includeSecrets } = req.body || {};
      const backup = await backupService.createBackup({
        sections: Array.isArray(sections) ? sections : undefined,
        includeSecrets: !!includeSecrets,
        user: req.user ? { id: req.user.id, username: req.user.username } : null,
      });
      recordEvent({
        user: req.user,
        action: ACTIONS.BACKUP_EXPORT,
        targetType: "backup",
        status: STATUS.SUCCESS,
        ip: req.ip,
        metadata: { sections: backup.metadata.sections, secretsIncluded: backup.metadata.secrets.included },
      });
      res.json(backup);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.BACKUP_EXPORT,
        targetType: "backup",
        status: STATUS.FAILED,
        ip: req.ip,
        metadata: { error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  });

  // Validation à blanc : lecture seule (dryRun), n'exige PAS isAdmin — voir en-tête de fichier.
  router.post("/validate", auth.requirePermission("backup_restore"), async (req, res) => {
    try {
      const { backup, onConflict } = req.body || {};
      const result = await backupService.validateBackup(backup, { onConflict });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post(
    "/restore",
    auth.requirePermission("backup_restore", null, {
      action: ACTIONS.BACKUP_RESTORE,
      targetType: "backup",
    }),
    auth.requireAdmin,
    async (req, res) => {
      try {
        const { backup, onConflict, confirm } = req.body || {};
        const result = await backupService.restoreBackup(backup, { onConflict, confirm: !!confirm });
        // Les mots de passe temporaires générés (lib/services/backup/sections.js#usersSection)
        // ne sont JAMAIS écrits dans l'audit log, même sanitizés : ils ne
        // transitent que dans la réponse HTTP, une seule fois, comme la
        // révélation d'un secret de clé API à sa création.
        recordEvent({
          user: req.user,
          action: ACTIONS.BACKUP_RESTORE,
          targetType: "backup",
          status: STATUS.SUCCESS,
          ip: req.ip,
          metadata: {
            onConflict: onConflict === "overwrite" ? "overwrite" : "skip",
            sections: result.summary.map((s) => ({
              section: s.section,
              created: s.created,
              updated: s.updated,
              skipped: s.skipped,
            })),
            usersCreated: result.generatedPasswords.length,
          },
        });
        res.json(result);
      } catch (e) {
        recordEvent({
          user: req.user,
          action: ACTIONS.BACKUP_RESTORE,
          targetType: "backup",
          status: STATUS.FAILED,
          ip: req.ip,
          metadata: { error: e.message },
        });
        res.status(400).json({ error: e.message });
      }
    },
  );

  return router;
}

module.exports = createBackupRouter;
