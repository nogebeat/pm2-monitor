"use strict";

/**
 * lib/services/updates/index.js — Vérification des mises à jour (Phase 23,
 * étape 1 : LECTURE SEULE).
 *
 * Ce service répond à trois questions, sans jamais rien modifier :
 *   1. quelle version est installée ?
 *   2. une release plus récente est-elle publiée ? (avec ses notes)
 *   3. cette installation peut-elle se mettre à jour avec `deploy.sh update` ?
 *
 * Il N'EXÉCUTE AUCUNE MISE À JOUR : l'interface affiche seulement la commande
 * à lancer soi-même. Rien ici ne touche au dépôt, aux dépendances ou à PM2.
 *
 * Vie privée / robustesse :
 *  - désactivable (UPDATE_CHECK_ENABLED=0) pour les serveurs isolés ou qui ne
 *    veulent aucun appel sortant ; aucune donnée de l'installation n'est
 *    envoyée (voir release-source.js) ;
 *  - le résultat est mis en cache sur disque (data/update-check.json) : un
 *    redémarrage — ou une boucle de crash — ne ré-interroge pas GitHub tant
 *    que le cache est frais (limite de 60 requêtes/heure/IP sans jeton) ;
 *  - après une erreur, nouvelle tentative au plus tôt 30 min plus tard (ou à la
 *    réinitialisation de la limite annoncée par GitHub) ;
 *  - une vérification forcée depuis l'interface est limitée à 1 par minute ;
 *  - jamais d'exception vers l'appelant, et l'indisponibilité de GitHub ne
 *    perturbe en rien le reste du monitor.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseVersion, parseReleaseTag, compareVersions, classifyUpdate } = require("./semver");
const { fetchReleases } = require("./release-source");
const { runDiagnostics } = require("./diagnostics");

const DEFAULT_REPO = "nogebeat/pm2-monitor";
const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 60 * 1000;
const ERROR_BACKOFF_MS = 30 * 60 * 1000;
const FORCE_MIN_GAP_MS = 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30 * 1000;
const DIAGNOSTICS_TTL_MS = 60 * 1000;
const MAX_PENDING = 5;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function parseInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.trunc(n));
}

function createUpdateService(options = {}) {
  const env = options.env || process.env;
  const now = options.now || (() => Date.now());
  const fetchFn = options.fetchReleases || fetchReleases;
  const diagnosticsFn = options.runDiagnostics || runDiagnostics;
  const cachePath = options.cachePath || path.join(__dirname, "..", "..", "..", "data", "update-check.json");
  const currentVersion = options.currentVersion || require("../../../package.json").version;

  const enabled = options.enabled !== undefined ? options.enabled : env.UPDATE_CHECK_ENABLED !== "0";
  const intervalMs = options.intervalMs || parseInterval(env.UPDATE_CHECK_INTERVAL_MS);
  const configuredRepo = options.repo || env.UPDATE_CHECK_REPO || DEFAULT_REPO;
  const repo = REPO_RE.test(configuredRepo) ? configuredRepo : DEFAULT_REPO;
  const apiBaseUrl = options.apiBaseUrl || env.UPDATE_CHECK_API_URL || DEFAULT_API_BASE;

  // État en mémoire, rechargé depuis le cache disque au démarrage.
  let releases = []; // releases brutes réduites (release-source.js#slimRelease)
  let etag = null;
  let checkedAt = null; // dernière réponse réussie (200 ou 304)
  let lastError = null; // { code, at }
  let nextAttemptAt = 0; // pas de nouvelle tentative avant cet instant (après erreur)
  let lastForceAt = 0;
  let inflight = null;
  let diagnosticsCache = null;
  let timer = null;
  let firstTimer = null;

  function loadCache() {
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (parsed && parsed.repo === repo && Array.isArray(parsed.releases)) {
        releases = parsed.releases;
        etag = typeof parsed.etag === "string" ? parsed.etag : null;
        checkedAt = Number.isFinite(parsed.checkedAt) ? parsed.checkedAt : null;
      }
    } catch (e) {
      /* pas de cache (premier démarrage) ou fichier illisible : on repart de zéro */
    }
  }

  function saveCache() {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const tmp = `${cachePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ repo, etag, checkedAt, releases }));
      fs.renameSync(tmp, cachePath);
    } catch (e) {
      /* disque en lecture seule, etc. : le cache est un confort, jamais une obligation */
    }
  }

  function isFresh() {
    return checkedAt !== null && now() - checkedAt < intervalMs;
  }

  /**
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<{ran: boolean, throttled?: boolean}>}
   */
  async function check({ force = false } = {}) {
    if (!enabled) return { ran: false };
    if (inflight) {
      await inflight;
      return { ran: false };
    }
    const t = now();
    if (force) {
      if (t - lastForceAt < FORCE_MIN_GAP_MS) return { ran: false, throttled: true };
      lastForceAt = t;
    } else {
      if (isFresh()) return { ran: false };
      if (t < nextAttemptAt) return { ran: false };
    }

    inflight = (async () => {
      const result = await fetchFn({ repo, apiBaseUrl, etag });
      if (result.ok) {
        if (!result.notModified) {
          releases = result.releases;
          etag = result.etag;
        }
        checkedAt = now();
        lastError = null;
        nextAttemptAt = 0;
        saveCache();
      } else {
        lastError = { code: result.code, at: now() };
        nextAttemptAt = Math.max(now() + ERROR_BACKOFF_MS, result.retryAt || 0);
      }
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
    }
    return { ran: true };
  }

  function getStatus() {
    const current = parseVersion(currentVersion);
    const stable = releases
      .filter((r) => !r.draft && !r.prerelease && parseReleaseTag(r.tag))
      .map((r) => ({ release: r, version: parseReleaseTag(r.tag) }))
      .sort((a, b) => compareVersions(b.version, a.version));

    const pending = current
      ? stable
          .map((entry) => ({ ...entry, type: classifyUpdate(current, entry.version) }))
          .filter((entry) => entry.type !== null)
          .slice(0, MAX_PENDING)
          .map(({ release, version, type }) => ({
            tag: release.tag,
            version: `${version.major}.${version.minor}.${version.patch}`,
            type,
            publishedAt: release.publishedAt,
            url: release.url,
            notes: release.body,
          }))
      : [];

    return {
      enabled,
      repo,
      intervalMs,
      checkedAt,
      current: { version: String(currentVersion), valid: current !== null },
      updateAvailable: pending.length > 0,
      latest: pending.length
        ? { tag: pending[0].tag, version: pending[0].version, type: pending[0].type }
        : null,
      // Release À PROPOSER par défaut : la plus récente qui n'est PAS une version majeure. Une
      // majeure (changements possiblement incompatibles) n'est jamais celle que la commande cible
      // d'office ; elle reste visible dans `latest` / `pending`.
      recommended: (() => {
        const r = pending.find((p) => p.type !== "major");
        return r ? { tag: r.tag, version: r.version, type: r.type } : null;
      })(),
      pending,
      error: lastError,
    };
  }

  async function getDiagnostics({ force = false } = {}) {
    const t = now();
    // La commande proposée dépend de la release cible : le cache n'est valable que pour la même cible.
    const status = getStatus();
    const chosen = status.recommended || status.latest;
    const target = chosen ? { tag: chosen.tag, type: chosen.type } : null;
    const key = target ? `${target.tag}:${target.type}` : "";
    if (
      !force &&
      diagnosticsCache &&
      diagnosticsCache.key === key &&
      t - diagnosticsCache.at < DIAGNOSTICS_TTL_MS
    ) {
      return diagnosticsCache.value;
    }
    const value = await diagnosticsFn({ repo, target });
    diagnosticsCache = { at: t, key, value };
    return value;
  }

  function start() {
    if (!enabled || timer) return;
    loadCache();
    // Premier contrôle un peu après le démarrage (ne pas peser sur le boot) ; le cache
    // disque évite de ré-interroger GitHub à chaque redémarrage.
    firstTimer = setTimeout(() => {
      check().catch(() => {});
    }, FIRST_CHECK_DELAY_MS);
    firstTimer.unref();
    timer = setInterval(
      () => {
        check().catch(() => {});
      },
      Math.min(intervalMs, MIN_INTERVAL_MS),
    );
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (firstTimer) clearTimeout(firstTimer);
    timer = null;
    firstTimer = null;
  }

  // Chargé aussi hors start() pour que getStatus() serve le cache dès la première requête.
  if (enabled) loadCache();

  return {
    start,
    stop,
    check,
    getStatus,
    getDiagnostics,
    ENABLED: enabled,
    REPO: repo,
    INTERVAL_MS: intervalMs,
  };
}

module.exports = { createUpdateService, DEFAULT_REPO };
