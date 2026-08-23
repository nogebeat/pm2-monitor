"use strict";

/**
 * CRUD + associations pour l'organisation logique des process (Phase 13 —
 * Tags, Environments & Process Groups). Même style que
 * lib/services/servers/store.js / lib/services/health-checks/store.js :
 * requêtes SQL directes via lib/db, conversion row (snake_case) <-> objet JS
 * (camelCase).
 *
 * Un process est identifié par (serverKey, processName) — voir
 * lib/db/migrations/015_process_organization.js pour le raisonnement.
 * `serverKey` par défaut à `"local"` partout ici : les appelants qui ne
 * connaissent pas encore le multi-serveur (ex: lib/routes/processes.js,
 * mono-hôte) peuvent ignorer ce paramètre sans rien casser.
 *
 * Ce module ne modifie JAMAIS la configuration PM2 elle-même (pas d'appel
 * pm2.*) : les tags/environnements/groupes sont un système de méta-données
 * propre à PM2 Monitor, entièrement indépendant de ce que pm2 connaît d'un
 * process (voir prompt de phase : "ne doivent pas modifier arbitrairement la
 * configuration PM2").
 */

const db = require("../../db");

const DEFAULT_SERVER_KEY = "local";

// Environnements créés automatiquement au premier démarrage (ensureDefaults,
// appelé depuis server.js comme serversStore.ensureLocalServer) — l'utilisateur
// reste libre de les renommer/supprimer/compléter ensuite (CRUD complet,
// contrairement à servers.environment qui reste une valeur figée, Phase 10).
const DEFAULT_ENVIRONMENTS = ["production", "staging", "development"];

function normServerKey(serverKey) {
  const key = String(serverKey || "").trim();
  return key || DEFAULT_SERVER_KEY;
}

function normName(name, label) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error(`${label} requis.`);
  return clean;
}

function rowToTag(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    color: row.color || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToEnvironment(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    color: row.color || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToGroup(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// --- Catalogue : tags ------------------------------------------------------

async function listTags() {
  const rows = await db.all("SELECT * FROM tags ORDER BY name ASC", []);
  return rows.map(rowToTag);
}

async function getTagById(id) {
  const row = await db.get("SELECT * FROM tags WHERE id = ?", [id]);
  return rowToTag(row);
}

async function createTag({ name, color }) {
  const clean = normName(name, "Nom du tag");
  const now = Date.now();
  try {
    const result = await db.run(
      "INSERT INTO tags (name, color, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [clean, color || null, now, now],
    );
    return getTagById(result.lastID);
  } catch (e) {
    if (/UNIQUE|Duplicate entry/i.test(e.message || "")) {
      throw new Error(`Un tag nommé "${clean}" existe déjà.`);
    }
    throw e;
  }
}

async function updateTag(id, { name, color }) {
  const existing = await getTagById(id);
  if (!existing) return null;
  const fields = [];
  const params = [];
  if (name !== undefined) {
    fields.push("name = ?");
    params.push(normName(name, "Nom du tag"));
  }
  if (color !== undefined) {
    fields.push("color = ?");
    params.push(color || null);
  }
  if (!fields.length) return existing;
  fields.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);
  try {
    await db.run(`UPDATE tags SET ${fields.join(", ")} WHERE id = ?`, params);
  } catch (e) {
    if (/UNIQUE|Duplicate entry/i.test(e.message || "")) {
      throw new Error(`Un tag nommé "${name}" existe déjà.`);
    }
    throw e;
  }
  return getTagById(id);
}

async function removeTag(id) {
  const result = await db.run("DELETE FROM tags WHERE id = ?", [id]);
  return result.changes > 0;
}

// --- Catalogue : environnements --------------------------------------------

async function listEnvironments() {
  const rows = await db.all("SELECT * FROM environments ORDER BY name ASC", []);
  return rows.map(rowToEnvironment);
}

async function getEnvironmentById(id) {
  const row = await db.get("SELECT * FROM environments WHERE id = ?", [id]);
  return rowToEnvironment(row);
}

async function createEnvironment({ name, color }) {
  const clean = normName(name, "Nom de l'environnement");
  const now = Date.now();
  try {
    const result = await db.run(
      "INSERT INTO environments (name, color, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [clean, color || null, now, now],
    );
    return getEnvironmentById(result.lastID);
  } catch (e) {
    if (/UNIQUE|Duplicate entry/i.test(e.message || "")) {
      throw new Error(`Un environnement nommé "${clean}" existe déjà.`);
    }
    throw e;
  }
}

async function updateEnvironment(id, { name, color }) {
  const existing = await getEnvironmentById(id);
  if (!existing) return null;
  const fields = [];
  const params = [];
  if (name !== undefined) {
    fields.push("name = ?");
    params.push(normName(name, "Nom de l'environnement"));
  }
  if (color !== undefined) {
    fields.push("color = ?");
    params.push(color || null);
  }
  if (!fields.length) return existing;
  fields.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);
  try {
    await db.run(`UPDATE environments SET ${fields.join(", ")} WHERE id = ?`, params);
  } catch (e) {
    if (/UNIQUE|Duplicate entry/i.test(e.message || "")) {
      throw new Error(`Un environnement nommé "${name}" existe déjà.`);
    }
    throw e;
  }
  return getEnvironmentById(id);
}

async function removeEnvironment(id) {
  const result = await db.run("DELETE FROM environments WHERE id = ?", [id]);
  return result.changes > 0;
}

/** Idempotent : crée les environnements par défaut absents (voir DEFAULT_ENVIRONMENTS). */
async function ensureDefaults() {
  const existing = await listEnvironments();
  const existingNames = new Set(existing.map((e) => e.name));
  for (const name of DEFAULT_ENVIRONMENTS) {
    if (!existingNames.has(name)) {
      await createEnvironment({ name });
    }
  }
}

// --- Catalogue : groupes ----------------------------------------------------

async function listGroups() {
  const rows = await db.all("SELECT * FROM process_groups ORDER BY name ASC", []);
  return rows.map(rowToGroup);
}

async function getGroupById(id) {
  const row = await db.get("SELECT * FROM process_groups WHERE id = ?", [id]);
  return rowToGroup(row);
}

async function createGroup({ name, description }) {
  const clean = normName(name, "Nom du groupe");
  const now = Date.now();
  try {
    const result = await db.run(
      "INSERT INTO process_groups (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [clean, description || null, now, now],
    );
    return getGroupById(result.lastID);
  } catch (e) {
    if (/UNIQUE|Duplicate entry/i.test(e.message || "")) {
      throw new Error(`Un groupe nommé "${clean}" existe déjà.`);
    }
    throw e;
  }
}

async function updateGroup(id, { name, description }) {
  const existing = await getGroupById(id);
  if (!existing) return null;
  const fields = [];
  const params = [];
  if (name !== undefined) {
    fields.push("name = ?");
    params.push(normName(name, "Nom du groupe"));
  }
  if (description !== undefined) {
    fields.push("description = ?");
    params.push(description || null);
  }
  if (!fields.length) return existing;
  fields.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);
  try {
    await db.run(`UPDATE process_groups SET ${fields.join(", ")} WHERE id = ?`, params);
  } catch (e) {
    if (/UNIQUE|Duplicate entry/i.test(e.message || "")) {
      throw new Error(`Un groupe nommé "${name}" existe déjà.`);
    }
    throw e;
  }
  return getGroupById(id);
}

async function removeGroup(id) {
  const result = await db.run("DELETE FROM process_groups WHERE id = ?", [id]);
  return result.changes > 0;
}

// --- Associations : lecture --------------------------------------------------

/** Tags assignés à un process précis -> [{id, name, color}]. */
async function getTagsForProcess(processName, serverKey = DEFAULT_SERVER_KEY) {
  const rows = await db.all(
    `SELECT t.* FROM tags t
     INNER JOIN process_tags pt ON pt.tag_id = t.id
     WHERE pt.server_key = ? AND pt.process_name = ?
     ORDER BY t.name ASC`,
    [normServerKey(serverKey), processName],
  );
  return rows.map(rowToTag);
}

/** Environnement assigné à un process précis (un seul, ou null). */
async function getEnvironmentForProcess(processName, serverKey = DEFAULT_SERVER_KEY) {
  const row = await db.get(
    `SELECT e.* FROM environments e
     INNER JOIN process_environment pe ON pe.environment_id = e.id
     WHERE pe.server_key = ? AND pe.process_name = ?`,
    [normServerKey(serverKey), processName],
  );
  return rowToEnvironment(row);
}

/** Groupes auxquels appartient un process précis -> [{id, name, description}]. */
async function getGroupsForProcess(processName, serverKey = DEFAULT_SERVER_KEY) {
  const rows = await db.all(
    `SELECT g.* FROM process_groups g
     INNER JOIN process_group_members pgm ON pgm.group_id = g.id
     WHERE pgm.server_key = ? AND pgm.process_name = ?
     ORDER BY g.name ASC`,
    [normServerKey(serverKey), processName],
  );
  return rows.map(rowToGroup);
}

/**
 * Organisation complète d'un process (tags + environnement + groupes) en un
 * seul objet — utilisé par le Routing Engine (notifications) pour évaluer
 * les conditions `tag`/`environment`/`group` d'une règle (voir
 * lib/services/notifications/routing/engine.js#_resolveProcessOrg).
 *
 * Limitation héritée du moteur d'alertes (mono-hôte, voir commentaire de
 * routing/engine.js) : une occurrence d'alerte ne porte pas de `serverKey`,
 * seulement un nom de process. Par prudence on résout donc l'organisation
 * sur `serverKey` fourni (par défaut "local") plutôt que d'agréger tous les
 * serveurs — comportement correct pour une installation mono-hôte (le cas
 * normal) et documenté comme limitation multi-serveur, au même titre que le
 * filtre `server` déjà présent dans routeMatches().
 */
async function getOrganizationForProcess(processName, serverKey = DEFAULT_SERVER_KEY) {
  const [tags, environment, groups] = await Promise.all([
    getTagsForProcess(processName, serverKey),
    getEnvironmentForProcess(processName, serverKey),
    getGroupsForProcess(processName, serverKey),
  ]);
  return {
    tags: tags.map((t) => t.name),
    environment: environment ? environment.name : null,
    groups: groups.map((g) => g.name),
  };
}

/**
 * Organisation de TOUS les process connus (au moins une association), groupée
 * par (serverKey, processName) — utilisée par l'UI pour construire les
 * filtres/la vue groupe en un seul aller-retour plutôt qu'un appel par
 * process (voir lib/routes/process-organization.js#GET /assignments).
 */
async function listAssignments() {
  const [tagRows, envRows, groupRows] = await Promise.all([
    db.all(
      `SELECT pt.server_key, pt.process_name, t.id AS tag_id, t.name AS tag_name, t.color AS tag_color
       FROM process_tags pt INNER JOIN tags t ON t.id = pt.tag_id`,
      [],
    ),
    db.all(
      `SELECT pe.server_key, pe.process_name, e.id AS env_id, e.name AS env_name, e.color AS env_color
       FROM process_environment pe INNER JOIN environments e ON e.id = pe.environment_id`,
      [],
    ),
    db.all(
      `SELECT pgm.server_key, pgm.process_name, g.id AS group_id, g.name AS group_name
       FROM process_group_members pgm INNER JOIN process_groups g ON g.id = pgm.group_id`,
      [],
    ),
  ]);

  const key = (serverKey, processName) => `${serverKey}\u0000${processName}`;
  const byProcess = new Map();
  const ensure = (serverKey, processName) => {
    const k = key(serverKey, processName);
    if (!byProcess.has(k)) {
      byProcess.set(k, { serverKey, processName, tags: [], environment: null, groups: [] });
    }
    return byProcess.get(k);
  };

  for (const r of tagRows) {
    ensure(r.server_key, r.process_name).tags.push({ id: r.tag_id, name: r.tag_name, color: r.tag_color });
  }
  for (const r of envRows) {
    ensure(r.server_key, r.process_name).environment = { id: r.env_id, name: r.env_name, color: r.env_color };
  }
  for (const r of groupRows) {
    ensure(r.server_key, r.process_name).groups.push({ id: r.group_id, name: r.group_name });
  }

  return Array.from(byProcess.values());
}

// --- Associations : écriture -------------------------------------------------

/**
 * Remplace l'ensemble des tags d'un process par `tagIds` (upsert complet,
 * plus simple à consommer côté UI — une case à cocher par tag — qu'un
 * add/remove unitaire). `tagIds = []` retire tous les tags du process.
 */
async function setProcessTags(processName, tagIds, serverKey = DEFAULT_SERVER_KEY) {
  const key = normServerKey(serverKey);
  const name = normName(processName, "Nom du process");
  const ids = Array.isArray(tagIds) ? [...new Set(tagIds.map(Number).filter(Number.isFinite))] : [];

  await db.run("DELETE FROM process_tags WHERE server_key = ? AND process_name = ?", [key, name]);
  const now = Date.now();
  for (const tagId of ids) {
    await db.run(
      "INSERT INTO process_tags (server_key, process_name, tag_id, created_at) VALUES (?, ?, ?, ?)",
      [key, name, tagId, now],
    );
  }
  return getTagsForProcess(name, key);
}

/** Assigne (ou retire, avec `environmentId = null`) l'environnement d'un process. */
async function setProcessEnvironment(processName, environmentId, serverKey = DEFAULT_SERVER_KEY) {
  const key = normServerKey(serverKey);
  const name = normName(processName, "Nom du process");
  await db.run("DELETE FROM process_environment WHERE server_key = ? AND process_name = ?", [key, name]);
  if (environmentId !== null && environmentId !== undefined) {
    const now = Date.now();
    await db.run(
      "INSERT INTO process_environment (server_key, process_name, environment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [key, name, Number(environmentId), now, now],
    );
  }
  return getEnvironmentForProcess(name, key);
}

/** Remplace l'ensemble des groupes d'un process par `groupIds` (même logique que setProcessTags). */
async function setProcessGroups(processName, groupIds, serverKey = DEFAULT_SERVER_KEY) {
  const key = normServerKey(serverKey);
  const name = normName(processName, "Nom du process");
  const ids = Array.isArray(groupIds) ? [...new Set(groupIds.map(Number).filter(Number.isFinite))] : [];

  await db.run("DELETE FROM process_group_members WHERE server_key = ? AND process_name = ?", [key, name]);
  const now = Date.now();
  for (const groupId of ids) {
    await db.run(
      "INSERT INTO process_group_members (server_key, process_name, group_id, created_at) VALUES (?, ?, ?, ?)",
      [key, name, groupId, now],
    );
  }
  return getGroupsForProcess(name, key);
}

/** Applique en un seul appel tags + environnement + groupes pour un process (formulaire d'assignation UI). */
async function assignProcess({ processName, serverKey = DEFAULT_SERVER_KEY, tagIds, environmentId, groups }) {
  const name = normName(processName, "Nom du process");
  const key = normServerKey(serverKey);
  if (tagIds !== undefined) await setProcessTags(name, tagIds, key);
  if (environmentId !== undefined) await setProcessEnvironment(name, environmentId, key);
  if (groups !== undefined) await setProcessGroups(name, groups, key);
  return getOrganizationForProcess(name, key);
}

/** Retire toute association (tags/environnement/groupes) d'un process — ex: nettoyage manuel. */
async function clearProcess(processName, serverKey = DEFAULT_SERVER_KEY) {
  const key = normServerKey(serverKey);
  const name = normName(processName, "Nom du process");
  await db.run("DELETE FROM process_tags WHERE server_key = ? AND process_name = ?", [key, name]);
  await db.run("DELETE FROM process_environment WHERE server_key = ? AND process_name = ?", [key, name]);
  await db.run("DELETE FROM process_group_members WHERE server_key = ? AND process_name = ?", [key, name]);
}

module.exports = {
  DEFAULT_SERVER_KEY,
  DEFAULT_ENVIRONMENTS,
  // Tags
  listTags,
  getTagById,
  createTag,
  updateTag,
  removeTag,
  // Environnements
  listEnvironments,
  getEnvironmentById,
  createEnvironment,
  updateEnvironment,
  removeEnvironment,
  ensureDefaults,
  // Groupes
  listGroups,
  getGroupById,
  createGroup,
  updateGroup,
  removeGroup,
  // Associations
  getTagsForProcess,
  getEnvironmentForProcess,
  getGroupsForProcess,
  getOrganizationForProcess,
  listAssignments,
  setProcessTags,
  setProcessEnvironment,
  setProcessGroups,
  assignProcess,
  clearProcess,
};
