"use strict";

/**
 * Point d'entrée du service d'organisation des process (Phase 13 — Tags,
 * Environments & Process Groups). Même découpage minimal que
 * lib/services/servers/index.js : ce module ne fait que ré-exporter le
 * store, consommé par lib/routes/process-organization.js et par
 * lib/services/notifications/routing/engine.js (résolution tag/environment/
 * group pour le routing des notifications).
 */

const store = require("./store");

module.exports = { store };
