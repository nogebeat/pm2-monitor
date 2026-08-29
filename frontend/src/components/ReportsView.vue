<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { state, loadReports, loadReportsCatalog, setReportsFilters, exportReport } from "../store";
import { apiGet } from "../api";

/**
 * Vue "Reports" (Phase 20 — Reports & Capacity Planning) : compose un
 * rapport (disponibilité, incidents, alertes, crashes/restarts, CPU/RAM,
 * health checks, notifications, auto-healing) sur une période, un
 * classement des process les plus problématiques, et des projections de
 * capacity planning — le tout dérivé des données déjà collectées ailleurs
 * (voir lib/services/reports/aggregator.js), rien de nouveau n'est mesuré
 * ici. Câblée sur lib/routes/reports.js via store.js (loadReports()...).
 */

const { t, locale } = useI18n();

const RANKING_KEYS = ["crashes", "restarts", "cpu", "ram", "downtime", "alertCount"];
const activeRankingTab = ref("crashes");

// Environnements/groupes pour les filtres : lus directement depuis
// process-organization (Phase 13) — pas de state global dédié côté
// frontend pour cette liste, simple lecture locale à l'ouverture de la vue.
const environments = ref([]);
const groups = ref([]);

function loadFilterOptions() {
  apiGet("/api/process-organization/environments")
    .then((list) => (environments.value = list))
    .catch(() => {
      environments.value = [];
    });
  apiGet("/api/process-organization/groups")
    .then((list) => (groups.value = list))
    .catch(() => {
      groups.value = [];
    });
}

function fmtDate(ts) {
  if (!ts) return "–";
  return new Date(ts).toLocaleString(locale.value === "fr" ? "fr-FR" : "en-US");
}

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return "–";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${Math.round(value * 10) / 10} ${units[i]}`;
}

function fmtDuration(ms) {
  if (!ms) return "0m";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}j${hours % 24}h`;
}

function fmtPercent(v) {
  return v === null || v === undefined ? "–" : `${v}%`;
}

const filters = computed(() => state.reports.filters);
const report = computed(() => state.reports.report);

function onFilterChange(key, value) {
  setReportsFilters({ [key]: value });
}

const rankingLabels = computed(() => ({
  crashes: t("reports.rankingCrashes"),
  restarts: t("reports.rankingRestarts"),
  cpu: t("reports.rankingCpu"),
  ram: t("reports.rankingRam"),
  downtime: t("reports.rankingDowntime"),
  alertCount: t("reports.rankingAlertCount"),
}));

const activeRankingRows = computed(() => (report.value ? report.value.ranking[activeRankingTab.value] || [] : []));

function rankingValueFor(entry) {
  switch (activeRankingTab.value) {
    case "crashes":
      return entry.crashes;
    case "restarts":
      return entry.restarts;
    case "cpu":
      return fmtPercent(entry.cpuAvg);
    case "ram":
      return fmtBytes(entry.memoryAvg);
    case "downtime":
      return fmtDuration(entry.downtimeMs);
    case "alertCount":
      return entry.alertCount;
    default:
      return "–";
  }
}

/** Résumé lisible d'une projection de capacity planning (voir lib/services/reports/capacity.js). */
function projectionSummary(projection) {
  if (!projection) return "";
  switch (projection.confidence) {
    case "already_exceeded":
      return t("reports.capacityAlreadyExceeded", { threshold: projection.threshold });
    case "stable_or_decreasing":
      return t("reports.capacityStable");
    case "beyond_horizon":
      return t("reports.capacityBeyondHorizon");
    case "insufficient_data":
      return t("reports.capacityInsufficientData");
    default:
      return t("reports.capacityProjection", { threshold: projection.threshold, days: projection.daysUntilThreshold });
  }
}

function confidenceLabel(confidence) {
  if (confidence === "high") return t("reports.capacityConfidenceHigh");
  if (confidence === "medium") return t("reports.capacityConfidenceMedium");
  if (confidence === "low") return t("reports.capacityConfidenceLow");
  return null;
}

const systemCapacity = computed(() => report.value?.capacityPlanning?.system || null);
const CAPACITY_METRICS = [
  { key: "cpu", label: "capacityCpu" },
  { key: "memory", label: "capacityMemory" },
  { key: "disk", label: "capacityDisk" },
];

onMounted(() => {
  loadFilterOptions();
  if (!state.reports.catalog) loadReportsCatalog();
  loadReports();
});

watch(
  () => filters.value.period,
  () => loadReports(),
);
</script>

<template>
  <main class="reports-view">
    <div class="reports-head">
      <h2>{{ t("reports.title") }}</h2>
      <div class="reports-export">
        <button class="filter-btn" @click="exportReport('json')">{{ t("reports.exportJson") }}</button>
        <button class="filter-btn" @click="exportReport('csv')">{{ t("reports.exportCsv") }}</button>
      </div>
    </div>

    <div class="reports-filters">
      <label>
        <span>{{ t("reports.periodLabel") }}</span>
        <select :value="filters.period" @change="onFilterChange('period', $event.target.value)">
          <option value="daily">{{ t("reports.periodDaily") }}</option>
          <option value="weekly">{{ t("reports.periodWeekly") }}</option>
          <option value="monthly">{{ t("reports.periodMonthly") }}</option>
          <option value="custom">{{ t("reports.periodCustom") }}</option>
        </select>
      </label>

      <template v-if="filters.period === 'custom'">
        <label>
          <span>{{ t("reports.startLabel") }}</span>
          <input
            type="datetime-local"
            :value="filters.start"
            @change="onFilterChange('start', $event.target.value)"
          />
        </label>
        <label>
          <span>{{ t("reports.endLabel") }}</span>
          <input type="datetime-local" :value="filters.end" @change="onFilterChange('end', $event.target.value)" />
        </label>
      </template>

      <label>
        <span>{{ t("reports.environmentLabel") }}</span>
        <select :value="filters.environment" @change="onFilterChange('environment', $event.target.value)">
          <option value="">{{ t("reports.allValue") }}</option>
          <option v-for="env in environments" :key="env.id" :value="env.name">{{ env.name }}</option>
        </select>
      </label>

      <label>
        <span>{{ t("reports.groupLabel") }}</span>
        <select :value="filters.group" @change="onFilterChange('group', $event.target.value)">
          <option value="">{{ t("reports.allValue") }}</option>
          <option v-for="g in groups" :key="g.id" :value="g.name">{{ g.name }}</option>
        </select>
      </label>

      <label>
        <span>{{ t("reports.processLabel") }}</span>
        <input
          type="text"
          :value="filters.process"
          :placeholder="t('reports.allValue')"
          @change="onFilterChange('process', $event.target.value)"
        />
      </label>
    </div>

    <div v-if="state.reports.loading" class="reports-empty">{{ t("reports.loading") }}</div>
    <div v-else-if="!report" class="reports-empty">{{ t("reports.empty") }}</div>

    <template v-else>
      <p class="reports-scope-hint">{{ t("reports.processesInScope", { count: report.scope.processCount }) }}</p>

      <section class="reports-summary-grid">
        <div class="summary-card">
          <span class="summary-label">{{ t("reports.availability") }}</span>
          <span class="summary-value">{{ fmtPercent(report.summary.availabilityPercent) }}</span>
        </div>
        <div class="summary-card">
          <span class="summary-label">{{ t("reports.crashes") }}</span>
          <span class="summary-value">{{ report.summary.crashes }}</span>
        </div>
        <div class="summary-card">
          <span class="summary-label">{{ t("reports.restarts") }}</span>
          <span class="summary-value">{{ report.summary.restarts }}</span>
        </div>
        <div class="summary-card">
          <span class="summary-label">{{ t("reports.avgCpu") }}</span>
          <span class="summary-value">{{ fmtPercent(report.summary.cpu.avg) }}</span>
        </div>
        <div class="summary-card">
          <span class="summary-label">{{ t("reports.avgRam") }}</span>
          <span class="summary-value">{{ fmtBytes(report.summary.memory.avg) }}</span>
        </div>
        <div class="summary-card">
          <span class="summary-label">{{ t("reports.incidents") }}</span>
          <span class="summary-value">{{ report.summary.incidents }}</span>
        </div>
        <div class="summary-card">
          <span class="summary-label">{{ t("reports.alerts") }}</span>
          <span class="summary-value"
            >{{ report.summary.alerts.total }}
            <small>({{ report.summary.alerts.critical }} crit.)</small></span
          >
        </div>
        <div class="summary-card">
          <span class="summary-label">{{ t("reports.healthChecks") }}</span>
          <span class="summary-value"
            >{{ report.summary.healthChecks.up }}/{{
              report.summary.healthChecks.up + report.summary.healthChecks.down + report.summary.healthChecks.degraded
            }}
            UP</span
          >
        </div>
        <div class="summary-card">
          <span class="summary-label">{{ t("reports.notifications") }}</span>
          <span class="summary-value">{{ report.summary.notifications.total }}</span>
        </div>
        <div class="summary-card">
          <span class="summary-label">{{ t("reports.autoHealing") }}</span>
          <span class="summary-value">{{ report.summary.autoHealing.total }}</span>
        </div>
      </section>

      <section class="reports-ranking">
        <h3>{{ t("reports.rankingTitle") }}</h3>
        <div class="filter-group" role="tablist">
          <button
            v-for="key in RANKING_KEYS"
            :key="key"
            class="filter-btn"
            :class="{ active: activeRankingTab === key }"
            @click="activeRankingTab = key"
          >
            {{ rankingLabels[key] }}
          </button>
        </div>
        <div v-if="!activeRankingRows.length" class="reports-empty">{{ t("reports.rankingEmpty") }}</div>
        <ol v-else class="ranking-list">
          <li v-for="entry in activeRankingRows" :key="entry.processName + entry.serverKey" class="ranking-row">
            <span class="ranking-name">{{ entry.processName }}</span>
            <span class="ranking-server">{{ entry.serverKey }}</span>
            <span class="ranking-value">{{ rankingValueFor(entry) }}</span>
          </li>
        </ol>
      </section>

      <section class="reports-capacity">
        <h3>{{ t("reports.capacityTitle") }}</h3>
        <p class="reports-hint">{{ t("reports.capacityNote") }}</p>
        <div v-if="!systemCapacity" class="reports-empty">{{ t("reports.capacitySystemUnavailable") }}</div>
        <div v-else class="capacity-grid">
          <div v-for="m in CAPACITY_METRICS" :key="m.key" class="capacity-card">
            <span class="capacity-label">{{ t(`reports.${m.label}`) }}</span>
            <span class="capacity-current">{{
              t("reports.capacityCurrentValue", { value: systemCapacity[m.key].currentValue ?? "–" })
            }}</span>
            <span class="capacity-projection">{{ projectionSummary(systemCapacity[m.key]) }}</span>
            <span v-if="confidenceLabel(systemCapacity[m.key].confidence)" class="capacity-confidence">{{
              confidenceLabel(systemCapacity[m.key].confidence)
            }}</span>
          </div>
        </div>
      </section>

      <section class="reports-processes">
        <h3>{{ t("reports.processesTitle") }}</h3>
        <div class="table-wrap">
          <table class="reports-table">
            <thead>
              <tr>
                <th>{{ t("reports.colProcess") }}</th>
                <th>{{ t("reports.colServer") }}</th>
                <th>{{ t("reports.colAvailability") }}</th>
                <th>{{ t("reports.colCrashes") }}</th>
                <th>{{ t("reports.colRestarts") }}</th>
                <th>{{ t("reports.colCpu") }}</th>
                <th>{{ t("reports.colRam") }}</th>
                <th>{{ t("reports.colDowntime") }}</th>
                <th>{{ t("reports.colAlerts") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in report.processes" :key="p.processName + p.serverKey">
                <td>{{ p.processName }}</td>
                <td>{{ p.serverKey }}</td>
                <td>{{ fmtPercent(p.availabilityPercent) }}</td>
                <td>{{ p.crashes }}</td>
                <td>{{ p.restarts }}</td>
                <td>{{ fmtPercent(p.cpuAvg) }}</td>
                <td>{{ fmtBytes(p.memoryAvg) }}</td>
                <td>{{ fmtDuration(p.downtimeMs) }}</td>
                <td>{{ p.alertCount }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <p class="reports-generated">{{ fmtDate(report.generatedAt) }}</p>
    </template>
  </main>
</template>

<style scoped>
.reports-view {
  flex: 1;
  overflow-y: auto;
  padding: 22px 24px 40px;
}

.reports-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  max-width: 1200px;
  margin: 0 auto 16px;
}

.reports-export {
  display: flex;
  gap: 8px;
}

.reports-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  max-width: 1200px;
  margin: 0 auto 20px;
}

.reports-filters label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.reports-filters select,
.reports-filters input {
  background: var(--panel, transparent);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  color: inherit;
  font-size: 13px;
}

.reports-empty {
  padding: 32px 8px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.reports-scope-hint {
  max-width: 1200px;
  margin: 0 auto 12px;
  color: var(--text-muted);
  font-size: 12px;
}

.reports-summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  max-width: 1200px;
  margin: 0 auto 24px;
}

.summary-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}

.summary-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.summary-value {
  font-size: 20px;
  font-weight: 600;
}

.summary-value small {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
}

.reports-ranking,
.reports-capacity,
.reports-processes {
  max-width: 1200px;
  margin: 0 auto 28px;
}

.reports-ranking h3,
.reports-capacity h3,
.reports-processes h3 {
  margin: 0 0 10px;
}

.filter-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.ranking-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ranking-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.ranking-name {
  flex: 1;
  font-weight: 600;
}

.ranking-server {
  color: var(--text-muted);
  font-size: 12px;
}

.ranking-value {
  font-variant-numeric: tabular-nums;
}

.reports-hint {
  color: var(--text-muted);
  font-size: 12px;
  margin: 0 0 12px;
}

.capacity-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.capacity-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}

.capacity-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.capacity-current {
  font-size: 18px;
  font-weight: 600;
}

.capacity-projection {
  font-size: 13px;
}

.capacity-confidence {
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
}

.table-wrap {
  overflow-x: auto;
}

.reports-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.reports-table th,
.reports-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.reports-generated {
  max-width: 1200px;
  margin: 0 auto;
  color: var(--text-muted);
  font-size: 11px;
}
</style>
