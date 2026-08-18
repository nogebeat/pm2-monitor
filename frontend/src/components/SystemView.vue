<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Chart from "chart.js/auto";
import { useI18n } from "vue-i18n";
import { state, loadHistoryChart } from "../store";
import { fmtRate } from "../format";

const { t, locale } = useI18n();

const snap = computed(() => state.system);

const historyCanvas = ref(null);
const networkCanvas = ref(null);
let historyChart = null;
let networkChart = null;

function chartColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    accent: styles.getPropertyValue("--accent").trim(),
    online: styles.getPropertyValue("--online").trim(),
    warn: styles.getPropertyValue("--warn").trim(),
    text: styles.getPropertyValue("--text-muted").trim(),
    grid: styles.getPropertyValue("--border").trim(),
  };
}

function chartOptions(c, unitLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { ticks: { color: c.text, maxTicksLimit: 8, font: { family: "JetBrains Mono", size: 10 } }, grid: { color: c.grid } },
      y: { ticks: { color: c.text, font: { family: "JetBrains Mono", size: 10 }, callback: (v) => v + (unitLabel === "%" ? "%" : "") }, grid: { color: c.grid } },
    },
    plugins: {
      legend: { labels: { color: c.text, font: { family: "Space Grotesk", size: 11 } } },
    },
  };
}

async function refreshCharts() {
  try {
    const r = await loadHistoryChart(state.historyRange);
    const labels = r.samples.map((s) => new Date(s.t).toLocaleTimeString(locale.value === "fr" ? "fr-FR" : "en-US", { hour12: false }));
    const c = chartColors();

    const cpuData = r.samples.map((s) => s.cpu);
    const memData = r.samples.map((s) => s.memPercent);
    const rxData = r.samples.map((s) => (s.netRx || 0) / 1024);
    const txData = r.samples.map((s) => (s.netTx || 0) / 1024);

    if (!historyCanvas.value || !networkCanvas.value) return;

    if (historyChart) historyChart.destroy();
    historyChart = new Chart(historyCanvas.value, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "CPU %", data: cpuData, borderColor: c.accent, backgroundColor: "transparent", tension: 0.25, pointRadius: 0, borderWidth: 1.8 },
          { label: "RAM %", data: memData, borderColor: c.online, backgroundColor: "transparent", tension: 0.25, pointRadius: 0, borderWidth: 1.8 },
        ],
      },
      options: chartOptions(c, "%"),
    });

    if (networkChart) networkChart.destroy();
    networkChart = new Chart(networkCanvas.value, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "↓ Ko/s", data: rxData, borderColor: c.accent, backgroundColor: "transparent", tension: 0.25, pointRadius: 0, borderWidth: 1.8 },
          { label: "↑ Ko/s", data: txData, borderColor: c.warn, backgroundColor: "transparent", tension: 0.25, pointRadius: 0, borderWidth: 1.8 },
        ],
      },
      options: chartOptions(c, "Ko/s"),
    });
  } catch (e) {
    /* API d'historique indisponible : les cartes de métriques temps réel restent affichées */
  }
}

function setRange(range) {
  state.historyRange = range;
  refreshCharts();
}

onMounted(() => {
  refreshCharts();
});

onBeforeUnmount(() => {
  if (historyChart) historyChart.destroy();
  if (networkChart) networkChart.destroy();
});

watch(
  () => document.documentElement.getAttribute("data-theme"),
  () => refreshCharts()
);
</script>

<template>
  <main class="system-view">
    <div class="system-grid">
      <div class="metric-card">
        <span class="metric-label">{{ t("system.load") }}</span>
        <div class="metric-value">{{ snap?.load ? snap.load["1m"].toFixed(2) : "–" }}</div>
        <div class="metric-sub">
          {{ snap?.load ? t("system.loadSub", { m1: snap.load["1m"].toFixed(2), m5: snap.load["5m"].toFixed(2), m15: snap.load["15m"].toFixed(2), cores: snap.load.cores }) : t("system.loadShort") }}
        </div>
      </div>
      <div class="metric-card">
        <span class="metric-label">{{ t("system.ram") }}</span>
        <div class="metric-value">{{ snap?.mem ? snap.mem.percent + "%" : "–" }}</div>
        <div class="bar"><div class="bar-fill" :style="{ width: (snap?.mem?.percent || 0) + '%' }"></div></div>
      </div>
      <div class="metric-card">
        <span class="metric-label">{{ t("system.swap") }}</span>
        <div class="metric-value">{{ snap?.swap ? (snap.swap.total ? snap.swap.percent + "%" : t("system.noSwap")) : "–" }}</div>
        <div class="bar"><div class="bar-fill warn" :style="{ width: (snap?.swap?.percent || 0) + '%' }"></div></div>
      </div>
      <div class="metric-card">
        <span class="metric-label">{{ t("system.disk") }}</span>
        <div class="metric-value">{{ snap?.disk ? snap.disk.percent + "%" : "–" }}</div>
        <div class="bar">
          <div
            class="bar-fill"
            :class="{ danger: (snap?.disk?.percent || 0) > 90, warn: (snap?.disk?.percent || 0) > 75 && (snap?.disk?.percent || 0) <= 90 }"
            :style="{ width: (snap?.disk?.percent || 0) + '%' }"
          ></div>
        </div>
      </div>
      <div class="metric-card">
        <span class="metric-label">{{ t("system.cpuTemp") }}</span>
        <div class="metric-value">{{ snap?.temp ? snap.temp.celsius + "°C" : t("system.notAvailable") }}</div>
        <div class="metric-sub">{{ t("system.linuxOnly") }}</div>
      </div>
      <div class="metric-card">
        <span class="metric-label">{{ t("system.networkBandwidth") }}</span>
        <div class="metric-value">{{ snap?.net ? `↓ ${fmtRate(snap.net.rxRate)}` : "–" }}</div>
        <div class="metric-sub">{{ snap?.net ? `↑ ${fmtRate(snap.net.txRate)}` : t("system.netHint") }}</div>
      </div>
      <div class="metric-card">
        <span class="metric-label">{{ t("system.systemProcesses") }}</span>
        <div class="metric-value">{{ snap?.processes ?? "–" }}</div>
        <div class="metric-sub">{{ t("system.systemProcessesSub") }}</div>
      </div>
      <div class="metric-card">
        <span class="metric-label">{{ t("system.cpuCores") }}</span>
        <div class="metric-value">{{ snap?.load ? snap.load.cores : "–" }}</div>
      </div>
    </div>

    <div class="chart-panel">
      <div class="chart-head">
        <h2>{{ t("system.cpuRamHistory") }}</h2>
        <div class="filter-group" role="group" :aria-label="t('system.rangeLabel')">
          <button class="filter-btn" :class="{ active: state.historyRange === '1h' }" @click="setRange('1h')">1h</button>
          <button class="filter-btn" :class="{ active: state.historyRange === '6h' }" @click="setRange('6h')">6h</button>
          <button class="filter-btn" :class="{ active: state.historyRange === '24h' }" @click="setRange('24h')">24h</button>
        </div>
      </div>
      <div class="chart-wrap"><canvas ref="historyCanvas"></canvas></div>
    </div>

    <div class="chart-panel">
      <div class="chart-head">
        <h2>{{ t("system.networkHistory") }}</h2>
      </div>
      <div class="chart-wrap"><canvas ref="networkCanvas"></canvas></div>
    </div>
  </main>
</template>
