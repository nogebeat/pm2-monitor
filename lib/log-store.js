"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

const ROTATE_SIZE_BYTES = (parseInt(process.env.LOG_ROTATE_SIZE_MB, 10) || 5) * 1024 * 1024;
const COMPRESS_SWEEP_MS = 60 * 60 * 1000; // sweep horaire pour compresser les archives oubliées

function slug(name) {
  return String(name).replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
}

function classifyLevel(text, streamType) {
  const t = String(text).toLowerCase();
  if (/\b(error|err!|exception|fatal|traceback|fail(?:ed|ure)?)\b/.test(t)) return "error";
  if (/\b(warn(?:ing)?|deprecat(?:ed|ion))\b/.test(t)) return "warn";
  if (/\bdebug\b/.test(t)) return "debug";
  return streamType === "err" ? "error" : "info";
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

  _activePath(pmId, name) {
    return path.join(this.baseDir, `proc-${pmId}-${slug(name)}.jsonl`);
  }

  _archivePrefix(pmId, name) {
    return `proc-${pmId}-${slug(name)}-`;
  }

  /** Découpe un paquet de logs PM2 (qui peut contenir plusieurs lignes) et les persiste. */
  appendPacket(pmId, name, type, rawData, ts) {
    const lines = String(rawData).split(/\r?\n/).filter((l) => l.length > 0);
    if (!lines.length) return;
    const filePath = this._activePath(pmId, name);
    const rows = lines.map((text) =>
      JSON.stringify({ t: ts, type, level: classifyLevel(text, type), text }) + "\n"
    );
    try {
      fs.appendFileSync(filePath, rows.join(""));
      this._rotateIfNeeded(pmId, name);
    } catch (e) {
      console.warn("Écriture log échouée :", e.message);
    }
  }

  _rotateIfNeeded(pmId, name) {
    const filePath = this._activePath(pmId, name);
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch (e) {
      return;
    }
    if (size < ROTATE_SIZE_BYTES) return;

    const archiveName = `${this._archivePrefix(pmId, name)}${new Date()
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

  _filesFor(pmId, name) {
    const activeBase = path.basename(this._activePath(pmId, name));
    const prefix = this._archivePrefix(pmId, name);
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
   * Recherche dans tous les fichiers (actif + archives, y compris .gz) d'un process.
   * options: { type: 'all'|'out'|'err', level: 'all'|'info'|'warn'|'error'|'debug',
   *            query: string, regex: bool, from: ms, to: ms, limit: number }
   */
  search(pmId, name, options = {}) {
    const { type = "all", level = "all", query = "", regex = false, from = 0, to = Infinity, limit = 1000 } = options;

    let matcher = null;
    let error = null;
    if (query) {
      if (regex) {
        try {
          matcher = new RegExp(query, "i");
        } catch (e) {
          error = `Regex invalide : ${e.message}`;
        }
      } else {
        const q = query.toLowerCase();
        matcher = { test: (s) => s.toLowerCase().includes(q) };
      }
    }
    if (error) return { error, results: [], truncated: false, total: 0 };

    const files = this._filesFor(pmId, name);
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

  /** Export texte brut d'une période précise, prêt à télécharger. */
  exportRange(pmId, name, { from = 0, to = Infinity, type = "all" } = {}) {
    const files = this._filesFor(pmId, name);
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

  stats(pmId, name) {
    const files = this._filesFor(pmId, name);
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
}

module.exports = { LogStore, classifyLevel };
