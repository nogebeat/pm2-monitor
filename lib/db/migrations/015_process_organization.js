"use strict";

/**
 * 015_process_organization
 *
 * Phase 13 — Tags, Environments & Process Groups : organisation logique des
 * process gérée entièrement par PM2 Monitor (jamais écrite dans la
 * configuration PM2 elle-même — voir docs/process-organization/README.md).
 *
 * Un process est identifié par (server_key, process_name), même convention
 * que process_metrics_raw/rollup depuis 014_process_metrics_server_key (et
 * health_checks.process_name, 010) : nécessaire pour ne pas fusionner deux
 * process de même nom sur deux serveurs différents (Phase 10 —
 * Multi-server). `server_key` vaut `'local'` pour l'hôte local.
 *
 * Six tables, structure relationnelle (pas de JSON dans une colonne, pour
 * rester cherchable/filtrable en SQL — voir prompt de phase, section DB) :
 *
 *  - `tags` : catalogue de tags (name unique, couleur optionnelle pour l'UI).
 *  - `environments` : catalogue d'environnements (name unique, couleur
 *    optionnelle). Contrairement à `servers.environment` (Phase 10, valeurs
 *    figées production/staging/development/custom), ici l'utilisateur peut
 *    créer/renommer/supprimer ses propres environnements — la CRUD est
 *    demandée explicitement par la tâche. Seedé avec production/staging/
 *    development par défaut (voir lib/services/process-organization/store.js
 *    #ensureDefaults, appelé au boot comme serversStore.ensureLocalServer).
 *  - `process_groups` : catalogue de groupes logiques (ex: "E-commerce").
 *  - `process_tags` : association N-N process <-> tag.
 *  - `process_environment` : association 1-N process -> environment (un seul
 *    environnement par process, cohérent avec l'énoncé "un process doit
 *    pouvoir appartenir à un environnement" — au singulier).
 *  - `process_group_members` : association N-N process <-> groupe ("un
 *    process peut appartenir à un ou plusieurs groupes").
 *
 * Toutes les associations utilisent ON DELETE CASCADE côté catalogue
 * (supprimer un tag/environnement/groupe retire ses associations, jamais le
 * process PM2 lui-même — cette table ne connaît que son nom).
 */

async function up(db) {
  const isMysql = db.driver === "mysql";

  if (isMysql) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL UNIQUE,
        color VARCHAR(32),
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS environments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL UNIQUE,
        color VARCHAR(32),
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS process_groups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL UNIQUE,
        description VARCHAR(500),
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS process_tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        server_key VARCHAR(191) NOT NULL DEFAULT 'local',
        process_name VARCHAR(191) NOT NULL,
        tag_id INT NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE KEY uniq_process_tag (server_key, process_name, tag_id),
        CONSTRAINT fk_process_tags_tag FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS process_environment (
        id INT AUTO_INCREMENT PRIMARY KEY,
        server_key VARCHAR(191) NOT NULL DEFAULT 'local',
        process_name VARCHAR(191) NOT NULL,
        environment_id INT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE KEY uniq_process_environment (server_key, process_name),
        CONSTRAINT fk_process_environment_env FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS process_group_members (
        id INT AUTO_INCREMENT PRIMARY KEY,
        server_key VARCHAR(191) NOT NULL DEFAULT 'local',
        process_name VARCHAR(191) NOT NULL,
        group_id INT NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE KEY uniq_process_group (server_key, process_name, group_id),
        CONSTRAINT fk_process_group_members_group FOREIGN KEY (group_id) REFERENCES process_groups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    for (const [name, def] of Object.entries({
      idx_process_tags_tag: "process_tags(tag_id)",
      idx_process_tags_process: "process_tags(server_key, process_name)",
      idx_process_environment_env: "process_environment(environment_id)",
      idx_process_group_members_group: "process_group_members(group_id)",
      idx_process_group_members_process: "process_group_members(server_key, process_name)",
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
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS environments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS process_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS process_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_key TEXT NOT NULL DEFAULT 'local',
      process_name TEXT NOT NULL,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE(server_key, process_name, tag_id)
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS process_environment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_key TEXT NOT NULL DEFAULT 'local',
      process_name TEXT NOT NULL,
      environment_id INTEGER NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(server_key, process_name)
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS process_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_key TEXT NOT NULL DEFAULT 'local',
      process_name TEXT NOT NULL,
      group_id INTEGER NOT NULL REFERENCES process_groups(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE(server_key, process_name, group_id)
    )
  `);

  await db.run("CREATE INDEX IF NOT EXISTS idx_process_tags_tag ON process_tags(tag_id)");
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_process_tags_process ON process_tags(server_key, process_name)",
  );
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_process_environment_env ON process_environment(environment_id)",
  );
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_process_group_members_group ON process_group_members(group_id)",
  );
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_process_group_members_process ON process_group_members(server_key, process_name)",
  );
}

async function down(db) {
  await db.run("DROP TABLE IF EXISTS process_group_members");
  await db.run("DROP TABLE IF EXISTS process_environment");
  await db.run("DROP TABLE IF EXISTS process_tags");
  await db.run("DROP TABLE IF EXISTS process_groups");
  await db.run("DROP TABLE IF EXISTS environments");
  await db.run("DROP TABLE IF EXISTS tags");
}

module.exports = {
  version: "015_process_organization",
  description:
    "Tags, environnements et groupes de process (Phase 13) — catalogues + associations (server_key, process_name).",
  up,
  down,
};
