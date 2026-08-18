<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { state, selectedProcess, togglePause, clearLogs, visibleLogs } from "../store";
import { renderLogText, time } from "../format";

const { t } = useI18n();

const logsBodyEl = ref(null);
const selected = computed(() => selectedProcess());
const logs = computed(() => visibleLogs());

const logsStatsLabel = computed(() => {
  const s = state.logsStats;
  if (!s) return "";
  return t("logs.statsLabel", {
    files: s.files,
    archived: s.archivedFiles,
    size: fmtBytesShort(s.totalBytes),
  });
});

function fmtBytesShort(bytes) {
  if (bytes === null || bytes === undefined) return "–";
  if (bytes < 1024) return bytes + " o";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " Ko";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " Mo";
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " Go";
}

watch(
  () => state.logs.length,
  async () => {
    if (!state.autoscroll || !logsBodyEl.value) return;
    await nextTick();
    logsBodyEl.value.scrollTop = logsBodyEl.value.scrollHeight;
  },
);

function copyLine(entry) {
  navigator.clipboard?.writeText(entry.data.trim()).catch(() => {});
}

function exportLogs(type) {
  if (state.selected === null) return alert(t("logs.selectAppFirst"));
  window.open(`/api/processes/${state.selected}/logs/export?type=${type}`, "_blank");
}
const exportType = ref("all");

function openFulltext() {
  if (state.selected === null) return alert(t("logs.selectAppFirstShort"));
  state.modal = { type: "fulltext", process: selected.value };
}

function openGotoDate() {
  if (state.selected === null) return alert(t("logs.selectAppFirstShort"));
  state.modal = { type: "gotodate", process: selected.value };
}

function openExportRange() {
  if (state.selected === null) return alert(t("logs.selectAppFirstShort"));
  state.modal = { type: "exportrange", process: selected.value };
}
</script>

<template>
  <section class="logs-panel">
    <div class="logs-head">
      <div class="logs-title">
        <h2>{{ selected ? selected.name : t("logs.selectProcess") }}</h2>
        <span class="logs-sub">
          {{
            selected
              ? `#${selected.id} · ${selected.status} · pid ${selected.pid || "–"}`
              : t("logs.waitingHint")
          }}
        </span>
      </div>
    </div>

    <div class="logs-toolbar">
      <div class="logs-toolbar-row">
        <input
          v-model="state.search"
          type="search"
          class="log-search"
          :placeholder="t('logs.searchPlaceholder')"
        />
        <label class="chk-inline" :title="t('logs.regexTitle')">
          <input v-model="state.regexMode" type="checkbox" /> .*
        </label>
        <select v-model="state.levelFilter" class="export-type" :title="t('logs.levelAll')">
          <option value="all">{{ t("logs.levelAll") }}</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="debug">debug</option>
        </select>
        <div class="filter-group" role="group" :aria-label="t('logs.filterLabel')">
          <button
            class="filter-btn"
            :class="{ active: state.filter === 'all' }"
            @click="state.filter = 'all'"
          >
            {{ t("logs.filterAll") }}
          </button>
          <button
            class="filter-btn"
            :class="{ active: state.filter === 'out' }"
            @click="state.filter = 'out'"
          >
            stdout
          </button>
          <button
            class="filter-btn"
            :class="{ active: state.filter === 'err' }"
            @click="state.filter = 'err'"
          >
            stderr
          </button>
        </div>
        <label class="chk-inline"
          ><input v-model="state.ansiOn" type="checkbox" /> {{ t("logs.ansi") }}</label
        >
        <label class="chk-inline"
          ><input v-model="state.lineNumOn" type="checkbox" /> {{ t("logs.lineNumbers") }}</label
        >
        <label class="autoscroll">
          <input v-model="state.autoscroll" type="checkbox" />
          {{ t("logs.autoscroll") }}
        </label>
        <button class="icon-btn" :title="t('logs.pauseTitle')" @click="togglePause">
          {{
            state.paused
              ? `▶ ${t("logs.resume", { count: state.pausedQueue.length })}`
              : `⏸ ${t("logs.pause")}`
          }}
        </button>
        <button class="icon-btn" :title="t('logs.clearTitle')" @click="clearLogs">
          {{ t("logs.clear") }}
        </button>
      </div>
      <div class="logs-toolbar-row">
        <button class="icon-btn" :title="t('logs.fulltextTitle')" @click="openFulltext">
          🔎 {{ t("logs.fulltext") }}
        </button>
        <button class="icon-btn" :title="t('logs.gotoDateTitle')" @click="openGotoDate">
          📅 {{ t("logs.gotoDate") }}
        </button>
        <div class="export-group">
          <button class="icon-btn" :title="t('logs.exportAllTitle')" @click="exportLogs(exportType)">
            {{ t("logs.export") }}
          </button>
          <select v-model="exportType" class="export-type" :title="t('logs.export')">
            <option value="all">{{ t("logs.exportAll") }}</option>
            <option value="out">stdout</option>
            <option value="err">stderr</option>
          </select>
        </div>
        <button class="icon-btn" :title="t('logs.exportRangeTitle')" @click="openExportRange">
          📥 {{ t("logs.exportRange") }}
        </button>
        <span class="logs-stats">{{ logsStatsLabel }}</span>
      </div>
    </div>

    <div ref="logsBodyEl" class="logs-body">
      <div v-if="!logs.length" class="empty-state">{{ t("logs.waitingForLogs") }}</div>

      <template v-for="entry in logs" :key="entry.n">
        <div v-if="entry.kind === 'event'" class="log-line">
          <span class="log-time">{{ time(entry.at) }}</span>
          <span class="log-event">— {{ entry.event }} —</span>
        </div>
        <div v-else class="log-line" :class="{ 'log-backlog': entry.backlog }">
          <span v-if="state.lineNumOn" class="log-line-num">{{ entry.n }}</span>
          <span class="log-time">{{ time(entry.at) }}</span>
          <span class="log-tag" :class="entry.type">{{ entry.type }}</span>
          <span v-if="entry.level && entry.level !== 'info'" class="log-tag" :class="entry.level">{{
            entry.level
          }}</span>
          <span
            class="log-text"
            :class="{ err: entry.type === 'err' }"
            v-html="renderLogText(entry.data, state.ansiOn)"
          ></span>
          <button class="log-copy" :title="t('logs.copyLineTitle')" @click="copyLine(entry)">⧉</button>
        </div>
      </template>
    </div>
  </section>
</template>
