<script setup>
/**
 * Settings → Détection d'anomalies (Phase 16).
 *
 * Même pattern que HealthChecksModal.vue : liste + petit formulaire de
 * création/édition dans la même modale, wrappers fetch locaux (apiPut/
 * apiDelete/apiPostRaw) car api.js n'expose que apiGet/apiPost.
 *
 * Backend : lib/routes/anomaly-detection.js (CRUD /rules + /catalog +
 * lecture /detections), lib/services/anomaly-detection/ (voir
 * docs/anomaly-detection/README.md). Les occurrences d'alerte produites par
 * une détection ne sont PAS gérées ici : elles vivent dans le moteur
 * d'alertes existant (mêmes flux que toute autre alerte, visibles dans le
 * Dashboard).
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { notifyError, can, state } from "../../store";
import { apiGet, apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

const { t, locale } = useI18n();

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

const tab = ref("rules"); // "rules" | "detections"

const rules = ref([]);
const loading = ref(true);
const catalog = ref({
  targetTypes: ["system", "process"],
  metricsByTargetType: { system: [], process: [] },
  severities: ["info", "warning", "critical"],
});

const detections = ref([]);
const detectionsLoading = ref(false);

// null = liste ; sinon un objet de formulaire (create ou edit)
const editing = ref(null);

function loadRules() {
  loading.value = true;
  return apiGet("/api/anomaly-detection/rules")
    .then((list) => {
      rules.value = list;
    })
    .catch(notifyError)
    .finally(() => {
      loading.value = false;
    });
}

function loadDetections() {
  detectionsLoading.value = true;
  return apiGet("/api/anomaly-detection/detections?limit=30")
    .then((res) => {
      detections.value = res.items || [];
    })
    .catch(notifyError)
    .finally(() => {
      detectionsLoading.value = false;
    });
}

function switchTab(name) {
  tab.value = name;
  if (name === "detections" && !detections.value.length) loadDetections();
}

onMounted(() => {
  loadRules();
  apiGet("/api/anomaly-detection/catalog")
    .then((c) => {
      catalog.value = c;
    })
    .catch(() => {});
});

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyForm(targetType = "process") {
  return {
    mode: "create",
    id: null,
    name: "",
    targetType,
    targetValue: "*",
    metric: catalog.value.metricsByTargetType[targetType]?.[0] || "cpu",
    sensitivity: 3,
    windowDays: 1,
    minSamples: 10,
    cooldownSeconds: 900,
    severity: "warning",
    enabled: true,
  };
}

function startCreate() {
  editing.value = emptyForm();
}

function startEdit(r) {
  editing.value = {
    mode: "edit",
    id: r.id,
    name: r.name,
    targetType: r.targetType,
    targetValue: r.targetValue || "*",
    metric: r.metric,
    sensitivity: r.sensitivity,
    windowDays: Math.max(0.01, r.windowMs / DAY_MS),
    minSamples: r.minSamples,
    cooldownSeconds: r.cooldownSeconds,
    severity: r.severity,
    enabled: r.enabled,
  };
}

function cancelEdit() {
  editing.value = null;
}

function onTargetTypeChange() {
  const f = editing.value;
  const metrics = catalog.value.metricsByTargetType[f.targetType] || [];
  if (!metrics.includes(f.metric)) f.metric = metrics[0] || "";
  if (f.targetType === "system") f.targetValue = "*";
}

function buildPayload(f) {
  return {
    name: f.name,
    targetType: f.targetType,
    targetValue: f.targetType === "system" ? null : f.targetValue || "*",
    metric: f.metric,
    sensitivity: Number(f.sensitivity) || 3,
    windowMs: Math.round((Number(f.windowDays) || 1) * DAY_MS),
    minSamples: Number(f.minSamples) || 10,
    cooldownSeconds: Number(f.cooldownSeconds) || 0,
    severity: f.severity,
    enabled: !!f.enabled,
  };
}

function save() {
  const f = editing.value;
  const payload = buildPayload(f);
  const req =
    f.mode === "create"
      ? apiPost("/api/anomaly-detection/rules", payload)
      : apiPut(`/api/anomaly-detection/rules/${f.id}`, payload);
  req
    .then(() => {
      editing.value = null;
      return loadRules();
    })
    .catch(notifyError);
}

function remove(r) {
  if (!confirm(t("anomalyModal.confirmDelete", { name: r.name }))) return;
  apiDelete(`/api/anomaly-detection/rules/${r.id}`).then(loadRules).catch(notifyError);
}

function toggleEnabled(r) {
  const action = r.enabled ? "disable" : "enable";
  apiPost(`/api/anomaly-detection/rules/${r.id}/${action}`).then(loadRules).catch(notifyError);
}

function fmtTime(ts) {
  if (!ts) return "–";
  return new Date(ts).toLocaleString(locale.value === "fr" ? "fr-FR" : "en-US");
}

function fmtWindow(ms) {
  const days = ms / DAY_MS;
  if (days >= 1) return t("anomalyModal.windowDays", { n: Math.round(days * 10) / 10 });
  return t("anomalyModal.windowHours", { n: Math.round((ms / (60 * 60 * 1000)) * 10) / 10 });
}

const METRIC_ICON = {
  cpu: "🖥",
  memory: "🧠",
  disk: "💾",
  restart_rate: "🔁",
  crash_rate: "💥",
  event_rate: "📈",
};

const canCreate = computed(() => can("anomaly_create"));
const canUpdate = computed(() => can("anomaly_update"));
const canDelete = computed(() => can("anomaly_delete"));
</script>

<template>
  <ModalBase :title="t('anomalyModal.title')" hide-confirm @close="close">
    <div class="an-modal">
      <div class="an-tabs">
        <button class="icon-btn" :class="{ go: tab === 'rules' }" @click="switchTab('rules')">
          {{ t("anomalyModal.tabRules") }}
        </button>
        <button class="icon-btn" :class="{ go: tab === 'detections' }" @click="switchTab('detections')">
          {{ t("anomalyModal.tabDetections") }}
        </button>
      </div>

      <div v-if="tab === 'rules'">
        <div v-if="!editing" class="an-list">
          <p class="an-intro">{{ t("anomalyModal.intro") }}</p>
          <div class="an-toolbar">
            <button v-if="canCreate" class="icon-btn go" @click="startCreate">
              {{ t("anomalyModal.newRule") }}
            </button>
          </div>

          <div v-if="loading">{{ t("anomalyModal.loading") }}</div>
          <div v-else-if="!rules.length" class="an-empty">{{ t("anomalyModal.empty") }}</div>

          <div v-else class="an-cards">
            <div v-for="r in rules" :key="r.id" class="an-card" :class="{ disabled: !r.enabled }">
              <div class="an-card-head">
                <span class="an-metric">{{ METRIC_ICON[r.metric] || "📊" }} {{ r.metric }}</span>
                <strong>{{ r.name }}</strong>
                <span class="an-severity" :class="`sev-${r.severity}`">{{ r.severity }}</span>
              </div>
              <div class="an-card-meta">
                <span>{{ t("anomalyModal.target") }} : {{ r.targetType === "system" ? t("anomalyModal.targetSystem") : (r.targetValue || "*") }}</span>
                <span>{{ t("anomalyModal.sensitivity") }} : {{ r.sensitivity }}σ</span>
                <span>{{ t("anomalyModal.window") }} : {{ fmtWindow(r.windowMs) }}</span>
                <span>{{ t("anomalyModal.cooldown") }} : {{ r.cooldownSeconds }}s</span>
              </div>
              <div class="an-card-actions">
                <button v-if="canUpdate" class="icon-btn" @click="toggleEnabled(r)">
                  {{ r.enabled ? t("anomalyModal.disable") : t("anomalyModal.enable") }}
                </button>
                <button v-if="canUpdate" class="icon-btn" @click="startEdit(r)">
                  {{ t("anomalyModal.edit") }}
                </button>
                <button v-if="canDelete" class="icon-btn danger" @click="remove(r)">
                  {{ t("anomalyModal.delete") }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="an-form">
          <label>
            {{ t("anomalyModal.name") }}
            <input v-model="editing.name" type="text" :placeholder="t('anomalyModal.namePlaceholder')" />
          </label>

          <label>
            {{ t("anomalyModal.targetType") }}
            <select v-model="editing.targetType" :disabled="editing.mode === 'edit'" @change="onTargetTypeChange">
              <option v-for="tt in catalog.targetTypes" :key="tt" :value="tt">
                {{ tt === "system" ? t("anomalyModal.targetSystem") : t("anomalyModal.targetProcess") }}
              </option>
            </select>
          </label>

          <label v-if="editing.targetType === 'process'">
            {{ t("anomalyModal.targetValue") }}
            <input v-model="editing.targetValue" type="text" placeholder="* (toutes les apps) ou nom-de-l-app" />
          </label>

          <label>
            {{ t("anomalyModal.metric") }}
            <select v-model="editing.metric" :disabled="editing.mode === 'edit'">
              <option v-for="m in catalog.metricsByTargetType[editing.targetType] || []" :key="m" :value="m">
                {{ m }}
              </option>
            </select>
          </label>

          <label>
            {{ t("anomalyModal.sensitivity") }}
            <input v-model="editing.sensitivity" type="number" min="0.5" step="0.5" />
          </label>
          <p class="an-hint">{{ t("anomalyModal.sensitivityHint") }}</p>

          <label>
            {{ t("anomalyModal.windowDaysLabel") }}
            <input v-model="editing.windowDays" type="number" min="0.05" step="0.5" />
          </label>

          <label>
            {{ t("anomalyModal.minSamples") }}
            <input v-model="editing.minSamples" type="number" min="1" />
          </label>

          <label>
            {{ t("anomalyModal.cooldown") }}
            <input v-model="editing.cooldownSeconds" type="number" min="0" />
          </label>

          <label>
            {{ t("anomalyModal.severity") }}
            <select v-model="editing.severity">
              <option v-for="s in catalog.severities" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>

          <label class="an-inline-checkbox">
            <input v-model="editing.enabled" type="checkbox" /> {{ t("anomalyModal.enabledLabel") }}
          </label>

          <div class="an-form-actions">
            <button class="icon-btn" @click="cancelEdit">{{ t("common.cancel") }}</button>
            <button class="icon-btn go" @click="save">{{ t("anomalyModal.save") }}</button>
          </div>
        </div>
      </div>

      <div v-else class="an-detections">
        <p class="an-intro">{{ t("anomalyModal.detectionsIntro") }}</p>
        <div v-if="detectionsLoading">{{ t("anomalyModal.loading") }}</div>
        <div v-else-if="!detections.length" class="an-empty">{{ t("anomalyModal.noDetections") }}</div>
        <div v-else class="an-cards">
          <div v-for="d in detections" :key="d.id" class="an-card">
            <div class="an-card-head">
              <span class="an-metric">{{ METRIC_ICON[d.metric] || "📊" }} {{ d.metric }}</span>
              <strong>{{ d.targetValue || t("anomalyModal.targetSystem") }}</strong>
              <span class="an-time">{{ fmtTime(d.createdAt) }}</span>
            </div>
            <p class="an-explanation">{{ d.explanation }}</p>
          </div>
        </div>
      </div>
    </div>
  </ModalBase>
</template>

<style scoped>
.an-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 480px;
}
.an-tabs {
  display: flex;
  gap: 6px;
}
.an-intro {
  font-size: 12px;
  opacity: 0.75;
  margin: 0;
}
.an-toolbar {
  display: flex;
  justify-content: flex-end;
}
.an-empty {
  opacity: 0.7;
  padding: 12px 0;
}
.an-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.an-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.an-card.disabled {
  opacity: 0.5;
}
.an-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.an-metric {
  font-size: 12px;
  opacity: 0.7;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 6px;
}
.an-severity {
  font-size: 11px;
  border-radius: 4px;
  padding: 1px 6px;
  text-transform: uppercase;
  margin-left: auto;
}
.sev-info {
  background: rgba(100, 149, 237, 0.15);
}
.sev-warning {
  background: rgba(230, 180, 40, 0.18);
}
.sev-critical {
  background: rgba(229, 72, 77, 0.2);
  color: var(--danger, #e5484d);
}
.an-time {
  font-size: 11px;
  opacity: 0.6;
  margin-left: auto;
}
.an-card-meta {
  display: flex;
  gap: 14px;
  font-size: 12px;
  opacity: 0.8;
  margin-top: 4px;
  flex-wrap: wrap;
}
.an-explanation {
  font-size: 12px;
  opacity: 0.85;
  margin: 6px 0 0;
}
.an-card-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.an-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.an-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.an-hint {
  font-size: 11px;
  opacity: 0.65;
  margin: -6px 0 0;
}
.an-inline-checkbox {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.an-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.icon-btn.danger {
  color: var(--danger, #e5484d);
}
</style>
