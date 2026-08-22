<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import Chart from "chart.js/auto";
import { useI18n } from "vue-i18n";
import {
  state,
  selectProcess,
  runProcessAction,
  can,
  loadProcessMetrics,
  loadProcessAnalytics,
} from "../store";
import { apiPost } from "../api";
import { notifyError } from "../store";
import { fmtMem, fmtUptime, fmtBytes } from "../format";

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
    const labels = r.points.map((p) =>
      new Date(p.ts).toLocaleTimeString(locale.value === "fr" ? "fr-FR" : "en-US", { hour12: false }),
    );
    const cpuData = r.points.map((p) => p.cpu ?? p.cpuAvg ?? null);
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
          {
            label: "CPU %",
            data: cpuData,
            borderColor: c.accent,
            backgroundColor: "transparent",
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 1.6,
            yAxisID: "y",
          },
          {
            label: "MEM Mo",
            data: memData,
            borderColor: c.online,
            backgroundColor: "transparent",
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 1.6,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            ticks: { color: c.text, maxTicksLimit: 6, font: { family: "JetBrains Mono", size: 9 } },
            grid: { color: c.grid },
          },
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

// --- Analytics (Phase 11) : stats de la période + comparaison précédente ---

const analytics = ref(null);
const analyticsError = ref(false);

function fmtDelta(pct) {
  if (pct === null || pct === undefined) return "";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct}%`;
}

function deltaClass(pct, invert = false) {
  if (pct === null || pct === undefined || pct === 0) return "delta-flat";
  const good = invert ? pct < 0 : pct > 0;
  return good ? "delta-up" : "delta-down";
}

function fmtPct(v) {
  return v === null || v === undefined ? null : `${v}%`;
}

function fmtMs(v) {
  return v === null || v === undefined ? null : `${v} ms`;
}

const analyticsSamples = computed(() => analytics.value?.current?.sampleCount || 0);
const hasAnalyticsData = computed(() => analyticsSamples.value > 0);
// Heap/event-loop-lag : best-effort côté backend (voir lib/process-helpers.js#readAxmMetrics),
// non affichés si le process n'expose jamais ces métriques sur toute la période.
const hasHeapData = computed(
  () =>
    analytics.value?.current?.heapUsed?.avg !== null && analytics.value?.current?.heapUsed?.avg !== undefined,
);
const hasEventLoopData = computed(
  () =>
    analytics.value?.current?.eventLoopLag?.avg !== null &&
    analytics.value?.current?.eventLoopLag?.avg !== undefined,
);

async function refreshAnalytics() {
  if (!metricsOpen.value) return;
  analyticsError.value = false;
  try {
    analytics.value = await loadProcessAnalytics(props.process.id, metricsRange.value);
  } catch (e) {
    analytics.value = null;
    analyticsError.value = true;
  }
}

function toggleMetrics() {
  metricsOpen.value = !metricsOpen.value;
  if (metricsOpen.value) {
    refreshMetricsChart();
    refreshAnalytics();
  }
}

function setMetricsRange(range) {
  metricsRange.value = range;
  refreshMetricsChart();
  refreshAnalytics();
}

onBeforeUnmount(() => {
  if (metricsChart) metricsChart.destroy();
});

watch(
  () => document.documentElement.getAttribute("data-theme"),
  () => refreshMetricsChart(),
);
</script>

<template>
  <div class="proc-card" :class="{ active: isActive }" @click="select">
    <div class="proc-card-top">
      <div class="proc-name">
        <span class="status-dot" :class="`status-${process.status}`"></span>
        <span class="label">{{ process.name }}</span>
      </div>
      <div style="display: flex; align-items: center; gap: 6px">
        <span v-if="errCount" class="err-badge">{{ errCount }}</span>
        <span class="proc-id">#{{ process.id }}</span>
      </div>
    </div>

    <div class="proc-meta">
      <span
        >CPU <b>{{ process.cpu }}%</b></span
      >
      <span
        >MEM <b>{{ fmtMem(process.memory) }}</b></span
      >
      <span
        >↻ <b>{{ process.restarts }}</b></span
      >
      <span>{{ fmtUptime(process.uptime) }}</span>
      <span>{{ process.execMode }}{{ process.instances > 1 ? " x" + process.instances : "" }}</span>
      <span v-if="process.watching" :title="t('processCard.watchActive')">👁</span>
    </div>

    <div class="vitals">
      <span v-for="(h, i) in bars" :key="i" :style="{ height: h + '%' }"></span>
    </div>

    <div class="proc-actions">
      <button v-if="can('start', process.name)" class="go" @click.stop="quickAction('start')">
        {{ t("processCard.start") }}
      </button>
      <button v-if="can('restart', process.name)" @click.stop="quickAction('restart')">
        {{ t("processCard.restart") }}
      </button>
      <button v-if="can('reload', process.name)" @click.stop="quickAction('reload')">
        {{ t("processCard.reload") }}
      </button>
      <button v-if="can('stop', process.name)" class="danger" @click.stop="quickAction('stop')">
        {{ t("processCard.stop") }}
      </button>
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

      <div v-if="analytics" class="analytics-panel">
        <div class="analytics-title">{{ t("processCard.analytics.title") }}</div>

        <div v-if="!hasAnalyticsData" class="analytics-empty">
          {{ t("processCard.analytics.noData") }}
        </div>

        <template v-else>
          <div class="analytics-grid">
            <div class="analytics-stat">
              <div class="analytics-stat-label">{{ t("processCard.analytics.cpu") }}</div>
              <div class="analytics-stat-value">
                {{ analytics.current.cpu.avg ?? "–" }}%
                <span class="analytics-stat-sub"
                  >{{ t("processCard.analytics.peak") }} {{ analytics.current.cpu.max ?? "–" }}%</span
                >
              </div>
              <div
                v-if="analytics.deltas"
                class="analytics-stat-delta"
                :class="deltaClass(analytics.deltas.cpuAvgPct, true)"
              >
                {{ fmtDelta(analytics.deltas.cpuAvgPct) }}
              </div>
            </div>

            <div class="analytics-stat">
              <div class="analytics-stat-label">{{ t("processCard.analytics.memory") }}</div>
              <div class="analytics-stat-value">
                {{ fmtMem(analytics.current.memory.avg) }}
                <span class="analytics-stat-sub"
                  >{{ t("processCard.analytics.peak") }} {{ fmtMem(analytics.current.memory.max) }}</span
                >
              </div>
              <div
                v-if="analytics.deltas"
                class="analytics-stat-delta"
                :class="deltaClass(analytics.deltas.memoryAvgPct, true)"
              >
                {{ fmtDelta(analytics.deltas.memoryAvgPct) }}
              </div>
            </div>

            <div v-if="hasHeapData" class="analytics-stat">
              <div class="analytics-stat-label">{{ t("processCard.analytics.heapUsed") }}</div>
              <div class="analytics-stat-value">
                {{ fmtBytes(analytics.current.heapUsed.avg) }}
                <span class="analytics-stat-sub"
                  >{{ t("processCard.analytics.peak") }} {{ fmtBytes(analytics.current.heapUsed.max) }}</span
                >
              </div>
            </div>

            <div v-if="hasEventLoopData" class="analytics-stat">
              <div class="analytics-stat-label">{{ t("processCard.analytics.eventLoopLag") }}</div>
              <div class="analytics-stat-value">{{ fmtMs(analytics.current.eventLoopLag.avg) }}</div>
            </div>

            <div class="analytics-stat">
              <div class="analytics-stat-label">{{ t("processCard.analytics.restarts") }}</div>
              <div class="analytics-stat-value">
                {{ analytics.current.restarts ?? 0 }}
                <span v-if="analytics.current.restartFrequencyPerHour !== null" class="analytics-stat-sub">
                  {{
                    t("processCard.analytics.restartsPerHour", {
                      n: analytics.current.restartFrequencyPerHour,
                    })
                  }}
                </span>
              </div>
              <div
                v-if="analytics.deltas"
                class="analytics-stat-delta"
                :class="deltaClass(analytics.deltas.restartsPct, true)"
              >
                {{ fmtDelta(analytics.deltas.restartsPct) }}
              </div>
            </div>

            <div class="analytics-stat">
              <div class="analytics-stat-label">{{ t("processCard.analytics.crashes") }}</div>
              <div class="analytics-stat-value">{{ analytics.current.crashes }}</div>
              <div
                v-if="analytics.deltas"
                class="analytics-stat-delta"
                :class="deltaClass(analytics.deltas.crashesPct, true)"
              >
                {{ fmtDelta(analytics.deltas.crashesPct) }}
              </div>
            </div>

            <div class="analytics-stat">
              <div class="analytics-stat-label">{{ t("processCard.analytics.availability") }}</div>
              <div class="analytics-stat-value">
                {{ fmtPct(analytics.current.availabilityPercent) ?? t("processCard.analytics.notAvailable") }}
              </div>
              <div
                v-if="analytics.deltas"
                class="analytics-stat-delta"
                :class="deltaClass(analytics.deltas.availabilityPct)"
              >
                {{ fmtDelta(analytics.deltas.availabilityPct) }}
              </div>
            </div>
          </div>

          <div class="analytics-foot">
            {{ t("processCard.analytics.samples", { n: analyticsSamples }) }}
            <template v-if="analytics.deltas">· {{ t("processCard.analytics.vsPrevious") }}</template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
