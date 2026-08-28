"use strict";

const { createBackup } = require("./export");
const { validateBackup, restoreBackup } = require("./restore");
const { SECTIONS, getSection } = require("./sections");
const format = require("./format");
const crypto = require("./crypto");

/** Catalogue des sections (id, label, inclusion par défaut, si secrets concernés) — pour l'UI/CLI. */
function listSectionsCatalog() {
  return SECTIONS.map((s) => ({
    id: s.id,
    label: s.label,
    defaultIncluded: s.defaultIncluded,
    containsSecrets: !!s.containsSecrets,
  }));
}

module.exports = {
  createBackup,
  validateBackup,
  restoreBackup,
  listSectionsCatalog,
  getSection,
  FORMAT_VERSION: format.FORMAT_VERSION,
  secretsConfigured: crypto.isConfigured,
};
