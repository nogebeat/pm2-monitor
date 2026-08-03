"use strict";

const fs = require("fs");
const path = require("path");

const SAMPLE_INTERVAL_MS = 5000; // 1 échantillon toutes les 5s
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // on garde 24h de données
const MAX_SAMPLES = Math.ceil(MAX_AGE_MS / SAMPLE_INTERVAL_MS); // ~17280 échantillons
const PERSIST_EVERY_MS = 60 * 1000;
const PERSIST_PATH = path.join(__dirname, "..", "data", "history.json");

class HistoryStore {
  constructor() {
    this.samples = []; // [{t, cpu, memPercent, load1, netRx, netTx, swapPercent, temp, diskPercent}]
    this._load();
    this._persistTimer = setInterval(() => this._persist(), PERSIST_EVERY_MS);
    this._persistTimer.unref?.();
  }

  push(snapshot) {
    this.samples.push({
      t: snapshot.t,
      cpu: snapshot.cpu,
      memPercent: snapshot.mem ? snapshot.mem.percent : null,
      load1: snapshot.load ? snapshot.load["1m"] : null,
      netRx: snapshot.net ? snapshot.net.rxRate : null,
      netTx: snapshot.net ? snapshot.net.txRate : null,
      swapPercent: snapshot.swap ? snapshot.swap.percent : null,
      temp: snapshot.temp ? snapshot.temp.celsius : null,
      diskPercent: snapshot.disk ? snapshot.disk.percent : null,
    });

    // purge : on retire ce qui dépasse MAX_AGE_MS ou MAX_SAMPLES
    const cutoff = Date.now() - MAX_AGE_MS;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    }
  }

  /**
   * range: "1h" | "6h" | "24h"
   * maxPoints: nombre max de points renvoyés (downsampling par moyenne de buckets)
   */
  query(range = "1h", maxPoints = 240) {
    const rangeMs = { "1h": 3600e3, "6h": 6 * 3600e3, "24h": 24 * 3600e3 }[range] || 3600e3;
    const cutoff = Date.now() - rangeMs;
    const filtered = this.samples.filter((s) => s.t >= cutoff);

    if (filtered.length <= maxPoints) return filtered;

    // downsampling : moyenne par bucket
    const bucketSize = Math.ceil(filtered.length / maxPoints);
    const out = [];
    for (let i = 0; i < filtered.length; i += bucketSize) {
      const bucket = filtered.slice(i, i + bucketSize);
      out.push(avgBucket(bucket));
    }
    return out;
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(PERSIST_PATH), { recursive: true });
      // on ne persiste pas plus que MAX_SAMPLES, déjà garanti par push()
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(this.samples));
    } catch (e) {
      console.warn("Impossible de persister l'historique système :", e.message);
    }
  }

  _load() {
    try {
      if (!fs.existsSync(PERSIST_PATH)) return;
      const raw = JSON.parse(fs.readFileSync(PERSIST_PATH, "utf8"));
      const cutoff = Date.now() - MAX_AGE_MS;
      if (Array.isArray(raw)) {
        this.samples = raw.filter((s) => s && s.t >= cutoff);
      }
    } catch (e) {
      console.warn("Historique système illisible, on repart de zéro :", e.message);
    }
  }
}

function avgBucket(bucket) {
  const n = bucket.length;
  const sum = (key) => {
    const vals = bucket.map((b) => b[key]).filter((v) => v !== null && v !== undefined);
    if (!vals.length) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  };
  return {
    t: bucket[Math.floor(n / 2)].t,
    cpu: sum("cpu"),
    memPercent: sum("memPercent"),
    load1: sum("load1"),
    netRx: sum("netRx"),
    netTx: sum("netTx"),
    swapPercent: sum("swapPercent"),
    temp: sum("temp"),
    diskPercent: sum("diskPercent"),
  };
}

module.exports = { HistoryStore, SAMPLE_INTERVAL_MS };
