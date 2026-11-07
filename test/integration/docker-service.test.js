"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Tests d'intégration Phase 22 (Docker Monitoring) — contre un VRAI socket
 * Unix (comme /var/run/docker.sock en production), servi par un faux daemon
 * Docker minimal ci-dessous. Couvre la section 13 du prompt maître : Docker
 * disponible/indisponible, récupération des conteneurs, conteneur
 * inexistant, stats, logs, fermeture du stream, plusieurs conteneurs
 * simultanément.
 *
 * `DOCKER_SOCKET_PATH` est positionné AVANT le premier require() de
 * lib/services/docker (lu une seule fois au chargement du module) — chaque
 * fichier de test tourne dans son propre process avec `node --test`, donc
 * sans risque d'interférence avec d'autres suites.
 */

const SOCKET_PATH = path.join(os.tmpdir(), `pm2-monitor-fake-docker-${process.pid}.sock`);
process.env.DOCKER_SOCKET_PATH = SOCKET_PATH;
process.env.DOCKER_MONITORING_ENABLED = "1";
// Plancher réel de 1000ms imposé par lib/services/docker/index.js (voir
// Math.max(1000, ...)) : inutile de viser plus bas, ça resterait à 1000ms.
// Suffisant pour observer un deuxième tick "naturel" sans attendre 5s
// (défaut prod) dans le test de calcul du %CPU ci-dessous.
process.env.DOCKER_POLL_INTERVAL_MS = "1000";

const dockerService = require("../../lib/services/docker");

/** État mutable du faux daemon, reconfiguré par chaque test. */
const fakeState = {
  up: true,
  containers: [], // [{ id, name, image, state, tty, cpuTotal, statsCallCount }]
};

function findContainer(id) {
  return fakeState.containers.find((c) => c.id === id || c.id.startsWith(id));
}

function startFakeDockerd() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://docker");

    if (!fakeState.up) {
      req.socket.destroy(); // Docker arrêté = rien ne répond, pas une 500 propre
      return;
    }

    if (url.pathname === "/_ping") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }

    if (url.pathname === "/containers/json") {
      const body = JSON.stringify(
        fakeState.containers.map((c) => ({
          Id: c.id,
          Names: [`/${c.name}`],
          Image: c.image || "img:latest",
          State: c.state || "running",
          Status: c.state === "running" ? "Up 1 minute" : "Exited (0) 1 minute ago",
          Created: 1_700_000_000,
          Ports: [],
          Labels: {},
        })),
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(body);
    }

    const inspectMatch = url.pathname.match(/^\/containers\/([^/]+)\/json$/);
    if (inspectMatch) {
      const c = findContainer(inspectMatch[1]);
      if (!c) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ message: `No such container: ${inspectMatch[1]}` }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          Id: c.id,
          Name: `/${c.name}`,
          Created: "2026-01-01T00:00:00.000000000Z",
          State: { Status: c.state || "running" },
          Config: { Image: c.image || "img:latest", Tty: !!c.tty, Labels: {} },
        }),
      );
    }

    const statsMatch = url.pathname.match(/^\/containers\/([^/]+)\/stats$/);
    if (statsMatch) {
      const c = findContainer(statsMatch[1]);
      if (!c) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ message: `No such container: ${statsMatch[1]}` }));
      }
      c.statsCallCount = (c.statsCallCount || 0) + 1;
      c.cpuTotal = (c.cpuTotal || 0) + 200_000_000; // progresse à chaque appel, pour un delta CPU non nul
      const body = JSON.stringify({
        cpu_stats: {
          cpu_usage: { total_usage: c.cpuTotal },
          system_cpu_usage: (c.statsCallCount || 0) * 500_000_000,
          online_cpus: 4,
        },
        memory_stats: {
          usage: 100 * 1024 * 1024,
          limit: 1024 * 1024 * 1024,
          stats: { cache: 10 * 1024 * 1024 },
        },
        networks: { eth0: { rx_bytes: 1000, tx_bytes: 2000 } },
        blkio_stats: {
          io_service_bytes_recursive: [
            { op: "read", value: 10 },
            { op: "write", value: 5 },
          ],
        },
        pids_stats: { current: 3 },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(body);
    }

    const logsMatch = url.pathname.match(/^\/containers\/([^/]+)\/logs$/);
    if (logsMatch) {
      const c = findContainer(logsMatch[1]);
      if (!c) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ message: `No such container: ${logsMatch[1]}` }));
      }
      res.writeHead(200, { "Content-Type": "application/vnd.docker.multiplexed-stream" });
      const follow = url.searchParams.get("follow") === "1";
      writeFrame(res, 1, "2026-01-02T10:00:00.000000000Z ligne one\n");
      writeFrame(res, 2, "2026-01-02T10:00:01.000000000Z ligne erreur\n");
      if (!follow) return res.end();
      // En mode follow, on garde la connexion ouverte et on note le handle
      // pour permettre au test de fermer explicitement côté serveur
      // (simulation d'un conteneur supprimé pendant qu'on le suit).
      c._openLogRes = res;
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(SOCKET_PATH, () => resolve(server));
  });
}

function writeFrame(res, streamType, text) {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(payload.length, 4);
  res.write(Buffer.concat([header, payload]));
}

/** Attend le PREMIER instantané émis après avoir déclenché une collecte (start()). */
function nextSnapshot() {
  return new Promise((resolve) => {
    const unsubscribe = dockerService.onSnapshot((snapshot) => {
      unsubscribe();
      resolve(snapshot);
    });
    dockerService.start();
  });
}

/**
 * Démarre le poller et attend les `n` premiers instantanés (utilisé pour
 * observer un delta CPU entre deux échantillons "naturels" du poller,
 * plutôt que d'enchaîner stop()/start() à la main — qui course avec le
 * `finally { polling = false }` de tick() si on le fait trop vite).
 */
function nextSnapshots(n) {
  return new Promise((resolve) => {
    const collected = [];
    const unsubscribe = dockerService.onSnapshot((snapshot) => {
      collected.push(snapshot);
      if (collected.length >= n) {
        unsubscribe();
        resolve(collected);
      }
    });
    dockerService.start();
  });
}

let server;

test.before(async () => {
  if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  server = await startFakeDockerd();
});

test.after(() => {
  dockerService.stop();
  server.close();
  if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
});

test.beforeEach(() => {
  dockerService.stop(); // jamais deux collectes/backgrounds qui se chevauchent entre tests
});

test("Docker disponible — instantané avec un conteneur running", async () => {
  fakeState.up = true;
  fakeState.containers = [{ id: "c1", name: "postgres", image: "postgres:16", state: "running" }];

  const snapshot = await nextSnapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.containers.length, 1);
  assert.equal(snapshot.containers[0].name, "postgres");
  assert.equal(snapshot.containers[0].serverKey, "local");
  assert.equal(snapshot.containers[0].cpuPercent, 0); // premier échantillon vu par le poller pour ce conteneur
});

test("Docker disponible — un second tick calcule un %CPU non nul (delta entre deux échantillons)", async () => {
  fakeState.up = true;
  fakeState.containers = [{ id: "c2", name: "redis", state: "running" }];

  const [, second] = await nextSnapshots(2); // 1er tick : 0% (pas de delta) ; 2e tick : delta réel
  const redis = second.containers.find((c) => c.id === "c2");
  assert.ok(redis.cpuPercent > 0, `attendu un %CPU > 0, obtenu ${redis.cpuPercent}`);
  assert.equal(redis.memory.usageBytes, 100 * 1024 * 1024 - 10 * 1024 * 1024);
  assert.deepEqual(redis.network, { rxBytes: 1000, txBytes: 2000 });
  assert.deepEqual(redis.blockIo, { readBytes: 10, writeBytes: 5 });
  assert.equal(redis.pids, 3);
});

test("Docker disponible — conteneur arrêté (state != running) : pas de stats inventées", async () => {
  fakeState.up = true;
  fakeState.containers = [{ id: "c3", name: "old-job", state: "exited" }];

  const snapshot = await nextSnapshot();
  const c = snapshot.containers[0];
  assert.equal(c.state, "exited");
  assert.equal(c.cpuPercent, null);
  assert.deepEqual(c.memory, { usageBytes: null, limitBytes: null, percent: null });
  assert.equal(c.network, null);
});

test("Docker disponible — plusieurs conteneurs simultanément, tous rapportés", async () => {
  fakeState.up = true;
  fakeState.containers = [
    { id: "m1", name: "api", state: "running" },
    { id: "m2", name: "worker", state: "running" },
    { id: "m3", name: "nginx", state: "running" },
  ];
  const snapshot = await nextSnapshot();
  assert.equal(snapshot.containers.length, 3);
  assert.deepEqual(snapshot.containers.map((c) => c.name).sort(), ["api", "nginx", "worker"]);
});

test("Docker indisponible (daemon arrêté) — available:false, jamais d'exception", async () => {
  fakeState.up = false;
  fakeState.containers = [{ id: "c4", name: "whatever", state: "running" }];

  const snapshot = await nextSnapshot();
  assert.equal(snapshot.available, false);
  assert.deepEqual(snapshot.containers, []);
  assert.equal(dockerService.isAvailable(), false);

  fakeState.up = true; // remet le daemon en état pour les tests suivants
});

test("Docker indisponible — le fichier socket n'existe même pas (jamais d'exception)", async () => {
  // Cas différent de "daemon arrêté" ci-dessus (connexion refusée) : ici
  // ENOENT sur le socket lui-même, la panne la plus basique possible
  // ("Docker n'est pas installé" — section 1 du prompt maître).
  await new Promise((r) => server.close(r));
  if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);

  const snapshot = await nextSnapshot();
  assert.equal(snapshot.available, false);
  assert.deepEqual(snapshot.containers, []);

  server = await startFakeDockerd(); // restaure le faux daemon pour les tests suivants
});

test("fetchContainerFresh() — conteneur inexistant rejette proprement (pas de crash process)", async () => {
  fakeState.up = true;
  fakeState.containers = [];
  await assert.rejects(() => dockerService.fetchContainerFresh("does-not-exist"));
});

test("fetchLogsTail() — historique récupéré et démultiplexé (stdout + stderr, timestamps)", async () => {
  fakeState.up = true;
  fakeState.containers = [{ id: "l1", name: "logtest", state: "running" }];

  const lines = await dockerService.fetchLogsTail("l1", { tail: 50 });
  assert.deepEqual(
    lines.map((l) => l.type),
    ["out", "err"],
  );
  assert.equal(lines[0].text, "ligne one");
  assert.equal(lines[1].text, "ligne erreur");
  assert.ok(lines[0].at > 0); // timestamp parsé
});

test("fetchLogsTail() — conteneur inexistant rejette proprement", async () => {
  fakeState.up = true;
  fakeState.containers = [];
  await assert.rejects(() => dockerService.fetchLogsTail("ghost"));
});

test("subscribeToLogs() — reçoit les lignes en direct puis close() ferme le flux sans fuite", async () => {
  fakeState.up = true;
  fakeState.containers = [{ id: "s1", name: "streamtest", state: "running" }];

  const received = [];
  const handle = await dockerService.subscribeToLogs(
    "s1",
    (line) => received.push(line),
    () => {},
  );

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 2);
  assert.equal(received[0].type, "out");
  assert.equal(received[1].type, "err");

  handle.close();
  // Fermer deux fois ne doit jamais lever (voir docker-bus.js, qui peut
  // appeler close() depuis plusieurs chemins : disconnect + resub).
  assert.doesNotThrow(() => handle.close());
});

test("subscribeToLogs() — le conteneur disparaît pendant le suivi : onError appelé, pas de crash", async () => {
  fakeState.up = true;
  fakeState.containers = [{ id: "s2", name: "vanish", state: "running" }];

  const errors = [];
  await dockerService.subscribeToLogs(
    "s2",
    () => {},
    (err) => errors.push(err),
  );

  await new Promise((r) => setTimeout(r, 30));
  const c = findContainer("s2");
  assert.ok(c._openLogRes, "le faux daemon doit garder le flux ouvert (follow=1)");
  c._openLogRes.destroy(); // simule le conteneur supprimé / le daemon qui coupe la connexion

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(errors.length, 1);
});

test("subscribeToLogs() — conteneur inexistant rejette avant d'ouvrir un flux", async () => {
  fakeState.up = true;
  fakeState.containers = [];
  await assert.rejects(() =>
    dockerService.subscribeToLogs(
      "ghost",
      () => {},
      () => {},
    ),
  );
});
