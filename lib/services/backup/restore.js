"use strict";

const db = require("../../db");
const { SECTIONS, getSection } = require("./sections");
const { validateEnvelope } = require("./format");

/**
 * Exécute toutes les sections présentes dans `backup.data`, dans l'ordre du
 * registre (sections.js — dépendances respectées : users avant permissions,
 * healthChecks avant serviceDependencies, etc.), et agrège un résumé par
 * section. Utilisé à la fois par `validateBackup` (dryRun=true, aucune
 * écriture) et par `restoreBackup` (dryRun=false, dans une transaction).
 */
async function runSections(backup, { dryRun, onConflict }) {
  const ctx = { dryRun: !!dryRun, onConflict: onConflict === "overwrite" ? "overwrite" : "skip" };
  const summary = [];
  for (const section of SECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(backup.data, section.id)) continue;
    const result = await section.restore(backup.data[section.id], ctx);
    summary.push({ section: section.id, label: section.label, ...result });
  }
  return { summary, generatedPasswords: ctx.generatedPasswords || [] };
}

/**
 * Valide la structure du backup + calcule un résumé "à blanc" (dry-run,
 * AUCUNE écriture) : compte par section ce qui serait créé/mis à jour, et
 * remonte les conflits détectés (clé naturelle déjà existante localement).
 * Utilisé par l'UI/CLI pour afficher un résumé et demander confirmation
 * avant un restore réel (voir routes/backup.js#POST /validate).
 *
 * @throws {Error} si le format/la version du backup est invalide.
 */
async function validateBackup(backup, { onConflict } = {}) {
  validateEnvelope(backup);
  const unknownSections = Object.keys(backup.data).filter((id) => !getSection(id));
  const { summary } = await runSections(backup, { dryRun: true, onConflict });
  return {
    valid: true,
    formatVersion: backup.formatVersion,
    metadata: backup.metadata,
    unknownSections, // sections présentes dans le fichier mais inconnues de cette version (ignorées, jamais fatal)
    summary,
    hasConflicts: summary.some((s) => s.conflicts.length > 0),
  };
}

/**
 * Restaure un backup, dans une transaction unique (voir lib/db/*-driver.js
 * beginTransaction/commit/rollback — déjà utilisées par lib/db/migrator.js,
 * mêmes garanties ici). Toute erreur survenant en cours de restauration
 * annule l'INTÉGRALITÉ des écritures déjà faites (aucune section
 * partiellement appliquée) — voir test/unit/backup-restore.test.js pour la
 * vérification de ce comportement.
 *
 * @param {object} backup - enveloppe de backup (voir format.js).
 * @param {object} [options]
 * @param {"skip"|"overwrite"} [options.onConflict] - stratégie face à un enregistrement déjà
 *   existant localement (clé naturelle) — "skip" (défaut) ne modifie jamais l'existant.
 * @param {boolean} [options.confirm] - doit être explicitement `true` : une restauration ne
 *   s'exécute jamais "par accident" (voir routes/backup.js).
 */
async function restoreBackup(backup, options = {}) {
  validateEnvelope(backup);
  if (options.confirm !== true) {
    throw new Error("Confirmation requise (confirm=true) pour exécuter une restauration.");
  }

  await db.beginTransaction();
  try {
    const { summary, generatedPasswords } = await runSections(backup, {
      dryRun: false,
      onConflict: options.onConflict,
    });
    await db.commit();
    return { summary, generatedPasswords };
  } catch (e) {
    await db.rollback();
    throw e;
  }
}

module.exports = { validateBackup, restoreBackup };
