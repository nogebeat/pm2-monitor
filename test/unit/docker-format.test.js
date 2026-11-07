"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fmtContainer,
  computeCpuPercent,
  computeMemory,
  computeNetwork,
  computeBlockIo,
  pidsCount,
} = require("../../lib/services/docker/format");

/**
 * Tests unitaires Phase 22 (Docker Monitoring) — fonctions pures, aucun
 * accès réseau/socket ici (voir test/integration/docker-service.test.js
 * pour le comportement bout-en-bout contre un faux daemon Docker).
 */

test("fmtContainer() — normalise une entrée de GET /containers/json", () => {
  const raw = {
    Id: "abc123",
    Names: ["/postgres"],
    Image: "postgres:16",
    State: "running",
    Status: "Up 2 hours",
    Created: 1_700_000_000, // secondes epoch
    Ports: [{ PrivatePort: 5432, PublicPort: 5432, Type: "tcp", IP: "0.0.0.0" }],
    Labels: { app: "lrpc" },
  };
  const out = fmtContainer(raw);
  assert.equal(out.id, "abc123");
  assert.equal(out.name, "postgres"); // slash de tête retiré
  assert.equal(out.image, "postgres:16");
  assert.equal(out.state, "running");
  assert.equal(out.created, 1_700_000_000_000); // converti en ms
  assert.deepEqual(out.ports, [{ privatePort: 5432, publicPort: 5432, type: "tcp", ip: "0.0.0.0" }]);
  assert.deepEqual(out.labels, { app: "lrpc" });
});

test("fmtContainer() — champs absents jamais inventés (ports/labels/created)", () => {
  const out = fmtContainer({ Id: "x", Names: ["/x"], Image: "x", State: "exited", Status: "" });
  assert.equal(out.created, null);
  assert.deepEqual(out.ports, []);
  assert.deepEqual(out.labels, {});
});

test("computeCpuPercent() — 0 au premier échantillon (pas encore de delta possible)", () => {
  const stats = { cpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 2000, online_cpus: 2 } };
  assert.equal(computeCpuPercent(stats, null), 0);
});

test("computeCpuPercent() — formule docker stats (cpuDelta/systemDelta * nbCpu * 100)", () => {
  const previous = {
    cpu_stats: {
      cpu_usage: { total_usage: 1_000_000_000 },
      system_cpu_usage: 10_000_000_000,
      online_cpus: 4,
    },
  };
  const current = {
    cpu_stats: {
      cpu_usage: { total_usage: 1_200_000_000 },
      system_cpu_usage: 10_500_000_000,
      online_cpus: 4,
    },
  };
  // cpuDelta=200_000_000, systemDelta=500_000_000 -> (200/500)*4*100 = 160%
  assert.equal(computeCpuPercent(current, previous), 160);
});

test("computeCpuPercent() — nombre de CPU dérivé de percpu_usage si online_cpus absent", () => {
  const previous = {
    cpu_stats: { cpu_usage: { total_usage: 0, percpu_usage: [0, 0] }, system_cpu_usage: 0 },
  };
  const current = {
    cpu_stats: { cpu_usage: { total_usage: 100, percpu_usage: [50, 50] }, system_cpu_usage: 1000 },
  };
  assert.equal(computeCpuPercent(current, previous), 20); // (100/1000)*2*100
});

test("computeCpuPercent() — jamais négatif ni NaN sur des données incohérentes", () => {
  const previous = { cpu_stats: { cpu_usage: { total_usage: 500 }, system_cpu_usage: 500 } };
  const current = { cpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 } }; // recul du compteur
  assert.equal(computeCpuPercent(current, previous), 0);
  assert.equal(computeCpuPercent({}, previous), 0); // stats malformés -> 0, jamais une exception
});

test("computeMemory() — soustrait le cache (cgroup v1) de l'usage brut", () => {
  const out = computeMemory({ memory_stats: { usage: 1000, limit: 4000, stats: { cache: 300 } } });
  assert.deepEqual(out, { usageBytes: 700, limitBytes: 4000, percent: 17.5 });
});

test("computeMemory() — cgroup v2 (inactive_file) si cache absent", () => {
  const out = computeMemory({ memory_stats: { usage: 1000, limit: 4000, stats: { inactive_file: 100 } } });
  assert.equal(out.usageBytes, 900);
});

test("computeMemory() — pas de valeur inventée si memory_stats absent", () => {
  assert.deepEqual(computeMemory({}), { usageBytes: null, limitBytes: null, percent: null });
});

test("computeNetwork() — somme toutes les interfaces, null si absent", () => {
  const out = computeNetwork({
    networks: { eth0: { rx_bytes: 100, tx_bytes: 50 }, eth1: { rx_bytes: 10, tx_bytes: 5 } },
  });
  assert.deepEqual(out, { rxBytes: 110, txBytes: 55 });
  assert.equal(computeNetwork({}), null);
  assert.equal(computeNetwork({ networks: {} }), null);
});

test("computeBlockIo() — somme read/write insensible à la casse (Read/Write vs read/write)", () => {
  const out = computeBlockIo({
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: "Read", value: 100 },
        { op: "write", value: 40 },
        { op: "Read", value: 20 },
      ],
    },
  });
  assert.deepEqual(out, { readBytes: 120, writeBytes: 40 });
  assert.equal(computeBlockIo({}), null);
});

test("pidsCount() — pas de valeur inventée si pids_stats absent", () => {
  assert.equal(pidsCount({ pids_stats: { current: 12 } }), 12);
  assert.equal(pidsCount({}), null);
});
