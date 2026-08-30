"use strict";

/**
 * lib/routes/logs.js — extrait de server.js. Monté sur /api/processes
 * (sous-routes /:id/logs/*).
 *
 * `logStore` est une instance créée une fois dans server.js (chemin sur
 * disque fixé au démarrage) : injectée ici plutôt que ré-instanciée, et
 * partagée avec le bus PM2 temps réel (voir lib/realtime/pm2-bus.js) qui
 * alimente les mêmes fichiers.
 */

const express = require("express");
const fs = require("fs");
const pm2 = require("pm2");
const { withAppPermission } = require("../process-helpers");

// Mêmes garde-fous que lib/routes/log-explorer.js#clampInt : un paramètre non
// numérique (`?limit=abc`) ne doit jamais se traduire par un NaN silencieux —
// dans LogStore#search, `results.length < NaN` est toujours faux, ce qui
// viderait `results` tout en laissant `total`/`truncated` cohérents avec un
// vrai match (réponse trompeuse). On retombe donc explicitement sur la
// valeur par défaut dès que l'entrée n'est pas un nombre fini.
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Comme clampInt, mais sans borne haute (utilisé pour `from`/`to`, en ms epoch). */
function numOrDefault(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Lit un fichier de log natif PM2 en entier, pour l'export brut. */
function readLogSafe(filePath, label) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return `===== ${label} (${filePath}) =====\n${content}`;
  } catch (e) {
    return `===== ${label} (${filePath}) =====\n(illisible : ${e.message})`;
  }
}

// Lit les dernières lignes d'un fichier log natif PM2 (sans tout charger en mémoire
// pour les gros fichiers), utilisé pour l'historique affiché à la sélection d'un process.
// C'est la même source que "pm2 logs" en CLI, donc indépendante du bus PM2 en temps réel.
function readTailLinesSafe(filePath, maxLines) {
  const MAX_BYTES = 300 * 1024; // largement suffisant pour ~maxLines lignes usuelles
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - MAX_BYTES);
    const fd = fs.openSync(filePath, "r");
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    let text = buffer.toString("utf8");
    if (start > 0) {
      // la première ligne peut être coupée en plein milieu : on la jette
      const firstBreak = text.indexOf("\n");
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
    }
    return text.split("\n").filter(Boolean).slice(-maxLines);
  } catch (e) {
    return [];
  }
}

/**
 * @param {object} deps
 * @param {import("../log-store").LogStore} deps.logStore
 */
function createLogsRouter({ logStore }) {
  const router = express.Router();

  // Export des logs complets bruts : lit directement les fichiers gérés par PM2
  // (out + err), pas seulement ce qui a été capturé en direct côté navigateur.
  router.get("/processes/:id/logs/export", withAppPermission("logs"), (req, res) => {
    pm2.describe(req.params.id, (err, list) => {
      if (err || !list || !list.length) {
        return res.status(404).json({ error: "Process introuvable." });
      }
      const proc = list[0];
      const env = proc.pm2_env || {};
      const which = req.query.type === "out" || req.query.type === "err" ? req.query.type : "all";

      const parts = [];
      if ((which === "all" || which === "out") && env.pm_out_log_path) {
        parts.push(readLogSafe(env.pm_out_log_path, "STDOUT"));
      }
      if ((which === "all" || which === "err") && env.pm_err_log_path) {
        parts.push(readLogSafe(env.pm_err_log_path, "STDERR"));
      }

      const body = parts.filter(Boolean).join("\n\n");
      const filename = `${proc.name}-${which}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(body || "(fichier de log vide ou introuvable)");
    });
  });

  // Recherche full-text / regex / niveau / date sur nos logs persistés (avec timestamp par ligne)
  router.get("/processes/:id/logs/search", withAppPermission("logs"), (req, res) => {
    pm2.describe(req.params.id, (err, list) => {
      if (err || !list || !list.length) {
        return res.status(404).json({ error: "Process introuvable." });
      }
      const proc = list[0];
      const result = logStore.search(proc.pm_id, proc.name, {
        type: req.query.type || "all",
        level: req.query.level || "all",
        query: req.query.q || "",
        regex: req.query.regex === "1",
        from: numOrDefault(req.query.from, 0),
        to: numOrDefault(req.query.to, Infinity),
        limit: clampInt(req.query.limit, 1000, 1, 10000),
      });
      if (result.error) return res.status(400).json({ error: result.error });
      res.json(result);
    });
  });

  // Export d'une période précise (date de début / fin en ms epoch)
  router.get("/processes/:id/logs/export-range", withAppPermission("logs"), (req, res) => {
    pm2.describe(req.params.id, (err, list) => {
      if (err || !list || !list.length) {
        return res.status(404).json({ error: "Process introuvable." });
      }
      const proc = list[0];
      const from = numOrDefault(req.query.from, 0);
      const to = numOrDefault(req.query.to, Infinity);
      const type = req.query.type || "all";
      const body = logStore.exportRange(proc.pm_id, proc.name, { from, to, type });
      const filename = `${proc.name}-periode-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(body || "(aucune ligne dans cette période)");
    });
  });

  // Historique immédiat à afficher quand on sélectionne un process dans l'UI :
  // lit directement les fichiers de log natifs PM2 (out + err), exactement comme
  // le ferait `pm2 logs`, plutôt que d'attendre une nouvelle ligne en direct.
  router.get("/processes/:id/logs/tail", withAppPermission("logs"), (req, res) => {
    pm2.describe(req.params.id, (err, list) => {
      if (err || !list || !list.length) {
        return res.status(404).json({ error: "Process introuvable." });
      }
      const proc = list[0];
      const env = proc.pm2_env || {};
      const limit = clampInt(req.query.lines, 200, 1, 1000);

      // On borne chaque flux séparément (et pas leur concaténation) pour être sûr de
      // représenter à la fois stdout et stderr, même si l'un des deux est très bavard.
      const outLines = env.pm_out_log_path ? readTailLinesSafe(env.pm_out_log_path, limit) : [];
      const errLines = env.pm_err_log_path ? readTailLinesSafe(env.pm_err_log_path, limit) : [];

      // On ne connaît pas l'horodatage exact de chaque ligne native PM2 (pas de JSON structuré),
      // donc on les restitue dans leur ordre de fichier respectif, stdout puis stderr,
      // avec une étiquette "historique" côté frontend plutôt qu'une heure précise.
      const results = [
        ...outLines.map((text) => ({ type: "out", text })),
        ...errLines.map((text) => ({ type: "err", text })),
      ];

      res.json({ results, pmId: proc.pm_id });
    });
  });

  router.get("/processes/:id/logs/stats", withAppPermission("logs"), (req, res) => {
    pm2.describe(req.params.id, (err, list) => {
      if (err || !list || !list.length) {
        return res.status(404).json({ error: "Process introuvable." });
      }
      const proc = list[0];
      res.json(logStore.stats(proc.pm_id, proc.name));
    });
  });

  return router;
}

module.exports = createLogsRouter;
