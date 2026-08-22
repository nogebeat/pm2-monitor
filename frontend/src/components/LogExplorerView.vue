<script setup>
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  state,
  logExplorerVisibleProcessNames,
  logExplorerVisibleServers,
  setLogExplorerFilter,
  setLogExplorerSelection,
  runLogExplorerSearch,
  logExplorerNextPage,
  logExplorerPrevPage,
  toggleLogExplorerLive,
  exportLogExplorer,
  openLogExplorerResultProcess,
} from "../store";
import { time, renderLogText } from "../format";

const { t } = useI18n();

const ex = computed(() => state.logExplorer);
const processNames = computed(() => logExplorerVisibleProcessNames());
const servers = computed(() => logExplorerVisibleServers());

const rangeLabel = computed(() => {
  const total = ex.value.total;
  if (!total) return t("logExplorer.noResults");
  const from = ex.value.offset + 1;
  const to = Math.min(ex.value.offset + ex.value.results.length, total);
  return t("logExplorer.rangeLabel", { from, to, total });
});

function toggleProcess(name) {
  const cur = ex.value.selectedProcesses;
  const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
  setLogExplorerSelection({ processes: next });
}

function toggleServer(serverKey) {
  const cur = ex.value.selectedServers;
  const next = cur.includes(serverKey) ? cur.filter((k) => k !== serverKey) : [...cur, serverKey];
  setLogExplorerSelection({ servers: next });
}

function selectAllProcesses() {
  setLogExplorerSelection({ processes: [] });
}

function selectAllServers() {
  setLogExplorerSelection({ servers: [] });
}

function onFromChange(e) {
  const v = e.target.value;
  setLogExplorerFilter({ from: v ? new Date(v).getTime() : null });
}

function onToChange(e) {
  const v = e.target.value;
  setLogExplorerFilter({ to: v ? new Date(v).getTime() : null });
}

function copyLine(entry) {
  navigator.clipboard?.writeText(entry.text.trim()).catch(() => {});
}

function sourceLabel(source) {
  if (source.serverKey === "local") return source.name;
  const srv = servers.value.find((s) => s.serverKey === source.serverKey);
  return `${source.name} @ ${srv ? srv.name : source.serverKey}`;
}
</script>

<template>
  <main class="log-explorer-view">
    <div class="chart-panel log-explorer-panel">
      <div class="chart-head">
        <h2>{{ t("logExplorer.title") }}</h2>
        <div class="log-explorer-actions">
          <button
            class="icon-btn"
            :class="{ active: ex.live }"
            :title="t('logExplorer.liveTitle')"
            @click="toggleLogExplorerLive"
          >
            {{ ex.live ? "🔴" : "⚪" }} {{ t("logExplorer.live") }}
          </button>
          <button class="icon-btn" :title="t('logExplorer.exportTitle')" @click="exportLogExplorer">
            📥 {{ t("logExplorer.export") }}
          </button>
        </div>
      </div>

      <div class="log-explorer-filters">
        <div class="log-explorer-pickers">
          <div class="picker">
            <div class="picker-head">
              <span>{{ t("logExplorer.processes") }}</span>
              <button class="picker-all" @click="selectAllProcesses">{{ t("logExplorer.allOption") }}</button>
            </div>
            <div class="picker-list">
              <label v-for="name in processNames" :key="name" class="chk-inline picker-item">
                <input
                  type="checkbox"
                  :checked="!ex.selectedProcesses.length || ex.selectedProcesses.includes(name)"
                  @change="toggleProcess(name)"
                />
                {{ name }}
              </label>
              <span v-if="!processNames.length" class="picker-empty">{{ t("logExplorer.noProcesses") }}</span>
            </div>
          </div>

          <div class="picker">
            <div class="picker-head">
              <span>{{ t("logExplorer.servers") }}</span>
              <button class="picker-all" @click="selectAllServers">{{ t("logExplorer.allOption") }}</button>
            </div>
            <div class="picker-list">
              <label v-for="s in servers" :key="s.serverKey" class="chk-inline picker-item">
                <input
                  type="checkbox"
                  :checked="!ex.selectedServers.length || ex.selectedServers.includes(s.serverKey)"
                  @change="toggleServer(s.serverKey)"
                />
                {{ s.name }}
              </label>
            </div>
          </div>
        </div>

        <div class="logs-toolbar-row">
          <input
            :value="ex.filters.query"
            type="search"
            class="log-search"
            :placeholder="t('logExplorer.searchPlaceholder')"
            @change="(e) => setLogExplorerFilter({ query: e.target.value })"
          />
          <label class="chk-inline" :title="t('logs.regexTitle')">
            <input
              :checked="ex.filters.regex"
              type="checkbox"
              @change="(e) => setLogExplorerFilter({ regex: e.target.checked })"
            />
            .*
          </label>
          <select
            :value="ex.filters.level"
            class="export-type"
            @change="(e) => setLogExplorerFilter({ level: e.target.value })"
          >
            <option value="all">{{ t("logs.levelAll") }}</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
            <option value="debug">debug</option>
          </select>
          <div class="filter-group" role="group" :aria-label="t('logs.filterLabel')">
            <button
              class="filter-btn"
              :class="{ active: ex.filters.type === 'all' }"
              @click="setLogExplorerFilter({ type: 'all' })"
            >
              {{ t("logs.filterAll") }}
            </button>
            <button
              class="filter-btn"
              :class="{ active: ex.filters.type === 'out' }"
              @click="setLogExplorerFilter({ type: 'out' })"
            >
              stdout
            </button>
            <button
              class="filter-btn"
              :class="{ active: ex.filters.type === 'err' }"
              @click="setLogExplorerFilter({ type: 'err' })"
            >
              stderr
            </button>
          </div>
          <select
            :value="ex.filters.sort"
            class="export-type"
            @change="(e) => setLogExplorerFilter({ sort: e.target.value })"
          >
            <option value="desc">{{ t("logExplorer.sortDesc") }}</option>
            <option value="asc">{{ t("logExplorer.sortAsc") }}</option>
          </select>
        </div>

        <div class="logs-toolbar-row">
          <label class="chk-inline">
            {{ t("logExplorer.from") }}
            <input type="datetime-local" @change="onFromChange" />
          </label>
          <label class="chk-inline">
            {{ t("logExplorer.to") }}
            <input type="datetime-local" @change="onToChange" />
          </label>
          <label class="chk-inline" :title="t('logExplorer.contextTitle')">
            {{ t("logExplorer.context") }}
            <input
              :value="ex.filters.context"
              type="number"
              min="0"
              max="20"
              class="context-input"
              @change="(e) => setLogExplorerFilter({ context: Number(e.target.value) || 0 })"
            />
          </label>
          <button class="icon-btn" :disabled="ex.loading" @click="() => runLogExplorerSearch()">
            {{ ex.loading ? t("logExplorer.searching") : t("logExplorer.search") }}
          </button>
          <span class="logs-stats">{{ rangeLabel }}</span>
        </div>
      </div>

      <div v-if="ex.truncated" class="log-explorer-truncated">
        {{ t("logExplorer.truncatedWarning") }}
      </div>

      <div v-if="ex.error" class="events-empty">{{ ex.error }}</div>
      <div v-else-if="ex.loading && !ex.results.length" class="events-empty">
        {{ t("logExplorer.searching") }}
      </div>
      <div v-else-if="!ex.results.length" class="events-empty">{{ t("logExplorer.noResults") }}</div>

      <div v-else class="log-explorer-results">
        <div
          v-for="(entry, i) in ex.results"
          :key="`${entry.source.serverKey}-${entry.source.name}-${entry.line}-${i}`"
          class="log-explorer-result"
        >
          <template v-if="entry.before && entry.before.length">
            <div
              v-for="(ctx, ci) in entry.before"
              :key="`before-${i}-${ci}`"
              class="log-line log-context-line"
            >
              <span class="log-text" v-html="renderLogText(ctx.text, true)"></span>
            </div>
          </template>

          <div class="log-line log-explorer-match">
            <span class="log-time">{{ time(entry.t) }}</span>
            <span class="log-source" :title="sourceLabel(entry.source)">{{ sourceLabel(entry.source) }}</span>
            <span class="log-tag" :class="entry.type">{{ entry.type }}</span>
            <span v-if="entry.level && entry.level !== 'info'" class="log-tag" :class="entry.level">{{
              entry.level
            }}</span>
            <span
              class="log-text"
              :class="{ err: entry.type === 'err' }"
              v-html="renderLogText(entry.text, true)"
            ></span>
            <button class="log-copy" :title="t('logs.copyLineTitle')" @click="copyLine(entry)">⧉</button>
            <button
              v-if="entry.source.serverKey === 'local'"
              class="log-copy"
              :title="t('logExplorer.openProcessTitle')"
              @click="openLogExplorerResultProcess(entry)"
            >
              ↗
            </button>
          </div>

          <template v-if="entry.after && entry.after.length">
            <div v-for="(ctx, ci) in entry.after" :key="`after-${i}-${ci}`" class="log-line log-context-line">
              <span class="log-text" v-html="renderLogText(ctx.text, true)"></span>
            </div>
          </template>
        </div>
      </div>

      <div v-if="ex.total > ex.limit" class="log-explorer-pagination">
        <button class="filter-btn" :disabled="ex.loading || ex.offset === 0" @click="logExplorerPrevPage">
          {{ t("logExplorer.prevPage") }}
        </button>
        <span class="logs-stats">{{ rangeLabel }}</span>
        <button
          class="filter-btn"
          :disabled="ex.loading || ex.offset + ex.limit >= ex.total"
          @click="logExplorerNextPage"
        >
          {{ t("logExplorer.nextPage") }}
        </button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.log-explorer-view {
  flex: 1;
  overflow-y: auto;
  padding: 22px 24px 40px;
}
.log-explorer-panel {
  max-width: 1100px;
  margin: 0 auto;
}

.log-explorer-actions {
  display: flex;
  gap: 8px;
}
.icon-btn.active {
  background: var(--accent-dim);
  color: var(--accent);
}

.log-explorer-filters {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 6px 16px;
  border-bottom: 1px solid var(--border);
}

.log-explorer-pickers {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.picker {
  min-width: 220px;
  flex: 1;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}

.picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 6px;
}

.picker-all {
  background: transparent;
  border: none;
  color: var(--accent);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}

.picker-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 140px;
  overflow-y: auto;
}

.picker-item {
  color: var(--text);
}

.picker-empty {
  font-size: 11.5px;
  color: var(--text-faint);
}

.context-input {
  width: 48px;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: var(--radius-sm);
  padding: 4px 6px;
  font-size: 11.5px;
}

.log-explorer-truncated {
  background: var(--warn-dim);
  color: var(--warn);
  font-family: var(--font-mono);
  font-size: 11.5px;
  padding: 7px 12px;
  margin: 8px 6px 0;
  border-radius: var(--radius-sm);
}

.log-explorer-results {
  display: flex;
  flex-direction: column;
  padding: 10px 6px 4px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
}

.log-explorer-result {
  border-bottom: 1px solid rgba(127, 127, 127, 0.08);
  padding: 4px 0;
}

.log-context-line {
  opacity: 0.55;
  padding-left: 4px;
}

.log-explorer-match {
  font-weight: 500;
}

.log-source {
  color: var(--accent);
  flex-shrink: 0;
  min-width: 90px;
}

.log-explorer-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 14px 6px 4px;
}
</style>
