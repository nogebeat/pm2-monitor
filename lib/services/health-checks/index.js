"use strict";

const { HealthCheckEngine } = require("./engine");
const store = require("./store");
const runner = require("./runner");

// Instance partagée : même raisonnement que lib/services/alerts/index.js —
// le scheduler (server.js) et le routeur REST (lib/routes/health-checks.js)
// doivent utiliser le même moteur.
const engine = new HealthCheckEngine({ store });

module.exports = { engine, HealthCheckEngine, store, runner };
