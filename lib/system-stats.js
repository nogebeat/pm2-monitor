"use strict";

const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");

const IS_LINUX = process.platform === "linux";

// --- État interne pour calculer des taux (CPU %, réseau) entre 2 échantillons ---

let lastCpuTimes = null; // snapshot os.cpus() précédent
let lastNet = null; // { t, rx, tx }

// --- CPU % (moyenne tous coeurs, calculée par delta idle/total) -------------

function cpuPercent() {
  const cpus = os.cpus();
  const totals = cpus.map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });

  if (!lastCpuTimes) {
    lastCpuTimes = totals;
    return 0;
  }

  let idleDiff = 0;
  let totalDiff = 0;
  totals.forEach((t, i) => {
    const prev = lastCpuTimes[i] || t;
    idleDiff += t.idle - prev.idle;
    totalDiff += t.total - prev.total;
  });
  lastCpuTimes = totals;

  if (totalDiff <= 0) return 0;
  const usage = 1 - idleDiff / totalDiff;
  return Math.max(0, Math.min(100, Math.round(usage * 1000) / 10));
}

// --- RAM ----------------------------------------------------------------

function memory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    total,
    free,
    used,
    percent: total ? Math.round((used / total) * 1000) / 10 : 0,
  };
}

// --- Swap (Linux via /proc/meminfo) --------------------------------------

function swap() {
  if (!IS_LINUX) return null;
  try {
    const content = fs.readFileSync("/proc/meminfo", "utf8");
    const grab = (key) => {
      const m = content.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
      return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    const total = grab("SwapTotal");
    const free = grab("SwapFree");
    const used = total - free;
    return {
      total,
      free,
      used,
      percent: total ? Math.round((used / total) * 1000) / 10 : 0,
    };
  } catch (e) {
    return null;
  }
}

// --- Load average ---------------------------------------------------------

function loadAverage() {
  const [l1, l5, l15] = os.loadavg();
  return { "1m": l1, "5m": l5, "15m": l15, cores: os.cpus().length || 1 };
}

// --- Disque (df sur /) ------------------------------------------------------

function disk() {
  try {
    const out = execSync("df -kP / 2>/dev/null", { encoding: "utf8", timeout: 2000 });
    const lines = out.trim().split("\n");
    if (lines.length < 2) return null;
    const cols = lines[1].trim().split(/\s+/);
    // Filesystem 1024-blocks Used Available Capacity Mounted
    const totalKb = parseInt(cols[1], 10);
    const usedKb = parseInt(cols[2], 10);
    const availKb = parseInt(cols[3], 10);
    if (Number.isNaN(totalKb)) return null;
    return {
      total: totalKb * 1024,
      used: usedKb * 1024,
      free: availKb * 1024,
      percent: totalKb ? Math.round((usedKb / totalKb) * 1000) / 10 : 0,
      mount: cols[5] || "/",
    };
  } catch (e) {
    return null;
  }
}

// --- Réseau (Linux via /proc/net/dev, calcul de débit) ----------------------

function readNetTotals() {
  if (!IS_LINUX) return null;
  try {
    const content = fs.readFileSync("/proc/net/dev", "utf8");
    const lines = content.trim().split("\n").slice(2);
    let rx = 0;
    let tx = 0;
    lines.forEach((line) => {
      const [iface, rest] = line.split(":");
      if (!rest) return;
      const name = iface.trim();
      if (name === "lo") return; // on ignore le loopback
      const cols = rest.trim().split(/\s+/).map(Number);
      rx += cols[0] || 0; // rx bytes
      tx += cols[8] || 0; // tx bytes
    });
    return { rx, tx };
  } catch (e) {
    return null;
  }
}

function network() {
  const now = Date.now();
  const totals = readNetTotals();
  if (!totals) return null;

  if (!lastNet) {
    lastNet = { t: now, ...totals };
    return { rxRate: 0, txRate: 0, rxTotal: totals.rx, txTotal: totals.tx };
  }

  const dt = Math.max(0.001, (now - lastNet.t) / 1000);
  const rxRate = Math.max(0, (totals.rx - lastNet.rx) / dt); // octets/s
  const txRate = Math.max(0, (totals.tx - lastNet.tx) / dt);
  lastNet = { t: now, ...totals };

  return {
    rxRate: Math.round(rxRate),
    txRate: Math.round(txRate),
    rxTotal: totals.rx,
    txTotal: totals.tx,
  };
}

// --- Température CPU (Linux, /sys/class/thermal) ----------------------------

function cpuTemperature() {
  if (!IS_LINUX) return null;
  try {
    const zonesDir = "/sys/class/thermal";
    if (!fs.existsSync(zonesDir)) return null;
    const zones = fs.readdirSync(zonesDir).filter((z) => z.startsWith("thermal_zone"));
    const readings = [];
    zones.forEach((zone) => {
      try {
        const typePath = `${zonesDir}/${zone}/type`;
        const tempPath = `${zonesDir}/${zone}/temp`;
        const type = fs.existsSync(typePath) ? fs.readFileSync(typePath, "utf8").trim() : "";
        const raw = parseInt(fs.readFileSync(tempPath, "utf8").trim(), 10);
        if (Number.isNaN(raw)) return;
        const celsius = raw > 1000 ? raw / 1000 : raw; // certaines plateformes exposent déjà en °C
        readings.push({ zone: type || zone, celsius: Math.round(celsius * 10) / 10 });
      } catch (e) {
        /* zone illisible, on ignore */
      }
    });
    if (!readings.length) return null;
    // On privilégie une zone "cpu"/"x86_pkg_temp"/"soc" si trouvée, sinon moyenne
    const preferred = readings.find((r) => /cpu|pkg|soc/i.test(r.zone));
    const avg = readings.reduce((s, r) => s + r.celsius, 0) / readings.length;
    return {
      celsius: preferred ? preferred.celsius : Math.round(avg * 10) / 10,
      zones: readings,
    };
  } catch (e) {
    return null;
  }
}

// --- Nombre de process système ----------------------------------------------

function processCount() {
  try {
    if (IS_LINUX) {
      const entries = fs.readdirSync("/proc").filter((e) => /^\d+$/.test(e));
      if (entries.length) return entries.length;
    }
    const out = execSync(process.platform === "win32" ? "tasklist /NH" : "ps -e", {
      encoding: "utf8",
      timeout: 2000,
    });
    return out.trim().split("\n").length;
  } catch (e) {
    return null;
  }
}

// --- Snapshot complet ---------------------------------------------------

function snapshot() {
  return {
    t: Date.now(),
    cpu: cpuPercent(),
    mem: memory(),
    swap: swap(),
    load: loadAverage(),
    disk: disk(),
    net: network(),
    temp: cpuTemperature(),
    processes: processCount(),
    platform: process.platform,
  };
}

module.exports = {
  snapshot,
  cpuPercent,
  memory,
  swap,
  loadAverage,
  disk,
  network,
  cpuTemperature,
  processCount,
};
