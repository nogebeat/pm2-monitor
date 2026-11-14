"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const snapshot = require("../../lib/db/snapshot");

/**
 * Sauvegarde / restauration de la base autour d'une mise à jour : on vérifie le
 * comportement OBSERVABLE (le contenu de la base avant/après), pas seulement
 * que des fichiers existent. SQLite tourne partout ; MySQL/MariaDB n'est testé
 * que si TEST_MYSQL_HOST (+ _PORT/_USER/_PASS/_NAME) est défini — voir en bas.
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-snap-"));
}

function makeSqliteDb(dir) {
  const dbPath = path.join(dir, "data", "monitor.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
  db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO users (name) VALUES (?)").run("admin");
  db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run("001_initial");
  return { db, dbPath };
}

const sqliteConfig = (dbPath) => ({ driver: "sqlite", sqlitePath: dbPath });

function readTables(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

test("configFromEnv", async (t) => {
  await t.test("défauts : sqlite, MySQL 127.0.0.1:3306", () => {
    const c = snapshot.configFromEnv({});
    assert.equal(c.driver, "sqlite");
    assert.equal(c.host, "127.0.0.1");
    assert.equal(c.port, "3306");
    assert.equal(c.database, "pm2_monitor");
  });
  await t.test("refuse un driver inconnu", () => {
    assert.throws(() => snapshot.configFromEnv({ DB_DRIVER: "oracle" }), /DB_DRIVER invalide/);
  });
  await t.test("insensible à la casse", () => {
    assert.equal(snapshot.configFromEnv({ DB_DRIVER: "MySQL" }).driver, "mysql");
  });
});

test("SQLite — sauvegarde puis restauration", async (t) => {
  await t.test(
    "restaure EXACTEMENT l'état d'avant (une table ajoutée par une migration disparaît)",
    async () => {
      const dir = tmpDir();
      try {
        const { db, dbPath } = makeSqliteDb(dir);
        const outDir = path.join(dir, "data", "backups");
        const file = await snapshot.createSnapshot({
          config: sqliteConfig(dbPath),
          rootDir: dir,
          outDir,
          label: "pre-update-v1-to-v2",
        });

        // « migration » de la nouvelle version, base TOUJOURS OUVERTE (application en cours d'exécution, mode WAL)
        db.exec("CREATE TABLE new_feature (id INTEGER PRIMARY KEY)");
        db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run("002_new_feature");
        db.prepare("INSERT INTO users (name) VALUES (?)").run("intrus");
        db.close();

        const { keptCopy } = await snapshot.restoreSnapshot({
          config: sqliteConfig(dbPath),
          rootDir: dir,
          outDir,
          file,
        });

        assert.deepEqual(readTables(dbPath), ["schema_migrations", "users"]);
        const check = new Database(dbPath, { readonly: true });
        assert.deepEqual(check.prepare("SELECT name FROM users").all(), [{ name: "admin" }]);
        assert.deepEqual(check.prepare("SELECT version FROM schema_migrations").all(), [
          { version: "001_initial" },
        ]);
        check.close();
        // l'état défaillant est conservé à côté, jamais détruit
        assert.ok(keptCopy && fs.existsSync(keptCopy));
        assert.ok(readTables(keptCopy).includes("new_feature"));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "la sauvegarde est cohérente même quand le contenu récent n'est que dans le journal WAL",
    async () => {
      const dir = tmpDir();
      try {
        const { db, dbPath } = makeSqliteDb(dir);
        for (let i = 0; i < 200; i++) db.prepare("INSERT INTO users (name) VALUES (?)").run(`u${i}`);
        // base ouverte, WAL non checkpointé : copier le seul fichier .db perdrait ces lignes
        const file = await snapshot.createSnapshot({
          config: sqliteConfig(dbPath),
          rootDir: dir,
          outDir: path.join(dir, "b"),
          label: "x",
        });
        db.close();
        const snap = new Database(file, { readonly: true });
        assert.equal(snap.prepare("SELECT COUNT(*) c FROM users").get().c, 201);
        snap.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "un journal WAL résiduel de la nouvelle version n'est PAS rejoué sur la base restaurée",
    async () => {
      const dir = tmpDir();
      try {
        const { db, dbPath } = makeSqliteDb(dir);
        const outDir = path.join(dir, "b");
        const file = await snapshot.createSnapshot({
          config: sqliteConfig(dbPath),
          rootDir: dir,
          outDir,
          label: "x",
        });
        db.exec("CREATE TABLE apres (id INTEGER)");
        // on NE ferme PAS proprement : le -wal contient encore « apres »
        assert.ok(fs.existsSync(`${dbPath}-wal`));
        await snapshot.restoreSnapshot({ config: sqliteConfig(dbPath), rootDir: dir, outDir, file });
        db.close();
        assert.ok(!readTables(dbPath).includes("apres"));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "la sauvegarde est UN SEUL fichier autonome : aucun -wal/-shm/.partial à côté, lisible une fois copiée seule",
    async () => {
      const dir = tmpDir();
      try {
        const { db, dbPath } = makeSqliteDb(dir);
        for (let i = 0; i < 300; i++) db.prepare("INSERT INTO users (name) VALUES (?)").run(`u${i}`);
        const outDir = path.join(dir, "b");
        const file = await snapshot.createSnapshot({
          config: sqliteConfig(dbPath),
          rootDir: dir,
          outDir,
          label: "x",
        });
        db.close();
        assert.deepEqual(fs.readdirSync(outDir), [path.basename(file)]);

        // copiée SEULE ailleurs (sans aucune annexe), elle contient tout
        const alone = path.join(dir, "copie-seule.sqlite");
        fs.copyFileSync(file, alone);
        const check = new Database(alone, { readonly: true });
        assert.equal(check.prepare("SELECT COUNT(*) c FROM users").get().c, 301);
        assert.equal(check.pragma("journal_mode", { simple: true }), "delete");
        check.close();
        assert.deepEqual(
          fs.readdirSync(dir).filter((f) => f.startsWith("copie-seule")),
          ["copie-seule.sqlite"],
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test("fichiers de sauvegarde en 600, dossier en 700", async () => {
    const dir = tmpDir();
    try {
      const { db, dbPath } = makeSqliteDb(dir);
      const outDir = path.join(dir, "b");
      const file = await snapshot.createSnapshot({
        config: sqliteConfig(dbPath),
        rootDir: dir,
        outDir,
        label: "x",
      });
      db.close();
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(outDir).mode & 0o777, 0o700);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("refuse de restaurer une sauvegarde corrompue, sans toucher à la base courante", async () => {
    const dir = tmpDir();
    try {
      const { db, dbPath } = makeSqliteDb(dir);
      db.close();
      const bad = path.join(dir, "pre-update-corrompu.sqlite");
      fs.writeFileSync(bad, "ceci n'est pas une base SQLite");
      await assert.rejects(
        snapshot.restoreSnapshot({ config: sqliteConfig(dbPath), rootDir: dir, outDir: dir, file: bad }),
      );
      assert.deepEqual(readTables(dbPath), ["schema_migrations", "users"]);
      assert.ok(!fs.readdirSync(path.join(dir, "data")).some((f) => f.includes("failed-update")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("base introuvable : erreur explicite", async () => {
    const dir = tmpDir();
    try {
      await assert.rejects(
        snapshot.createSnapshot({
          config: sqliteConfig(path.join(dir, "absente.db")),
          rootDir: dir,
          outDir: path.join(dir, "b"),
          label: "x",
        }),
        /introuvable/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("le libellé est assaini (pas de traversée de chemin dans le nom du fichier)", async () => {
    const dir = tmpDir();
    try {
      const { db, dbPath } = makeSqliteDb(dir);
      db.close();
      const outDir = path.join(dir, "b");
      const file = await snapshot.createSnapshot({
        config: sqliteConfig(dbPath),
        rootDir: dir,
        outDir,
        label: "../../etc/passwd; rm -rf /",
      });
      assert.equal(path.dirname(file), outDir);
      assert.match(path.basename(file), /^[A-Za-z0-9._-]+\.sqlite$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("checkPrerequisites", async (t) => {
  await t.test("sqlite avec base présente : ok", () => {
    const dir = tmpDir();
    try {
      const { db, dbPath } = makeSqliteDb(dir);
      db.close();
      assert.deepEqual(snapshot.checkPrerequisites(sqliteConfig(dbPath), { rootDir: dir }), {
        ok: true,
        problems: [],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  await t.test("sqlite sans fichier de base : signalé", () => {
    const dir = tmpDir();
    try {
      const r = snapshot.checkPrerequisites(sqliteConfig(path.join(dir, "absente.db")), { rootDir: dir });
      assert.equal(r.ok, false);
      assert.deepEqual(r.problems, ["no_db_file"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  await t.test("mysql sans clients mysqldump/mysql dans le PATH : signalé", () => {
    const r = snapshot.checkPrerequisites(
      { driver: "mysql" },
      { rootDir: "/", env: { PATH: "/nonexistent" } },
    );
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, ["no_mysqldump", "no_mysql_client"]);
  });
});

test("pruneSnapshots", async (t) => {
  function seed(dir, names) {
    const base = Date.now() - 100000;
    names.forEach((name, i) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, "x");
      fs.utimesSync(f, new Date(base + i * 1000), new Date(base + i * 1000));
    });
  }

  await t.test("garde les N plus récentes de chaque famille, ne touche pas aux autres fichiers", () => {
    const dir = tmpDir();
    try {
      seed(dir, [
        "pre-update-a-1.sqlite",
        "pre-update-a-2.sqlite",
        "pre-update-a-3.sqlite",
        "failed-update-a-1.sqlite",
        "failed-update-a-2.sqlite",
        "notes-perso.txt",
        "autre.sqlite",
      ]);
      const removed = snapshot.pruneSnapshots({ outDir: dir, keep: 2 });
      assert.deepEqual(removed.map((f) => path.basename(f)).sort(), ["pre-update-a-1.sqlite"]);
      assert.ok(fs.existsSync(path.join(dir, "notes-perso.txt")));
      assert.ok(fs.existsSync(path.join(dir, "autre.sqlite")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("ne supprime jamais un fichier protégé (la sauvegarde qu'on vient de faire)", () => {
    const dir = tmpDir();
    try {
      seed(dir, ["pre-update-a-1.sqlite", "pre-update-a-2.sqlite", "pre-update-a-3.sqlite"]);
      const protectedFile = path.join(dir, "pre-update-a-1.sqlite");
      const removed = snapshot.pruneSnapshots({ outDir: dir, keep: 1, protect: [protectedFile] });
      assert.ok(fs.existsSync(protectedFile));
      assert.deepEqual(
        removed.map((f) => path.basename(f)),
        ["pre-update-a-2.sqlite"],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("dossier inexistant : rien à faire", () => {
    assert.deepEqual(snapshot.pruneSnapshots({ outDir: "/nonexistent/dir-xyz", keep: 1 }), []);
  });
});

// ---------------------------------------------------------------------
// MySQL / MariaDB — opt-in (nécessite un vrai serveur et les clients mysqldump/mysql)
// ---------------------------------------------------------------------

const MYSQL = process.env.TEST_MYSQL_HOST
  ? {
      driver: "mysql",
      host: process.env.TEST_MYSQL_HOST,
      port: process.env.TEST_MYSQL_PORT || "3306",
      user: process.env.TEST_MYSQL_USER || "root",
      password: process.env.TEST_MYSQL_PASS || "",
      database: process.env.TEST_MYSQL_NAME || "pm2_test",
    }
  : null;

function mysqlQuery(sql) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync(
    "mysql",
    [
      `--host=${MYSQL.host}`,
      `--port=${MYSQL.port}`,
      `--user=${MYSQL.user}`,
      "-N",
      "-B",
      MYSQL.database,
      "-e",
      sql,
    ],
    { env: { ...process.env, MYSQL_PWD: MYSQL.password }, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test("MySQL/MariaDB — sauvegarde puis restauration (TEST_MYSQL_HOST requis)", { skip: !MYSQL }, async (t) => {
  await t.test(
    "restaure l'état d'avant : la table créée par la « migration » disparaît, les données reviennent",
    async () => {
      const dir = tmpDir();
      try {
        mysqlQuery("DROP TABLE IF EXISTS new_feature, users, schema_migrations");
        mysqlQuery("CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50)) ENGINE=InnoDB");
        mysqlQuery("CREATE TABLE schema_migrations (version VARCHAR(100) PRIMARY KEY)");
        mysqlQuery("INSERT INTO users (name) VALUES ('admin')");
        mysqlQuery("INSERT INTO schema_migrations VALUES ('001_initial')");

        const outDir = path.join(dir, "backups");
        const file = await snapshot.createSnapshot({
          config: MYSQL,
          rootDir: dir,
          outDir,
          label: "pre-update-v1-to-v2",
        });
        assert.match(path.basename(file), /\.sql$/);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        // le mot de passe ne doit figurer nulle part dans le dump
        assert.ok(!fs.readFileSync(file, "utf8").includes(MYSQL.password) || MYSQL.password === "");

        // « migration » de la nouvelle version
        mysqlQuery("CREATE TABLE new_feature (id INT PRIMARY KEY) ENGINE=InnoDB");
        mysqlQuery("INSERT INTO schema_migrations VALUES ('002_new_feature')");
        mysqlQuery("INSERT INTO users (name) VALUES ('intrus')");

        const { keptCopy } = await snapshot.restoreSnapshot({ config: MYSQL, rootDir: dir, outDir, file });

        assert.equal(
          mysqlQuery(
            "SELECT GROUP_CONCAT(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema = DATABASE()",
          ),
          "schema_migrations,users",
        );
        assert.equal(mysqlQuery("SELECT GROUP_CONCAT(name) FROM users"), "admin");
        assert.equal(mysqlQuery("SELECT GROUP_CONCAT(version) FROM schema_migrations"), "001_initial");
        assert.ok(keptCopy && fs.existsSync(keptCopy), "l'état défaillant doit être conservé");
        assert.match(fs.readFileSync(keptCopy, "utf8"), /new_feature/);
      } finally {
        mysqlQuery("DROP TABLE IF EXISTS new_feature, users, schema_migrations");
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test("mauvais mot de passe : échec explicite, aucun fichier de sauvegarde laissé", async () => {
    const dir = tmpDir();
    try {
      const outDir = path.join(dir, "backups");
      await assert.rejects(
        snapshot.createSnapshot({
          config: { ...MYSQL, password: "mauvais" },
          rootDir: dir,
          outDir,
          label: "x",
        }),
      );
      assert.deepEqual(fs.readdirSync(outDir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
