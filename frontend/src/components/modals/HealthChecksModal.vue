<script setup>
/**
 * Settings → Health Checks (Phase 6).
 *
 * Système de vérification de disponibilité indépendant du statut PM2 (un
 * process "online" ne veut pas forcément dire "fonctionne réellement").
 * Même pattern que NotificationsModal.vue / UsersModal.vue : liste + petit
 * formulaire de création/édition dans la même modale, wrappers fetch locaux
 * (apiPut/apiDelete) car api.js n'expose que apiGet/apiPost.
 *
 * Backend : lib/routes/health-checks.js (CRUD + /:id/test + /status/summary
 * + /catalog), lib/services/health-checks/ (store + engine d'exécution,
 * alimente le moteur d'alertes existant — voir docs/health-checks/README.md).
 */
import { reactive, ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { state, notifyError, can } from "../../store";
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

const checks = ref([]);
const loading = ref(true);
const catalog = ref({ types: ["http", "tcp", "command"], methods: ["GET"], statuses: [] });
const testResults = reactive({}); // id -> { pending }

// null = liste ; sinon un objet de formulaire (create ou edit)
const editing = ref(null);

function load() {
  loading.value = true;
  return apiGet("/api/health-checks")
    .then((list) => {
      checks.value = list;
    })
    .catch(notifyError)
    .finally(() => {
      loading.value = false;
    });
}

onMounted(() => {
  load();
  apiGet("/api/health-checks/catalog")
    .then((c) => {
      catalog.value = c;
    })
    .catch(() => {});
});

function emptyForm(type = "http") {
  return {
    mode: "create",
    id: null,
    name: "",
    type,
    enabled: true,
    url: "",
    method: "GET",
    expectedStatus: "200-299",
    expectedContent: "",
    host: "",
    port: "",
    command: "",
    commandArgsText: "",
    expectedExitCode: 0,
    timeoutMs: 5000,
    intervalSeconds: 60,
    degradedThresholdMs: "",
  };
}

function startCreate() {
  editing.value = emptyForm();
}

function startEdit(c) {
  editing.value = {
    mode: "edit",
    id: c.id,
    name: c.name,
    type: c.type,
    enabled: c.enabled,
    url: c.url || "",
    method: c.method || "GET",
    expectedStatus: c.expectedStatus || "200-299",
    expectedContent: c.expectedContent || "",
    host: c.host || "",
    port: c.port || "",
    command: c.command || "",
    commandArgsText: Array.isArray(c.commandArgs) ? c.commandArgs.join(" ") : "",
    expectedExitCode: c.expectedExitCode ?? 0,
    timeoutMs: c.timeoutMs,
    intervalSeconds: c.intervalSeconds,
    degradedThresholdMs: c.degradedThresholdMs || "",
  };
}

function cancelEdit() {
  editing.value = null;
}

function buildPayload(f) {
  const payload = {
    name: f.name,
    type: f.type,
    enabled: !!f.enabled,
    timeoutMs: Number(f.timeoutMs) || 5000,
    intervalSeconds: Number(f.intervalSeconds) || 60,
    degradedThresholdMs: f.degradedThresholdMs === "" || f.degradedThresholdMs === null ? null : Number(f.degradedThresholdMs),
  };
  if (f.type === "http") {
    payload.url = f.url;
    payload.method = f.method;
    payload.expectedStatus = f.expectedStatus || "200-299";
    payload.expectedContent = f.expectedContent || null;
  } else if (f.type === "tcp") {
    payload.host = f.host;
    payload.port = Number(f.port);
  } else if (f.type === "command") {
    payload.command = f.command;
    payload.commandArgs = f.commandArgsText ? f.commandArgsText.trim().split(/\s+/) : [];
    payload.expectedExitCode = Number(f.expectedExitCode) || 0;
  }
  return payload;
}

function save() {
  const f = editing.value;
  const payload = buildPayload(f);
  const req = f.mode === "create" ? apiPost("/api/health-checks", payload) : apiPut(`/api/health-checks/${f.id}`, payload);
  req
    .then(() => {
      editing.value = null;
      return load();
    })
    .catch(notifyError);
}

function remove(c) {
  if (!confirm(t("healthChecksModal.confirmDelete", { name: c.name }))) return;
  apiDelete(`/api/health-checks/${c.id}`).then(load).catch(notifyError);
}

function toggleEnabled(c) {
  const action = c.enabled ? "disable" : "enable";
  apiPost(`/api/health-checks/${c.id}/${action}`).then(load).catch(notifyError);
}

function runTest(c) {
  testResults[c.id] = { pending: true };
  apiPost(`/api/health-checks/${c.id}/test`)
    .then(() => load())
    .catch(notifyError)
    .finally(() => {
      testResults[c.id] = { pending: false };
    });
}

const STATUS_ICON = { UP: "🟢", DOWN: "🔴", DEGRADED: "🟡", UNKNOWN: "⚪" };

function fmtTime(ts) {
  if (!ts) return t("healthChecksModal.never");
  return new Date(ts).toLocaleString(locale.value === "fr" ? "fr-FR" : "en-US");
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return "–";
  return `${ms} ms`;
}

const canCreate = computed(() => can("health_checks_create"));
const canUpdate = computed(() => can("health_checks_update"));
const canDelete = computed(() => can("health_checks_delete"));
const canTest = computed(() => can("health_checks_test"));
</script>

<template>
  <ModalBase :title="t('healthChecksModal.title')" hide-confirm @close="close">
    <div class="hc-modal">
      <div v-if="!editing" class="hc-list">
        <div class="hc-toolbar">
          <button v-if="canCreate" class="icon-btn go" @click="startCreate">{{ t("healthChecksModal.newCheck") }}</button>
        </div>

        <div v-if="loading">{{ t("healthChecksModal.loading") }}</div>
        <div v-else-if="!checks.length" class="hc-empty">{{ t("healthChecksModal.empty") }}</div>

        <div v-else class="hc-cards">
          <div v-for="c in checks" :key="c.id" class="hc-card" :class="{ disabled: !c.enabled }">
            <div class="hc-card-head">
              <span class="hc-status">{{ STATUS_ICON[c.status] || "⚪" }} {{ c.status }}</span>
              <strong>{{ c.name }}</strong>
              <span class="hc-type">{{ c.type }}</span>
            </div>
            <div class="hc-card-meta">
              <span>{{ t("healthChecksModal.lastCheck", { time: fmtTime(c.lastCheckAt) }) }}</span>
              <span>{{ t("healthChecksModal.lastResponseTime", { time: fmtMs(c.lastResponseTimeMs) }) }}</span>
              <span>{{ t("healthChecksModal.lastFailure", { time: fmtTime(c.lastFailureAt) }) }}</span>
            </div>
            <div v-if="c.lastError" class="hc-card-error">{{ c.lastError }}</div>
            <div class="hc-card-actions">
              <button v-if="canTest" class="icon-btn" :disabled="testResults[c.id]?.pending" @click="runTest(c)">
                {{ testResults[c.id]?.pending ? "…" : t("healthChecksModal.runTest") }}
              </button>
              <button v-if="canUpdate" class="icon-btn" @click="toggleEnabled(c)">
                {{ c.enabled ? t("healthChecksModal.disable") : t("healthChecksModal.enable") }}
              </button>
              <button v-if="canUpdate" class="icon-btn" @click="startEdit(c)">{{ t("healthChecksModal.edit") }}</button>
              <button v-if="canDelete" class="icon-btn danger" @click="remove(c)">{{ t("healthChecksModal.delete") }}</button>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="hc-form">
        <label>
          {{ t("healthChecksModal.name") }}
          <input v-model="editing.name" type="text" :placeholder="t('healthChecksModal.namePlaceholder')" />
        </label>

        <label>
          {{ t("healthChecksModal.type") }}
          <select v-model="editing.type" :disabled="editing.mode === 'edit'">
            <option v-for="t2 in catalog.types" :key="t2" :value="t2">{{ t2 }}</option>
          </select>
        </label>

        <template v-if="editing.type === 'http'">
          <label>{{ t("healthChecksModal.url") }} <input v-model="editing.url" type="text" placeholder="https://example.com/health" /></label>
          <label>
            {{ t("healthChecksModal.method") }}
            <select v-model="editing.method">
              <option v-for="m in catalog.methods" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>
          <label>{{ t("healthChecksModal.expectedStatus") }} <input v-model="editing.expectedStatus" type="text" placeholder="200-299" /></label>
          <label>{{ t("healthChecksModal.expectedContent") }} <input v-model="editing.expectedContent" type="text" /></label>
        </template>

        <template v-else-if="editing.type === 'tcp'">
          <label>{{ t("healthChecksModal.host") }} <input v-model="editing.host" type="text" placeholder="db.internal" /></label>
          <label>{{ t("healthChecksModal.port") }} <input v-model="editing.port" type="number" placeholder="5432" /></label>
        </template>

        <template v-else-if="editing.type === 'command'">
          <p class="hc-command-warning">
            {{ t("healthChecksModal.commandWarning") }}
          </p>
          <label>{{ t("healthChecksModal.command") }} <input v-model="editing.command" type="text" placeholder="/usr/local/bin/check.sh" /></label>
          <label>{{ t("healthChecksModal.commandArgs") }} <input v-model="editing.commandArgsText" type="text" /></label>
          <label>{{ t("healthChecksModal.expectedExitCode") }} <input v-model="editing.expectedExitCode" type="number" /></label>
        </template>

        <label>{{ t("healthChecksModal.timeout") }} <input v-model="editing.timeoutMs" type="number" /></label>
        <label>{{ t("healthChecksModal.interval") }} <input v-model="editing.intervalSeconds" type="number" /></label>
        <label>{{ t("healthChecksModal.degradedThreshold") }} <input v-model="editing.degradedThresholdMs" type="number" /></label>
        <label class="hc-inline-checkbox">
          <input v-model="editing.enabled" type="checkbox" /> {{ t("healthChecksModal.enabledLabel") }}
        </label>

        <div class="hc-form-actions">
          <button class="icon-btn" @click="cancelEdit">{{ t("common.cancel") }}</button>
          <button class="icon-btn go" @click="save">{{ t("healthChecksModal.save") }}</button>
        </div>
      </div>
    </div>
  </ModalBase>
</template>

<style scoped>
.hc-modal { display: flex; flex-direction: column; gap: 12px; min-width: 480px; }
.hc-toolbar { display: flex; justify-content: flex-end; }
.hc-empty { opacity: 0.7; padding: 12px 0; }
.hc-cards { display: flex; flex-direction: column; gap: 10px; }
.hc-card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.hc-card.disabled { opacity: 0.5; }
.hc-card-head { display: flex; align-items: center; gap: 8px; }
.hc-type { font-size: 12px; opacity: 0.7; border: 1px solid var(--border); border-radius: 4px; padding: 0 6px; }
.hc-card-meta { display: flex; gap: 14px; font-size: 12px; opacity: 0.8; margin-top: 4px; flex-wrap: wrap; }
.hc-card-error { font-size: 12px; color: var(--danger, #e5484d); margin-top: 4px; }
.hc-card-actions { display: flex; gap: 6px; margin-top: 8px; }
.hc-form { display: flex; flex-direction: column; gap: 10px; }
.hc-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.hc-inline-checkbox { flex-direction: row; align-items: center; gap: 6px; }
.hc-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
.hc-command-warning { font-size: 12px; opacity: 0.8; background: var(--panel-alt, rgba(255,255,255,0.05)); padding: 8px; border-radius: 6px; }
.icon-btn.danger { color: var(--danger, #e5484d); }
</style>
