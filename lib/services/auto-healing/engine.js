"use strict";

/**
 * AutoHealingService — Phase 7. Fonctionnalité CRITIQUE/DANGEREUSE : elle
 * peut redémarrer automatiquement un process de production. La sécurité et
 * les garde-fous passent avant le happy path (voir docs/auto-healing/README.md).
 *
 * Reçoit des événements de trois sources (server.js les branche toutes sur
 * `trigger()`, seul point d'entrée qui décide/agit) :
 *   - Alert Engine  : transition d'alerte vers "active" (process ou health_check)
 *   - Health Checks : statut DOWN (arrive aussi via Alert Engine, cf. Phase 6
 *     "les health checks ne sont qu'une nouvelle source pour le moteur d'alerte")
 *   - PM2 events    : packet "exit" du bus PM2 (process:event)
 *
 * Jamais d'action directe sans passer par les garde-fous de `trigger()` :
 * aucune autre méthode publique n'exécute de restart.
 *
 * Action : uniquement `pm2Actions.restart()` (API PM2 déjà utilisée par le
 * reste de l'application, jamais de commande shell — voir section 10 du
 * prompt maître et test/unit/auto-healing-security.test.js).
 */

const defaultSettingsStore = require("./settings-store");
const defaultStateStore = require("./state-store");
const defaultAuditStore = require("./audit-store");
const pm2Actions = require("../../pm2-actions");

class AutoHealingService {
  constructor({ settingsStore, stateStore, auditStore, pm2, restart, now } = {}) {
    this.settingsStore = settingsStore || defaultSettingsStore;
    this.stateStore = stateStore || defaultStateStore;
    this.auditStore = auditStore || defaultAuditStore;
    this.pm2 = pm2 || null;
    // Point d'injection pour les tests (fake restart) ; en production, passe
    // toujours par pm2Actions.restart(this.pm2, processName) — jamais un
    // exec/spawn de commande arbitraire (voir la garde en tête de trigger()).
    this._restart = restart || ((processName) => pm2Actions.restart(this.pm2, processName));
    this.now = now || (() => Date.now());
  }

  /**
   * Point d'entrée unique. `reason` est une phrase courte et fixe (ex:
   * "process crashed", "health check DOWN", "memory > threshold") — jamais
   * une valeur libre injectée depuis une entrée utilisateur non contrôlée,
   * pour que l'audit reste lisible et non falsifiable par un tiers.
   */
  async trigger({ processName, source, reason }) {
    if (!processName || typeof processName !== "string") {
      throw new Error("processName requis.");
    }

    const settings = await this.settingsStore.get();
    if (!settings.enabled) return { skipped: "disabled" };

    const state = await this.stateStore.get(processName);
    const now = this.now();

    if (state.blocked) {
      return { skipped: "blocked" };
    }

    if (state.nextAllowedAt && now < state.nextAllowedAt) {
      return { skipped: "cooldown" };
    }

    const nextAttempt = state.attempts + 1;

    if (nextAttempt > settings.maxAttempts) {
      return this._block(processName, source, reason, settings, now);
    }

    return this._attemptRestart(processName, source, reason, settings, nextAttempt, now);
  }

  async _attemptRestart(processName, source, reason, settings, attempt, now) {
    let result = "success";
    let message = null;

    try {
      await this._restart(processName);
    } catch (e) {
      result = "failure";
      message = e && e.message ? e.message : String(e);
    }

    const backoffSeconds = settings.backoffSeconds[Math.min(attempt - 1, settings.backoffSeconds.length - 1)] || 0;

    await this.stateStore.upsert(processName, {
      attempts: attempt,
      lastAttemptAt: now,
      nextAllowedAt: now + backoffSeconds * 1000,
    });

    await this.auditStore.record({
      processName,
      source,
      reason,
      action: "restart",
      attempt,
      maxAttempts: settings.maxAttempts,
      result,
      message,
    });

    return { action: "restart", attempt, maxAttempts: settings.maxAttempts, result, message };
  }

  async _block(processName, source, reason, settings, now) {
    const blockedReason = `Nombre maximum de tentatives atteint (${settings.maxAttempts}).`;

    await this.stateStore.upsert(processName, {
      blocked: true,
      blockedAt: now,
      blockedReason,
    });

    await this.auditStore.record({
      processName,
      source,
      reason,
      action: "block",
      attempt: settings.maxAttempts,
      maxAttempts: settings.maxAttempts,
      result: "blocked",
      message: blockedReason,
    });

    return { action: "block", result: "blocked", message: blockedReason };
  }

  /**
   * Signale qu'un process est de nouveau sain (ex: health check redevenu UP,
   * alerte résolue). Remet le compteur de tentatives à zéro — mais ne
   * débloque JAMAIS un process bloqué : seul unblock() (action utilisateur
   * explicite) le peut (section 6 du prompt maître).
   */
  async recordRecovery(processName) {
    const state = await this.stateStore.get(processName);
    if (state.blocked) return state;
    if (state.attempts === 0 && !state.nextAllowedAt) return state;
    return this.stateStore.reset(processName);
  }

  /** Déblocage explicite par un utilisateur autorisé (authealing.manage, voir lib/routes/auto-healing.js). */
  async unblock(processName, user) {
    const state = await this.stateStore.get(processName);
    if (!state.blocked) return state;

    const updated = await this.stateStore.reset(processName, { unblockedBy: user && user.id !== undefined ? user.id : null });

    await this.auditStore.record({
      processName,
      source: "manual",
      reason: "manual unblock",
      action: "unblock",
      attempt: null,
      maxAttempts: null,
      result: "success",
      message: user && user.username ? `Débloqué par ${user.username}.` : "Débloqué manuellement.",
    });

    return updated;
  }
}

module.exports = { AutoHealingService };
