"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROTATE_SIZE_BYTES = (parseInt(process.env.LOG_ROTATE_SIZE_MB, 10) || 5) * 1024 * 1024;
const COMPRESS_SWEEP_MS = 60 * 60 * 1000; // sweep horaire pour compresser les archives oubliées

// --- Log Explorer (Phase 12) — limites de sécurité ------------------------
//
// Le stockage lui-même (un fichier JSONL par instance de process, tourné à
// ROTATE_SIZE_BYTES) borne déjà la taille d'UN fichier. Les limites
// ci-dessous bornent en plus le travail effectué par UNE requête de
// recherche/export qui peut désormais traverser PLUSIEURS process et/ou
// PLUSIEURS serveurs (Phase 10) en un seul appel — voir searchMulti().
const MAX_REGEX_LENGTH = 200; // pattern trop long = coût d'évaluation difficile à borner
const MAX_LINE_MATCH_LENGTH = 4000; // tronque la cible du test (pas le texte stocké/affiché)
const DEFAULT_MAX_SCAN_LINES = 300000; // lignes lues (toutes sources confondues) avant arrêt forcé
const DEFAULT_MAX_CANDIDATES = 5000; // résultats gardés en mémoire pour le tri chronologique final
const MAX_CONTEXT_LINES = 20;

function slug(name) {
  return String(name)
    .replace(/[^a-z0-9_-]/gi, "_")
    .slice(0, 60);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyLevel(text, streamType) {
  const t = String(text).toLowerCase();
  if (/\b(error|err!|exception|fatal|traceback|fail(?:ed|ure)?)\b/.test(t)) return "error";
  if (/\b(warn(?:ing)?|deprecat(?:ed|ion))\b/.test(t)) return "warn";
  if (/\bdebug\b/.test(t)) return "debug";
  return streamType === "err" ? "error" : "info";
}

/** Tronque la cible d'un test de correspondance (jamais le texte stocké/renvoyé) — voir MAX_LINE_MATCH_LENGTH. */
function truncateForMatch(text) {
  const s = String(text);
  return s.length > MAX_LINE_MATCH_LENGTH ? s.slice(0, MAX_LINE_MATCH_LENGTH) : s;
}

/**
 * Heuristique anti-ReDoS : refuse les regex "classiquement" catastrophiques —
 * un groupe déjà quantifié en interne (`+`, `*`, `{n,}`), lui-même suivi
 * d'un quantifier (`(a+)+`, `(a*)+`, `(\d+)*`…). Ce n'est pas une preuve
 * formelle de sécurité (pas de moteur regex à budget borné en Node sans
 * dépendance externe), donc combinée à MAX_REGEX_LENGTH et
 * MAX_LINE_MATCH_LENGTH (la complexité d'un backtracking catastrophique
 * croît avec la longueur de l'entrée testée, pas seulement celle du motif).
 */
function isCatastrophicPattern(pattern) {
  return /\([^()]*[+*][^()]*\)\s*[+*]/.test(pattern);
}

/**
 * Construit un matcher texte/regex sûr, partagé par search() et
 * searchMulti() (une seule implémentation des règles de sécurité).
 * @returns {{ matcher: {test(string): boolean}|null, error: string|null }}
 */
function buildMatcher(query, regexMode) {
  if (!query) return { matcher: null, error: null };
  if (regexMode) {
    if (query.length > MAX_REGEX_LENGTH) {
      return { matcher: null, error: `Regex trop longue (max ${MAX_REGEX_LENGTH} caractères).` };
    }
    if (isCatastrophicPattern(query)) {
      return {
        matcher: null,
        error: "Regex refusée : motif potentiellement catastrophique (groupes quantifiés imbriqués).",
      };
    }
    let re;
    try {
      re = new RegExp(query, "i");
    } catch (e) {
      return { matcher: null, error: `Regex invalide : ${e.message}` };
    }
    return { matcher: { test: (s) => re.test(truncateForMatch(s)) }, error: null };
  }
  const q = query.toLowerCase();
  return { matcher: { test: (s) => truncateForMatch(s).toLowerCase().includes(q) }, error: null };
}

/** Vérifie une requête de recherche sans exécuter la recherche — utilisé par les routes qui streament
 *  leur réponse (export) et doivent valider AVANT d'envoyer les en-têtes HTTP. */
function validateSearchQuery(query, regexMode) {
  const { error } = buildMatcher(query, regexMode);
  return { error };
}

class LogStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
    this._sweepTimer = setInterval(() => this.compressOldArchives(), COMPRESS_SWEEP_MS);
    this._sweepTimer.unref?.();
    // rattrapage au démarrage
    this.compressOldArchives();
  }

  // --- Résolution de chemins -------------------------------------------
  //
  // Le serveur local ("local", valeur par défaut — voir migration
  // 014_process_metrics_server_key.js pour le même choix de valeur par
  // défaut côté process_metrics) garde EXACTEMENT le nommage de fichier
  // historique (`proc-<pmId>-<nomSlug>.jsonl`) : zéro migration de fichiers
  // existants, zéro risque de perte des logs déjà écrits avant la Phase 12.
  // Un serveur distant (Phase 10) — dont les logs n'étaient jamais persistés
  // avant cette phase, seulement diffusés en direct (voir server.js#onLog) —
  // utilise un nommage distinct (`proc-remote-<serverKeySlug>-...`), en
  // espace de nommage séparé pour ne jamais pouvoir collisionner avec un
  // fichier local existant.

  _isLocal(serverKey) {
    return !serverKey || serverKey === "local";
  }

  _activePath(serverKey, pmId, name) {
    return this._isLocal(serverKey)
      ? path.join(this.baseDir, `proc-${pmId}-${slug(name)}.jsonl`)
      : path.join(this.baseDir, `proc-remote-${slug(serverKey)}-${pmId}-${slug(name)}.jsonl`);
  }

  _archivePrefix(serverKey, pmId, name) {
    return this._isLocal(serverKey)
      ? `proc-${pmId}-${slug(name)}-`
      : `proc-remote-${slug(serverKey)}-${pmId}-${slug(name)}-`;
  }

  /**
   * Découpe un paquet de logs PM2 (qui peut contenir plusieurs lignes) et les
   * persiste. `serverKey` est optionnel (défaut "local", rétrocompatible
   * avec tous les appels existants de lib/realtime/pm2-bus.js) — un serveur
   * distant (Phase 10) doit le passer explicitement (voir server.js#onLog).
   */
  appendPacket(pmId, name, type, rawData, ts, serverKey = "local") {
    const lines = String(rawData)
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
    if (!lines.length) return;
    const filePath = this._activePath(serverKey, pmId, name);
    const rows = lines.map(
      (text) => JSON.stringify({ t: ts, type, level: classifyLevel(text, type), text }) + "\n",
    );
    try {
      fs.appendFileSync(filePath, rows.join(""));
      this._rotateIfNeeded(serverKey, pmId, name);
    } catch (e) {
      console.warn("Écriture log échouée :", e.message);
    }
  }

  _rotateIfNeeded(serverKey, pmId, name) {
    const filePath = this._activePath(serverKey, pmId, name);
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch (e) {
      return;
    }
    if (size < ROTATE_SIZE_BYTES) return;

    const archiveName = `${this._archivePrefix(serverKey, pmId, name)}${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.jsonl`;
    const archivePath = path.join(this.baseDir, archiveName);
    try {
      fs.renameSync(filePath, archivePath);
      this._compressFile(archivePath);
    } catch (e) {
      console.warn("Rotation de log échouée :", e.message);
    }
  }

  _compressFile(plainPath) {
    try {
      const content = fs.readFileSync(plainPath);
      const gz = zlib.gzipSync(content);
      fs.writeFileSync(plainPath + ".gz", gz);
      fs.unlinkSync(plainPath);
    } catch (e) {
      console.warn("Compression de log échouée :", e.message);
    }
  }

  /** Compresse toute archive .jsonl non compressée qui traîne (redémarrage interrompu, etc). */
  compressOldArchives() {
    let files = [];
    try {
      files = fs.readdirSync(this.baseDir);
    } catch (e) {
      return;
    }
    files
      .filter((f) => f.endsWith(".jsonl") && this._looksLikeArchive(f))
      .forEach((f) => this._compressFile(path.join(this.baseDir, f)));
  }

  _looksLikeArchive(filename) {
    return /-\d{4}-\d{2}-\d{2}T/.test(filename);
  }

  /** Fichiers (actif + archives, y compris .gz) d'UNE instance précise (server, pm_id, name). */
  _filesFor(serverKey, pmId, name) {
    const activeBase = path.basename(this._activePath(serverKey, pmId, name));
    const prefix = this._archivePrefix(serverKey, pmId, name);
    let all = [];
    try {
      all = fs.readdirSync(this.baseDir);
    } catch (e) {
      return [];
    }
    return all
      .filter((f) => f === activeBase || f.startsWith(prefix))
      .sort() // les archives sont préfixées par une date ISO -> tri chronologique correct
      .map((f) => path.join(this.baseDir, f));
  }

  /**
   * Fichiers de TOUTES les instances (tous pm_id) d'un process nommé, sur un
   * serveur donné — nécessaire pour le Log Explorer (Phase 12, recherche
   * "par process" plutôt que par instance précise) : un process en mode
   * cluster a un pm_id distinct par instance, chacune avec son propre
   * fichier (voir appendPacket, alimenté par lib/realtime/pm2-bus.js avec
   * `packet.process.pm_id`).
   */
  _filesForNameAllInstances(serverKey, name) {
    let all = [];
    try {
      all = fs.readdirSync(this.baseDir);
    } catch (e) {
      return [];
    }
    const nameRe = escapeRegExp(slug(name));
    const re = this._isLocal(serverKey)
      ? new RegExp(`^proc-(\\d+)-${nameRe}(\\.jsonl|-.*\\.jsonl(\\.gz)?)$`)
      : new RegExp(
          `^proc-remote-${escapeRegExp(slug(serverKey))}-(\\d+)-${nameRe}(\\.jsonl|-.*\\.jsonl(\\.gz)?)$`,
        );
    return all
      .filter((f) => re.test(f))
      .sort()
      .map((f) => path.join(this.baseDir, f));
  }

  _readLines(filePath) {
    let content;
    try {
      if (filePath.endsWith(".gz")) {
        content = zlib.gunzipSync(fs.readFileSync(filePath)).toString("utf8");
      } else {
        content = fs.readFileSync(filePath, "utf8");
      }
    } catch (e) {
      return [];
    }
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  }

  /**
   * Recherche dans tous les fichiers (actif + archives, y compris .gz) d'UNE
   * instance de process précise (comportement historique, utilisé par
   * `/api/processes/:id/logs/search` — voir lib/routes/logs.js).
   * options: { type: 'all'|'out'|'err', level: 'all'|'info'|'warn'|'error'|'debug',
   *            query: string, regex: bool, from: ms, to: ms, limit: number, serverKey: string }
   */
  search(pmId, name, options = {}) {
    const {
      type = "all",
      level = "all",
      query = "",
      regex = false,
      from = 0,
      to = Infinity,
      limit = 1000,
      serverKey = "local",
    } = options;

    const { matcher, error } = buildMatcher(query, regex);
    if (error) return { error, results: [], truncated: false, total: 0 };

    const files = this._filesFor(serverKey, pmId, name);
    const results = [];
    let total = 0;
    let lineNo = 0;

    for (const f of files) {
      const rows = this._readLines(f);
      for (const row of rows) {
        lineNo++;
        if (row.t < from || row.t > to) continue;
        if (type !== "all" && row.type !== type) continue;
        if (level !== "all" && row.level !== level) continue;
        if (matcher && !matcher.test(row.text)) continue;
        total++;
        if (results.length < limit) {
          results.push({ ...row, line: lineNo });
        }
      }
    }

    return { results, total, truncated: total > results.length, error: null };
  }

  /** Export texte brut d'une période précise, prêt à télécharger (une seule instance de process). */
  exportRange(pmId, name, { from = 0, to = Infinity, type = "all", serverKey = "local" } = {}) {
    const files = this._filesFor(serverKey, pmId, name);
    const out = [];
    for (const f of files) {
      const rows = this._readLines(f);
      for (const row of rows) {
        if (row.t < from || row.t > to) continue;
        if (type !== "all" && row.type !== type) continue;
        const time = new Date(row.t).toISOString();
        out.push(`${time} [${row.type}/${row.level}] ${row.text}`);
      }
    }
    return out.join("\n");
  }

  stats(pmId, name, serverKey = "local") {
    const files = this._filesFor(serverKey, pmId, name);
    let totalBytes = 0;
    let archived = 0;
    files.forEach((f) => {
      try {
        totalBytes += fs.statSync(f).size;
      } catch (e) {
        /* ignore */
      }
      if (f.endsWith(".gz")) archived++;
    });
    return { files: files.length, archivedFiles: archived, totalBytes };
  }

  /**
   * Supprime tous les fichiers persistés (actif + archives) d'UNE instance de
   * process précise. Utilisé par `POST /processes/:id/flush` (voir
   * lib/routes/processes.js) EN PLUS de `pm2.flush()` — celui-ci ne vide que
   * les fichiers natifs PM2 (out/err), jamais ce store-ci : sans cet appel,
   * "Vider les logs" viderait `/logs/tail` mais laisserait tout réapparaître
   * dans `/logs/search`, `/logs/stats` et le Log Explorer.
   */
  clear(serverKey, pmId, name) {
    const files = this._filesFor(serverKey, pmId, name);
    let removed = 0;
    for (const f of files) {
      try {
        fs.unlinkSync(f);
        removed++;
      } catch (e) {
        console.warn("Suppression de log échouée :", e.message);
      }
    }
    return { removed };
  }

  /**
   * Supprime TOUS les fichiers persistés, tous process/serveurs confondus.
   * Pendant `POST /api/pm2/flush-all` (voir lib/routes/pm2-daemon.js), même
   * raisonnement que clear() ci-dessus mais à l'échelle du daemon entier.
   */
  clearAll() {
    let all = [];
    try {
      all = fs.readdirSync(this.baseDir);
    } catch (e) {
      return { removed: 0 };
    }
    let removed = 0;
    for (const f of all) {
      if (!f.startsWith("proc-") || !(f.endsWith(".jsonl") || f.endsWith(".jsonl.gz"))) continue;
      try {
        fs.unlinkSync(path.join(this.baseDir, f));
        removed++;
      } catch (e) {
        console.warn("Suppression de log échouée :", e.message);
      }
    }
    return { removed };
  }

  // --- Log Explorer (Phase 12) — recherche multi-process / multi-serveur ---

  /**
   * Recherche à travers PLUSIEURS process et/ou PLUSIEURS serveurs en un seul
   * passage. `selectors`: [{ serverKey, name }] — chaque sélecteur couvre
   * automatiquement toutes les instances (pm_id) de ce process (voir
   * _filesForNameAllInstances). La résolution des sélecteurs autorisés
   * (permissions "logs" par app + accès serveur) est la responsabilité de
   * l'appelant (lib/routes/log-explorer.js) : ce module ne connaît ni
   * l'authentification ni les permissions, comme le reste de lib/log-store.js.
   *
   * Deux modes :
   *  - par défaut : accumule les correspondances (bornées par
   *    `maxCandidates`), les trie chronologiquement, puis pagine
   *    (`limit`/`offset`) — utilisé par la recherche paginée de l'Explorer.
   *  - `onMatch(row)` fourni : mode streaming, chaque correspondance est
   *    remise immédiatement à l'appelant plutôt qu'accumulée (utilisé par
   *    l'export, pour ne jamais matérialiser l'ensemble du résultat en
   *    mémoire — voir lib/routes/log-explorer.js).
   *
   * Dans les deux cas, la lecture s'arrête dès que `maxScanLines` lignes ont
   * été examinées (toutes sources confondues) : borne de sécurité absolue,
   * indépendante de la sélectivité du filtre — répond à l'exigence
   * "aucune requête non bornée" (Phase 12).
   */
  searchMulti(selectors, options = {}) {
    const {
      type = "all",
      level = "all",
      query = "",
      regex = false,
      from = 0,
      to = Infinity,
      limit = 100,
      offset = 0,
      context = 0,
      sort = "desc", // "desc" (plus récent d'abord) | "asc"
      maxScanLines = DEFAULT_MAX_SCAN_LINES,
      maxCandidates = DEFAULT_MAX_CANDIDATES,
      maxMatches = Infinity, // borne (mode streaming) du nombre total de correspondances remises à onMatch
      onMatch = null,
    } = options;

    const { matcher, error } = buildMatcher(query, regex);
    if (error) return { error, results: [], total: 0, truncated: false, scanned: 0 };

    const ctx = Math.max(0, Math.min(MAX_CONTEXT_LINES, context));
    const candidates = [];
    let scanned = 0;
    let totalMatched = 0;
    let scanLimitReached = false;
    let matchLimitReached = false;

    outer: for (const sel of selectors) {
      const files = this._filesForNameAllInstances(sel.serverKey, sel.name);
      for (const f of files) {
        const rows = this._readLines(f);
        for (let i = 0; i < rows.length; i++) {
          scanned++;
          if (scanned > maxScanLines) {
            scanLimitReached = true;
            break outer;
          }
          const row = rows[i];
          if (row.t < from || row.t > to) continue;
          if (type !== "all" && row.type !== type) continue;
          if (level !== "all" && row.level !== level) continue;
          if (matcher && !matcher.test(row.text)) continue;

          totalMatched++;
          const entry = {
            ...row,
            line: i + 1, // numéro de ligne DANS ce fichier (une source peut être répartie sur plusieurs fichiers)
            source: { serverKey: sel.serverKey, name: sel.name },
          };
          if (ctx > 0) {
            entry.before = rows.slice(Math.max(0, i - ctx), i);
            entry.after = rows.slice(i + 1, i + 1 + ctx);
          }

          if (onMatch) {
            onMatch(entry);
            if (totalMatched >= maxMatches) {
              matchLimitReached = true;
              break outer;
            }
          } else if (candidates.length < maxCandidates) {
            candidates.push(entry);
          } else {
            matchLimitReached = true; // on continue à compter `total`, mais on n'accumule plus
          }
        }
      }
    }

    const truncated = scanLimitReached || matchLimitReached;

    if (onMatch) {
      return { total: totalMatched, scanned, truncated, error: null };
    }

    candidates.sort((a, b) => (sort === "asc" ? a.t - b.t : b.t - a.t));
    const page = candidates.slice(offset, offset + limit);

    return {
      results: page,
      total: totalMatched,
      truncated,
      scanned,
      limit,
      offset,
      error: null,
    };
  }
}

module.exports = {
  LogStore,
  classifyLevel,
  validateSearchQuery,
  MAX_REGEX_LENGTH,
  MAX_CONTEXT_LINES,
  DEFAULT_MAX_SCAN_LINES,
  DEFAULT_MAX_CANDIDATES,
};
