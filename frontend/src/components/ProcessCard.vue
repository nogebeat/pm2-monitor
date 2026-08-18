<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import Chart from "chart.js/auto";
import { useI18n } from "vue-i18n";
import { state, selectProcess, runProcessAction, can, loadProcessMetrics } from "../store";
import { apiPost } from "../api";
import { notifyError } from "../store";
import { fmtMem, fmtUptime } from "../format";

const { t, locale } = useI18n();

const props = defineProps({
  process: { type: Object, required: true },
});

const isActive = computed(() => state.selected === props.process.id);
const errCount = computed(() => state.errCounts[props.process.id] || 0);

const bars = computed(() => {
  const hist = state.cpuHistory[props.process.id] || [];
  const maxCpu = Math.max(10, ...hist);
  return hist.map((v) => Math.max(6, (v / maxCpu) * 100));
});

function select() {
  selectProcess(props.process.id);
}

function quickAction(action) {
  if (action === "reload") {
    return apiPost(`/api/processes/${props.process.id}/reload`).catch(notifyError);
  }
  runProcessAction(props.process.id, action);
}

function openMore() {
  state.modal = { type: "more", process: props.process };
}

const canAny = (...actions) => actions.some((a) => can(a, props.process.name));

// --- Onglet "Metrics" : historique CPU/RAM/restarts (lib/services/process-history/) ---

const metricsOpen = ref(false);
const metricsRange = ref("1h");
const metricsCanvas = ref(null);
let metricsChart = null;

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

async function refreshMetricsChart() {
  if (!metricsOpen.value) return;
  try {
    const r = await loadProcessMetrics(props.process.id, metricsRange.value);
    await nextTick();
    if (!metricsCanvas.value) return;
    const c = chartColors();
    const labels = r.points.map((p) => new Date(p.ts).toLocaleTimeString(locale.value === "fr" ? "fr-FR" : "en-US", { hour12: false }));
    const cpuData = r.points.map((p) => (p.cpu ?? p.cpuAvg ?? null));
    const memData = r.points.map((p) => {
      const bytes = p.memory ?? p.memoryAvg ?? null;
      return bytes === null ? null : Math.round((bytes / (1024 * 1024)) * 10) / 10;
    });

    if (metricsChart) metricsChart.destroy();
    metricsChart = new Chart(metricsCanvas.value, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "CPU %", data: cpuData, borderColor: c.accent, backgroundColor: "transparent", tension: 0.25, pointRadius: 0, borderWidth: 1.6, yAxisID: "y" },
          { label: "MEM Mo", data: memData, borderColor: c.online, backgroundColor: "transparent", tension: 0.25, pointRadius: 0, borderWidth: 1.6, yAxisID: "y1" },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { ticks: { color: c.text, maxTicksLimit: 6, font: { family: "JetBrains Mono", size: 9 } }, grid: { color: c.grid } },
          y: { position: "left", ticks: { color: c.text, font: { size: 9 } }, grid: { color: c.grid } },
          y1: { position: "right", ticks: { color: c.text, font: { size: 9 } }, grid: { display: false } },
        },
        plugins: { legend: { labels: { color: c.text, font: { family: "Space Grotesk", size: 10 } } } },
      },
    });
  } catch (e) {
    // Historique indisponible (PROCESS_HISTORY_ENABLED=0, ou pas encore de données) : pas bloquant.
  }
}

function toggleMetrics() {
  metricsOpen.value = !metricsOpen.value;
  if (metricsOpen.value) refreshMetricsChart();
}

function setMetricsRange(range) {
  metricsRange.value = range;
  refreshMetricsChart();
}

onBeforeUnmount(() => {
  if (metricsChart) metricsChart.destroy();
});

watch(
  () => document.documentElement.getAttribute("data-theme"),
  () => refreshMetricsChart()
);
</script>

<template>
  <div class="proc-card" :class="{ active: isActive }" @click="select">
    <div class="proc-card-top">
      <div class="proc-name">
        <span class="status-dot" :class="`status-${process.status}`"></span>
        <span class="label">{{ process.name }}</span>
      </div>
      <div style="display:flex; align-items:center; gap:6px;">
        <span v-if="errCount" class="err-badge">{{ errCount }}</span>
        <span class="proc-id">#{{ process.id }}</span>
      </div>
    </div>

    <div class="proc-meta">
      <span>CPU <b>{{ process.cpu }}%</b></span>
      <span>MEM <b>{{ fmtMem(process.memory) }}</b></span>
      <span>↻ <b>{{ process.restarts }}</b></span>
      <span>{{ fmtUptime(process.uptime) }}</span>
      <span>{{ process.execMode }}{{ process.instances > 1 ? " x" + process.instances : "" }}</span>
      <span v-if="process.watching" :title="t('processCard.watchActive')">👁</span>
    </div>

    <div class="vitals">
      <span v-for="(h, i) in bars" :key="i" :style="{ height: h + '%' }"></span>
    </div>

    <div class="proc-actions">
      <button v-if="can('start', process.name)" class="go" @click.stop="quickAction('start')">{{ t("processCard.start") }}</button>
      <button v-if="can('restart', process.name)" @click.stop="quickAction('restart')">{{ t("processCard.restart") }}</button>
      <button v-if="can('reload', process.name)" @click.stop="quickAction('reload')">{{ t("processCard.reload") }}</button>
      <button v-if="can('stop', process.name)" class="danger" @click.stop="quickAction('stop')">{{ t("processCard.stop") }}</button>
      <button
        v-if="can('view', process.name)"
        class="more"
        :class="{ active: metricsOpen }"
        @click.stop="toggleMetrics"
      >
        📈 {{ t("processCard.metrics") }}
      </button>
      <button
        v-if="canAny('scale', 'watch', 'env', 'config', 'flush', 'reset', 'delete')"
        class="more"
        @click.stop="openMore"
      >
        ⋯ {{ t("processCard.more") }}
      </button>
    </div>

    <div v-if="metricsOpen" class="proc-metrics-panel" @click.stop>
      <div class="chart-head">
        <div class="filter-group" role="group" :aria-label="t('processCard.rangeLabel')">
          <button
            v-for="r in ['1h', '6h', '24h', '7d', '30d']"
            :key="r"
            class="filter-btn"
            :class="{ active: metricsRange === r }"
            @click="setMetricsRange(r)"
          >
            {{ r }}
          </button>
        </div>
      </div>
      <div class="chart-wrap proc-chart-wrap"><canvas ref="metricsCanvas"></canvas></div>
    </div>
  </div>
</template>
