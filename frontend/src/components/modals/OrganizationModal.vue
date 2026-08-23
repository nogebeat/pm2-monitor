<script setup>
/**
 * Settings → Organisation des process (Phase 13 — Tags, Environments &
 * Process Groups).
 *
 * Quatre onglets dans la même modale (même pattern que NotificationsModal.vue
 * providers/routing) :
 *  - Tags / Environnements / Groupes : CRUD simple du catalogue (même
 *    approche liste + petit formulaire que HealthChecksModal.vue).
 *  - Assignation : associe tags/environnement/groupes à UN process précis
 *    (formulaire unique, sauvegardé en un seul appel PUT — voir
 *    lib/routes/process-organization.js#PUT /assignments/:processName).
 *
 * Backend : lib/routes/process-organization.js (CRUD + assignments),
 * lib/services/process-organization/ (store), voir aussi
 * docs/process-organization/README.md. Wrappers fetch locaux (apiPut/
 * apiDelete) car api.js n'expose que apiGet/apiPost (même raison que
 * HealthChecksModal.vue).
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { state, notifyError, can } from "../../store";
import { apiGet, apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

const { t } = useI18n();

function close() {
  state.modal = null;
}

function apiPut(url, body) {
  return fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || `HTTP Error ${r.status}`);
    return data;
  });
}

function apiDelete(url) {
  return fetch(url, { method: "DELETE" }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || `HTTP Error ${r.status}`);
    return data;
  });
}

const tab = ref("tags"); // "tags" | "environments" | "groups" | "assign"

const canManage = computed(() => can("process_org_manage"));

// ---------- Catalogue : tags / environnements / groupes ----------
// Même structure pour les trois onglets : liste + petit formulaire inline
// (name [+ color pour tags/environnements, + description pour groupes]).

const tags = ref([]);
const environments = ref([]);
const groups = ref([]);
const loadingCatalog = ref(true);

function loadCatalog() {
  loadingCatalog.value = true;
  return Promise.all([
    apiGet("/api/process-organization/tags"),
    apiGet("/api/process-organization/environments"),
    apiGet("/api/process-organization/groups"),
  ])
    .then(([t2, e, g]) => {
      tags.value = t2;
      environments.value = e;
      groups.value = g;
    })
    .catch(notifyError)
    .finally(() => {
      loadingCatalog.value = false;
    });
}

onMounted(loadCatalog);

function emptyCatalogForm(withColor) {
  return { name: "", color: withColor ? "#2f81f7" : undefined, description: withColor ? undefined : "" };
}

const tagForm = ref(null); // null = pas de formulaire ouvert ; { mode, id?, name, color }
const envForm = ref(null);
const groupForm = ref(null);

function startCreateTag() {
  tagForm.value = { mode: "create", ...emptyCatalogForm(true) };
}
function startEditTag(tg) {
  tagForm.value = { mode: "edit", id: tg.id, name: tg.name, color: tg.color || "#2f81f7" };
}
function saveTag() {
  const f = tagForm.value;
  const req =
    f.mode === "create"
      ? apiPost("/api/process-organization/tags", { name: f.name, color: f.color })
      : apiPut(`/api/process-organization/tags/${f.id}`, { name: f.name, color: f.color });
  req
    .then(() => {
      tagForm.value = null;
      return loadCatalog();
    })
    .catch(notifyError);
}
function removeTag(tg) {
  if (!confirm(t("organizationModal.confirmDeleteTag", { name: tg.name }))) return;
  apiDelete(`/api/process-organization/tags/${tg.id}`).then(loadCatalog).catch(notifyError);
}

function startCreateEnv() {
  envForm.value = { mode: "create", ...emptyCatalogForm(true) };
}
function startEditEnv(e) {
  envForm.value = { mode: "edit", id: e.id, name: e.name, color: e.color || "#2f81f7" };
}
function saveEnv() {
  const f = envForm.value;
  const req =
    f.mode === "create"
      ? apiPost("/api/process-organization/environments", { name: f.name, color: f.color })
      : apiPut(`/api/process-organization/environments/${f.id}`, { name: f.name, color: f.color });
  req
    .then(() => {
      envForm.value = null;
      return loadCatalog();
    })
    .catch(notifyError);
}
function removeEnv(e) {
  if (!confirm(t("organizationModal.confirmDeleteEnvironment", { name: e.name }))) return;
  apiDelete(`/api/process-organization/environments/${e.id}`).then(loadCatalog).catch(notifyError);
}

function startCreateGroup() {
  groupForm.value = { mode: "create", ...emptyCatalogForm(false) };
}
function startEditGroup(g) {
  groupForm.value = { mode: "edit", id: g.id, name: g.name, description: g.description || "" };
}
function saveGroup() {
  const f = groupForm.value;
  const req =
    f.mode === "create"
      ? apiPost("/api/process-organization/groups", { name: f.name, description: f.description })
      : apiPut(`/api/process-organization/groups/${f.id}`, { name: f.name, description: f.description });
  req
    .then(() => {
      groupForm.value = null;
      return loadCatalog();
    })
    .catch(notifyError);
}
function removeGroup(g) {
  if (!confirm(t("organizationModal.confirmDeleteGroup", { name: g.name }))) return;
  apiDelete(`/api/process-organization/groups/${g.id}`).then(loadCatalog).catch(notifyError);
}

// ---------- Assignation ----------
// Un seul process à la fois (voir docstring de composant) : nom saisi
// librement (avec suggestions issues de state.processes — l'hôte local, seul
// disponible en direct côté client) + serveur optionnel (défaut "local",
// voir lib/services/process-organization/store.js#DEFAULT_SERVER_KEY).

const assignProcessName = ref("");
const assignServerKey = ref("local");
const assignTagIds = ref([]);
const assignEnvironmentId = ref(null);
const assignGroupIds = ref([]);
const assignLoading = ref(false);
const assignSaving = ref(false);
const assignLoaded = ref(false);

const knownProcessNames = computed(() => [...new Set(state.processes.map((p) => p.name))].sort());
const knownServerKeys = computed(() => {
  const keys = (state.servers?.items || []).map((s) => s.serverKey);
  return keys.length ? keys : ["local"];
});

function toggleAssignTag(id) {
  const i = assignTagIds.value.indexOf(id);
  if (i === -1) assignTagIds.value.push(id);
  else assignTagIds.value.splice(i, 1);
}
function toggleAssignGroup(id) {
  const i = assignGroupIds.value.indexOf(id);
  if (i === -1) assignGroupIds.value.push(id);
  else assignGroupIds.value.splice(i, 1);
}

function loadAssignment() {
  const name = assignProcessName.value.trim();
  if (!name) return;
  assignLoading.value = true;
  assignLoaded.value = false;
  apiGet(
    `/api/process-organization/assignments/${encodeURIComponent(name)}?serverKey=${encodeURIComponent(assignServerKey.value || "local")}`,
  )
    .then((org) => {
      assignTagIds.value = tags.value.filter((tg) => org.tags.includes(tg.name)).map((tg) => tg.id);
      const env = environments.value.find((e) => e.name === org.environment);
      assignEnvironmentId.value = env ? env.id : null;
      assignGroupIds.value = groups.value.filter((g) => org.groups.includes(g.name)).map((g) => g.id);
      assignLoaded.value = true;
    })
    .catch(notifyError)
    .finally(() => {
      assignLoading.value = false;
    });
}

function saveAssignment() {
  const name = assignProcessName.value.trim();
  if (!name) return notifyError(new Error(t("organizationModal.processNameRequired")));
  assignSaving.value = true;
  apiPut(`/api/process-organization/assignments/${encodeURIComponent(name)}`, {
    serverKey: assignServerKey.value || "local",
    tagIds: assignTagIds.value,
    environmentId: assignEnvironmentId.value,
    groups: assignGroupIds.value,
  })
    .then(() => {
      assignLoaded.value = true;
    })
    .catch(notifyError)
    .finally(() => {
      assignSaving.value = false;
    });
}
</script>

<template>
  <ModalBase :title="t('organizationModal.title')" hide-confirm @close="close">
    <div class="org-modal">
      <div class="org-tabs">
        <button class="icon-btn" :class="{ active: tab === 'tags' }" type="button" @click="tab = 'tags'">
          {{ t("organizationModal.tabTags") }}
        </button>
        <button
          class="icon-btn"
          :class="{ active: tab === 'environments' }"
          type="button"
          @click="tab = 'environments'"
        >
          {{ t("organizationModal.tabEnvironments") }}
        </button>
        <button class="icon-btn" :class="{ active: tab === 'groups' }" type="button" @click="tab = 'groups'">
          {{ t("organizationModal.tabGroups") }}
        </button>
        <button class="icon-btn" :class="{ active: tab === 'assign' }" type="button" @click="tab = 'assign'">
          {{ t("organizationModal.tabAssign") }}
        </button>
      </div>

      <div v-if="loadingCatalog" class="hint-text">{{ t("organizationModal.loading") }}</div>

      <template v-else>
        <!-- ---------- Tags ---------- -->
        <div v-if="tab === 'tags'" class="org-catalog">
          <div v-if="canManage" class="org-toolbar">
            <button v-if="!tagForm" class="icon-btn go" @click="startCreateTag">
              {{ t("organizationModal.newTag") }}
            </button>
          </div>

          <form v-if="tagForm" class="org-form" @submit.prevent="saveTag">
            <label>
              {{ t("organizationModal.name") }}
              <input
                v-model="tagForm.name"
                type="text"
                required
                :placeholder="t('organizationModal.tagPlaceholder')"
              />
            </label>
            <label>
              {{ t("organizationModal.color") }}
              <input v-model="tagForm.color" type="color" />
            </label>
            <div class="org-form-actions">
              <button type="button" class="icon-btn" @click="tagForm = null">{{ t("common.cancel") }}</button>
              <button type="submit" class="icon-btn go">{{ t("organizationModal.save") }}</button>
            </div>
          </form>

          <div v-if="!tags.length" class="org-empty">{{ t("organizationModal.emptyTags") }}</div>
          <div v-else class="org-chip-list">
            <div
              v-for="tg in tags"
              :key="tg.id"
              class="org-chip"
              :style="{ borderColor: tg.color || undefined }"
            >
              <span class="org-chip-dot" :style="{ background: tg.color || '#888' }"></span>
              <span>{{ tg.name }}</span>
              <template v-if="canManage">
                <button
                  class="org-chip-action"
                  :title="t('organizationModal.edit')"
                  @click="startEditTag(tg)"
                >
                  ✎
                </button>
                <button class="org-chip-action" :title="t('organizationModal.delete')" @click="removeTag(tg)">
                  ✕
                </button>
              </template>
            </div>
          </div>
        </div>

        <!-- ---------- Environnements ---------- -->
        <div v-else-if="tab === 'environments'" class="org-catalog">
          <div v-if="canManage" class="org-toolbar">
            <button v-if="!envForm" class="icon-btn go" @click="startCreateEnv">
              {{ t("organizationModal.newEnvironment") }}
            </button>
          </div>

          <form v-if="envForm" class="org-form" @submit.prevent="saveEnv">
            <label>
              {{ t("organizationModal.name") }}
              <input
                v-model="envForm.name"
                type="text"
                required
                :placeholder="t('organizationModal.environmentPlaceholder')"
              />
            </label>
            <label>
              {{ t("organizationModal.color") }}
              <input v-model="envForm.color" type="color" />
            </label>
            <div class="org-form-actions">
              <button type="button" class="icon-btn" @click="envForm = null">{{ t("common.cancel") }}</button>
              <button type="submit" class="icon-btn go">{{ t("organizationModal.save") }}</button>
            </div>
          </form>

          <div v-if="!environments.length" class="org-empty">
            {{ t("organizationModal.emptyEnvironments") }}
          </div>
          <div v-else class="org-chip-list">
            <div
              v-for="e in environments"
              :key="e.id"
              class="org-chip"
              :style="{ borderColor: e.color || undefined }"
            >
              <span class="org-chip-dot" :style="{ background: e.color || '#888' }"></span>
              <span>{{ e.name }}</span>
              <template v-if="canManage">
                <button class="org-chip-action" :title="t('organizationModal.edit')" @click="startEditEnv(e)">
                  ✎
                </button>
                <button class="org-chip-action" :title="t('organizationModal.delete')" @click="removeEnv(e)">
                  ✕
                </button>
              </template>
            </div>
          </div>
        </div>

        <!-- ---------- Groupes ---------- -->
        <div v-else-if="tab === 'groups'" class="org-catalog">
          <div v-if="canManage" class="org-toolbar">
            <button v-if="!groupForm" class="icon-btn go" @click="startCreateGroup">
              {{ t("organizationModal.newGroup") }}
            </button>
          </div>

          <form v-if="groupForm" class="org-form" @submit.prevent="saveGroup">
            <label>
              {{ t("organizationModal.name") }}
              <input
                v-model="groupForm.name"
                type="text"
                required
                :placeholder="t('organizationModal.groupPlaceholder')"
              />
            </label>
            <label>
              {{ t("organizationModal.description") }}
              <input v-model="groupForm.description" type="text" />
            </label>
            <div class="org-form-actions">
              <button type="button" class="icon-btn" @click="groupForm = null">
                {{ t("common.cancel") }}
              </button>
              <button type="submit" class="icon-btn go">{{ t("organizationModal.save") }}</button>
            </div>
          </form>

          <div v-if="!groups.length" class="org-empty">{{ t("organizationModal.emptyGroups") }}</div>
          <div v-else class="org-group-list">
            <div v-for="g in groups" :key="g.id" class="org-group-row">
              <div>
                <strong>{{ g.name }}</strong>
                <span v-if="g.description" class="hint-text"> — {{ g.description }}</span>
              </div>
              <div v-if="canManage" class="org-group-actions">
                <button class="icon-btn" @click="startEditGroup(g)">{{ t("organizationModal.edit") }}</button>
                <button class="icon-btn danger" @click="removeGroup(g)">
                  {{ t("organizationModal.delete") }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- ---------- Assignation ---------- -->
        <div v-else class="org-assign">
          <p class="hint-text">{{ t("organizationModal.assignHint") }}</p>

          <div class="org-assign-lookup">
            <label class="org-field">
              <span>{{ t("organizationModal.processName") }}</span>
              <input
                v-model="assignProcessName"
                type="text"
                list="org-process-names"
                :placeholder="t('organizationModal.processNamePlaceholder')"
                @keyup.enter="loadAssignment"
              />
              <datalist id="org-process-names">
                <option v-for="name in knownProcessNames" :key="name" :value="name" />
              </datalist>
            </label>

            <label class="org-field">
              <span>{{ t("organizationModal.server") }}</span>
              <input v-model="assignServerKey" type="text" list="org-server-keys" placeholder="local" />
              <datalist id="org-server-keys">
                <option v-for="key in knownServerKeys" :key="key" :value="key" />
              </datalist>
            </label>

            <button
              class="icon-btn"
              :disabled="!assignProcessName.trim() || assignLoading"
              @click="loadAssignment"
            >
              {{ assignLoading ? "…" : t("organizationModal.load") }}
            </button>
          </div>

          <template v-if="assignLoaded">
            <div class="org-field">
              <span>{{ t("organizationModal.tabTags") }}</span>
              <div v-if="!tags.length" class="hint-text">{{ t("organizationModal.emptyTags") }}</div>
              <div v-else class="route-chip-row">
                <label v-for="tg in tags" :key="tg.id" class="chk route-chip">
                  <input
                    type="checkbox"
                    :disabled="!canManage"
                    :checked="assignTagIds.includes(tg.id)"
                    @change="toggleAssignTag(tg.id)"
                  />
                  {{ tg.name }}
                </label>
              </div>
            </div>

            <label class="org-field">
              <span>{{ t("organizationModal.tabEnvironments") }}</span>
              <select v-model="assignEnvironmentId" :disabled="!canManage">
                <option :value="null">{{ t("organizationModal.noEnvironment") }}</option>
                <option v-for="e in environments" :key="e.id" :value="e.id">{{ e.name }}</option>
              </select>
            </label>

            <div class="org-field">
              <span>{{ t("organizationModal.tabGroups") }}</span>
              <div v-if="!groups.length" class="hint-text">{{ t("organizationModal.emptyGroups") }}</div>
              <div v-else class="route-chip-row">
                <label v-for="g in groups" :key="g.id" class="chk route-chip">
                  <input
                    type="checkbox"
                    :disabled="!canManage"
                    :checked="assignGroupIds.includes(g.id)"
                    @change="toggleAssignGroup(g.id)"
                  />
                  {{ g.name }}
                </label>
              </div>
            </div>

            <div v-if="canManage" class="org-form-actions">
              <button class="icon-btn go" :disabled="assignSaving" @click="saveAssignment">
                {{ assignSaving ? "…" : t("organizationModal.save") }}
              </button>
            </div>
          </template>
        </div>
      </template>
    </div>
  </ModalBase>
</template>

<style scoped>
.org-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 480px;
}
.org-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 4px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.org-tabs .icon-btn.active {
  background: var(--accent, #2f81f7);
  color: #fff;
  border-color: transparent;
}
.org-toolbar {
  display: flex;
  justify-content: flex-end;
}
.org-empty {
  opacity: 0.7;
  padding: 12px 0;
}
.org-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.org-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.org-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.org-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.org-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 13px;
}
.org-chip-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.org-chip-action {
  background: none;
  border: none;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  padding: 0 2px;
}
.org-chip-action:hover {
  opacity: 1;
}
.org-group-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.org-group-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  gap: 10px;
}
.org-group-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.org-assign {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.org-assign-lookup {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
.org-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
</style>
