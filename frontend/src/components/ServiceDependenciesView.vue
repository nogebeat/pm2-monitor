<script setup>
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  state,
  can,
  notifyError,
  loadServiceDependencies,
  loadServiceDependenciesCatalog,
  loadServiceDependenciesGraph,
  createServiceDependency,
  updateServiceDependency,
  setServiceDependencyEnabled,
  deleteServiceDependency,
  selectServiceDependencyNode,
} from "../store";

/**
 * Vue "Dépendances" (Phase 17 — Service Dependency Map) : dépendances de
 * service déclarées explicitement par l'utilisateur (PM2 Monitor n'invente
 * rien, voir lib/db/migrations/019_service_dependencies.js), avec statut
 * dérivé des health checks liés (Phase 6) et calcul d'impact
 * ("potentially affected") — jamais de causalité certaine affichée.
 *
 * Trois sous-vues sur les mêmes données (state.serviceDependencies) :
 * - "graph" : représentation visuelle simple (couches CSS, pas de librairie
 *   de graphe — voir prompt de phase, "Commencer simplement").
 * - "list" / "status" : représentations 100% accessibles (tableaux), pour
 *   "prévoir une représentation accessible en dehors du graphe".
 * Le clic sur un nœud (dans n'importe quelle sous-vue) charge son impact
 * potentiel via GET /api/service-dependencies/impact/:service.
 */

const { t } = useI18n();

const subView = ref("graph"); // "graph" | "list" | "status"

const STATUS_LABELS = computed(() => ({
  UP: t("serviceDependencies.statusUp"),
  DOWN: t("serviceDependencies.statusDown"),
  DEGRADED: t("serviceDependencies.statusDegraded"),
  UNKNOWN: t("serviceDependencies.statusUnknown"),
}));

const emptyForm = () => ({
  id: null,
  source: "",
  target: "",
  type: "CUSTOM",
  enabled: true,
  description: "",
  healthCheckId: "",
});

const showForm = ref(false);
const form = ref(emptyForm());
const saving = ref(false);

function openCreateForm() {
  form.value = emptyForm();
  showForm.value = true;
}

function openEditForm(dep) {
  form.value = {
    id: dep.id,
    source: dep.source,
    target: dep.target,
    type: dep.type,
    enabled: dep.enabled,
    description: dep.description || "",
    healthCheckId: dep.healthCheckId || "",
  };
  showForm.value = true;
}

function closeForm() {
  showForm.value = false;
}

function submitForm() {
  const payload = {
    source: form.value.source.trim(),
    target: form.value.target.trim(),
    type: form.value.type,
    enabled: !!form.value.enabled,
    description: form.value.description || "",
    healthCheckId: form.value.healthCheckId ? Number(form.value.healthCheckId) : null,
  };
  saving.value = true;
  const action = form.value.id
    ? updateServiceDependency(form.value.id, payload)
    : createServiceDependency(payload);
  action
    .then(() => {
      showForm.value = false;
    })
    .catch(notifyError)
    .finally(() => {
      saving.value = false;
    });
}

function toggleEnabled(dep) {
  setServiceDependencyEnabled(dep.id, !dep.enabled).catch(notifyError);
}

function removeDependency(dep) {
  if (!window.confirm(t("serviceDependencies.confirmDelete", { source: dep.source, target: dep.target }))) return;
  deleteServiceDependency(dep.id).catch(notifyError);
}

function selectNode(name) {
  selectServiceDependencyNode(name === state.serviceDependencies.selectedId ? null : name);
}

// Regroupe les nœuds par "couche" (distance topologique depuis les nœuds
// sans dépendance entrante), pour un affichage graphe simple en colonnes —
// pas de layout physique/librairie externe (voir prompt : "commencer simplement").
const graphLayers = computed(() => {
  const graph = state.serviceDependencies.graph;
  if (!graph) return [];
  const incoming = new Map(graph.nodes.map((n) => [n.name, 0]));
  for (const e of graph.edges) {
    if (!e.enabled) continue;
    incoming.set(e.target, (incoming.get(e.target) || 0) + 1);
  }
  const depth = new Map();
  const roots = graph.nodes.filter((n) => !incoming.get(n.name));
  let frontier = roots.map((n) => n.name);
  frontier.forEach((name) => depth.set(name, 0));
  const adjacency = new Map();
  for (const e of graph.edges) {
    if (!e.enabled) continue;
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    adjacency.get(e.source).push(e.target);
  }
  let level = 0;
  while (frontier.length) {
    level += 1;
    const next = [];
    for (const name of frontier) {
      for (const target of adjacency.get(name) || []) {
        if (depth.has(target) && depth.get(target) >= level) continue;
        depth.set(target, level);
        next.push(target);
      }
    }
    frontier = next;
    if (level > graph.nodes.length) break; // filet de sécurité, ne devrait jamais arriver (pas de cycle en base)
  }
  // Nœuds jamais atteints (composantes isolées) : couche 0 avec les racines.
  for (const n of graph.nodes) if (!depth.has(n.name)) depth.set(n.name, 0);

  const byLayer = new Map();
  for (const n of graph.nodes) {
    const l = depth.get(n.name);
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(n);
  }
  return [...byLayer.keys()]
    .sort((a, b) => a - b)
    .map((l) => ({ level: l, nodes: byLayer.get(l).sort((a, b) => a.name.localeCompare(b.name)) }));
});

function outgoingEdgesFor(name) {
  const graph = state.serviceDependencies.graph;
  if (!graph) return [];
  return graph.edges.filter((e) => e.source === name);
}

onMounted(() => {
  loadServiceDependencies();
  loadServiceDependenciesGraph();
  loadServiceDependenciesCatalog();
});
</script>

<template>
  <main class="deps-view">
    <div class="deps-head">
      <h2>{{ t("serviceDependencies.title") }}</h2>
      <div class="sub-tabs" role="tablist">
        <button class="filter-btn" :class="{ active: subView === 'graph' }" @click="subView = 'graph'">
          {{ t("serviceDependencies.tabGraph") }}
        </button>
        <button class="filter-btn" :class="{ active: subView === 'list' }" @click="subView = 'list'">
          {{ t("serviceDependencies.tabList") }}
        </button>
        <button class="filter-btn" :class="{ active: subView === 'status' }" @click="subView = 'status'">
          {{ t("serviceDependencies.tabStatus") }}
        </button>
      </div>
      <button v-if="can('dependencies_create')" class="filter-btn add-btn" @click="openCreateForm">
        {{ t("serviceDependencies.add") }}
      </button>
    </div>

    <form v-if="showForm" class="deps-form" @submit.prevent="submitForm">
      <label>
        {{ t("serviceDependencies.source") }}
        <input v-model="form.source" required :placeholder="t('serviceDependencies.sourcePlaceholder')" />
      </label>
      <label>
        {{ t("serviceDependencies.target") }}
        <input v-model="form.target" required :placeholder="t('serviceDependencies.targetPlaceholder')" />
      </label>
      <label>
        {{ t("serviceDependencies.type") }}
        <select v-model="form.type">
          <option v-for="ty in state.serviceDependencies.catalog?.types || []" :key="ty" :value="ty">{{ ty }}</option>
        </select>
      </label>
      <label>
        {{ t("serviceDependencies.healthCheckId") }}
        <input v-model="form.healthCheckId" type="number" min="1" placeholder="—" />
      </label>
      <label class="deps-form-description">
        {{ t("serviceDependencies.description") }}
        <input v-model="form.description" :placeholder="t('serviceDependencies.descriptionPlaceholder')" />
      </label>
      <label class="deps-form-checkbox">
        <input v-model="form.enabled" type="checkbox" />
        {{ t("serviceDependencies.enabled") }}
      </label>
      <div class="deps-form-actions">
        <button type="submit" class="filter-btn" :disabled="saving">{{ t("serviceDependencies.save") }}</button>
        <button type="button" class="filter-btn" @click="closeForm">{{ t("serviceDependencies.cancel") }}</button>
      </div>
    </form>

    <div class="deps-body">
      <div class="deps-main-panel">
        <!-- Graphe (couches simples, pas de librairie externe) -->
        <div v-if="subView === 'graph'" class="deps-graph">
          <div v-if="!state.serviceDependencies.graph" class="deps-empty">{{ t("serviceDependencies.loading") }}</div>
          <div v-else-if="!state.serviceDependencies.graph.nodes.length" class="deps-empty">
            {{ t("serviceDependencies.empty") }}
          </div>
          <div v-else class="deps-graph-layers">
            <div v-for="layer in graphLayers" :key="layer.level" class="deps-graph-layer">
              <button
                v-for="node in layer.nodes"
                :key="node.name"
                class="deps-node"
                :class="[`status-${node.status.toLowerCase()}`, { active: state.serviceDependencies.selectedId === node.name }]"
                @click="selectNode(node.name)"
              >
                <span class="deps-node-name">{{ node.name }}</span>
                <span class="deps-node-status">{{ STATUS_LABELS[node.status] }}</span>
                <span v-for="edge in outgoingEdgesFor(node.name)" :key="edge.id" class="deps-node-edge">
                  → {{ edge.target }} ({{ edge.type }})
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- Liste (accessible, tableau) -->
        <table v-else-if="subView === 'list'" class="deps-table">
          <thead>
            <tr>
              <th>{{ t("serviceDependencies.source") }}</th>
              <th>{{ t("serviceDependencies.target") }}</th>
              <th>{{ t("serviceDependencies.type") }}</th>
              <th>{{ t("serviceDependencies.enabled") }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!state.serviceDependencies.items.length">
              <td colspan="5" class="deps-empty">{{ t("serviceDependencies.empty") }}</td>
            </tr>
            <tr v-for="dep in state.serviceDependencies.items" :key="dep.id">
              <td>
                <button class="deps-link" @click="selectNode(dep.source)">{{ dep.source }}</button>
              </td>
              <td>
                <button class="deps-link" @click="selectNode(dep.target)">{{ dep.target }}</button>
              </td>
              <td>{{ dep.type }}</td>
              <td>{{ dep.enabled ? t("serviceDependencies.yes") : t("serviceDependencies.no") }}</td>
              <td class="deps-row-actions">
                <button v-if="can('dependencies_update')" class="filter-btn" @click="openEditForm(dep)">
                  {{ t("serviceDependencies.edit") }}
                </button>
                <button v-if="can('dependencies_update')" class="filter-btn" @click="toggleEnabled(dep)">
                  {{ dep.enabled ? t("serviceDependencies.disable") : t("serviceDependencies.enable") }}
                </button>
                <button v-if="can('dependencies_delete')" class="filter-btn" @click="removeDependency(dep)">
                  {{ t("serviceDependencies.delete") }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Statut par service (accessible) -->
        <table v-else class="deps-table">
          <thead>
            <tr>
              <th>{{ t("serviceDependencies.service") }}</th>
              <th>{{ t("serviceDependencies.status") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!state.serviceDependencies.graph?.nodes?.length">
              <td colspan="2" class="deps-empty">{{ t("serviceDependencies.empty") }}</td>
            </tr>
            <tr v-for="node in state.serviceDependencies.graph?.nodes || []" :key="node.name">
              <td>
                <button class="deps-link" @click="selectNode(node.name)">{{ node.name }}</button>
              </td>
              <td>
                <span class="deps-status-badge" :class="`status-${node.status.toLowerCase()}`">{{
                  STATUS_LABELS[node.status]
                }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Détail + dépendances affectées -->
      <div class="deps-detail-panel">
        <div v-if="!state.serviceDependencies.selectedId" class="deps-empty">
          {{ t("serviceDependencies.selectPrompt") }}
        </div>
        <template v-else>
          <h3>{{ state.serviceDependencies.selectedId }}</h3>
          <div v-if="state.serviceDependencies.impactLoading" class="deps-empty">
            {{ t("serviceDependencies.loading") }}
          </div>
          <template v-else-if="state.serviceDependencies.impact">
            <p class="deps-detail-status">
              {{ t("serviceDependencies.currentStatus") }} :
              <span
                class="deps-status-badge"
                :class="`status-${state.serviceDependencies.impact.status.toLowerCase()}`"
                >{{ STATUS_LABELS[state.serviceDependencies.impact.status] }}</span
              >
            </p>
            <h4>{{ t("serviceDependencies.potentiallyAffected") }}</h4>
            <p v-if="!state.serviceDependencies.impact.potentiallyAffected.length" class="deps-empty">
              {{ t("serviceDependencies.noImpact") }}
            </p>
            <ul v-else class="deps-impact-list">
              <li v-for="affected in state.serviceDependencies.impact.potentiallyAffected" :key="affected.name">
                <span class="deps-impact-name">{{ affected.name }}</span>
                <span class="deps-impact-path">{{ affected.path.join(" → ") }}</span>
              </li>
            </ul>
            <p class="deps-impact-disclaimer">{{ t("serviceDependencies.impactDisclaimer") }}</p>
          </template>
        </template>
      </div>
    </div>
  </main>
</template>

<style scoped>
.deps-view {
  padding: 16px;
  max-width: 1200px;
  margin: 0 auto;
}
.deps-head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.deps-head h2 {
  margin: 0;
}
.sub-tabs {
  display: flex;
  gap: 6px;
}
.add-btn {
  margin-left: auto;
}

.deps-form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 16px;
}
.deps-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}
.deps-form-checkbox {
  flex-direction: row !important;
  align-items: center;
  gap: 6px !important;
}
.deps-form-actions {
  display: flex;
  gap: 8px;
}

.deps-body {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 16px;
}
.deps-main-panel {
  min-width: 0;
  overflow-x: auto;
}
.deps-detail-panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  min-height: 200px;
}
.deps-empty {
  padding: 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.deps-graph-layers {
  display: flex;
  gap: 24px;
  align-items: flex-start;
  overflow-x: auto;
  padding-bottom: 8px;
}
.deps-graph-layer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 180px;
}
.deps-node {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
}
.deps-node.active {
  border-color: var(--accent, #5fa8d3);
}
.deps-node-name {
  font-weight: 600;
}
.deps-node-status {
  font-size: 11px;
  text-transform: uppercase;
}
.deps-node-edge {
  font-size: 11px;
  color: var(--text-muted);
}
.status-up .deps-node-status,
.status-up.deps-status-badge {
  color: #4fd68c;
}
.status-down .deps-node-status,
.status-down.deps-status-badge {
  color: #e85d5d;
}
.status-degraded .deps-node-status,
.status-degraded.deps-status-badge {
  color: #e0a64f;
}
.status-unknown .deps-node-status,
.status-unknown.deps-status-badge {
  color: var(--text-muted);
}

.deps-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.deps-table th,
.deps-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.deps-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent, #5fa8d3);
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
}
.deps-row-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.deps-status-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  text-transform: uppercase;
}

.deps-detail-status {
  font-size: 13px;
}
.deps-impact-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.deps-impact-list li {
  display: flex;
  flex-direction: column;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.deps-impact-name {
  font-weight: 600;
}
.deps-impact-path {
  font-size: 11px;
  color: var(--text-muted);
}
.deps-impact-disclaimer {
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
}

@media (max-width: 800px) {
  .deps-body {
    grid-template-columns: 1fr;
  }
}
</style>
