"use strict";

/**
 * lib/services/docker/format.js — Docker Monitoring (Phase 22).
 *
 * Fonctions PURES de mise en forme : aucun accès réseau/socket ici (même
 * esprit que lib/services/metrics/registry.js ou
 * lib/process-helpers.js#fmtProcess). Ne rapporte JAMAIS une valeur
 * inventée : un champ absent/non calculable de la réponse Docker reste
 * `null` (section 3 du prompt maître — "pas de valeurs inventées").
 */

/** Normalise une entrée de GET /containers/json vers le format renvoyé au frontend. */
function fmtContainer(c) {
  return {
    id: c.Id,
    name: ((c.Names && c.Names[0]) || "").replace(/^\//, ""),
    image: c.Image,
    state: c.State, // "running" | "exited" | "paused" | "restarting" | "created" | "removing" | "dead"
    status: c.Status || "", // texte libre Docker ("Up 2 hours", "Exited (0) 3 days ago"…)
    created: c.Created ? c.Created * 1000 : null, // Docker donne des secondes epoch, on aligne sur le reste de l'app (ms)
    ports: (c.Ports || []).map((p) => ({
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort || null,
      type: p.Type,
      ip: p.IP || null,
    })),
    labels: c.Labels || {},
  };
}

/**
 * % CPU d'un conteneur, calculé entre DEUX échantillons SUCCESSIFS de notre
 * propre poller — pas entre `cpu_stats`/`precpu_stats` d'un seul appel
 * Docker, qui ne sont significatifs que si le daemon a déjà eu le temps
 * d'échantillonner deux fois en interne (comportement non garanti sur un
 * appel `stream=false` isolé). Même choix que lib/system-stats.js#cpuPercent,
 * qui calcule lui aussi un delta entre deux appels du poller plutôt que de
 * faire confiance à une seule mesure instantanée.
 *
 * Formule (identique à celle utilisée par `docker stats` CLI) :
 *   cpuDelta    = cpu_usage.total_usage(t) - cpu_usage.total_usage(t-1)
 *   systemDelta = system_cpu_usage(t)      - system_cpu_usage(t-1)
 *   percent     = (cpuDelta / systemDelta) * nombre de CPU * 100
 *
 * @param {object} current - stats bruts Docker de ce tick
 * @param {object|null} previous - stats bruts Docker du tick précédent (null au premier tick vu pour ce conteneur)
 * @returns {number} 0 si pas encore de second échantillon ou données incohérentes (jamais négatif, jamais inventé)
 */
function computeCpuPercent(current, previous) {
  if (!previous) return 0;
  try {
    const cpuDelta = current.cpu_stats.cpu_usage.total_usage - previous.cpu_stats.cpu_usage.total_usage;
    const systemDelta = current.cpu_stats.system_cpu_usage - previous.cpu_stats.system_cpu_usage;
    if (!(systemDelta > 0) || !(cpuDelta >= 0)) return 0;
    const numCpus =
      current.cpu_stats.online_cpus ||
      (current.cpu_stats.cpu_usage.percpu_usage && current.cpu_stats.cpu_usage.percpu_usage.length) ||
      1;
    return Math.round(((cpuDelta / systemDelta) * numCpus * 100 + Number.EPSILON) * 10) / 10;
  } catch (e) {
    return 0;
  }
}

/**
 * Mémoire "réelle" telle qu'affichée par `docker stats` : usage total moins
 * le cache page (sinon la mémoire "utilisée" inclut du cache disque récupérable
 * par le noyau à tout moment, ce qui gonflerait artificiellement la métrique).
 * Compatible cgroup v1 (`stats.cache`) et v2 (`stats.inactive_file`).
 */
function computeMemory(stats) {
  const mem = stats && stats.memory_stats;
  if (!mem || typeof mem.usage !== "number") return { usageBytes: null, limitBytes: null, percent: null };
  const cacheStats = mem.stats || {};
  const cache = typeof cacheStats.cache === "number" ? cacheStats.cache : cacheStats.inactive_file || 0;
  const usageBytes = Math.max(0, mem.usage - cache);
  const limitBytes = typeof mem.limit === "number" ? mem.limit : null;
  const percent = limitBytes ? Math.round((usageBytes / limitBytes) * 1000) / 10 : null;
  return { usageBytes, limitBytes, percent };
}

/** Somme les compteurs réseau de toutes les interfaces du conteneur (null si non exposé, ex: network_mode=none). */
function computeNetwork(stats) {
  const nets = stats && stats.networks;
  if (!nets || typeof nets !== "object") return null;
  let rx = 0;
  let tx = 0;
  let any = false;
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    any = true;
    rx += iface.rx_bytes || 0;
    tx += iface.tx_bytes || 0;
  }
  return any ? { rxBytes: rx, txBytes: tx } : null;
}

/** Somme les octets lus/écrits sur bloc (I/O disque) ; null si non exposé par le cgroup driver. */
function computeBlockIo(stats) {
  const entries = stats && stats.blkio_stats && stats.blkio_stats.io_service_bytes_recursive;
  if (!Array.isArray(entries) || !entries.length) return null;
  let read = 0;
  let write = 0;
  let any = false;
  for (const e of entries) {
    if (!e || !e.op) continue;
    const op = String(e.op).toLowerCase();
    if (op === "read") {
      read += e.value || 0;
      any = true;
    } else if (op === "write") {
      write += e.value || 0;
      any = true;
    }
  }
  return any ? { readBytes: read, writeBytes: write } : null;
}

function pidsCount(stats) {
  return stats && stats.pids_stats && typeof stats.pids_stats.current === "number"
    ? stats.pids_stats.current
    : null;
}

module.exports = {
  fmtContainer,
  computeCpuPercent,
  computeMemory,
  computeNetwork,
  computeBlockIo,
  pidsCount,
};
