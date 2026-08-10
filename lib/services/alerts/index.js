"use strict";

const { AlertEngine } = require("./engine");
const ruleStore = require("./alert-rules-store");
const alertStore = require("./alert-store");

// Instance partagée : le scheduler d'évaluation (server.js) et le routeur
// REST (lib/routes/alerts.js) doivent voir les mêmes occurrences en mémoire
// (aucun état en mémoire dans l'engine lui-même en réalité, tout passe par
// la DB, mais un singleton évite d'instancier N moteurs pour rien).
const engine = new AlertEngine({ ruleStore, alertStore });

module.exports = { engine, AlertEngine, ruleStore, alertStore };
