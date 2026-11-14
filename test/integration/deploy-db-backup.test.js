"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

/**
 * Raccord RÉEL entre deploy.sh et les CLI Node (bin/migrate.js, bin/db-snapshot.js) :
 * noms d'arguments, format de sortie, chemins. Les scénarios bats de
 * test/deploy/update_release.bats remplacent ces appels par des doublures (le CI
 * « deploy » n'installe pas les dépendances Node) ; ici on exécute les VRAIES
 * fonctions backup_database / restore_database / count_pending_migrations de
 * deploy.sh contre une vraie base SQLite.
 */

const REPO = path.join(__dirname, "..", "..");

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-deploydb-"));
  for (const sub of ["bin", "lib"]) fs.cpSync(path.join(REPO, sub), path.join(dir, sub), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(dir, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}

/** Exécute du bash qui source le VRAI deploy.sh, dans un projet temporaire. */
function sh(dir, script, extraEnv = {}) {
  const r = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail; source "${path.join(REPO, "deploy.sh")}"; SCRIPT_DIR="${dir}"; BACKUP_DIR="${dir}/data/backups"; cd "${dir}"; ${script}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, DB_SQLITE_PATH: path.join(dir, "data", "monitor.db"), ...extraEnv },
    },
  );
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test("deploy.sh ↔ CLI Node : migrations, sauvegarde, restauration (SQLite réel)", async (t) => {
  await t.test(
    "count_pending_migrations : nombre de migrations en attente (base neuve = toutes), 0 une fois appliquées",
    () => {
      const dir = makeProject();
      try {
        const before = sh(dir, "count_pending_migrations");
        assert.equal(before.status, 0, before.err);
        assert.match(before.out, /^\d+$/);
        assert.ok(Number(before.out) > 0);

        execFileSync("node", ["bin/migrate.js", "up"], {
          cwd: dir,
          env: { ...process.env, DB_SQLITE_PATH: path.join(dir, "data", "monitor.db") },
        });
        const after = sh(dir, "count_pending_migrations");
        assert.equal(after.out, "0");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "backup_database puis restore_database : la base revient EXACTEMENT à l'état d'avant, état défaillant conservé",
    () => {
      const dir = makeProject();
      const dbPath = path.join(dir, "data", "monitor.db");
      try {
        execFileSync("node", ["bin/migrate.js", "up"], {
          cwd: dir,
          env: { ...process.env, DB_SQLITE_PATH: dbPath },
        });
        const db = new Database(dbPath);
        db.prepare("CREATE TABLE IF NOT EXISTS marqueur (v TEXT)").run();
        db.prepare("INSERT INTO marqueur VALUES ('avant-mise-a-jour')").run();
        db.close();

        const run = sh(dir, 'backup_database 4.1.2 v4.2.0; echo "$DB_BACKUP_FILE"');
        assert.equal(run.status, 0, run.err);
        const file = run.out.split("\n").pop();
        assert.match(path.basename(file), /^pre-update-v4\.1\.2-to-v4\.2\.0-\d{8}-\d{6}\.sqlite$/);
        assert.ok(fs.existsSync(file));

        // la « migration » de la nouvelle version
        const db2 = new Database(dbPath);
        db2.prepare("CREATE TABLE nouvelle_fonctionnalite (id INTEGER)").run();
        db2.prepare("DELETE FROM marqueur").run();
        db2.close();

        const restored = sh(dir, `DB_BACKUP_FILE="${file}"; restore_database`);
        assert.equal(restored.status, 0, restored.err);

        const check = new Database(dbPath, { readonly: true });
        const tables = check
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name);
        assert.ok(!tables.includes("nouvelle_fonctionnalite"));
        assert.deepEqual(check.prepare("SELECT v FROM marqueur").all(), [{ v: "avant-mise-a-jour" }]);
        check.close();
        assert.ok(
          fs.readdirSync(path.join(dir, "data")).some((f) => f.includes("failed-update")),
          "état défaillant conservé",
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test("prune_database_backups garde les plus récentes et protège la sauvegarde courante", () => {
    const dir = makeProject();
    try {
      const b = path.join(dir, "data", "backups");
      fs.mkdirSync(b, { recursive: true });
      const names = [];
      for (let i = 1; i <= 7; i++) {
        const n = path.join(b, `pre-update-v1-to-v${i}-2026110${i}-000000.sqlite`);
        fs.writeFileSync(n, "x");
        fs.utimesSync(n, new Date(Date.now() - (10 - i) * 1000), new Date(Date.now() - (10 - i) * 1000));
        names.push(n);
      }
      const r = sh(dir, `DB_BACKUP_FILE="${names[0]}"; prune_database_backups`);
      assert.equal(r.status, 0, r.err);
      const left = fs.readdirSync(b).sort();
      assert.equal(left.length, 6); // 5 plus récentes + la sauvegarde protégée (la plus ancienne)
      assert.ok(fs.existsSync(names[0]), "la sauvegarde protégée ne doit jamais être supprimée");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test(
    "bin/db-snapshot.js : driver invalide et sous-commande inconnue = code de sortie non nul",
    () => {
      const dir = makeProject();
      try {
        const bad = spawnSync("node", ["bin/db-snapshot.js", "check"], {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, DB_DRIVER: "oracle" },
        });
        assert.notEqual(bad.status, 0);
        assert.match(bad.stderr, /DB_DRIVER invalide/);
        const unknown = spawnSync("node", ["bin/db-snapshot.js", "detruire"], { cwd: dir, encoding: "utf8" });
        assert.notEqual(unknown.status, 0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test("bin/db-snapshot.js check : base absente signalée, base présente OK", () => {
    const dir = makeProject();
    try {
      const env = { ...process.env, DB_SQLITE_PATH: path.join(dir, "data", "monitor.db") };
      const missing = spawnSync("node", ["bin/db-snapshot.js", "check"], { cwd: dir, encoding: "utf8", env });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /no_db_file/);
      execFileSync("node", ["bin/migrate.js", "up"], { cwd: dir, env });
      const ok = spawnSync("node", ["bin/db-snapshot.js", "check"], { cwd: dir, encoding: "utf8", env });
      assert.equal(ok.status, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
