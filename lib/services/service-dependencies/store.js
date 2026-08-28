"use strict";

/**
 * CRUD + validation pour les dépendances de service (table
 * `service_dependencies`). Même style que lib/services/anomaly-detection/
 * rules-store.js : requêtes SQL directes via lib/db, pas d'ORM, conversion
 * row (snake_case) <-> objet JS (camelCase).
 *
 * La détection de cycle (graph.js#detectCycle) est appliquée ICI, dans
 * create()/update(), pas dans les routes : c'est une règle métier du store,
 * comme la contrainte UNIQUE (source, target, type) gérée par la même
 * fonction.
 */

const db = require("../../db");
const { detectCycle } = require("./graph");

const TYPES = ["HTTP", "TCP", "DATABASE", "REDIS", "CUSTOM", "PROCESS"];

function rowToDependency(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    type: row.type,
    enabled: !!row.enabled,
    description: row.description || "",
    healthCheckId:
      row.health_check_id === null || row.health_check_id === undefined ? null : Number(row.health_check_id),
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Valide les champs d'une dépendance. `partial=true` (update) : seuls les champs fournis sont validés. */
function validate(input, { partial = false } = {}) {
  const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;

  if (!partial || has("source")) {
    if (!input.source || !String(input.source).trim()) errors.push("source requis.");
  }
  if (!partial || has("target")) {
    if (!input.target || !String(input.target).trim()) errors.push("target requis.");
  }
  if (has("source") && has("target") && String(input.source).trim() === String(input.target).trim()) {
    errors.push("source et target doivent être différents (une dépendance sur soi-même n'a pas de sens).");
  }
  if (!partial || has("type")) {
    if (!TYPES.includes(input.type)) {
      errors.push(`type invalide (attendu : ${TYPES.join(", ")}).`);
    }
  }
  if (has("healthCheckId") && input.healthCheckId !== null) {
    if (!Number.isInteger(Number(input.healthCheckId))) {
      errors.push("healthCheckId doit être un entier ou null.");
    }
  }
  if (has("metadata") && input.metadata !== null && typeof input.metadata !== "object") {
    errors.push("metadata doit être un objet (ou null).");
  }

  if (errors.length) throw new Error(errors.join(" "));
}

async function getById(id) {
  const row = await db.get("SELECT * FROM service_dependencies WHERE id = ?", [id]);
  return rowToDependency(row);
}

async function list({ enabledOnly = false, source, target, type } = {}) {
  const clauses = [];
  const params = [];
  if (enabledOnly) clauses.push("enabled = 1");
  if (source) {
    clauses.push("source = ?");
    params.push(source);
  }
  if (target) {
    clauses.push("target = ?");
    params.push(target);
  }
  if (type) {
    clauses.push("type = ?");
    params.push(type);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await db.all(
    `SELECT * FROM service_dependencies ${where} ORDER BY source ASC, target ASC`,
    params,
  );
  return rows.map(rowToDependency);
}

/** Toutes les dépendances liées à un health check donné (utilisé pour l'impact au changement de statut). */
async function listByHealthCheckId(healthCheckId) {
  const rows = await db.all("SELECT * FROM service_dependencies WHERE health_check_id = ? AND enabled = 1", [
    healthCheckId,
  ]);
  return rows.map(rowToDependency);
}

/** Détecte un doublon (source, target, type), à l'exclusion optionnelle d'un id (cas update). */
async function findDuplicate({ source, target, type }, excludeId) {
  const row = await db.get(
    `SELECT * FROM service_dependencies WHERE source = ? AND target = ? AND type = ? ${
      excludeId ? "AND id != ?" : ""
    }`,
    excludeId ? [source, target, type, excludeId] : [source, target, type],
  );
  return rowToDependency(row);
}

/** Lève une erreur si la dépendance proposée (avec l'ensemble déjà existant) introduit un cycle. */
async function assertNoCycle(candidate, excludeId) {
  const existing = await list({});
  const edges = existing
    .filter((d) => !excludeId || d.id !== excludeId)
    .map((d) => ({ source: d.source, target: d.target }));
  const cyclePath = detectCycle(edges, { source: candidate.source, target: candidate.target });
  if (cyclePath) {
    throw new Error(`Cette dépendance créerait un cycle : ${cyclePath.join(" → ")}.`);
  }
}

async function create(input, { userId } = {}) {
  validate(input, { partial: false });
  const source = String(input.source).trim();
  const target = String(input.target).trim();

  const duplicate = await findDuplicate({ source, target, type: input.type });
  if (duplicate) {
    throw new Error(`Cette dépendance existe déjà (${source} → ${target}, type ${input.type}).`);
  }
  await assertNoCycle({ source, target });

  const now = Date.now();
  const result = await db.run(
    `INSERT INTO service_dependencies
      (source, target, type, enabled, description, health_check_id, metadata, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      source,
      target,
      input.type,
      input.enabled === undefined ? 1 : input.enabled ? 1 : 0,
      input.description ? String(input.description) : null,
      input.healthCheckId === undefined || input.healthCheckId === null ? null : Number(input.healthCheckId),
      input.metadata ? JSON.stringify(input.metadata) : null,
      userId || null,
      now,
      now,
    ],
  );
  return getById(result.lastID);
}

async function update(id, changes) {
  const existing = await getById(id);
  if (!existing) return null;

  validate(changes, { partial: true });
  const merged = { ...existing, ...changes };
  const source = String(merged.source).trim();
  const target = String(merged.target).trim();

  const duplicate = await findDuplicate({ source, target, type: merged.type }, id);
  if (duplicate) {
    throw new Error(`Cette dépendance existe déjà (${source} → ${target}, type ${merged.type}).`);
  }
  await assertNoCycle({ source, target }, id);

  const now = Date.now();
  await db.run(
    `UPDATE service_dependencies SET
      source = ?, target = ?, type = ?, enabled = ?, description = ?, health_check_id = ?, metadata = ?,
      updated_at = ?
     WHERE id = ?`,
    [
      source,
      target,
      merged.type,
      merged.enabled ? 1 : 0,
      merged.description ? String(merged.description) : null,
      merged.healthCheckId === undefined || merged.healthCheckId === null
        ? null
        : Number(merged.healthCheckId),
      merged.metadata ? JSON.stringify(merged.metadata) : null,
      now,
      id,
    ],
  );
  return getById(id);
}

async function setEnabled(id, enabled) {
  const existing = await getById(id);
  if (!existing) return null;
  await db.run("UPDATE service_dependencies SET enabled = ?, updated_at = ? WHERE id = ?", [
    enabled ? 1 : 0,
    Date.now(),
    id,
  ]);
  return getById(id);
}

async function remove(id) {
  const result = await db.run("DELETE FROM service_dependencies WHERE id = ?", [id]);
  return result.changes > 0;
}

/** Noms de service distincts apparaissant comme source ou target (nœuds du graphe). */
async function listNodeNames() {
  const rows = await db.all(
    "SELECT source AS name FROM service_dependencies UNION SELECT target AS name FROM service_dependencies",
    [],
  );
  return rows.map((r) => r.name).sort();
}

module.exports = {
  TYPES,
  validate,
  create,
  getById,
  list,
  listByHealthCheckId,
  listNodeNames,
  findDuplicate,
  update,
  setEnabled,
  remove,
};
