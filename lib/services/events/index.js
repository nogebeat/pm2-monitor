"use strict";

/**
 * Service de timeline d'événements PM2 — point d'entrée.
 *
 * `recordFromPacket()` est appelé depuis server.js, dans le handler
 * `bus.on("process:event", …)` déjà existant (startPm2Bus()) : aucun second
 * listener PM2 créé pour cette fonctionnalité, réutilisation explicite de la
 * source déjà branchée (même règle que lib/services/process-history/,
 * qui réutilise le pm2.list() déjà pollé par le moteur d'alertes).
 *
 * `list()` est consommé par la route GET /api/events (lib/routes/events.js).
 *
 * La purge (rétention EVENTS_RETENTION_MS) tourne sur son propre intervalle
 * via start()/stop(), même découpage que ProcessHistoryService.
 *
 * Comme ProcessHistoryService (voir son commentaire de fin de fichier), ce
 * service lit process.env dans son constructeur : il doit donc être
 * instancié par server.js APRÈS loadDotEnv(), pas au moment du require().
 */

const { resolveConfig } = require("./config");
const { normalizeEvent, EVENT_TYPES, SEVERITY_BY_TYPE } = require("./normalizer");
const eventStore = require("./event-store");

class EventsService {
  constructor(env = process.env) {
    this.config = resolveConfig(env);
    this._maintenanceTimer = null;
    this._maintenanceRunning = false;
  }

  // --- Collecte --------------------------------------------------------

  /**
   * @param {object} packet - packet brut du bus PM2 process:event
   * @param {number} [now]
   * @returns {Promise<object|null>} l'événement stocké, ou null si ignoré (désactivé, ou
   *   packet ne correspondant à aucun type retenu — voir normalizer.js)
   */
  async recordFromPacket(packet, now = Date.now()) {
    if (!this.config.enabled) return null;
    const normalized = normalizeEvent(packet, now);
    if (!normalized) return null;
    return eventStore.create(normalized);
  }

  // --- Lecture (API) -----------------------------------------------------

  list(filters) {
    return eventStore.list(filters);
  }

  // --- Maintenance (purge par rétention) ----------------------------------

  start() {
    if (this._maintenanceTimer || !this.config.enabled) return;
    this._maintenanceTimer = setInterval(() => this._tick(), this.config.maintenanceIntervalMs);
    if (this._maintenanceTimer.unref) this._maintenanceTimer.unref();
  }

  stop() {
    if (this._maintenanceTimer) clearInterval(this._maintenanceTimer);
    this._maintenanceTimer = null;
  }

  async _tick() {
    if (this._maintenanceRunning) return; // évite le chevauchement si un cycle prend plus longtemps que l'intervalle
    this._maintenanceRunning = true;
    try {
      await this.purgeOnce();
    } catch (e) {
      console.error("Erreur de purge de la timeline d'événements :", e.message);
    } finally {
      this._maintenanceRunning = false;
    }
  }

  /** Exposé pour les tests (et un éventuel appel manuel) : un cycle de purge synchrone. */
  purgeOnce(now = Date.now()) {
    return eventStore.purgeOlderThan(now - this.config.retentionMs);
  }
}

// Pas de singleton auto-instancié ici (même raison que ProcessHistoryService) :
// server.js instancie `new EventsService()` une fois le .env chargé.
module.exports = { EventsService, EVENT_TYPES, SEVERITY_BY_TYPE };
