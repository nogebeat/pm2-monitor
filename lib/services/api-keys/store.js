"use strict";

/**
 * lib/services/api-keys/store.js — Phase 18 (Advanced RBAC & API Keys).
 *
 * CRUD pour la table `api_keys` (migration 020_rbac_api_keys.js). Même style
 * que lib/services/servers/store.js : requêtes SQL directes via lib/db,
 * conversion row (snake_case) <-> objet JS (camelCase), génération d'un
 * secret en clair retourné une seule fois (à la création).
 *
 * Choix de hachage — SHA-256 (PAS bcrypt, contrairement à
 * servers.token_hash) : le secret d'une clé API est un token ALÉATOIRE à
 * haute entropie (crypto.randomBytes(24), 192 bits) généré par le serveur,
 * jamais choisi/mémorisé par un humain. Un hachage lent façon bcrypt protège
 * contre le bruteforce d'un mot de passe à faible entropie ; ici il n'apporte
 * rien (192 bits de hasard sont déjà impossibles à bruteforcer) et empêcherait
 * la recherche directe `WHERE key_hash = ?` nécessaire à chaque requête M2M
 * (bcrypt ne permet pas de retrouver une ligne par son hash, seulement de
 * vérifier un hash déjà connu). SHA-256 est comparé en temps constant
 * (crypto.timingSafeEqual) pour éviter une attaque par timing sur la
 * comparaison elle-même.
 */

const crypto = require("crypto");
const db = require("../../db");

const KEY_PREFIX = "pmk_";
const SECRET_BYTES = 24; // 192 bits — cf. commentaire de tête de fichier

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

/** Comparaison en temps constant de deux hex strings de même longueur attendue. */
function safeHexEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "hex");
  const bufB = Buffer.from(String(b || ""), "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function rowToApiKey(row) {
  if (!row) return null;
  let scopes = [];
  try {
    scopes = JSON.parse(row.scopes || "[]");
  } catch (e) {
    scopes = [];
  }
  let resourceScopes = null;
  if (row.resource_scopes) {
    try {
      resourceScopes = JSON.parse(row.resource_scopes);
    } catch (e) {
      resourceScopes = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes,
    resourceScopes,
    createdBy: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
    // Jamais le hash ni le secret — voir en-tête de fichier et docs/rbac-api-keys/README.md.
  };
}

/** Génère un secret en clair (retourné une seule fois) + son hash à stocker, et le préfixe d'affichage. */
function generateSecret() {
  const raw = `${KEY_PREFIX}${crypto.randomBytes(SECRET_BYTES).toString("hex")}`;
  return { raw, hash: sha256Hex(raw), prefix: raw.slice(0, 12) };
}

async function list() {
  const rows = await db.all("SELECT * FROM api_keys ORDER BY created_at DESC", []);
  return rows.map(rowToApiKey);
}

async function getById(id) {
  const row = await db.get("SELECT * FROM api_keys WHERE id = ?", [id]);
  return rowToApiKey(row);
}

/**
 * Crée une clé API. Retourne { apiKey, secret } — `secret` (la clé en clair)
 * n'est disponible qu'ici : ni list()/getById() ni aucune autre fonction de
 * ce module ne le renvoient jamais après coup.
 */
async function create({ name, scopes, resourceScopes, expiresAt, createdBy }) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("Nom de la clé API requis.");
  if (!Array.isArray(scopes) || !scopes.length) {
    throw new Error("Au moins un scope est requis.");
  }

  const { raw, hash, prefix } = generateSecret();
  const now = Date.now();

  const result = await db.run(
    `INSERT INTO api_keys
      (name, key_prefix, key_hash, scopes, resource_scopes, created_by, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [
      cleanName,
      prefix,
      hash,
      JSON.stringify(scopes),
      resourceScopes ? JSON.stringify(resourceScopes) : null,
      createdBy || null,
      now,
      expiresAt || null,
    ],
  );

  return { apiKey: await getById(result.lastID), secret: raw };
}

/** Modifie le nom/scopes/resourceScopes/expiresAt d'une clé existante — jamais le secret (immuable après création). */
async function update(id, { name, scopes, resourceScopes, expiresAt } = {}) {
  const existing = await getById(id);
  if (!existing) return null;

  const fields = [];
  const params = [];
  if (name !== undefined) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Nom de la clé API requis.");
    fields.push("name = ?");
    params.push(cleanName);
  }
  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || !scopes.length) {
      throw new Error("Au moins un scope est requis.");
    }
    fields.push("scopes = ?");
    params.push(JSON.stringify(scopes));
  }
  if (resourceScopes !== undefined) {
    fields.push("resource_scopes = ?");
    params.push(resourceScopes ? JSON.stringify(resourceScopes) : null);
  }
  if (expiresAt !== undefined) {
    fields.push("expires_at = ?");
    params.push(expiresAt || null);
  }
  if (!fields.length) return existing;

  params.push(id);
  await db.run(`UPDATE api_keys SET ${fields.join(", ")} WHERE id = ?`, params);
  return getById(id);
}

/** Révoque une clé (jamais de suppression : trace d'audit conservée, voir docs/rbac-api-keys/README.md). Idempotent. */
async function revoke(id) {
  const existing = await getById(id);
  if (!existing) return null;
  if (!existing.revokedAt) {
    await db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ?", [Date.now(), id]);
  }
  return getById(id);
}

/**
 * Vérifie une clé en clair fournie par un client M2M (header
 * `Authorization: Bearer <clé>`). Retourne l'objet clé (SANS hash) si valide,
 * non expirée et non révoquée, sinon null. Met à jour `last_used_at` en
 * arrière-plan (jamais bloquant, jamais fatal si l'update échoue).
 */
async function verify(rawKey) {
  if (!rawKey || typeof rawKey !== "string" || !rawKey.startsWith(KEY_PREFIX)) return null;
  const hash = sha256Hex(rawKey);
  const row = await db.get("SELECT * FROM api_keys WHERE key_hash = ?", [hash]);
  if (!row) return null;
  if (!safeHexEqual(hash, row.key_hash)) return null; // défense en profondeur si un jour l'index n'est plus l'égalité stricte
  if (row.revoked_at) return null;
  if (row.expires_at && Number(row.expires_at) < Date.now()) return null;

  db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [Date.now(), row.id]).catch(() => {});

  return rowToApiKey(row);
}

module.exports = {
  KEY_PREFIX,
  list,
  getById,
  create,
  update,
  revoke,
  verify,
};
