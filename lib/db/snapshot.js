"use strict";

/**
 * lib/db/snapshot.js — sauvegarde / restauration de la BASE DE DONNÉES autour
 * d'une mise à jour (utilisé par bin/db-snapshot.js, lui-même appelé par
 * `deploy.sh update`).
 *
 * Pourquoi : les migrations s'appliquent AVANT le redémarrage et le contrôle de
 * santé. Si la nouvelle version ne démarre pas, revenir au code précédent ne
 * suffit pas — l'ancien code se retrouverait sur un schéma déjà migré. Il faut
 * pouvoir restaurer la base telle qu'elle était juste avant les migrations.
 *
 * SQLite (défaut) : copie COHÉRENTE via l'API de sauvegarde en ligne de
 * better-sqlite3 (la base est en mode WAL et l'application peut tourner :
 * copier le seul fichier .db donnerait une sauvegarde incohérente), puis
 * `PRAGMA integrity_check` sur la copie avant de la considérer valide.
 *
 * MySQL / MariaDB : `mysqldump --single-transaction` (clients `mysqldump` et
 * `mysql` requis dans le PATH). Le mot de passe passe par la variable
 * d'environnement MYSQL_PWD, jamais par la ligne de commande (visible dans
 * `ps`). À la restauration, TOUTES les tables sont d'abord supprimées : un
 * simple rejeu du dump laisserait en place les tables créées par les
 * migrations de la nouvelle version, et une nouvelle tentative de mise à jour
 * échouerait sur « table déjà existante ».
 *
 * Rien n'est jamais détruit sans copie : à la restauration, la base défaillante
 * est conservée à côté (`*.failed-update-<date>`) pour analyse.
 *
 * Les fichiers de sauvegarde contiennent des données sensibles (hashes de mots
 * de passe, secrets de notification chiffrés) : dossier 700, fichiers 600.
 */

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const FILE_RE = /^(pre-update|failed-update)-[A-Za-z0-9._-]+\.(sqlite|sql)$/;
const MIN_FREE_MARGIN_BYTES = 50 * 1024 * 1024;

function configFromEnv(env = process.env) {
  const driver = String(env.DB_DRIVER || "sqlite").toLowerCase();
  if (driver !== "sqlite" && driver !== "mysql") {
    throw new Error(`DB_DRIVER invalide : "${env.DB_DRIVER}" (valeurs acceptées : sqlite, mysql).`);
  }
  return {
    driver,
    sqlitePath: env.DB_SQLITE_PATH || null,
    host: env.DB_HOST || "127.0.0.1",
    port: env.DB_PORT ? String(Number(env.DB_PORT)) : "3306",
    user: env.DB_USER || "",
    password: env.DB_PASS || "",
    database: env.DB_NAME || "pm2_monitor",
  };
}

function resolveSqlitePath(config, rootDir) {
  return path.resolve(rootDir, config.sqlitePath || path.join("data", "monitor.db"));
}

function stamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
}

function safeLabel(label) {
  return (
    String(label || "snapshot")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "snapshot"
  );
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (e) {
    /* système de fichiers sans permissions Unix : on continue */
  }
}

function freeBytes(dir) {
  const st = fs.statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

function onPath(binary, env = process.env) {
  const dirs = String(env.PATH || "").split(path.delimiter);
  return dirs.some((d) => {
    if (!d) return false;
    try {
      fs.accessSync(path.join(d, binary), fs.constants.X_OK);
      return true;
    } catch (e) {
      return false;
    }
  });
}

/** Les prérequis d'une sauvegarde sont-ils réunis ? → { ok, problems: [codes] } */
function checkPrerequisites(config, { rootDir, env = process.env } = {}) {
  const problems = [];
  if (config.driver === "sqlite") {
    try {
      require("better-sqlite3");
    } catch (e) {
      problems.push("no_better_sqlite3");
    }
    const dbPath = resolveSqlitePath(config, rootDir);
    if (!fs.existsSync(dbPath)) problems.push("no_db_file");
  } else {
    if (!onPath("mysqldump", env)) problems.push("no_mysqldump");
    if (!onPath("mysql", env)) problems.push("no_mysql_client");
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------

function sqliteIntegrityOk(file) {
  const Database = require("better-sqlite3");
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.pragma("integrity_check", { simple: true }) === "ok";
  } finally {
    db.close();
  }
}

async function sqliteCreate({ config, rootDir, outDir, label, now }) {
  const Database = require("better-sqlite3");
  const dbPath = resolveSqlitePath(config, rootDir);
  if (!fs.existsSync(dbPath)) throw new Error(`Base SQLite introuvable : ${dbPath}`);

  const size =
    fs.statSync(dbPath).size + (fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0);
  if (freeBytes(outDir) < size * 2 + MIN_FREE_MARGIN_BYTES) {
    throw new Error(`Espace disque insuffisant pour sauvegarder la base dans ${outDir}.`);
  }

  const final = path.join(outDir, `${safeLabel(label)}-${stamp(now)}.sqlite`);
  const tmp = `${final}.partial`;
  const src = new Database(dbPath, { fileMustExist: true });
  try {
    await src.backup(tmp);
  } finally {
    src.close();
  }
  // La copie hérite du mode WAL de la base : en l'état, ouvrir le fichier (même en lecture seule)
  // laisse des fichiers -wal / -shm à côté, et la sauvegarde ne serait PAS un fichier autonome.
  // On la repasse en journal classique (DELETE) : un seul fichier, complet, sans annexes.
  let intact = false;
  const copy = new Database(tmp, { fileMustExist: true });
  try {
    copy.pragma("journal_mode = DELETE");
    intact = copy.pragma("integrity_check", { simple: true }) === "ok";
  } finally {
    copy.close();
  }
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${tmp}${suffix}`, { force: true });
  if (!intact) {
    fs.rmSync(tmp, { force: true });
    throw new Error("La sauvegarde SQLite a échoué au contrôle d'intégrité (PRAGMA integrity_check).");
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, final);
  return final;
}

function sqliteRestore({ config, rootDir, file, now }) {
  const dbPath = resolveSqlitePath(config, rootDir);
  if (!sqliteIntegrityOk(file)) {
    throw new Error("La sauvegarde à restaurer ne passe pas le contrôle d'intégrité : restauration refusée.");
  }
  const tag = `failed-update-${stamp(now)}`;
  const tmp = `${dbPath}.restore-tmp`;
  fs.copyFileSync(file, tmp);
  fs.chmodSync(tmp, 0o600);

  // La base défaillante (et son journal WAL) est conservée, jamais supprimée.
  let keptCopy = null;
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${dbPath}${suffix}`;
    if (!fs.existsSync(from)) continue;
    const to = `${dbPath}.${tag}${suffix}`;
    fs.renameSync(from, to);
    if (suffix === "") keptCopy = to;
  }
  fs.renameSync(tmp, dbPath);
  return { keptCopy };
}

// ---------------------------------------------------------------------
// MySQL / MariaDB
// ---------------------------------------------------------------------

function mysqlEnv(config, env = process.env) {
  return { ...env, MYSQL_PWD: config.password };
}

function mysqlConnArgs(config) {
  return [`--host=${config.host}`, `--port=${config.port}`, `--user=${config.user}`];
}

function mysqldumpSupports(option, env = process.env) {
  const r = childProcess.spawnSync("mysqldump", ["--help"], { env, encoding: "utf8" });
  return r.status === 0 && String(r.stdout).includes(option);
}

function runToFile(command, args, { env, outFile }) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outFile, { mode: 0o600 });
    const child = childProcess.spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c;
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.stdout.pipe(out);
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      out.end(() => {
        if (code === 0) resolve();
        else reject(new Error(`${command} a échoué (code ${code}) : ${stderr.trim().split("\n").pop()}`));
      });
    });
  });
}

function runFromFile(command, args, { env, inFile }) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c;
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} a échoué (code ${code}) : ${stderr.trim().split("\n").pop()}`));
    });
    if (inFile) {
      const input = fs.createReadStream(inFile);
      input.on("error", (err) => reject(err));
      input.pipe(child.stdin);
    }
  });
}

function runCapture(command, args, { env, input }) {
  const r = childProcess.spawnSync(command, args, {
    env,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${command} a échoué (code ${r.status}) : ${String(r.stderr).trim().split("\n").pop()}`);
  }
  return String(r.stdout);
}

async function mysqlCreate({ config, outDir, label, now, env }) {
  const final = path.join(outDir, `${safeLabel(label)}-${stamp(now)}.sql`);
  const tmp = `${final}.partial`;
  const args = [
    ...mysqlConnArgs(config),
    "--single-transaction",
    "--routines",
    "--triggers",
    "--default-character-set=utf8mb4",
  ];
  if (mysqldumpSupports("no-tablespaces", env)) args.push("--no-tablespaces");
  args.push(config.database);

  try {
    await runToFile("mysqldump", args, { env: mysqlEnv(config, env), outFile: tmp });
    // mysqldump termine un export COMPLET par une ligne « Dump completed » : son absence = dump tronqué.
    const tail = fs.readFileSync(tmp, "utf8").slice(-300);
    if (!/Dump completed/i.test(tail))
      throw new Error("Le dump MySQL est incomplet (marqueur de fin absent).");
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, final);
  return final;
}

function quoteIdent(name) {
  return `\`${String(name).replace(/`/g, "``")}\``;
}

async function mysqlRestore({ config, outDir, file, now, env }) {
  const full = mysqlEnv(config, env);
  const conn = [...mysqlConnArgs(config), "--default-character-set=utf8mb4", config.database];

  // Copie de l'état défaillant (au mieux) avant d'écraser quoi que ce soit.
  let keptCopy = null;
  try {
    keptCopy = await mysqlCreate({ config, outDir, label: "failed-update", now, env });
  } catch (e) {
    keptCopy = null;
  }

  const tables = runCapture(
    "mysql",
    [
      ...conn,
      "-N",
      "-B",
      "-e",
      "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()",
    ],
    { env: full },
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (tables.length) {
    const dropSql = `SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS ${tables.map(quoteIdent).join(", ")}; SET FOREIGN_KEY_CHECKS=1;`;
    runCapture("mysql", conn, { env: full, input: dropSql });
  }
  await runFromFile("mysql", conn, { env: full, inFile: file });
  return { keptCopy };
}

// ---------------------------------------------------------------------
// API commune
// ---------------------------------------------------------------------

/** Crée une sauvegarde ; renvoie le chemin du fichier. */
async function createSnapshot({ config, rootDir, outDir, label, now = new Date(), env = process.env }) {
  ensurePrivateDir(outDir);
  if (config.driver === "sqlite") return sqliteCreate({ config, rootDir, outDir, label, now });
  return mysqlCreate({ config, outDir, label, now, env });
}

/** Restaure une sauvegarde. L'application DOIT être arrêtée. → { keptCopy } */
async function restoreSnapshot({ config, rootDir, outDir, file, now = new Date(), env = process.env }) {
  if (!fs.existsSync(file)) throw new Error(`Sauvegarde introuvable : ${file}`);
  if (config.driver === "sqlite") return sqliteRestore({ config, rootDir, file, now });
  ensurePrivateDir(outDir);
  return mysqlRestore({ config, outDir, file, now, env });
}

/**
 * Ne conserve que les `keep` sauvegardes les plus récentes de chaque famille
 * (pre-update-* et failed-update-*). Ne touche qu'aux fichiers au nom attendu.
 */
function pruneSnapshots({ outDir, keep = 5, protect = [] }) {
  if (!fs.existsSync(outDir)) return [];
  const removed = [];
  const protectedSet = new Set(protect.map((p) => path.resolve(p)));
  for (const prefix of ["pre-update-", "failed-update-"]) {
    const files = fs
      .readdirSync(outDir)
      .filter((name) => FILE_RE.test(name) && name.startsWith(prefix))
      .map((name) => ({
        name,
        full: path.join(outDir, name),
        mtime: fs.statSync(path.join(outDir, name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(Math.max(0, keep))) {
      if (protectedSet.has(path.resolve(f.full))) continue;
      fs.rmSync(f.full, { force: true });
      removed.push(f.full);
    }
  }
  return removed;
}

module.exports = {
  configFromEnv,
  resolveSqlitePath,
  checkPrerequisites,
  createSnapshot,
  restoreSnapshot,
  pruneSnapshots,
  stamp,
  safeLabel,
  FILE_RE,
};
