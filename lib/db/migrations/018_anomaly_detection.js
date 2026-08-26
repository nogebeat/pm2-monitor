"use strict";

/**
 * 018_anomaly_detection
 *
 * Phase 16 — Anomaly Detection. Deux tables, même séparation config/
 * occurrences que 003_alert_engine.js (alert_rules / alerts) :
 *
 *  - `anomaly_rules` : la configuration (une ligne = une métrique surveillée
 *    sur une cible, avec sa sensibilité/fenêtre/cooldown). Même forme que
 *    `alert_rules`, en plus restreint (pas d'operator/threshold : la
 *    "condition" est toujours "écart statistique significatif par rapport à
 *    la baseline", pas une comparaison définie par l'utilisateur).
 *
 *  - `anomaly_detections` : une ligne par détection effective (z-score >=
 *    sensibilité), avec tout le détail statistique nécessaire pour expliquer
 *    la détection à l'utilisateur (valeur observée, baseline, écart-type,
 *    z-score, confiance, nombre d'échantillons). N'est PAS l'équivalent de
 *    `alerts` : les occurrences d'alerte elles-mêmes restent gérées par
 *    lib/services/alerts/ (voir lib/services/anomaly-detection/service.js —
 *    une détection alimente le moteur d'alertes existant via une "règle
 *    virtuelle", jamais un second moteur). `alert_id` référence donc
 *    `alerts(id)` : c'est le pont entre les deux, permettant d'afficher
 *    "pourquoi" une alerte anomalie a été déclenchée. Nullable + ON DELETE
 *    SET NULL : une détection reste consultable même si l'alerte liée est
 *    ensuite purgée (ne devrait normalement jamais arriver, `alerts` n'étant
 *    jamais purgée automatiquement, mais on reste défensif).
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS anomaly_rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL,
        description TEXT,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        target_type VARCHAR(32) NOT NULL,
        target_value VARCHAR(191),
        metric VARCHAR(64) NOT NULL,
        sensitivity DOUBLE NOT NULL DEFAULT 3,
        window_ms BIGINT NOT NULL,
        min_samples INT NOT NULL DEFAULT 10,
        cooldown_seconds INT NOT NULL DEFAULT 900,
        severity VARCHAR(32) NOT NULL DEFAULT 'warning',
        created_by INT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS anomaly_detections (
        id INT AUTO_INCREMENT PRIMARY KEY,
        rule_id INT,
        alert_id INT,
        target_type VARCHAR(32) NOT NULL,
        target_value VARCHAR(191),
        metric VARCHAR(64) NOT NULL,
        value DOUBLE,
        baseline DOUBLE,
        stddev DOUBLE,
        zscore DOUBLE,
        confidence_pct DOUBLE,
        direction VARCHAR(8),
        sample_count INT NOT NULL DEFAULT 0,
        method VARCHAR(32) NOT NULL DEFAULT 'zscore',
        explanation TEXT,
        created_at BIGINT NOT NULL,
        CONSTRAINT fk_anomaly_detection_rule FOREIGN KEY (rule_id) REFERENCES anomaly_rules(id) ON DELETE SET NULL,
        CONSTRAINT fk_anomaly_detection_alert FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const indexes = [
      ["idx_anomaly_rules_enabled", "anomaly_rules(enabled)"],
      ["idx_anomaly_rules_target_type", "anomaly_rules(target_type)"],
      ["idx_anomaly_detections_rule_id", "anomaly_detections(rule_id)"],
      ["idx_anomaly_detections_alert_id", "anomaly_detections(alert_id)"],
      ["idx_anomaly_detections_created_at", "anomaly_detections(created_at)"],
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
      CREATE TABLE IF NOT EXISTS anomaly_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        target_type TEXT NOT NULL,
        target_value TEXT,
        metric TEXT NOT NULL,
        sensitivity REAL NOT NULL DEFAULT 3,
        window_ms INTEGER NOT NULL,
        min_samples INTEGER NOT NULL DEFAULT 10,
        cooldown_seconds INTEGER NOT NULL DEFAULT 900,
        severity TEXT NOT NULL DEFAULT 'warning',
        created_by INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS anomaly_detections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER REFERENCES anomaly_rules(id) ON DELETE SET NULL,
        alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
        target_type TEXT NOT NULL,
        target_value TEXT,
        metric TEXT NOT NULL,
        value REAL,
        baseline REAL,
        stddev REAL,
        zscore REAL,
        confidence_pct REAL,
        direction TEXT,
        sample_count INTEGER NOT NULL DEFAULT 0,
        method TEXT NOT NULL DEFAULT 'zscore',
        explanation TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    await db.run("CREATE INDEX IF NOT EXISTS idx_anomaly_rules_enabled ON anomaly_rules(enabled)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_anomaly_rules_target_type ON anomaly_rules(target_type)");
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_anomaly_detections_rule_id ON anomaly_detections(rule_id)",
    );
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_anomaly_detections_alert_id ON anomaly_detections(alert_id)",
    );
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_anomaly_detections_created_at ON anomaly_detections(created_at)",
    );
  }
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS anomaly_detections");
  await db.run("DROP TABLE IF EXISTS anomaly_rules");
}

module.exports = {
  version: "018_anomaly_detection",
  description: "Tables anomaly_rules et anomaly_detections (détection d'anomalies statistiques, Phase 16).",
  up,
  down,
};
