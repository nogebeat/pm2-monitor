"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMetricsText } = require("../../lib/services/metrics/registry");

const ONLINE_PROCESS = {
  name: "api",
  status: "online",
  cpu: 12.5,
  memory: 104857600,
  restarts: 3,
  uptime: Date.now() - 60_000, // démarré il y a 60s
};

test("buildMetricsText() — format Prometheus valide (HELP/TYPE avant les échantillons)", () => {
  const text = buildMetricsText({ localProcesses: [ONLINE_PROCESS] });
  const lines = text.trim().split("\n");
  assert.ok(lines.length > 0);
  // Chaque métrique doit être précédée de son HELP puis son TYPE.
  const idx = lines.findIndex((l) => l.startsWith("# HELP pm2_monitor_process_cpu_percent"));
  assert.ok(idx >= 0, "HELP manquant pour pm2_monitor_process_cpu_percent");
  assert.match(lines[idx + 1], /^# TYPE pm2_monitor_process_cpu_percent gauge$/);
  assert.match(lines[idx + 2], /^pm2_monitor_process_cpu_percent\{/);
});

test("buildMetricsText() — métriques process attendues, avec les bons labels", () => {
  const text = buildMetricsText({ localProcesses: [ONLINE_PROCESS] });

  assert.match(
    text,
    /pm2_monitor_process_cpu_percent\{process="api",server="local",environment="production"\} 12\.5/,
  );
  assert.match(
    text,
    /pm2_monitor_process_memory_bytes\{process="api",server="local",environment="production"\} 104857600/,
  );
  assert.match(
    text,
    /pm2_monitor_process_restarts_total\{process="api",server="local",environment="production"\} 3/,
  );
  assert.match(
    text,
    /pm2_monitor_process_status\{process="api",server="local",environment="production",status="online"\} 1/,
  );
  // uptime > 0 pour un process online avec un pm_uptime passé
  assert.match(text, /pm2_monitor_process_uptime_seconds\{[^}]+\} (?!0$)\d+/);
});

test("buildMetricsText() — un process non-online a un uptime à 0, pas de valeur inventée", () => {
  const text = buildMetricsText({
    localProcesses: [{ name: "worker", status: "stopped", cpu: 0, memory: 0, restarts: 0, uptime: null }],
  });
  assert.match(text, /pm2_monitor_process_uptime_seconds\{[^}]+\} 0/);
  assert.match(text, /pm2_monitor_process_status\{[^}]+status="stopped"[^}]*\} 1/);
});

test("buildMetricsText() — métriques système (cpu/mémoire/disque) avec labels server/environment", () => {
  const text = buildMetricsText({
    localSystem: {
      cpu: 55,
      mem: { used: 1000, total: 2000, percent: 50 },
      disk: { used: 300, total: 1000, percent: 30 },
    },
  });
  assert.match(text, /pm2_monitor_system_cpu_percent\{server="local",environment="production"\} 55/);
  assert.match(text, /pm2_monitor_system_memory_used_bytes\{server="local",environment="production"\} 1000/);
  assert.match(text, /pm2_monitor_system_memory_percent\{server="local",environment="production"\} 50/);
  assert.match(text, /pm2_monitor_system_disk_percent\{server="local",environment="production"\} 30/);
});

test("buildMetricsText() — multi-serveur (Phase 10) : labels server/environment corrects par serveur", () => {
  const remoteProcessesByServer = new Map([
    ["srv_abc", [{ name: "worker", status: "online", cpu: 5, memory: 50, restarts: 0, uptime: null }]],
  ]);
  const text = buildMetricsText({
    localProcesses: [ONLINE_PROCESS],
    servers: [
      { serverKey: "local", environment: "production", kind: "local", status: "ONLINE" },
      { serverKey: "srv_abc", environment: "staging", kind: "agent", status: "ONLINE" },
    ],
    remoteProcessesByServer,
  });

  assert.match(
    text,
    /pm2_monitor_process_cpu_percent\{process="worker",server="srv_abc",environment="staging"\} 5/,
  );
  assert.match(
    text,
    /pm2_monitor_server_status\{server="srv_abc",environment="staging",kind="agent",status="ONLINE"\} 1/,
  );
});

test("buildMetricsText() — cardinalité raisonnable : une seule série de statut par entité (pas une par état possible)", () => {
  const text = buildMetricsText({ localProcesses: [ONLINE_PROCESS] });
  const statusLines = text.split("\n").filter((l) => l.startsWith("pm2_monitor_process_status{"));
  assert.equal(statusLines.length, 1);
});

test("buildMetricsText() — alertes actives comptées par sévérité + target_type/target réels, sans label server (non supporté par le moteur d'alertes)", () => {
  const text = buildMetricsText({
    alerts: [
      { severity: "critical", targetType: "process", targetValue: "api", state: "active" },
      { severity: "critical", targetType: "process", targetValue: "api", state: "acknowledged" },
      { severity: "warning", targetType: "system", targetValue: null, state: "active" },
      { severity: "warning", targetType: "health_check", targetValue: "api-http", state: "active" },
    ],
  });
  assert.match(text, /pm2_monitor_alerts_active\{severity="critical",target_type="process",target="api"\} 2/);
  assert.match(text, /pm2_monitor_alerts_active\{severity="warning",target_type="system"\} 1/);
  assert.match(
    text,
    /pm2_monitor_alerts_active\{severity="warning",target_type="health_check",target="api-http"\} 1/,
  );
  assert.ok(!text.includes('server="local"'), "aucun label server sur les métriques d'alerte");
});

test("buildMetricsText() — health checks exposés avec un statut courant", () => {
  const text = buildMetricsText({
    healthChecks: [{ name: "api-http", enabled: true, status: "UP" }],
  });
  assert.match(text, /pm2_monitor_healthcheck_status\{check="api-http",enabled="true",status="UP"\} 1/);
});

test("buildMetricsText() — aucun secret exposé (env, tokens, credentials) même si présents dans les données sources", () => {
  const text = buildMetricsText({
    localProcesses: [
      {
        ...ONLINE_PROCESS,
        env: { DB_PASSWORD: "super-secret", API_KEY: "abcd1234" },
        script: "/srv/app/index.js",
      },
    ],
    servers: [
      { serverKey: "local", environment: "production", kind: "local", status: "ONLINE", hasToken: true },
    ],
  });
  assert.ok(!text.includes("super-secret"));
  assert.ok(!text.includes("abcd1234"));
  assert.ok(!text.includes("DB_PASSWORD"));
});

test("buildMetricsText() — pm2_monitor_up et build_info toujours présents", () => {
  const text = buildMetricsText({ appVersion: "9.9.9" });
  assert.match(text, /pm2_monitor_up 1/);
  assert.match(text, /pm2_monitor_build_info\{version="9\.9\.9"\} 1/);
});
