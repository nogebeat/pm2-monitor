"use strict";

/**
 * CRUD + gestion de statut pour le registre de serveurs (table `servers`,
 * migration 012_servers.js). Même style que lib/services/health-checks/store.js :
 * requêtes SQL directes via lib/db, conversion row (snake_case) <-> objet JS
 * (camelCase).
 *
 * Le serveur local (celui sur lequel tourne PM2 Monitor lui-même) est
 * représenté par une ligne `server_key = "local"`, `kind = "local"`,
 * créée automatiquement au démarrage par ensureLocalServer() — voir
 * server.js. Il n'a pas de token (pas d'agent : les données viennent
 * directement de lib/system-stats.js et du pm2 local, dans le même
 * process), et son statut est toujours recalculé à la volée à "ONLINE"
 * (voir lib/routes/servers.js) plutôt que dépendre d'un heartbeat.
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../../db");

const SALT_ROUNDS = 10;
const ENVIRONMENTS = ["production", "staging", "development", "custom"];
const STATUSES = ["ONLINE", "OFFLINE", "PENDING"];

function rowToServer(row) {
  if (!row) return null;
  let lastSnapshot = null;
  if (row.last_snapshot) {
    try {
      lastSnapshot = JSON.parse(row.last_snapshot);
    } catch (e) {
      lastSnapshot = null;
    }
  }
  return {
    id: row.id,
    serverKey: row.server_key,
    name: row.name,
    hostname: row.hostname || null,
    environment: row.environment || "production",
    kind: row.kind || "agent", // "local" | "agent"
    enabled: !!row.enabled,
    status: row.status || "OFFLINE",
    protocolVersion: row.protocol_version || null,
    agentVersion: row.agent_version || null,
    lastSeen: row.last_seen_at === null || row.last_seen_at === undefined ? null : Number(row.last_seen_at),
    snapshot: lastSnapshot, // dernier système/process snapshot reçu (voir lib/realtime/agent-hub.js)
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    hasToken: !!row.token_hash,
  };
}

function genServerKey() {
  return `srv_${crypto.randomBytes(12).toString("hex")}`;
}

/** Génère un token d'agent en clair (retourné une seule fois à la création) + son hash à stocker. */
async function generateToken() {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = await bcrypt.hash(token, SALT_ROUNDS);
  return { token, hash };
}

async function list() {
  const rows = await db.all("SELECT * FROM servers ORDER BY kind ASC, name ASC", []);
  return rows.map(rowToServer);
}

async function getByKey(serverKey) {
  const row = await db.get("SELECT * FROM servers WHERE server_key = ?", [serverKey]);
  return rowToServer(row);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM servers WHERE id = ?", [id]);
  return rowToServer(row);
}

function validateEnvironment(environment) {
  const env = environment || "production";
  if (!ENVIRONMENTS.includes(env)) {
    throw new Error(`Environnement invalide : "${environment}". Valeurs acceptées : ${ENVIRONMENTS.join(", ")}.`);
  }
  return env;
}

/**
 * Enregistre un nouveau serveur agent. Retourne { server, token } — `token`
 * n'est disponible qu'ici (à la création) et lors de regenerateToken(),
 * jamais renvoyé ensuite par list()/getByKey() (voir rowToServer : seul
 * `hasToken` (booléen) est exposé).
 */
async function create({ name, hostname, environment }) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("Nom du serveur requis.");
  const env = validateEnvironment(environment);

  const serverKey = genServerKey();
  const { token, hash } = await generateToken();
  const now = Date.now();

  await db.run(
    `INSERT INTO servers
      (server_key, name, hostname, environment, kind, enabled, status, token_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'agent', 1, 'PENDING', ?, ?, ?)`,
    [serverKey, cleanName, hostname || null, env, hash, now, now],
  );

  const server = await getByKey(serverKey);
  return { server, token };
}

/** Idempotent : crée la ligne "local" si absente, ne la touche pas sinon. */
async function ensureLocalServer() {
  const existing = await getByKey("local");
  if (existing) return existing;
  const now = Date.now();
  await db.run(
    `INSERT INTO servers
      (server_key, name, hostname, environment, kind, enabled, status, token_hash, created_at, updated_at)
     VALUES ('local', ?, ?, 'production', 'local', 1, 'ONLINE', NULL, ?, ?)`,
    [process.env.PM2_MONITOR_LOCAL_SERVER_NAME || "Serveur local", require("os").hostname(), now, now],
  );
  return getByKey("local");
}

async function update(serverKey, { name, hostname, environment }) {
  const existing = await getByKey(serverKey);
  if (!existing) return null;

  const fields = [];
  const params = [];
  if (name !== undefined) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Nom du serveur requis.");
    fields.push("name = ?");
    params.push(cleanName);
  }
  if (hostname !== undefined) {
    fields.push("hostname = ?");
    params.push(hostname || null);
  }
  if (environment !== undefined) {
    fields.push("environment = ?");
    params.push(validateEnvironment(environment));
  }
  if (!fields.length) return existing;

  fields.push("updated_at = ?");
  params.push(Date.now());
  params.push(serverKey);
  await db.run(`UPDATE servers SET ${fields.join(", ")} WHERE server_key = ?`, params);
  return getByKey(serverKey);
}

async function setEnabled(serverKey, enabled) {
  const existing = await getByKey(serverKey);
  if (!existing || existing.kind === "local") {
    // Le serveur local ne peut pas être désactivé : c'est le monitor lui-même
    // (voir "le serveur local doit continuer à fonctionner sans configuration
    // supplémentaire", prompt maître Phase 10, section UI).
    if (existing && existing.kind === "local") {
      throw new Error("Le serveur local ne peut pas être désactivé.");
    }
    return null;
  }
  await db.run("UPDATE servers SET enabled = ?, updated_at = ? WHERE server_key = ?", [
    enabled ? 1 : 0,
    Date.now(),
    serverKey,
  ]);
  return getByKey(serverKey);
}

async function remove(serverKey) {
  const existing = await getByKey(serverKey);
  if (!existing) return false;
  if (existing.kind === "local") throw new Error("Le serveur local ne peut pas être supprimé.");
  await db.run("DELETE FROM servers WHERE server_key = ?", [serverKey]);
  await db.run("DELETE FROM user_servers WHERE server_key = ?", [serverKey]);
  return true;
}

/** Régénère le token d'un agent (ex. compromission suspectée) — invalide l'ancien immédiatement. */
async function regenerateToken(serverKey) {
  const existing = await getByKey(serverKey);
  if (!existing) return null;
  if (existing.kind === "local") throw new Error("Le serveur local n'utilise pas de token d'agent.");
  const { token, hash } = await generateToken();
  await db.run("UPDATE servers SET token_hash = ?, status = 'PENDING', updated_at = ? WHERE server_key = ?", [
    hash,
    Date.now(),
    serverKey,
  ]);
  return { server: await getByKey(serverKey), token };
}

/** Vérifie un (serverKey, token) fournis par un agent au moment de la connexion Socket.IO. */
async function verifyAgentToken(serverKey, token) {
  const row = await db.get("SELECT * FROM servers WHERE server_key = ?", [serverKey]);
  if (!row || !row.token_hash || !row.enabled) return null;
  const ok = await bcrypt.compare(String(token || ""), row.token_hash);
  if (!ok) return null;
  return rowToServer(row);
}

/** Met à jour le statut temps réel d'un serveur (heartbeat / connexion / déconnexion). */
async function touchStatus(serverKey, { status, agentVersion, protocolVersion, snapshot } = {}) {
  const fields = ["updated_at = ?"];
  const params = [Date.now()];
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw new Error(`Statut invalide : "${status}".`);
    fields.push("status = ?");
    params.push(status);
  }
  if (status === "ONLINE") {
    fields.push("last_seen_at = ?");
    params.push(Date.now());
  }
  if (agentVersion !== undefined) {
    fields.push("agent_version = ?");
    params.push(agentVersion || null);
  }
  if (protocolVersion !== undefined) {
    fields.push("protocol_version = ?");
    params.push(protocolVersion || null);
  }
  if (snapshot !== undefined) {
    fields.push("last_snapshot = ?");
    params.push(snapshot ? JSON.stringify(snapshot) : null);
  }
  params.push(serverKey);
  await db.run(`UPDATE servers SET ${fields.join(", ")} WHERE server_key = ?`, params);
}

/** Bascule OFFLINE tous les serveurs "agent" dont le dernier heartbeat dépasse `timeoutMs`. */
async function markStaleOffline(timeoutMs) {
  const cutoff = Date.now() - timeoutMs;
  const stale = await db.all(
    "SELECT server_key FROM servers WHERE kind = 'agent' AND status = 'ONLINE' AND (last_seen_at IS NULL OR last_seen_at < ?)",
    [cutoff],
  );
  for (const row of stale) {
    await touchStatus(row.server_key, { status: "OFFLINE" });
  }
  return stale.map((r) => r.server_key);
}

module.exports = {
  ENVIRONMENTS,
  STATUSES,
  list,
  getByKey,
  getById,
  create,
  ensureLocalServer,
  update,
  setEnabled,
  remove,
  regenerateToken,
  verifyAgentToken,
  touchStatus,
  markStaleOffline,
};
