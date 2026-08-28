"use strict";

/**
 * lib/services/api-keys/index.js — Phase 18. Point d'entrée du service,
 * même convention que lib/services/servers/index.js : ré-exporte le store
 * (pas de logique métier supplémentaire nécessaire dans cette phase — la
 * vérification de scope elle-même vit dans lib/permissions.js, réutilisée à
 * la fois pour les utilisateurs et les clés API).
 */

const store = require("./store");

module.exports = { store };
