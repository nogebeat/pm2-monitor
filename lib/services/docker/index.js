"use strict";

/**
 * lib/services/docker/index.js — Docker Monitoring (Phase 22).
 *
 * Service central : un poller PARTAGÉ (une seule boucle, quel que soit le
 * nombre de clients connectés — section 12 du prompt maître, "ne pas
 * interroger Docker inutilement") qui maintient un instantané en mémoire
 * (disponibilité + liste des conteneurs + stats). Ce même instantané est
 * consommé par trois chemins différents, JAMAIS par un nouvel appel Docker
 * chacun :
 *  - le temps réel (lib/realtime/docker-bus.js, diffusion "docker.snapshot")
 *  - le REST (lib/routes/docker.js, lecture du cache)
 *  - l'export Prometheus (lib/routes/metrics.js, même cache)
 *
 * Résilience (section 11 du prompt maître) : Docker absent/indisponible ne
 * doit JAMAIS faire tomber ce module ni le reste de PM2 Monitor — toute
 * erreur est capturée, journalisée, et se traduit par `available: false`
 * dans le dernier instantané, jamais par une exception qui remonte à
 * l'appelant (server.js ne fait d'ailleurs rien de spécial au démarrage
 * pour Docker : contrairement au bus PM2, `start()` ne bloque jamais le
 * démarrage du serveur HTTP).
 *
 * Préparé pour le multi-serveur (Phase 10 du monitor), mais SEULEMENT côté
 * FORME des données : chaque conteneur/instantané porte déjà un `serverKey`
 * ("local" uniquement pour l'instant — voir SERVER_KEY ci-dessous). Le jour
 * où un agent distant (bin/agent.js) doit exposer son propre Docker, il
 * suffira d'instancier ce même service côté agent et de republier ses
 * instantanés avec son propre serverKey (comme onLog/onSnapshot le font déjà
 * pour PM2, voir server.js) — sans changer la forme des données ni ce
 * module. Rien de plus n'est fait ici : aucun vrai support multi-serveur,
 * juste ne pas fermer la porte.
 */

const client = require("./client");
const { DockerLogDemuxer, splitTimestamp } = require("./log-demux");
const {
  fmtContainer,
  computeCpuPercent,
  computeMemory,
  computeNetwork,
  computeBlockIo,
  pidsCount,
} = require("./format");

const SERVER_KEY = "local"; // voir note multi-serveur ci-dessus — jamais une autre valeur dans cette phase

const ENABLED = process.env.DOCKER_MONITORING_ENABLED !== "0";
const SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || client.DEFAULT_SOCKET_PATH;
const POLL_INTERVAL_MS = process.env.DOCKER_POLL_INTERVAL_MS
  ? Math.max(1000, Number(process.env.DOCKER_POLL_INTERVAL_MS) || 5000)
  : 5000;

let pollTimer = null;
let polling = false; // garde anti-chevauchement si un tick dure plus longtemps que POLL_INTERVAL_MS
const lastRawStatsById = new Map(); // containerId -> stats bruts du tick précédent (nécessaire au calcul CPU)
let lastSnapshot = { available: false, checkedAt: 0, containers: [] };
let listeners = []; // callbacks(snapshot) — voir onSnapshot()

/** @param {(snapshot: object) => void} cb @returns {() => void} désabonnement */
function onSnapshot(cb) {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

function notify(snapshot) {
  lastSnapshot = snapshot;
  for (const cb of listeners) {
    try {
      cb(snapshot);
    } catch (e) {
      console.error("Erreur d'un abonné docker.snapshot :", e.message);
    }
  }
}

function getLastSnapshot() {
  return lastSnapshot;
}

function isAvailable() {
  return !!lastSnapshot.available;
}

/** Forme "pas de métriques" partagée par tous les cas où on ne peut/veut pas en calculer (section 3 : jamais inventées). */
function emptyMetrics() {
  return {
    cpuPercent: null,
    memory: { usageBytes: null, limitBytes: null, percent: null },
    network: null,
    blockIo: null,
    pids: null,
  };
}

async function collectOnce() {
  const up = await client.ping({ socketPath: SOCKET_PATH }).catch(() => false);
  if (!up) {
    lastRawStatsById.clear();
    notify({ available: false, checkedAt: Date.now(), containers: [] });
    return;
  }

  let list;
  try {
    list = await client.listContainers({ socketPath: SOCKET_PATH });
  } catch (e) {
    console.warn("Docker Monitoring : liste des conteneurs indisponible :", e.message);
    lastRawStatsById.clear();
    notify({ available: false, checkedAt: Date.now(), containers: [] });
    return;
  }

  const seenIds = new Set();
  const settled = await Promise.allSettled(
    (list || []).map(async (raw) => {
      const base = fmtContainer(raw);
      seenIds.add(base.id);

      if (raw.State !== "running") {
        // Un conteneur arrêté n'a pas de stats à récupérer (l'endpoint /stats
        // ne renvoie rien d'utile hors "running") — "pas de donnée" est un
        // état distinct de "0%", jamais confondu (section 3 du prompt maître).
        lastRawStatsById.delete(base.id);
        return { ...base, serverKey: SERVER_KEY, ...emptyMetrics() };
      }

      try {
        const stats = await client.statsOnce(base.id, { socketPath: SOCKET_PATH });
        const previous = lastRawStatsById.get(base.id) || null;
        lastRawStatsById.set(base.id, stats);
        return {
          ...base,
          serverKey: SERVER_KEY,
          cpuPercent: computeCpuPercent(stats, previous),
          memory: computeMemory(stats),
          network: computeNetwork(stats),
          blockIo: computeBlockIo(stats),
          pids: pidsCount(stats),
        };
      } catch (e) {
        // Conteneur supprimé/arrêté entre list() et stats() (section 11) :
        // on le rapporte sans métriques plutôt que de faire échouer tout le tick.
        lastRawStatsById.delete(base.id);
        return { ...base, serverKey: SERVER_KEY, ...emptyMetrics() };
      }
    }),
  );

  // Purge du cache CPU des conteneurs qui n'existent plus du tout (évite une
  // fuite mémoire lente sur un hôte qui crée/détruit beaucoup de conteneurs).
  for (const id of lastRawStatsById.keys()) {
    if (!seenIds.has(id)) lastRawStatsById.delete(id);
  }

  const containers = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  notify({ available: true, checkedAt: Date.now(), containers });
}

async function tick() {
  if (polling) return; // ne jamais chevaucher deux collectes (section 12)
  polling = true;
  try {
    await collectOnce();
  } catch (e) {
    // Filet de sécurité ultime (section 11) : une erreur totalement
    // inattendue ici ne doit jamais remonter (un setInterval planterait
    // silencieusement sinon, sans jamais reprogrammer le prochain tick).
    console.error("Erreur inattendue du poller Docker Monitoring :", e.message);
    notify({ available: false, checkedAt: Date.now(), containers: [] });
  } finally {
    polling = false;
  }
}

function start() {
  if (!ENABLED || pollTimer) return;
  tick(); // premier instantané dès le démarrage, pas d'attente du premier intervalle
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// --- Lecture à la demande (REST, en dehors du rythme du poller) -------------

/**
 * Un seul conteneur, interrogé fraîchement — utilisé uniquement si le cache
 * du poller n'a pas (encore) ce conteneur (ex: Docker vient de redevenir
 * disponible). Ne renvoie jamais de métriques (elles ne viennent que du
 * poller, voir emptyMetrics()) : ce chemin sert à afficher les métadonnées
 * du conteneur sans attendre le prochain tick, pas à dupliquer la collecte.
 */
async function fetchContainerFresh(id) {
  const raw = await client.inspectContainer(id, { socketPath: SOCKET_PATH });
  // `inspect` a un format différent de `list` (Created en ISO plutôt qu'en
  // secondes epoch, Name unique plutôt que Names[]) : on le ramène à la forme
  // attendue par fmtContainer() plutôt que de dupliquer sa logique ici.
  const base = fmtContainer({
    Id: raw.Id,
    Names: [raw.Name],
    Image: raw.Config && raw.Config.Image,
    State: raw.State && raw.State.Status,
    Status: raw.State && raw.State.Status,
    Created: raw.Created ? Math.floor(new Date(raw.Created).getTime() / 1000) : null,
    Ports: [], // omis dans ce chemin de secours (nécessiterait de parser NetworkSettings.Ports) — jamais inventé
    Labels: (raw.Config && raw.Config.Labels) || {},
  });
  return { ...base, serverKey: SERVER_KEY, ...emptyMetrics() };
}

/** Historique récent des logs d'un conteneur (une seule réponse, pas de flux ouvert). */
async function fetchLogsTail(id, { tail = 200 } = {}) {
  const info = await client.inspectContainer(id, { socketPath: SOCKET_PATH });
  const tty = !!(info.Config && info.Config.Tty);
  const { statusCode, body } = await client.logsTail(id, { tail, socketPath: SOCKET_PATH });
  if (statusCode >= 400) {
    throw new Error(`Docker a répondu ${statusCode} pour les logs de ${id}`);
  }
  const demuxer = new DockerLogDemuxer(tty);
  return demuxer.push(body).map(({ type, text }) => {
    const { at, text: clean } = splitTimestamp(text);
    return { type, text: clean, at };
  });
}

/**
 * Ouvre un flux de logs en direct pour UN conteneur. Retourne un handle
 * `{ close() }` — l'appelant (lib/realtime/docker-bus.js) DOIT appeler
 * close() quand l'abonné se déconnecte / change de conteneur / que le
 * conteneur disparaît (section 5 du prompt maître) : sans ça, la requête
 * Docker resterait ouverte indéfiniment (fuite de descripteur + charge
 * inutile sur le daemon — voir section 12).
 *
 * @param {string} id
 * @param {(line: {type: "out"|"err", text: string, at: number}) => void} onLine
 * @param {(err: Error) => void} onError - appelé au plus une fois ; le flux est alors considéré fermé
 * @param {{ since?: number|string }} [options] - `since` (secondes epoch, fraction acceptée) : ne renvoie que
 *   les lignes à partir de cet instant. Permet d'enchaîner SANS trou ni doublon après un historique
 *   déjà chargé (voir docker-bus.js) : sans lui le flux démarre à « maintenant » (`tail=0`), et tout
 *   ce qui a été écrit entre la lecture de l'historique et l'ouverture du flux serait perdu.
 * @returns {Promise<{close: () => void}>}
 */
async function subscribeToLogs(id, onLine, onError, { since } = {}) {
  const info = await client.inspectContainer(id, { socketPath: SOCKET_PATH });
  const tty = !!(info.Config && info.Config.Tty);
  const res = await client.openLogStream(id, { since, socketPath: SOCKET_PATH });
  const demuxer = new DockerLogDemuxer(tty);
  let closed = false;

  res.on("data", (chunk) => {
    if (closed) return;
    let lines;
    try {
      lines = demuxer.push(chunk);
    } catch (e) {
      return; // frame malformée : on ignore ce morceau plutôt que de casser tout le flux
    }
    for (const { type, text } of lines) {
      const { at, text: clean } = splitTimestamp(text);
      onLine({ type, text: clean, at: at || Date.now() });
    }
  });
  res.on("error", (e) => {
    if (closed) return;
    closed = true;
    onError(e);
  });
  res.on("end", () => {
    if (closed) return;
    closed = true;
    onError(new Error("Flux de logs Docker terminé (conteneur arrêté ou supprimé)."));
  });

  return {
    close() {
      if (closed) return;
      closed = true;
      res.destroy();
    },
  };
}

module.exports = {
  ENABLED,
  SOCKET_PATH,
  POLL_INTERVAL_MS,
  start,
  stop,
  isAvailable,
  getLastSnapshot,
  onSnapshot,
  fetchContainerFresh,
  fetchLogsTail,
  subscribeToLogs,
};
