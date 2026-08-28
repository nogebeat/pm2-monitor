"use strict";

const db = require("../../db");
const { SECTIONS } = require("./sections");
const { buildEnvelope } = require("./format");
const backupCrypto = require("./crypto");

let pkgVersion = null;
function monitorVersion() {
  if (pkgVersion === null) {
    try {
      pkgVersion = require("../../../package.json").version || null;
    } catch (e) {
      pkgVersion = null;
    }
  }
  return pkgVersion;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.sections] - ids de sections à inclure (défaut : sections.defaultIncluded).
 * @param {boolean} [options.includeSecrets] - inclure les secrets de providers de notification,
 *   chiffrés avec BACKUP_ENCRYPTION_KEY (voir crypto.js). Lève une erreur explicite si la clé
 *   n'est pas configurée.
 * @param {{id:number, username:string}|null} [options.user] - utilisateur à l'origine de l'export (audit).
 * @returns {Promise<object>} l'enveloppe de backup complète (voir format.js).
 */
async function createBackup(options = {}) {
  const requestedIds =
    Array.isArray(options.sections) && options.sections.length ? new Set(options.sections) : null;
  const includeSecrets = !!options.includeSecrets;

  if (includeSecrets && !backupCrypto.isConfigured()) {
    throw new Error(
      "includeSecrets demandé mais BACKUP_ENCRYPTION_KEY n'est pas configurée : voir docs/backup-restore/README.md.",
    );
  }

  const includedSections = SECTIONS.filter((s) =>
    requestedIds ? requestedIds.has(s.id) : s.defaultIncluded,
  );

  const data = {};
  for (const section of includedSections) {
    data[section.id] = await section.export(section.containsSecrets ? { includeSecrets } : undefined);
  }

  const secretsMeta = {
    included: includeSecrets && includedSections.some((s) => s.containsSecrets),
    encrypted: includeSecrets,
    algorithm: includeSecrets ? backupCrypto.ALGORITHM : null,
  };

  return buildEnvelope({
    monitorVersion: monitorVersion(),
    driver: db.driver,
    createdBy: options.user || null,
    sections: includedSections.map((s) => s.id),
    secretsMeta,
    data,
  });
}

module.exports = { createBackup };
