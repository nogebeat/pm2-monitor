"use strict";

/**
 * lib/services/metrics/registry.js — Phase 15 (Prometheus Metrics Export).
 *
 * `buildMetricsText(deps)` est une fonction **pure** (même esprit que
 * lib/services/dashboard/global-status.js) : aucun accès DB/réseau/pm2 ici,
 * uniquement des données déjà chargées par l'appelant (lib/routes/metrics.js).
 * Ne crée AUCUNE nouvelle source de données — uniquement une mise en forme
 * Prometheus de ce que le dashboard/l'historique/les alertes exposent déjà
 * (system-stats.js, process-helpers.js#fmtProcess, alertStore, healthChecksStore,
 * serversStore).
 *
 * ---------------------------------------------------------------------------
 * Labels (voir docs/metrics/README.md#métriques-disponibles) :
 * ---------------------------------------------------------------------------
 *  - `process`     : nom d'app PM2 (cardinalité = nombre de process, bornée
 *                     par ce que l'opérateur fait tourner — jamais un ID/PID
 *                     qui changerait à chaque redémarrage).
 *  - `server`      : `serverKey` (Phase 10 — "local" ou "srv_xxx"), MÊME
 *                     identifiant que celui déjà utilisé partout ailleurs
 *                     dans l'app (`serverId` des events socket.io, clé de
 *                     lib/services/process-history/). Jamais le nom
 *                     affichable (modifiable par l'utilisateur, non garanti
 *                     unique) — voir lib/services/servers/store.js.
 *  - `environment` : `servers.environment` (production/staging/development/
 *                     custom, Phase 10) — un environnement PAR SERVEUR, pas
 *                     par process (Process Organization/Phase 13 a ses
 *                     propres tags par process, non repris ici pour éviter
 *                     d'exploser la cardinalité avec des combinaisons
 *                     tag×process arbitraires).
 *  - `target_type`,
 *    `target`       : uniquement sur `pm2_monitor_alerts_active` — reflètent
 *                     `alert_rules.target_type`/`target_value`
 *                     (lib/services/alerts/alert-rules-store.js), les seules
 *                     dimensions que le moteur d'alertes garantit. Pas de
 *                     label `server` sur cette métrique : le moteur
 *                     n'évalue les règles que contre l'hôte local (voir
 *                     lib/polling.js), Phase 10 n'a jamais été rétrofittée
 *                     dedans — un label `server="local"` figé serait
 *                     trompeur plutôt qu'informatif.
 *
 * Le statut process/health-check/serveur (valeurs énumérées) est exposé en
 * une seule série par entité (`status="<valeur courante>"`, valeur 1),
 * jamais une série par valeur possible × entité : garde la cardinalité
 * proportionnelle au nombre de process/checks/serveurs réels, pas multipliée
 * par le nombre d'états PM2 possibles.
 */

const { createWriter } = require("./format");

const PREFIX = "pm2_monitor";

function labelsForServer(serverKey, serverIndex) {
  const info = serverIndex.get(serverKey);
  return {
    server: serverKey || "local",
    environment: (info && info.environment) || "production",
  };
}

function addProcessMetrics(w, processes, serverKey, serverIndex) {
  const base = labelsForServer(serverKey, serverIndex);
  for (const p of processes || []) {
    if (!p || !p.name) continue;
    const labels = { process: p.name, ...base };

    w.metric(
      `${PREFIX}_process_cpu_percent`,
      "gauge",
      "Pourcentage CPU du process (tel que rapporté par pm2 monit).",
      labels,
      typeof p.cpu === "number" ? p.cpu : 0,
    );

    w.metric(
      `${PREFIX}_process_memory_bytes`,
      "gauge",
      "Mémoire résidente (RSS) du process, en octets.",
      labels,
      typeof p.memory === "number" ? p.memory : 0,
    );

    const uptimeSeconds =
      p.status === "online" && typeof p.uptime === "number" && p.uptime > 0
        ? Math.max(0, Math.round((Date.now() - p.uptime) / 1000))
        : 0;
    w.metric(
      `${PREFIX}_process_uptime_seconds`,
      "gauge",
      "Durée depuis le dernier démarrage du process, en secondes (0 si non online).",
      labels,
      uptimeSeconds,
    );

    w.metric(
      `${PREFIX}_process_restarts_total`,
      "counter",
      "Nombre de redémarrages du process depuis sa création dans PM2.",
      labels,
      typeof p.restarts === "number" ? p.restarts : 0,
    );

    w.metric(
      `${PREFIX}_process_status`,
      "gauge",
      'État courant du process ("online"|"stopped"|"stopping"|"launching"|"errored") : 1 pour le label `status` correspondant à l\'état actuel, aucune série pour les autres valeurs possibles.',
      { ...labels, status: p.status || "unknown" },
      1,
    );
  }
}

function addSystemMetrics(w, system, serverKey, serverIndex) {
  if (!system) return;
  const labels = labelsForServer(serverKey, serverIndex);

  if (typeof system.cpu === "number") {
    w.metric(
      `${PREFIX}_system_cpu_percent`,
      "gauge",
      "Utilisation CPU système (moyenne tous cœurs), en %.",
      labels,
      system.cpu,
    );
  }

  if (system.mem) {
    w.metric(
      `${PREFIX}_system_memory_used_bytes`,
      "gauge",
      "Mémoire système utilisée, en octets.",
      labels,
      system.mem.used,
    );
    w.metric(
      `${PREFIX}_system_memory_total_bytes`,
      "gauge",
      "Mémoire système totale, en octets.",
      labels,
      system.mem.total,
    );
    w.metric(
      `${PREFIX}_system_memory_percent`,
      "gauge",
      "Pourcentage de mémoire système utilisée.",
      labels,
      system.mem.percent,
    );
  }

  if (system.disk) {
    w.metric(
      `${PREFIX}_system_disk_used_bytes`,
      "gauge",
      "Espace disque utilisé (partition /), en octets.",
      labels,
      system.disk.used,
    );
    w.metric(
      `${PREFIX}_system_disk_total_bytes`,
      "gauge",
      "Espace disque total (partition /), en octets.",
      labels,
      system.disk.total,
    );
    w.metric(
      `${PREFIX}_system_disk_percent`,
      "gauge",
      "Pourcentage d'espace disque utilisé (partition /).",
      labels,
      system.disk.percent,
    );
  }
}

function addServerMetrics(w, servers) {
  for (const s of servers || []) {
    if (!s || !s.serverKey) continue;
    const labels = {
      server: s.serverKey,
      environment: s.environment || "production",
      kind: s.kind || "agent",
    };
    w.metric(
      `${PREFIX}_server_status`,
      "gauge",
      'État courant d\'un serveur surveillé ("ONLINE"|"OFFLINE"|"PENDING") : 1 pour le label `status` correspondant, aucune série pour les autres valeurs.',
      { ...labels, status: s.status || "OFFLINE" },
      1,
    );
  }
}

function addHealthCheckMetrics(w, healthChecks) {
  for (const c of healthChecks || []) {
    if (!c || !c.name) continue;
    const labels = { check: c.name, enabled: c.enabled === false ? "false" : "true" };
    w.metric(
      `${PREFIX}_healthcheck_status`,
      "gauge",
      'État courant d\'un health check ("UP"|"DOWN"|"DEGRADED"|"UNKNOWN") : 1 pour le label `status` correspondant, aucune série pour les autres valeurs.',
      { ...labels, status: c.status || "UNKNOWN" },
      1,
    );
  }
}

function addAlertMetrics(w, alerts) {
  // `target_type`/`target_value` (lib/services/alerts/alert-store.js) sont
  // les seules dimensions que le moteur d'alertes garantit réellement :
  // "process"+nom d'app, "system", ou "health_check"+nom de check. On les
  // utilise comme labels plutôt que de se limiter à un compte global par
  // sévérité — plus utile pour distinguer "quelle app/quel check est en
  // alerte" sans rien inventer que la donnée source ne porte pas.
  //
  // Pas de label `server` : lib/polling.js (seul appelant de
  // lib/services/alerts/engine.js) n'évalue les règles que contre l'hôte
  // local — Phase 10 (multi-server) n'a jamais été rétrofittée dans le
  // moteur d'alertes, donc toute alerte active concerne forcément le
  // serveur local. Ajouter `server="local"` sur cette seule métrique
  // laisserait croire, à tort, que les alertes distantes sont juste
  // absentes du scrape plutôt qu'absentes du système lui-même — voir
  // docs/metrics/README.md#alertes-label-severity-target_type-target.
  const counts = new Map(); // "severity\u0000targetType\u0000target" -> count
  for (const a of alerts || []) {
    if (!a || !a.severity || !a.targetType) continue;
    const target = a.targetType === "system" ? "" : a.targetValue || "*";
    const key = `${a.severity}\u0000${a.targetType}\u0000${target}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  w.declare(
    `${PREFIX}_alerts_active`,
    "gauge",
    "Nombre d'alertes actuellement actives, par sévérité, type de cible et cible.",
  );
  for (const [key, count] of counts) {
    const [severity, targetType, target] = key.split("\u0000");
    const labels = { severity, target_type: targetType };
    if (target) labels.target = target;
    w.sample(`${PREFIX}_alerts_active`, labels, count);
  }
}

/**
 * Docker Monitoring (Phase 22) — `docker` est lib/services/docker/index.js#getLastSnapshot(),
 * DÉJÀ calculé par le poller partagé du service (voir lib/routes/metrics.js) :
 * comme le reste de ce fichier, aucune nouvelle collecte ici, uniquement une
 * mise en forme Prometheus du cache existant.
 *
 * `pm2_monitor_docker_up` reflète la disponibilité du daemon Docker lui-même
 * (indépendante de `pm2_monitor_up`, qui ne reflète que la capacité de
 * /metrics à répondre) — si Docker Monitoring est désactivé
 * (DOCKER_MONITORING_ENABLED=0) ou que le socket est inaccessible, vaut 0 et
 * aucune métrique par conteneur n'est émise (jamais de valeur inventée).
 *
 * Labels : `container` (nom, pas l'ID — cardinalité bornée par le nombre de
 * conteneurs réellement lancés, jamais un ID qui changerait à chaque
 * recréation), `image`, `server` (toujours "local" pour l'instant — voir la
 * note multi-serveur dans lib/services/docker/index.js).
 *
 * Compteurs cumulés depuis le démarrage du conteneur (réseau, bloc I/O) en
 * `counter`, comme `pm2_monitor_process_restarts_total` ; tout le reste
 * (CPU %, mémoire, PIDs, statut) est un `gauge` (valeur instantanée), comme
 * les métriques process/système existantes.
 */
function addDockerMetrics(w, docker) {
  if (!docker) return;
  w.metric(
    `${PREFIX}_docker_up`,
    "gauge",
    "Vaut 1 si Docker Monitoring est activé et que le daemon Docker répond sur le socket local, 0 sinon.",
    {},
    docker.available ? 1 : 0,
  );
  if (!docker.available) return;

  for (const c of docker.containers || []) {
    if (!c || !c.name) continue;
    const labels = { container: c.name, image: c.image || "", server: c.serverKey || "local" };

    w.metric(
      `${PREFIX}_docker_container_status`,
      "gauge",
      'État courant du conteneur ("running"|"exited"|"paused"|"restarting"|"created"|"removing"|"dead") : 1 pour le label `status` correspondant, aucune série pour les autres valeurs.',
      { ...labels, status: c.state || "unknown" },
      1,
    );

    if (typeof c.cpuPercent === "number") {
      w.metric(
        `${PREFIX}_docker_container_cpu_percent`,
        "gauge",
        "Pourcentage CPU du conteneur (delta entre deux échantillons du poller — voir lib/services/docker/format.js#computeCpuPercent).",
        labels,
        c.cpuPercent,
      );
    }
    if (c.memory && typeof c.memory.usageBytes === "number") {
      w.metric(
        `${PREFIX}_docker_container_memory_usage_bytes`,
        "gauge",
        "Mémoire utilisée par le conteneur (cache page exclu), en octets.",
        labels,
        c.memory.usageBytes,
      );
    }
    if (c.memory && typeof c.memory.limitBytes === "number") {
      w.metric(
        `${PREFIX}_docker_container_memory_limit_bytes`,
        "gauge",
        "Limite mémoire du conteneur, en octets.",
        labels,
        c.memory.limitBytes,
      );
    }
    if (c.network) {
      w.metric(
        `${PREFIX}_docker_container_network_rx_bytes_total`,
        "counter",
        "Octets reçus, toutes interfaces réseau du conteneur cumulées, depuis son démarrage.",
        labels,
        c.network.rxBytes,
      );
      w.metric(
        `${PREFIX}_docker_container_network_tx_bytes_total`,
        "counter",
        "Octets envoyés, toutes interfaces réseau du conteneur cumulées, depuis son démarrage.",
        labels,
        c.network.txBytes,
      );
    }
    if (c.blockIo) {
      w.metric(
        `${PREFIX}_docker_container_blkio_read_bytes_total`,
        "counter",
        "Octets lus sur bloc (disque) depuis le démarrage du conteneur.",
        labels,
        c.blockIo.readBytes,
      );
      w.metric(
        `${PREFIX}_docker_container_blkio_write_bytes_total`,
        "counter",
        "Octets écrits sur bloc (disque) depuis le démarrage du conteneur.",
        labels,
        c.blockIo.writeBytes,
      );
    }
    if (typeof c.pids === "number") {
      w.metric(
        `${PREFIX}_docker_container_pids`,
        "gauge",
        "Nombre de processus/threads dans le conteneur.",
        labels,
        c.pids,
      );
    }
  }
}

/**
 * @param {object} deps
 * @param {Array<object>} deps.localProcesses - process locaux déjà au format fmtProcess()
 * @param {object} [deps.localSystem] - lib/system-stats.js#snapshot()
 * @param {Array<object>} [deps.servers] - lib/services/servers/store.js#list() (statut live appliqué)
 * @param {Map<string, Array<object>>} [deps.remoteProcessesByServer] - serverKey -> process[] (déjà au format fmtProcess())
 * @param {Map<string, object>} [deps.remoteSystemByServer] - serverKey -> snapshot système (lib/services/servers/store.js#touchStatus)
 * @param {Array<object>|null} [deps.alerts] - lib/services/alerts/alert-store.js#listActive(), null si non applicable
 * @param {Array<object>|null} [deps.healthChecks] - lib/services/health-checks/store.js#list(), null si non applicable
 * @param {string} [deps.appVersion] - package.json#version
 */
function buildMetricsText(deps = {}) {
  const {
    localProcesses = [],
    localSystem = null,
    servers = [],
    remoteProcessesByServer = new Map(),
    remoteSystemByServer = new Map(),
    alerts = null,
    healthChecks = null,
    docker = null,
    appVersion = "",
  } = deps;

  const w = createWriter();
  const serverIndex = new Map((servers || []).map((s) => [s.serverKey, s]));

  w.metric(`${PREFIX}_up`, "gauge", "Vaut 1 si l'endpoint /metrics a pu générer une réponse.", {}, 1);
  if (appVersion) {
    w.metric(
      `${PREFIX}_build_info`,
      "gauge",
      "Métadonnées de version de PM2 Monitor (valeur toujours 1).",
      {
        version: appVersion,
      },
      1,
    );
  }

  // --- Process (local + chaque serveur distant) ------------------------
  addProcessMetrics(w, localProcesses, "local", serverIndex);
  for (const [serverKey, processes] of remoteProcessesByServer) {
    addProcessMetrics(w, processes, serverKey, serverIndex);
  }

  // --- Système (local + chaque serveur distant) -------------------------
  addSystemMetrics(w, localSystem, "local", serverIndex);
  for (const [serverKey, snapshot] of remoteSystemByServer) {
    addSystemMetrics(w, snapshot, serverKey, serverIndex);
  }

  // --- Registre de serveurs (Phase 10) -----------------------------------
  addServerMetrics(w, servers);

  // --- Health checks -------------------------------------------------------
  if (healthChecks) {
    addHealthCheckMetrics(w, healthChecks);
  }

  // --- Alertes ---------------------------------------------------------------
  if (alerts) {
    addAlertMetrics(w, alerts);
  }

  // --- Docker Monitoring (Phase 22) -------------------------------------
  if (docker) {
    addDockerMetrics(w, docker);
  }

  return w.toString();
}

module.exports = { buildMetricsText, PREFIX };
