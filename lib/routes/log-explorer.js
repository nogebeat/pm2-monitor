"use strict";

/**
 * lib/routes/log-explorer.js — Phase 12 (Advanced Log Explorer).
 *
 * Étend lib/log-store.js (recherche, regex, niveaux, plage temporelle,
 * export, tail, statistiques — déjà en place, voir lib/routes/logs.js, qui
 * reste inchangé) avec une recherche GLOBALE : plusieurs process, et
 * plusieurs serveurs à la fois (Phase 10 — Multi-server / Remote PM2).
 *
 * Découpage volontaire en un routeur SÉPARÉ de lib/routes/logs.js plutôt
 * qu'un ajout dedans : logs.js résout `:id` via pm2.describe() (une seule
 * instance de process, forcément locale) ; ce routeur résout un ENSEMBLE de
 * (serverKey, processName) fournis explicitement par le client, sans jamais
 * appeler pm2 — voir la note "Pourquoi pas de découverte serveur des
 * process ?" ci-dessous. Même style de découpage que lib/routes/servers.js
 * (routes `/:key/processes/:processName/...` séparées de processes.js).
 *
 * Pourquoi pas de découverte serveur des process ?
 * Les logs d'un process distant ne sont identifiables sur disque que par
 * leur NOM SLUGIFIÉ (voir lib/log-store.js#slug) — le nom d'origine exact
 * n'est stocké nulle part une fois le fichier écrit, donc reconstruire la
 * liste des process "connus" depuis le disque serait approximatif (deux
 * noms différents peuvent se slugifier identiquement). Le frontend connaît
 * déjà les noms exacts de TOUS les process visibles par l'utilisateur (local
 * via /api/processes, distant via l'état temps réel "server.snapshot" déjà
 * diffusé — voir frontend/src/store.js) : c'est cette liste, déjà exacte et
 * déjà filtrée par permission côté UI, qui est envoyée en paramètre `process`
 * ici. Ce routeur revalide chaque nom malgré tout côté serveur (jamais de
 * confiance aveugle dans ce que le client envoie) via permissions.hasPermission.
 */

const express = require("express");
const auth = require("../auth");
const permissions = require("../permissions");
const serversStore = require("../services/servers/store");
const { validateSearchQuery } = require("../log-store");

const MAX_PROCESSES = 15; // borne le nombre de process interrogés en un seul appel
const MAX_SERVERS = 15; // idem pour les serveurs (Phase 10)
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500; // page de résultats — jamais une requête non bornée (Phase 12, section Performance)
const MAX_OFFSET = 50000; // au-delà, on demande d'affiner les filtres plutôt que de paginer à l'infini
const MAX_EXPORT_MATCHES = 20000; // export : borne haute, streamée (voir note dans /export)

function parseCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** appName = "*" n'a pas de sens ici (un nom de process précis est toujours fourni) : jamais de joker. */
function canReadProcessLogs(user, processName) {
  if (!auth.AUTH_ENABLED) return true;
  return permissions.hasPermission(user, processName, "logs");
}

function canReadServer(user, serverKey) {
  if (!auth.AUTH_ENABLED) return true;
  return permissions.hasServerAccess(user, serverKey);
}

/**
 * Résout et autorise les sélecteurs (serverKey, processName) d'une requête :
 * - `process` (requis, CSV) : noms exacts fournis par le client (voir note
 *   de fichier ci-dessus) — filtrés par permission "logs" par app.
 * - `server` (optionnel, CSV) : sous-ensemble de serveurs enregistrés
 *   (lib/services/servers/store.js, Phase 10) ; par défaut, tous les
 *   serveurs connus. Filtré par hasServerAccess (scope, orthogonal à
 *   hasPermission — voir lib/permissions.js).
 * Un process doit passer LES DEUX vérifications sur CHAQUE serveur pour être
 * inclus (même règle que lib/routes/servers.js#action et #metrics).
 */
async function resolveSelectors(req, res) {
  const processNames = parseCsv(req.query.process);
  if (!processNames.length) {
    res
      .status(400)
      .json({ error: "Au moins un process (paramètre 'process', séparés par des virgules) est requis." });
    return null;
  }
  if (processNames.length > MAX_PROCESSES) {
    res.status(400).json({ error: `Trop de process sélectionnés (max ${MAX_PROCESSES}).` });
    return null;
  }

  const allServers = await serversStore.list();
  const knownServerKeys = new Set(allServers.map((s) => s.serverKey));
  const requestedServers = parseCsv(req.query.server);
  let serverKeys;
  if (requestedServers.length) {
    if (requestedServers.length > MAX_SERVERS) {
      res.status(400).json({ error: `Trop de serveurs sélectionnés (max ${MAX_SERVERS}).` });
      return null;
    }
    serverKeys = requestedServers.filter((k) => knownServerKeys.has(k));
  } else {
    serverKeys = allServers.map((s) => s.serverKey);
  }

  const allowedProcesses = processNames.filter((n) => canReadProcessLogs(req.user, n));
  const allowedServers = serverKeys.filter((k) => canReadServer(req.user, k));

  const selectors = [];
  for (const serverKey of allowedServers) {
    for (const name of allowedProcesses) {
      selectors.push({ serverKey, name });
    }
  }
  return selectors;
}

function searchParamsFromQuery(req) {
  return {
    type: ["all", "out", "err"].includes(req.query.type) ? req.query.type : "all",
    level: ["all", "info", "warn", "error", "debug"].includes(req.query.level) ? req.query.level : "all",
    query: req.query.q || "",
    regex: req.query.regex === "1",
    from: req.query.from ? Number(req.query.from) : 0,
    to: req.query.to ? Number(req.query.to) : Infinity,
  };
}

/**
 * @param {object} deps
 * @param {import("../log-store").LogStore} deps.logStore
 */
function createLogExplorerRouter({ logStore }) {
  const router = express.Router();

  // Recherche globale paginée, avec contexte optionnel autour de chaque
  // ligne trouvée (`context`, jusqu'à MAX_CONTEXT_LINES lignes avant/après —
  // voir lib/log-store.js). Aucune permission "globale" à vérifier ici :
  // chaque process/serveur demandé est revalidé individuellement
  // (resolveSelectors) ; un utilisateur sans aucun accès reçoit une réponse
  // 200 avec un résultat vide, exactement comme lib/process-helpers.js#visibleProcesses
  // ailleurs dans l'app (silencieux, pas un 403 sur un endpoint agrégé).
  router.get("/search", async (req, res) => {
    try {
      const selectors = await resolveSelectors(req, res);
      if (!selectors) return; // resolveSelectors a déjà répondu (400)

      const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
      const offset = clampInt(req.query.offset, 0, 0, MAX_OFFSET);
      const context = clampInt(req.query.context, 0, 0, 20);
      const sort = req.query.sort === "asc" ? "asc" : "desc";

      if (!selectors.length) {
        return res.json({ results: [], total: 0, truncated: false, scanned: 0, limit, offset });
      }

      const result = logStore.searchMulti(selectors, {
        ...searchParamsFromQuery(req),
        limit,
        offset,
        context,
        sort,
      });
      if (result.error) return res.status(400).json({ error: result.error });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Export texte des résultats correspondant aux mêmes filtres que /search,
  // sans pagination (jusqu'à MAX_EXPORT_MATCHES lignes). Streamé ligne par
  // ligne vers la réponse HTTP (`onMatch`) plutôt qu'accumulé puis envoyé
  // d'un bloc : évite de matérialiser l'ensemble du résultat en mémoire
  // (Phase 12, section Performance) — contrairement à
  // lib/log-store.js#exportRange (un seul process, volume déjà borné par la
  // rotation), un export multi-process/multi-serveur peut agréger beaucoup
  // plus de données.
  router.get("/export", async (req, res) => {
    try {
      const selectors = await resolveSelectors(req, res);
      if (!selectors) return;

      const params = searchParamsFromQuery(req);
      // Valide la regex AVANT d'envoyer les en-têtes HTTP (impossible de
      // répondre 400 proprement une fois le flux de réponse commencé).
      const { error } = validateSearchQuery(params.query, params.regex);
      if (error) return res.status(400).json({ error });

      const filename = `logs-explorer-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

      if (!selectors.length) {
        res.write("(aucun résultat : aucun process/serveur accessible ou sélectionné)\n");
        return res.end();
      }

      let wrote = false;
      const result = logStore.searchMulti(selectors, {
        ...params,
        sort: "asc", // export : ordre chronologique croissant, plus naturel à relire qu'un flux "direct"
        maxMatches: MAX_EXPORT_MATCHES,
        onMatch: (row) => {
          wrote = true;
          const time = new Date(row.t).toISOString();
          res.write(
            `${time} [${row.source.serverKey}/${row.source.name}] [${row.type}/${row.level}] ${row.text}\n`,
          );
        },
      });
      if (result.truncated) {
        res.write(
          `\n(export tronqué : plus de ${MAX_EXPORT_MATCHES} lignes correspondantes, affinez les filtres)\n`,
        );
      }
      if (!wrote) res.write("(aucune ligne ne correspond à ces filtres)\n");
      res.end();
    } catch (e) {
      // Si les en-têtes sont déjà partis, on ne peut plus renvoyer de JSON d'erreur proprement.
      if (res.headersSent) return res.end(`\n(erreur : ${e.message})\n`);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createLogExplorerRouter;
