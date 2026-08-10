"use strict";

/**
 * 003_alert_engine
 *
 * Deux tables pour le moteur d'alertes (lib/services/alerts/) :
 *
 *  - `alert_rules` : la configuration (une règle = une condition à
 *    surveiller sur une app ou une métrique système).
 *  - `alerts` : les occurrences (une ligne = une alerte en cours ou passée
 *    pour une règle+cible donnée). Contrairement à `alert_rules`, ces lignes
 *    ne sont jamais purgées automatiquement : elles constituent l'historique
 *    consultable via GET /api/alerts/history. Les colonnes rule_name/
 *    operator/threshold/severity sont dupliquées depuis la règle au moment
 *    du déclenchement (snapshot) pour que l'historique reste lisible même si
 *    la règle est ensuite modifiée ou supprimée (rule_id passe alors à NULL
 *    via ON DELETE SET NULL, sans perdre la ligne d'historique).
 *
 * Aucune table de notification ici : cette phase ne branche aucun provider
 * (email/webhook/Slack…), voir docs/alerts/README.md.
 *
 * `created_by` (alert_rules) et `acknowledged_by` (alerts) ne portent
 * volontairement PAS de contrainte FK vers `users(id)` : en mode
 * PM2_MONITOR_DISABLE_AUTH=1 (auth désactivée), req.user.id vaut 0, un id
 * qui n'existe jamais réellement dans `users` — une FK y ferait échouer
 * chaque création de règle / acquittement dans ce mode pourtant supporté
 * par le reste du projet. Ces colonnes restent donc de simples entiers
 * informatifs (affichage "créé par" / "acquitté par" si l'utilisateur
 * existe encore), jamais requis pour le fonctionnement du moteur.
 */

async function up(db) {
  if (db.driver === "mysql") {
    await db.run(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL,
        description TEXT,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        target_type VARCHAR(32) NOT NULL,
        target_value VARCHAR(191),
        metric VARCHAR(64) NOT NULL,
        operator VARCHAR(8) NOT NULL,
        threshold VARCHAR(191) NOT NULL,
        duration_seconds INT NOT NULL DEFAULT 0,
        severity VARCHAR(32) NOT NULL DEFAULT 'warning',
        cooldown_seconds INT NOT NULL DEFAULT 0,
        created_by INT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        rule_id INT,
        rule_name VARCHAR(191) NOT NULL,
        dedup_key VARCHAR(255) NOT NULL,
        target_type VARCHAR(32) NOT NULL,
        target_value VARCHAR(191),
        metric VARCHAR(64) NOT NULL,
        operator VARCHAR(8) NOT NULL,
        threshold VARCHAR(191) NOT NULL,
        severity VARCHAR(32) NOT NULL,
        state VARCHAR(16) NOT NULL,
        value VARCHAR(191),
        condition_met_at BIGINT NOT NULL,
        triggered_at BIGINT,
        resolved_at BIGINT,
        acknowledged_at BIGINT,
        acknowledged_by INT,
        cooldown_until BIGINT,
        last_seen_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        CONSTRAINT fk_alert_rule FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Index séparés (pas de CREATE INDEX IF NOT EXISTS portable sous MySQL < 8.0.29,
    // voir 002_job_queue.js pour la même remarque) : on avale l'erreur "doublon"
    // si la migration est rejouée après un échec partiel.
    const indexes = [
      ["idx_alert_rules_enabled", "alert_rules(enabled)"],
      ["idx_alerts_dedup_state", "alerts(dedup_key, state)"],
      ["idx_alerts_rule_id", "alerts(rule_id)"],
      ["idx_alerts_state", "alerts(state)"],
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
      CREATE TABLE IF NOT EXISTS alert_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        target_type TEXT NOT NULL,
        target_value TEXT,
        metric TEXT NOT NULL,
        operator TEXT NOT NULL,
        threshold TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        severity TEXT NOT NULL DEFAULT 'warning',
        cooldown_seconds INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
        rule_name TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_value TEXT,
        metric TEXT NOT NULL,
        operator TEXT NOT NULL,
        threshold TEXT NOT NULL,
        severity TEXT NOT NULL,
        state TEXT NOT NULL,
        value TEXT,
        condition_met_at INTEGER NOT NULL,
        triggered_at INTEGER,
        resolved_at INTEGER,
        acknowledged_at INTEGER,
        acknowledged_by INTEGER,
        cooldown_until INTEGER,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await db.run("CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_alerts_dedup_state ON alerts(dedup_key, state)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_alerts_rule_id ON alerts(rule_id)");
    await db.run("CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts(state)");
  }
}

async function down(db) {
  // alerts avant alert_rules (FK) — inutile sous SQLite (pas de contrainte
  // bloquante par défaut ici) mais nécessaire sous MySQL/InnoDB.
  await db.run("DROP TABLE IF EXISTS alerts");
  await db.run("DROP TABLE IF EXISTS alert_rules");
}

module.exports = {
  version: "003_alert_engine",
  description: "Tables alert_rules et alerts (moteur d'alertes, sans providers de notification).",
  up,
  down,
};
