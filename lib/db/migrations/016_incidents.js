"use strict";

/**
 * 016_incidents
 *
 * Phase 14 — Incident Management & Alert Silencing : construit un système
 * d'incidents AU-DESSUS de l'Alert Engine existant (lib/services/alerts/),
 * sans le remplacer ni le modifier. Une ou plusieurs occurrences d'alerte
 * (`alerts`, migration 003) liées par une corrélation déterministe
 * (lib/services/incidents/correlation.js) forment un incident.
 *
 * Quatre tables :
 *
 *  - `incidents` : l'incident lui-même (statut, cible corrélée, sévérité
 *    agrégée, horodatages de cycle de vie).
 *  - `incident_alerts` : association N-N incident <-> alerte (une alerte
 *    n'appartient qu'à un seul incident à la fois — UNIQUE(alert_id) — mais
 *    un incident peut regrouper plusieurs alertes liées).
 *  - `incident_timeline` : entrées PROPRES à l'incident (changement d'état,
 *    acquittement, silence créé...). Les événements déjà stockés ailleurs
 *    (alerte déclenchée/résolue, événement PM2, notification envoyée,
 *    tentative d'auto-healing) ne sont JAMAIS dupliqués ici : ils sont
 *    résolus à la lecture par jointure/filtre sur les tables existantes
 *    (`alerts`, `process_events`, `notification_history`,
 *    `auto_healing_audit`) — voir lib/services/incidents/timeline-store.js.
 *  - `alert_silences` : règles de silence (temporaire, jusqu'à une date,
 *    par règle/process/tag/environnement/groupe). Un silence ne supprime
 *    JAMAIS une alerte ni un événement — il n'affecte que le routing des
 *    notifications (lib/services/notifications/routing/engine.js).
 */

async function up(db) {
  const isMysql = db.driver === "mysql";

  if (isMysql) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS incidents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
        severity VARCHAR(32) NOT NULL,
        target_type VARCHAR(32) NOT NULL,
        target_value VARCHAR(191),
        metric VARCHAR(191) NOT NULL,
        correlation_key VARCHAR(255) NOT NULL,
        first_alert_id INT,
        opened_at BIGINT NOT NULL,
        acknowledged_at BIGINT,
        acknowledged_by INT,
        investigating_at BIGINT,
        mitigated_at BIGINT,
        resolved_at BIGINT,
        resolved_by INT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS incident_alerts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        incident_id INT NOT NULL,
        alert_id INT NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE KEY uniq_incident_alert (alert_id),
        CONSTRAINT fk_incident_alerts_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS incident_timeline (
        id INT AUTO_INCREMENT PRIMARY KEY,
        incident_id INT NOT NULL,
        ts BIGINT NOT NULL,
        type VARCHAR(64) NOT NULL,
        ref_table VARCHAR(64),
        ref_id INT,
        actor_user_id INT,
        summary VARCHAR(500),
        metadata TEXT,
        created_at BIGINT NOT NULL,
        CONSTRAINT fk_incident_timeline_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS alert_silences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        scope_type VARCHAR(32) NOT NULL,
        scope_value VARCHAR(191) NOT NULL,
        silence_type VARCHAR(32) NOT NULL DEFAULT 'duration',
        expires_at BIGINT NOT NULL,
        reason VARCHAR(500),
        created_by INT,
        cancelled_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    for (const [name, def] of Object.entries({
      idx_incidents_status: "incidents(status)",
      idx_incidents_correlation: "incidents(correlation_key, status)",
      idx_incident_alerts_incident: "incident_alerts(incident_id)",
      idx_incident_timeline_incident: "incident_timeline(incident_id, ts)",
      idx_alert_silences_scope: "alert_silences(scope_type, scope_value)",
      idx_alert_silences_expires: "alert_silences(expires_at)",
    })) {
      try {
        await db.run(`CREATE INDEX ${name} ON ${def}`);
      } catch (e) {
        if (!/ER_DUP_KEYNAME|Duplicate key name/i.test(e.message || "")) throw e;
      }
    }
    return;
  }

  await db.run(`
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      severity TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_value TEXT,
      metric TEXT NOT NULL,
      correlation_key TEXT NOT NULL,
      first_alert_id INTEGER,
      opened_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      acknowledged_by INTEGER,
      investigating_at INTEGER,
      mitigated_at INTEGER,
      resolved_at INTEGER,
      resolved_by INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS incident_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      alert_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(alert_id)
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS incident_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      ref_table TEXT,
      ref_id INTEGER,
      actor_user_id INTEGER,
      summary TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS alert_silences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type TEXT NOT NULL,
      scope_value TEXT NOT NULL,
      silence_type TEXT NOT NULL DEFAULT 'duration',
      expires_at INTEGER NOT NULL,
      reason TEXT,
      created_by INTEGER,
      cancelled_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await db.run("CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status)");
  await db.run("CREATE INDEX IF NOT EXISTS idx_incidents_correlation ON incidents(correlation_key, status)");
  await db.run("CREATE INDEX IF NOT EXISTS idx_incident_alerts_incident ON incident_alerts(incident_id)");
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_incident_timeline_incident ON incident_timeline(incident_id, ts)",
  );
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_alert_silences_scope ON alert_silences(scope_type, scope_value)",
  );
  await db.run("CREATE INDEX IF NOT EXISTS idx_alert_silences_expires ON alert_silences(expires_at)");
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS alert_silences");
  await db.run("DROP TABLE IF EXISTS incident_timeline");
  await db.run("DROP TABLE IF EXISTS incident_alerts");
  await db.run("DROP TABLE IF EXISTS incidents");
}

module.exports = {
  version: "016_incidents",
  description:
    "Incident Management & Alert Silencing (Phase 14) — incidents corrélés depuis l'Alert Engine, timeline, silences.",
  up,
  down,
};
