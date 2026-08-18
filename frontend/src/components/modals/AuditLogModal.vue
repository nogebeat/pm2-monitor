<script setup>
/**
 * Settings → Audit Log (Phase 9).
 *
 * Même pattern que HealthChecksModal.vue / NotificationsModal.vue : liste +
 * détail dans la même modale. Backend : lib/routes/audit.js (GET / avec
 * pagination + filtres, GET /:id, GET /catalog), lib/services/audit/
 * (voir docs/audit/README.md).
 *
 * Permission : audit_read (lecture seule — l'audit log n'est jamais
 * modifiable via l'API, voir docs/audit/README.md#retention).
 *
 * Les `metadata` affichées dans le détail sont déjà sanitisées côté serveur
 * (sanitizeAuditMetadata, voir lib/services/audit/sanitize.js) : ce
 * composant les affiche telles quelles, sans logique de masquage
 * supplémentaire côté client (le client ne doit pas avoir besoin de
 * "faire confiance" à un masquage frontend — le secret n'a de toute façon
 * jamais quitté le serveur).
 */
import { reactive, ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { state, notifyError } from "../../store";
import { apiGet } from "../../api";
import ModalBase from "../ModalBase.vue";

const { t, locale } = useI18n();

function close() {
  state.modal = null;
}

const items = ref([]);
const total = ref(0);
const loading = ref(true);
const catalog = ref({ actions: {}, statuses: [] });
const selected = ref(null); // entrée sélectionnée pour le détail

const PAGE_SIZE = 25;
const filters = reactive({
  username: "",
  action: "",
  status: "",
  target: "",
  start: "", // datetime-local string
  end: "",
});
const offset = ref(0);

const actionOptions = computed(() => Object.values(catalog.value.actions || {}));

function buildQuery() {
  const params = new URLSearchParams();
  if (filters.username) params.set("username", filters.username.trim());
  if (filters.action) params.set("action", filters.action);
  if (filters.status) params.set("status", filters.status);
  if (filters.target) params.set("target", filters.target.trim());
  if (filters.start) params.set("start", String(new Date(filters.start).getTime()));
  if (filters.end) params.set("end", String(new Date(filters.end).getTime()));
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset.value));
  return params.toString();
}

function load() {
  loading.value = true;
  return apiGet(`/api/audit?${buildQuery()}`)
    .then((r) => {
      items.value = r.items;
      total.value = r.total;
    })
    .catch(notifyError)
    .finally(() => {
      loading.value = false;
    });
}

function applyFilters() {
  offset.value = 0;
  load();
}

function resetFilters() {
  filters.username = "";
  filters.action = "";
  filters.status = "";
  filters.target = "";
  filters.start = "";
  filters.end = "";
  offset.value = 0;
  load();
}

function nextPage() {
  if (offset.value + PAGE_SIZE >= total.value) return;
  offset.value += PAGE_SIZE;
  load();
}

function prevPage() {
  if (offset.value === 0) return;
  offset.value = Math.max(0, offset.value - PAGE_SIZE);
  load();
}

function openDetail(entry) {
  selected.value = entry;
}

function closeDetail() {
  selected.value = null;
}

onMounted(() => {
  load();
  apiGet("/api/audit/catalog")
    .then((c) => {
      catalog.value = c;
    })
    .catch(() => {});
});

const STATUS_ICON = { success: "✅", failed: "⚠️", denied: "⛔" };

function fmtTime(ts) {
  if (!ts) return "–";
  return new Date(ts).toLocaleString(locale.value === "fr" ? "fr-FR" : "en-US");
}

const currentPageLabel = computed(() => {
  if (!total.value) return "0 / 0";
  const from = offset.value + 1;
  const to = Math.min(offset.value + PAGE_SIZE, total.value);
  return `${from}–${to} / ${total.value}`;
});
</script>

<template>
  <ModalBase :title="t('auditLogModal.title')" hide-confirm @close="close">
    <div class="audit-modal">
      <div v-if="!selected" class="audit-list">
        <div class="audit-filters">
          <label>
            {{ t("auditLogModal.username") }}
            <input v-model="filters.username" type="text" :placeholder="t('auditLogModal.usernamePlaceholder')" @keyup.enter="applyFilters" />
          </label>
          <label>
            {{ t("auditLogModal.action") }}
            <select v-model="filters.action">
              <option value="">{{ t("auditLogModal.all") }}</option>
              <option v-for="a in actionOptions" :key="a" :value="a">{{ a }}</option>
            </select>
          </label>
          <label>
            {{ t("auditLogModal.status") }}
            <select v-model="filters.status">
              <option value="">{{ t("auditLogModal.allMasc") }}</option>
              <option v-for="s in catalog.statuses" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>
          <label>
            {{ t("auditLogModal.target") }}
            <input v-model="filters.target" type="text" :placeholder="t('auditLogModal.targetPlaceholder')" @keyup.enter="applyFilters" />
          </label>
          <label>
            {{ t("auditLogModal.from") }}
            <input v-model="filters.start" type="datetime-local" />
          </label>
          <label>
            {{ t("auditLogModal.to") }}
            <input v-model="filters.end" type="datetime-local" />
          </label>
          <div class="audit-filters-actions">
            <button class="icon-btn go" @click="applyFilters">{{ t("auditLogModal.filter") }}</button>
            <button class="icon-btn" @click="resetFilters">{{ t("auditLogModal.reset") }}</button>
          </div>
        </div>

        <div v-if="loading">{{ t("auditLogModal.loading") }}</div>
        <div v-else-if="!items.length" class="audit-empty">{{ t("auditLogModal.empty") }}</div>

        <table v-else class="audit-table">
          <thead>
            <tr>
              <th>{{ t("auditLogModal.colDate") }}</th>
              <th>{{ t("auditLogModal.colUser") }}</th>
              <th>{{ t("auditLogModal.colAction") }}</th>
              <th>{{ t("auditLogModal.colTarget") }}</th>
              <th>{{ t("auditLogModal.colStatus") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in items" :key="entry.id" class="audit-row" @click="openDetail(entry)">
              <td>{{ fmtTime(entry.timestamp) }}</td>
              <td>{{ entry.username || "–" }}</td>
              <td>{{ entry.action }}</td>
              <td>{{ entry.target || "–" }}</td>
              <td>{{ STATUS_ICON[entry.status] || "" }} {{ entry.status }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="items.length" class="audit-pagination">
          <button class="icon-btn" :disabled="offset === 0" @click="prevPage">{{ t("auditLogModal.prev") }}</button>
          <span>{{ currentPageLabel }}</span>
          <button class="icon-btn" :disabled="offset + PAGE_SIZE >= total" @click="nextPage">{{ t("auditLogModal.next") }}</button>
        </div>
      </div>

      <div v-else class="audit-detail">
        <button class="icon-btn" @click="closeDetail">{{ t("auditLogModal.backToList") }}</button>
        <dl class="audit-detail-grid">
          <dt>{{ t("auditLogModal.date") }}</dt>
          <dd>{{ fmtTime(selected.timestamp) }}</dd>
          <dt>{{ t("auditLogModal.user") }}</dt>
          <dd>{{ selected.username || "–" }} <span v-if="selected.userId" class="audit-muted">(#{{ selected.userId }})</span></dd>
          <dt>{{ t("auditLogModal.action") }}</dt>
          <dd>{{ selected.action }}</dd>
          <dt>{{ t("auditLogModal.target") }}</dt>
          <dd>{{ selected.target || "–" }} <span v-if="selected.targetType" class="audit-muted">({{ selected.targetType }})</span></dd>
          <dt>{{ t("auditLogModal.status") }}</dt>
          <dd>{{ STATUS_ICON[selected.status] || "" }} {{ selected.status }}</dd>
          <dt>{{ t("auditLogModal.server") }}</dt>
          <dd>{{ selected.server || "–" }}</dd>
          <dt>{{ t("auditLogModal.ip") }}</dt>
          <dd>{{ selected.ip || "–" }}</dd>
        </dl>
        <div class="audit-metadata">
          <div class="audit-metadata-label">
            {{ t("auditLogModal.metadataLabel") }}
          </div>
          <pre v-if="selected.metadata">{{ JSON.stringify(selected.metadata, null, 2) }}</pre>
          <div v-else class="audit-muted">{{ t("auditLogModal.noMetadata") }}</div>
        </div>
      </div>
    </div>
  </ModalBase>
</template>

<style scoped>
.audit-modal { display: flex; flex-direction: column; gap: 12px; min-width: 560px; max-width: 720px; }
.audit-filters {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px 12px;
  align-items: end;
}
.audit-filters label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.audit-filters-actions { display: flex; gap: 8px; grid-column: span 3; justify-content: flex-end; }
.audit-empty { opacity: 0.7; padding: 12px 0; }
.audit-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.audit-table th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); opacity: 0.7; }
.audit-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
.audit-row { cursor: pointer; }
.audit-row:hover { background: var(--panel-alt, rgba(255, 255, 255, 0.05)); }
.audit-pagination { display: flex; align-items: center; justify-content: center; gap: 12px; font-size: 13px; }
.audit-detail { display: flex; flex-direction: column; gap: 12px; }
.audit-detail-grid { display: grid; grid-template-columns: 120px 1fr; gap: 6px 10px; font-size: 13px; margin: 0; }
.audit-detail-grid dt { opacity: 0.7; }
.audit-detail-grid dd { margin: 0; }
.audit-muted { opacity: 0.6; font-size: 12px; }
.audit-metadata { border-top: 1px solid var(--border); padding-top: 10px; }
.audit-metadata-label { font-size: 12px; opacity: 0.7; margin-bottom: 6px; }
.audit-metadata pre {
  background: var(--panel-alt, rgba(255, 255, 255, 0.05));
  border-radius: 6px;
  padding: 10px;
  font-size: 12px;
  overflow-x: auto;
  max-height: 300px;
}
</style>
