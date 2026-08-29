"use strict";

/**
 * lib/services/reports/ — Phase 20 (Reports & Capacity Planning).
 * Point d'entrée public du domaine, même convention que
 * lib/services/health-checks/index.js, lib/services/incidents/index.js…
 */

const periods = require("./periods");
const scope = require("./scope");
const capacity = require("./capacity");
const ranking = require("./ranking");
const queries = require("./queries");
const aggregator = require("./aggregator");
const exportModule = require("./export");

module.exports = {
  ...periods,
  ...scope,
  ...capacity,
  ...ranking,
  queries,
  ...aggregator,
  ...exportModule,
};
