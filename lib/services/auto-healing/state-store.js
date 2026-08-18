"use strict";

/**
 * Persistance de l'état Auto-Healing *par process* (table `auto_healing_state`).
 * Ne contient aucune logique de décision (pas de notion de "faut-il agir ?"
 * ici) : c'est lib/services/auto-healing/engine.js qui orchestre, ce module
 * ne fait que lire/écrire une ligne par process — même séparation que
 * lib/services/alerts/alert-store.js vis-à-vis de engine.js.
 */

const db = require("../../db");

function rowToState(row, processName) {
  if (!row) {
    return {
      processName,
      attempts: 0,
      blocked: false,
      blockedAt: null,
      blockedReason: null,
      lastAttemptAt: null,
      nextAllowedAt: null,
      unblockedBy: null,
      unblockedAt: null,
    };
  }
  return {
    processName: row.process_name,
    attempts: Number(row.attempts) || 0,
    blocked: !!row.blocked,
    blockedAt: row.blocked_at === null || row.blocked_at === undefined ? null : Number(row.blocked_at),
    blockedReason: row.blocked_reason || null,
    lastAttemptAt:
      row.last_attempt_at === null || row.last_attempt_at === undefined ? null : Number(row.last_attempt_at),
    nextAllowedAt:
      row.next_allowed_at === null || row.next_allowed_at === undefined ? null : Number(row.next_allowed_at),
    unblockedBy: row.unblocked_by === undefined ? null : row.unblocked_by,
    unblockedAt:
      row.unblocked_at === null || row.unblocked_at === undefined ? null : Number(row.unblocked_at),
  };
}

async function get(processName) {
  const row = await db.get("SELECT * FROM auto_healing_state WHERE process_name = ?", [processName]);
  return rowToState(row, processName);
}

async function list() {
  const rows = await db.all("SELECT * FROM auto_healing_state ORDER BY process_name ASC", []);
  return rows.map((r) => rowToState(r, r.process_name));
}

/** Insère la ligne si absente, sinon met à jour les colonnes fournies (upsert manuel, portable sqlite/mysql). */
async function upsert(processName, fields) {
  const now = Date.now();
  const existing = await db.get("SELECT process_name FROM auto_healing_state WHERE process_name = ?", [
    processName,
  ]);

  const merged = {
    attempts: 0,
    blocked: false,
    blockedAt: null,
    blockedReason: null,
    lastAttemptAt: null,
    nextAllowedAt: null,
    unblockedBy: null,
    unblockedAt: null,
    ...(existing ? await get(processName) : {}),
    ...fields,
  };

  if (existing) {
    await db.run(
      `UPDATE auto_healing_state SET attempts = ?, blocked = ?, blocked_at = ?, blocked_reason = ?,
         last_attempt_at = ?, next_allowed_at = ?, unblocked_by = ?, unblocked_at = ?, updated_at = ?
       WHERE process_name = ?`,
      [
        merged.attempts,
        merged.blocked ? 1 : 0,
        merged.blockedAt,
        merged.blockedReason,
        merged.lastAttemptAt,
        merged.nextAllowedAt,
        merged.unblockedBy,
        merged.unblockedAt,
        now,
        processName,
      ],
    );
  } else {
    await db.run(
      `INSERT INTO auto_healing_state
        (process_name, attempts, blocked, blocked_at, blocked_reason, last_attempt_at, next_allowed_at,
         unblocked_by, unblocked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        processName,
        merged.attempts,
        merged.blocked ? 1 : 0,
        merged.blockedAt,
        merged.blockedReason,
        merged.lastAttemptAt,
        merged.nextAllowedAt,
        merged.unblockedBy,
        merged.unblockedAt,
        now,
        now,
      ],
    );
  }

  return get(processName);
}

/** Remise à zéro complète (recovery, ou déblocage manuel). */
async function reset(processName, { unblockedBy } = {}) {
  return upsert(processName, {
    attempts: 0,
    blocked: false,
    blockedAt: null,
    blockedReason: null,
    nextAllowedAt: null,
    unblockedBy: unblockedBy ?? null,
    unblockedAt: unblockedBy !== undefined ? Date.now() : null,
  });
}

module.exports = { get, list, upsert, reset };
