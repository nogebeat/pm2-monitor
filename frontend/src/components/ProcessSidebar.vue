<script setup>
/**
 * Sidebar de la liste des process (colonne de gauche du dashboard).
 *
 * Phase 13 — Tags, Environments & Process Groups : ajoute des filtres par
 * tag/environnement et une vue "par groupe", basés sur
 * /api/process-organization/assignments (lib/routes/process-organization.js)
 * — un seul appel réseau pour récupérer l'organisation de tous les process
 * connus (voir lib/services/process-organization/store.js#listAssignments).
 * Chargé une fois au montage ; l'organisation change rarement en cours de
 * session (l'utilisateur peut recharger via le bouton 🔄).
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { state, can } from "../store";
import { apiGet } from "../api";
import ProcessCard from "./ProcessCard.vue";

const { t } = useI18n();

const tags = ref([]);
const environments = ref([]);
// process (nom) -> { tags: [{id,name,color}], environment: {id,name,color}|null, groups: [{id,name}] }
const assignmentsByProcess = ref({});
const filterTagId = ref(null);
const filterEnvironmentId = ref(null);
const groupView = ref(false);
const canFilter = computed(() => can("process_org_read"));

function loadOrganization() {
  if (!canFilter.value) return;
  Promise.all([
    apiGet("/api/process-organization/tags"),
    apiGet("/api/process-organization/environments"),
    apiGet("/api/process-organization/assignments"),
  ])
    .then(([t2, e, assignments]) => {
      tags.value = t2;
      environments.value = e;
      const byProcess = {};
      for (const a of assignments) {
        // Colonne de gauche = hôte local uniquement (voir ProcessCard.vue) :
        // on ignore les assignations d'autres serveurs pour ce lookup.
        if (a.serverKey && a.serverKey !== "local") continue;
        byProcess[a.processName] = a;
      }
      assignmentsByProcess.value = byProcess;
    })
    .catch(() => {
      // Filtres non critiques : un échec de chargement ne doit pas empêcher
      // d'afficher la liste des process elle-même.
    });
}

onMounted(loadOrganization);

function orgFor(processName) {
  return assignmentsByProcess.value[processName] || { tags: [], environment: null, groups: [] };
}

const filteredProcesses = computed(() => {
  return state.processes.filter((p) => {
    const org = orgFor(p.name);
    if (filterTagId.value && !org.tags.some((t2) => t2.id === filterTagId.value)) return false;
    if (filterEnvironmentId.value && (!org.environment || org.environment.id !== filterEnvironmentId.value)) {
      return false;
    }
    return true;
  });
});

// Vue "par groupe" : un process apparaît sous chacun de ses groupes ; les
// process sans groupe sont rassemblés sous "Sans groupe" (voir énoncé de
// phase : "un process peut appartenir à un ou plusieurs groupes").
const groupedProcesses = computed(() => {
  if (!groupView.value) return null;
  const buckets = new Map(); // groupName -> processes[]
  const ungrouped = [];
  for (const p of filteredProcesses.value) {
    const org = orgFor(p.name);
    if (!org.groups.length) {
      ungrouped.push(p);
      continue;
    }
    for (const g of org.groups) {
      if (!buckets.has(g.name)) buckets.set(g.name, []);
      buckets.get(g.name).push(p);
    }
  }
  const groups = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, processes]) => ({ name, processes }));
  if (ungrouped.length) groups.push({ name: t("sidebar.ungrouped"), processes: ungrouped });
  return groups;
});

function resetFilters() {
  filterTagId.value = null;
  filterEnvironmentId.value = null;
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-head">
      <h2>{{ t("sidebar.title") }}</h2>
      <span class="hint">{{ t("sidebar.hint") }}</span>
    </div>

    <div v-if="canFilter && (tags.length || environments.length)" class="sidebar-filters">
      <select v-model="filterTagId" class="sidebar-filter-select">
        <option :value="null">{{ t("sidebar.allTags") }}</option>
        <option v-for="tg in tags" :key="tg.id" :value="tg.id">{{ tg.name }}</option>
      </select>
      <select v-model="filterEnvironmentId" class="sidebar-filter-select">
        <option :value="null">{{ t("sidebar.allEnvironments") }}</option>
        <option v-for="e in environments" :key="e.id" :value="e.id">{{ e.name }}</option>
      </select>
      <button
        v-if="filterTagId || filterEnvironmentId"
        class="icon-btn sidebar-filter-reset"
        :title="t('sidebar.resetFilters')"
        @click="resetFilters"
      >
        ✕
      </button>
      <label class="sidebar-group-toggle">
        <input v-model="groupView" type="checkbox" />
        {{ t("sidebar.groupView") }}
      </label>
    </div>

    <div class="process-list">
      <div v-if="!state.processes.length" class="empty-state">{{ t("sidebar.connecting") }}</div>
      <div v-else-if="!filteredProcesses.length" class="empty-state">{{ t("sidebar.noMatch") }}</div>

      <template v-else-if="groupedProcesses">
        <div v-for="group in groupedProcesses" :key="group.name" class="sidebar-group">
          <h3 class="sidebar-group-title">{{ group.name }}</h3>
          <ProcessCard v-for="p in group.processes" :key="`${group.name}-${p.id}`" :process="p" />
        </div>
      </template>

      <template v-else>
        <ProcessCard v-for="p in filteredProcesses" :key="p.id" :process="p" />
      </template>
    </div>
  </aside>
</template>

<style scoped>
.sidebar-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 0 0 10px;
}
.sidebar-filter-select {
  font-size: 12px;
  max-width: 140px;
}
.sidebar-filter-reset {
  padding: 2px 6px;
}
.sidebar-group-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  opacity: 0.85;
  margin-left: auto;
}
.sidebar-group-title {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.7;
  margin: 10px 0 6px;
}
.sidebar-group:first-child .sidebar-group-title {
  margin-top: 0;
}
</style>
