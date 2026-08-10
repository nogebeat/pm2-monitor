"use strict";

const fs = require("fs");
const path = require("path");
const db = require("./index");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/** Charge tous les fichiers de migrations, triés par version (ordre alphabétique = ordre chronologique). */
function loadMigrations() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort();

  return files.map((file) => {
    const mod = require(path.join(MIGRATIONS_DIR, file));
    if (!mod.version || typeof mod.up !== "function" || typeof mod.down !== "function") {
      throw new Error(`Migration invalide (${file}) : version/up()/down() requis.`);
    }
    return mod;
  });
}

/** Crée la table de suivi des migrations si nécessaire. Statement universel (sqlite + mysql). */
async function ensureMigrationsTable() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )
  `);
}

async function getAppliedVersions() {
  await ensureMigrationsTable();
  const rows = await db.all("SELECT version FROM schema_migrations ORDER BY version ASC", []);
  return rows.map((r) => r.version);
}

/** { applied: [...migrations], pending: [...migrations] } */
async function status() {
  const all = loadMigrations();
  const appliedVersions = new Set(await getAppliedVersions());
  return {
    applied: all.filter((m) => appliedVersions.has(m.version)),
    pending: all.filter((m) => !appliedVersions.has(m.version)),
  };
}

async function applyOne(migration) {
  await db.beginTransaction();
  try {
    await migration.up(db);
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
      migration.version,
      Date.now(),
    ]);
    await db.commit();
  } catch (e) {
    await db.rollback();
    throw new Error(`Migration ${migration.version} échouée (up) : ${e.message}`);
  }
}

async function revertOne(migration) {
  await db.beginTransaction();
  try {
    await migration.down(db);
    await db.run("DELETE FROM schema_migrations WHERE version = ?", [migration.version]);
    await db.commit();
  } catch (e) {
    await db.rollback();
    throw new Error(`Migration ${migration.version} échouée (down) : ${e.message}`);
  }
}

/**
 * Applique toutes les migrations en attente (ou jusqu'à `to` inclus si fourni).
 * Idempotent : si tout est déjà appliqué, ne fait rien. Retourne les migrations appliquées.
 */
async function up({ to } = {}) {
  const { pending } = await status();
  const toApply = to ? pending.filter((m) => m.version <= to) : pending;

  const applied = [];
  for (const migration of toApply) {
    await applyOne(migration);
    applied.push(migration.version);
  }
  return applied;
}

/**
 * Annule les `steps` dernières migrations appliquées (1 par défaut = la plus récente).
 * Retourne les migrations annulées (dans l'ordre où elles ont été annulées).
 */
async function down({ steps = 1 } = {}) {
  const all = loadMigrations();
  const byVersion = new Map(all.map((m) => [m.version, m]));
  const appliedVersions = await getAppliedVersions(); // ordre croissant

  const toRevert = appliedVersions.slice(-steps).reverse(); // les plus récentes d'abord
  const reverted = [];
  for (const version of toRevert) {
    const migration = byVersion.get(version);
    if (!migration) {
      throw new Error(
        `Migration "${version}" marquée comme appliquée mais introuvable sur disque (fichier supprimé ?).`
      );
    }
    await revertOne(migration);
    reverted.push(version);
  }
  return reverted;
}

module.exports = {
  MIGRATIONS_DIR,
  loadMigrations,
  ensureMigrationsTable,
  getAppliedVersions,
  status,
  up,
  down,
};
