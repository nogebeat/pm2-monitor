"use strict";

/**
 * Format versionné du fichier de backup (Phase 19). Voir
 * docs/backup-restore/README.md pour la description complète du format.
 *
 * FORMAT_VERSION est un entier, incrémenté à chaque changement de forme
 * (pas de contenu) de l'enveloppe elle-même (ex: renommage d'une section,
 * changement de la façon dont un secret est représenté) — pas à chaque
 * nouvelle section ajoutée (ça, `sections`/`data` l'absorbe nativement, un
 * lecteur plus ancien ignore juste les clés qu'il ne connaît pas côté
 * export ; c'est à l'IMPORT qu'on doit être strict, voir validateEnvelope).
 */

const FORMAT_MARKER = "pm2-monitor-backup";
const FORMAT_VERSION = 1;

/**
 * Construit l'enveloppe complète. `data` est déjà le résultat assemblé par
 * export.js (une clé par section incluse). `meta` porte tout ce qui décrit
 * *comment* le backup a été produit, jamais consommé pour l'import lui-même
 * (l'import ne fait confiance qu'à `formatVersion` + au contenu de `data`).
 */
function buildEnvelope({ monitorVersion, driver, createdBy, sections, secretsMeta, data }) {
  return {
    format: FORMAT_MARKER,
    formatVersion: FORMAT_VERSION,
    metadata: {
      monitorVersion: monitorVersion || null,
      createdAt: Date.now(),
      createdBy: createdBy ? { id: createdBy.id, username: createdBy.username } : null,
      driver: driver || null,
      sections,
      secrets: secretsMeta,
    },
    data,
  };
}

/**
 * Validation STRUCTURELLE uniquement (forme de l'enveloppe) — ne valide pas
 * le contenu métier de chaque section (ça reste la responsabilité de chaque
 * validateur de section, voir sections.js), pour un message d'erreur précis
 * à chaque étape plutôt qu'un unique bloc de validation monolithique.
 *
 * @throws {Error} avec un message explicite si le format est invalide ou la
 *   version incompatible.
 */
function validateEnvelope(backup) {
  if (!backup || typeof backup !== "object" || Array.isArray(backup)) {
    throw new Error("Backup invalide : attendu un objet JSON.");
  }
  if (backup.format !== FORMAT_MARKER) {
    throw new Error(
      `Backup invalide : champ "format" absent ou incorrect (attendu "${FORMAT_MARKER}"). ` +
        "Ce fichier ne semble pas être un backup PM2 Monitor.",
    );
  }
  if (!Number.isInteger(backup.formatVersion)) {
    throw new Error('Backup invalide : "formatVersion" absent ou non numérique.');
  }
  if (backup.formatVersion > FORMAT_VERSION) {
    throw new Error(
      `Version de backup non supportée (formatVersion=${backup.formatVersion}) : cette instance de ` +
        `PM2 Monitor ne connaît que jusqu'à la version ${FORMAT_VERSION}. Mets à jour PM2 Monitor avant ` +
        "de restaurer ce backup.",
    );
  }
  if (backup.formatVersion < FORMAT_VERSION) {
    // Pas encore de migration de format nécessaire (une seule version existe à ce jour) —
    // ce garde-fou documente l'intention pour une future formatVersion=2 : voir
    // docs/backup-restore/README.md, section "Compatibilité des versions".
    throw new Error(
      `Version de backup obsolète (formatVersion=${backup.formatVersion}, attendu ${FORMAT_VERSION}) : ` +
        "aucune migration de format n'est disponible pour cette version dans cette release.",
    );
  }
  if (!backup.data || typeof backup.data !== "object" || Array.isArray(backup.data)) {
    throw new Error('Backup invalide : champ "data" absent ou invalide.');
  }
  if (!backup.metadata || typeof backup.metadata !== "object") {
    throw new Error('Backup invalide : champ "metadata" absent ou invalide.');
  }
}

module.exports = { FORMAT_MARKER, FORMAT_VERSION, buildEnvelope, validateEnvelope };
