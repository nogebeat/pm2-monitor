"use strict";

/**
 * Point d'entrée du service de détection d'anomalies (Phase 16). Même
 * convention que lib/services/alerts/index.js : un singleton partagé entre
 * le scheduler d'évaluation (lib/polling.js) et le routeur REST
 * (lib/routes/anomaly-detection.js).
 *
 * `service` est construit sans stores système/process/events injectés par
 * défaut (`historyStore`/`processHistoryStore`/`eventStore` restent `null`) :
 * server.js les branche explicitement après coup (`service.historyStore = ...`),
 * comme il le fait déjà pour `healthCheckEngine.onAlertResult` — ce module ne
 * dépend ni de PM2 ni d'Express, donc pas de ces instances au require().
 */

const { AnomalyDetectionService } = require("./service");
const ruleStore = require("./rules-store");
const detectionStore = require("./detections-store");
const detector = require("./detector");
const math = require("./math");
const config = require("./config");

const service = new AnomalyDetectionService({ ruleStore, detectionStore });

module.exports = { service, AnomalyDetectionService, ruleStore, detectionStore, detector, math, config };
