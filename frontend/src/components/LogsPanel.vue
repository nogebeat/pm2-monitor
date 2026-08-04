<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { state, selectedProcess, togglePause, clearLogs, visibleLogs } from "../store";
import { renderLogText, time } from "../format";

const logsBodyEl = ref(null);
const selected = computed(() => selectedProcess());
const logs = computed(() => visibleLogs());

const logsStatsLabel = computed(() => {
  const s = state.logsStats;
  if (!s) return "";
  return `${s.files} fichier(s) · ${s.archivedFiles} compressé(s) · ${fmtBytesShort(s.totalBytes)}`;
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
  }
);

function copyLine(entry) {
  navigator.clipboard?.writeText(entry.data.trim()).catch(() => {});
}

function exportLogs(type) {
  if (state.selected === null) return alert("Sélectionne d'abord une app dans la liste.");
  window.open(`/api/processes/${state.selected}/logs/export?type=${type}`, "_blank");
}
const exportType = ref("all");

function openFulltext() {
  if (state.selected === null) return alert("Sélectionne d'abord une app.");
  state.modal = { type: "fulltext", process: selected.value };
}

function openGotoDate() {
  if (state.selected === null) return alert("Sélectionne d'abord une app.");
  state.modal = { type: "gotodate", process: selected.value };
}

function openExportRange() {
  if (state.selected === null) return alert("Sélectionne d'abord une app.");
  state.modal = { type: "exportrange", process: selected.value };
}
</script>

<template>
  <section class="logs-panel">
    <div class="logs-head">
      <div class="logs-title">
        <h2>{{ selected ? selected.name : "Sélectionne un process" }}</h2>
        <span class="logs-sub">
          {{ selected ? `#${selected.id} · ${selected.status} · pid ${selected.pid || "–"}` : "Les logs stdout / stderr apparaîtront ici" }}
        </span>
      </div>
    </div>

    <div class="logs-toolbar">
      <div class="logs-toolbar-row">
        <input v-model="state.search" type="search" class="log-search" placeholder="Rechercher dans les logs…" />
        <label class="chk-inline" title="Traiter la recherche comme une regex">
          <input v-model="state.regexMode" type="checkbox" /> .*
        </label>
        <select v-model="state.levelFilter" class="export-type" title="Filtrer par niveau">
          <option value="all">tous niveaux</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="debug">debug</option>
        </select>
        <div class="filter-group" role="group" aria-label="Filtrer les logs">
          <button class="filter-btn" :class="{ active: state.filter === 'all' }" @click="state.filter = 'all'">Tout</button>
          <button class="filter-btn" :class="{ active: state.filter === 'out' }" @click="state.filter = 'out'">stdout</button>
          <button class="filter-btn" :class="{ active: state.filter === 'err' }" @click="state.filter = 'err'">stderr</button>
        </div>
        <label class="chk-inline"><input v-model="state.ansiOn" type="checkbox" /> ANSI</label>
        <label class="chk-inline"><input v-model="state.lineNumOn" type="checkbox" /> N° ligne</label>
        <label class="autoscroll">
          <input v-model="state.autoscroll" type="checkbox" />
          Auto-scroll
        </label>
        <button class="icon-btn" title="Mettre le flux en pause" @click="togglePause">
          {{ state.paused ? `▶ Reprendre (${state.pausedQueue.length})` : "⏸ Pause" }}
        </button>
        <button class="icon-btn" title="Vider l'affichage" @click="clearLogs">Vider</button>
      </div>
      <div class="logs-toolbar-row">
        <button class="icon-btn" title="Recherche plein texte dans le fichier complet" @click="openFulltext">🔎 Recherche complète</button>
        <button class="icon-btn" title="Aller à une date" @click="openGotoDate">📅 Aller à une date</button>
        <div class="export-group">
          <button class="icon-btn" title="Télécharger les logs complets" @click="exportLogs(exportType)">Exporter</button>
          <select v-model="exportType" class="export-type" title="Quoi exporter">
            <option value="all">tout</option>
            <option value="out">stdout</option>
            <option value="err">stderr</option>
          </select>
        </div>
        <button class="icon-btn" title="Télécharger une période précise" @click="openExportRange">📥 Exporter période</button>
        <span class="logs-stats">{{ logsStatsLabel }}</span>
      </div>
    </div>

    <div ref="logsBodyEl" class="logs-body">
      <div v-if="!logs.length" class="empty-state">En attente de logs…</div>

      <template v-for="entry in logs" :key="entry.n">
        <div v-if="entry.kind === 'event'" class="log-line">
          <span class="log-time">{{ time(entry.at) }}</span>
          <span class="log-event">— {{ entry.event }} —</span>
        </div>
        <div v-else class="log-line" :class="{ 'log-backlog': entry.backlog }">
          <span v-if="state.lineNumOn" class="log-line-num">{{ entry.n }}</span>
          <span class="log-time">{{ time(entry.at) }}</span>
          <span class="log-tag" :class="entry.type">{{ entry.type }}</span>
          <span v-if="entry.level && entry.level !== 'info'" class="log-tag" :class="entry.level">{{ entry.level }}</span>
          <span class="log-text" :class="{ err: entry.type === 'err' }" v-html="renderLogText(entry.data, state.ansiOn)"></span>
          <button class="log-copy" title="Copier la ligne" @click="copyLine(entry)">⧉</button>
        </div>
      </template>
    </div>
  </section>
</template>
