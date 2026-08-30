<script setup>
/**
 * Settings → Plugins (Phase 21).
 *
 * Même pattern que AnomalyDetectionModal.vue : liste + petit formulaire
 * (ici : édition de la config JSON d'un plugin) dans la même modale,
 * wrappers fetch locaux (apiPut) car api.js n'expose que apiGet/apiPost.
 *
 * Backend : lib/routes/plugins.js (liste/détail/enable/disable/config),
 * lib/services/plugins/ (voir docs/plugins/README.md). Volontairement AUCUN
 * bouton "installer" : un plugin s'ajoute uniquement en déposant un dossier
 * sur le serveur (plugins/<nom>/index.js), jamais depuis l'UI.
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { notifyError, can, state } from "../../store";
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

const items = ref([]);
const loading = ref(true);

// null = liste ; sinon { name, text } = édition de la config JSON d'un plugin
const editingConfig = ref(null);
const configError = ref("");

function loadPlugins() {
  loading.value = true;
  return apiGet("/api/plugins")
    .then((list) => {
      items.value = list;
    })
    .catch(notifyError)
    .finally(() => {
      loading.value = false;
    });
}

onMounted(loadPlugins);

const STATUS_LABEL = {
  active: "pluginsModal.statusActive",
  disabled: "pluginsModal.statusDisabled",
  error: "pluginsModal.statusError",
  invalid: "pluginsModal.statusInvalid",
  incompatible: "pluginsModal.statusIncompatible",
};

function statusLabel(status) {
  return t(STATUS_LABEL[status] || status);
}

function toggleEnabled(p) {
  const action = p.enabled ? "disable" : "enable";
  apiPost(`/api/plugins/${encodeURIComponent(p.name)}/${action}`)
    .then(loadPlugins)
    .catch(notifyError);
}

function startEditConfig(p) {
  configError.value = "";
  editingConfig.value = { name: p.name, text: JSON.stringify(p.config || {}, null, 2) };
}

function cancelEditConfig() {
  editingConfig.value = null;
  configError.value = "";
}

function saveConfig() {
  let parsed;
  try {
    parsed = JSON.parse(editingConfig.value.text || "{}");
  } catch (e) {
    configError.value = t("pluginsModal.invalidJson");
    return;
  }
  apiPut(`/api/plugins/${encodeURIComponent(editingConfig.value.name)}/config`, parsed)
    .then(() => {
      editingConfig.value = null;
      return loadPlugins();
    })
    .catch(notifyError);
}

const canManage = computed(() => can("plugins_manage"));
</script>

<template>
  <ModalBase :title="t('pluginsModal.title')" hide-confirm @close="close">
    <div class="pl-modal">
      <p class="pl-intro">{{ t("pluginsModal.intro") }}</p>

      <div v-if="loading">{{ t("pluginsModal.loading") }}</div>
      <div v-else-if="!items.length" class="pl-empty">{{ t("pluginsModal.empty") }}</div>

      <div v-else class="pl-cards">
        <div v-for="p in items" :key="p.name" class="pl-card" :class="`status-${p.status}`">
          <div class="pl-card-head">
            <strong>{{ p.name }}</strong>
            <span v-if="p.version" class="pl-version">v{{ p.version }}</span>
            <span class="pl-status" :class="`status-${p.status}`">{{ statusLabel(p.status) }}</span>
          </div>
          <p v-if="p.description" class="pl-desc">{{ p.description }}</p>
          <p v-if="p.error" class="pl-error">{{ p.error }}</p>

          <div v-if="editingConfig && editingConfig.name === p.name" class="pl-config-form">
            <textarea v-model="editingConfig.text" rows="6" spellcheck="false"></textarea>
            <p v-if="configError" class="pl-error">{{ configError }}</p>
            <div class="pl-form-actions">
              <button class="icon-btn" @click="cancelEditConfig">{{ t("common.cancel") }}</button>
              <button class="icon-btn go" @click="saveConfig">{{ t("pluginsModal.saveConfig") }}</button>
            </div>
          </div>

          <div v-else class="pl-card-actions">
            <button v-if="canManage && p.compatible" class="icon-btn" @click="toggleEnabled(p)">
              {{ p.enabled ? t("pluginsModal.disable") : t("pluginsModal.enable") }}
            </button>
            <button v-if="canManage" class="icon-btn" @click="startEditConfig(p)">
              {{ t("pluginsModal.editConfig") }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </ModalBase>
</template>

<style scoped>
.pl-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 480px;
}
.pl-intro {
  font-size: 12px;
  opacity: 0.75;
  margin: 0;
}
.pl-empty {
  opacity: 0.7;
  padding: 12px 0;
}
.pl-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pl-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.pl-card.status-disabled {
  opacity: 0.6;
}
.pl-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pl-version {
  font-size: 11px;
  opacity: 0.7;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 6px;
}
.pl-status {
  font-size: 11px;
  border-radius: 4px;
  padding: 1px 6px;
  text-transform: uppercase;
  margin-left: auto;
}
.status-active .pl-status {
  background: rgba(80, 200, 120, 0.18);
}
.status-disabled .pl-status {
  background: rgba(140, 140, 140, 0.18);
}
.status-error .pl-status,
.status-invalid .pl-status,
.status-incompatible .pl-status {
  background: rgba(229, 72, 77, 0.2);
  color: var(--danger, #e5484d);
}
.pl-desc {
  font-size: 12px;
  opacity: 0.85;
  margin: 6px 0 0;
}
.pl-error {
  font-size: 12px;
  color: var(--danger, #e5484d);
  margin: 6px 0 0;
}
.pl-card-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.pl-config-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.pl-config-form textarea {
  font-family: monospace;
  font-size: 12px;
  width: 100%;
  resize: vertical;
}
.pl-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
