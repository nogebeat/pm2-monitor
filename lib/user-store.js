"use strict";

const bcrypt = require("bcryptjs");
const db = require("./db");

const SALT_ROUNDS = 10;

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    isAdmin: !!row.is_admin,
    createdAt: row.created_at,
  };
}

async function loadPermissions(userId) {
  const rows = await db.all("SELECT app_name, action FROM permissions WHERE user_id = ?", [userId]);
  return rows.map((r) => ({ appName: r.app_name, action: r.action }));
}

/** Retourne l'utilisateur (avec permissions chargées) ou null. */
async function getUserWithPermissions(id) {
  const row = await db.get("SELECT * FROM users WHERE id = ?", [id]);
  if (!row) return null;
  const user = rowToUser(row);
  user.permissions = await loadPermissions(user.id);
  return user;
}

async function getByUsername(username) {
  return db.get("SELECT * FROM users WHERE username = ?", [String(username || "").toLowerCase()]);
}

async function verifyCredentials(username, password) {
  const row = await getByUsername(username);
  if (!row) return null;
  const ok = await bcrypt.compare(String(password || ""), row.password_hash);
  if (!ok) return null;
  return getUserWithPermissions(row.id);
}

async function countUsers() {
  const row = await db.get("SELECT COUNT(*) AS n FROM users", []);
  return row ? Number(row.n) : 0;
}

async function createUser({ username, password, isAdmin = false }) {
  const uname = String(username || "")
    .trim()
    .toLowerCase();
  if (!uname) throw new Error("Nom d'utilisateur requis.");
  if (!password || String(password).length < 8) {
    throw new Error("Le mot de passe doit contenir au moins 8 caractères.");
  }
  const existing = await getByUsername(uname);
  if (existing) throw new Error(`L'utilisateur "${uname}" existe déjà.`);

  const hash = await bcrypt.hash(String(password), SALT_ROUNDS);
  const result = await db.run(
    "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)",
    [uname, hash, isAdmin ? 1 : 0, Date.now()],
  );
  return getUserWithPermissions(result.lastID);
}

async function setPassword(userId, password) {
  if (!password || String(password).length < 8) {
    throw new Error("Le mot de passe doit contenir au moins 8 caractères.");
  }
  const hash = await bcrypt.hash(String(password), SALT_ROUNDS);
  await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, userId]);
}

async function setAdmin(userId, isAdmin) {
  await db.run("UPDATE users SET is_admin = ? WHERE id = ?", [isAdmin ? 1 : 0, userId]);
}

async function deleteUser(userId) {
  await db.run("DELETE FROM users WHERE id = ?", [userId]);
}

async function listUsers() {
  const rows = await db.all("SELECT * FROM users ORDER BY username ASC", []);
  const users = rows.map(rowToUser);
  for (const u of users) {
    u.permissions = await loadPermissions(u.id);
  }
  return users;
}

/** Ajoute (ou laisse tel quel si déjà présente) une permission (app_name/action peuvent être "*"). */
async function grant(userId, appName, action) {
  await db.run(
    db.driver === "mysql"
      ? "INSERT IGNORE INTO permissions (user_id, app_name, action, created_at) VALUES (?, ?, ?, ?)"
      : "INSERT OR IGNORE INTO permissions (user_id, app_name, action, created_at) VALUES (?, ?, ?, ?)",
    [userId, appName, action, Date.now()],
  );
}

async function revoke(userId, appName, action) {
  await db.run("DELETE FROM permissions WHERE user_id = ? AND app_name = ? AND action = ?", [
    userId,
    appName,
    action,
  ]);
}

/** Remplace toutes les permissions d'un utilisateur par la liste fournie [{appName, action}]. */
async function replacePermissions(userId, permissions) {
  await db.run("DELETE FROM permissions WHERE user_id = ?", [userId]);
  for (const p of permissions || []) {
    if (!p || !p.appName || !p.action) continue;
    await grant(userId, p.appName, p.action);
  }
}

module.exports = {
  getUserWithPermissions,
  getByUsername,
  verifyCredentials,
  countUsers,
  createUser,
  setPassword,
  setAdmin,
  deleteUser,
  listUsers,
  grant,
  revoke,
  replacePermissions,
};
