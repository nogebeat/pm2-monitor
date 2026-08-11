"use strict";

/**
 * 005_process_events
 *
 * Table pour la timeline d'événements/crashs PM2 (lib/services/events/,
 * lib/routes/events.js). Une ligne = un événement normalisé issu du bus PM2
 * déjà branché dans server.js (`bus.on("process:event", …)`, voir
 * startPm2Bus()) — aucun second listener PM2 créé pour cette table, voir
 * lib/services/events/normalizer.js pour la normalisation.
 *
 * `severity` est dérivée du `type` (voir normalizer.js#SEVERITY_BY_TYPE),
 * pas saisie par l'utilisateur : elle sert uniquement au filtrage rapide de
 * l'API/l'UI (mêmes valeurs que lib/services/alerts/ : info/warning/critical,
 * réutilisées pour rester cohérent avec le reste du projet plutôt que
 * d'inventer une nouvelle échelle).
 *
 * `metadata` est un blob JSON texte (restart_count PM2, dernier statut connu,
 * mode d'exécution, nom brut de l'événement PM2) : pas de colonnes dédiées
 * pour ces champs annexes, pour ne pas devoir migrer le schéma à chaque
 * nouveau détail qu'on voudrait tracer. Aucun contenu de log n'est dupliqué
 * ici (voir docs/events/README.md, section "Logs") : `lib/log-store.js`
 * reste l'unique source des lignes de log, la timeline ne fait que
 * référencer process + période via le timestamp de l'événement.
 *
 * Comme `process_metrics_raw` (004_process_metrics.js) et `alerts`
 * (003_alert_engine.js), `process_name` sert d'identifiant de cible (pas de
 * FK vers une table "apps" qui n'existe pas dans ce projet — le monitor ne
 * maintient aucun registre d'apps indépendant de PM2 lui-même).
 *
 * Cette table n'est jamais purgée par une autre migration : la rétention est
 * gérée en application par lib/services/events/index.js (purge périodique
 * configurable via EVENTS_RETENTION_MS), pas par une contrainte SQL — même
 * approche que lib/services/process-history/rollup.js.
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS process_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        ts BIGINT NOT NULL,
        type VARCHAR(32) NOT NULL,
        severity VARCHAR(16) NOT NULL,
        process_name VARCHAR(191),
        process_id INT,
        server VARCHAR(191),
        status VARCHAR(32),
        exit_code INT,
        signal VARCHAR(32),
        metadata TEXT,
        created_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const indexes = [
      ["idx_process_events_ts", "process_events(ts)"],
      ["idx_process_events_process", "process_events(process_name, ts)"],
      ["idx_process_events_type", "process_events(type)"],
      ["idx_process_events_severity", "process_events(severity)"],
    ];
    for (const [indexName, def] of indexes) {
      try {
        await db.run(`CREATE INDEX ${indexName} ON ${def}`);
      } catch (e) {
        if (!/ER_DUP_KEYNAME|Duplicate key name/i.test(e.message || "")) throw e;
      }
    }
  } else {
    await db.run(`
      CREATE TABLE IF NOT EXISTS process_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        process_name TEXT,
        process_id INTEGER,
        server TEXT,
        status TEXT,
        exit_code INTEGER,
        signal TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    await db.run("CREATE INDEX IF NOT EXISTS idx_process_events_ts ON process_events(ts)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_process_events_process ON process_events(process_name, ts)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_process_events_type ON process_events(type)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_process_events_severity ON process_events(severity)");
  }
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS process_events");
}

module.exports = {
  version: "005_process_events",
  description: "Table process_events (timeline d'événements/crashs PM2, lib/services/events/).",
  up,
  down,
};
