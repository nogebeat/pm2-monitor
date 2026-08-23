<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  state,
  can,
  loadIncidents,
  setIncidentsStatusFilter,
  loadIncidentsCatalog,
  selectIncident,
  transitionIncident,
  loadSilences,
  createSilence,
  cancelSilence,
} from "../store";

/**
 * Vue "Incidents" (Phase 14 — Incident Management & Alert Silencing) : liste
 * des incidents (corrélés depuis l'Alert Engine, lib/services/incidents/),
 * détail + timeline fusionnée (alertes/événements PM2/notifications/
 * auto-healing), transitions d'état, et gestion des silences. Même
 * structure "liste + détail" que ProcessSidebar/LogsPanel, câblée sur
 * lib/routes/incidents.js via store.js.
 */

const { t, locale } = useI18n();

const subView = ref("incidents"); // "incidents" | "silences"

const STATUS_FILTERS = computed(() => [
  { key: "all", label: t("incidents.filterAll") },
  { key: "OPEN", label: t("incidents.filterOpen") },
  { key: "ACKNOWLEDGED", label: t("incidents.filterAcknowledged") },
  { key: "INVESTIGATING", label: t("incidents.filterInvestigating") },
  { key: "MITIGATED", label: t("incidents.filterMitigated") },
  { key: "RESOLVED", label: t("incidents.filterResolved") },
]);

const STATUS_LABELS = computed(() => ({
  OPEN: t("incidents.statusOpen"),
  ACKNOWLEDGED: t("incidents.statusAcknowledged"),
  INVESTIGATING: t("incidents.statusInvestigating"),
  MITIGATED: t("incidents.statusMitigated"),
  RESOLVED: t("incidents.statusResolved"),
}));

const TIMELINE_LABELS = computed(() => ({
  alert_triggered: t("incidents.timelineTypeAlertTriggered"),
  health_check: t("incidents.timelineTypeHealthCheck"),
  resolution: t("incidents.timelineTypeResolution"),
  process_event: t("incidents.timelineTypeProcessEvent"),
  notification: t("incidents.timelineTypeNotification"),
  auto_healing: t("incidents.timelineTypeAutoHealing"),
  acknowledge: t("incidents.timelineTypeAcknowledge"),
  state_change: t("incidents.timelineTypeStateChange"),
}));

// Reflète lib/services/incidents/incident-store.js#ALLOWED_TRANSITIONS — la
// vérité vient du serveur (transitionIncident renvoie une erreur 400 sinon),
// ceci n'est qu'un confort d'UI pour ne proposer que les boutons pertinents.
const ALLOWED_ACTIONS = {
  OPEN: ["acknowledge", "investigate", "mitigate", "resolve"],
  ACKNOWLEDGED: ["investigate", "mitigate", "resolve"],
  INVESTIGATING: ["mitigate", "acknowledge", "resolve"],
  MITIGATED: ["resolve", "investigate"],
  RESOLVED: [],
};

const detail = computed(() => state.incidents.detail);
const availableActions = computed(() => (detail.value ? ALLOWED_ACTIONS[detail.value.status] || [] : []));

function dateLabel(ts) {
  if (!ts) return "–";
  return new Date(ts).toLocaleString(locale.value === "fr" ? "fr-FR" : "en-US");
}

function doTransition(action) {
  if (!detail.value) return;
  transitionIncident(detail.value.id, action).catch(() => {});
}

// --- Formulaire de création de silence ---
const emptySilenceForm = () => ({
  scopeType: "process",
  scopeValue: "",
  silenceType: "duration",
  durationMinutes: 30,
  until: "",
  reason: "",
});
const silenceForm = ref(emptySilenceForm());
const showSilenceForm = ref(false);

function submitSilence() {
  const fields = { ...silenceForm.value };
  if (fields.silenceType === "duration") {
    fields.durationMinutes = Number(fields.durationMinutes);
    delete fields.until;
  } else {
    delete fields.durationMinutes;
  }
  createSilence(fields)
    .then(() => {
      showSilenceForm.value = false;
      silenceForm.value = emptySilenceForm();
    })
    .catch(() => {});
}

/** Raccourci depuis le détail d'un incident : pré-remplit le scope "process" avec sa cible. */
function openSilenceForIncident() {
  if (!detail.value) return;
  silenceForm.value = emptySilenceForm();
  silenceForm.value.scopeType = detail.value.targetType === "process" ? "process" : "rule";
  silenceForm.value.scopeValue = detail.value.targetValue || "";
  subView.value = "silences";
  showSilenceForm.value = true;
  if (!state.incidents.silencesLoaded) loadSilences();
}

function doCancelSilence(id) {
  cancelSilence(id).catch(() => {});
}

onMounted(() => {
  if (!state.incidents.catalog) loadIncidentsCatalog();
  if (!state.incidents.loaded) loadIncidents();
});

watch(subView, (v) => {
  if (v === "silences" && !state.incidents.silencesLoaded) loadSilences();
});
</script>

<template>
  <main class="incidents-view">
    <div class="incidents-head">
      <h2>{{ t("incidents.title") }}</h2>
      <div class="sub-tabs" role="tablist">
        <button
          class="filter-btn"
          :class="{ active: subView === 'incidents' }"
          @click="subView = 'incidents'"
        >
          {{ t("incidents.title") }}
        </button>
        <button class="filter-btn" :class="{ active: subView === 'silences' }" @click="subView = 'silences'">
          {{ t("incidents.silencesTitle") }}
        </button>
      </div>
    </div>

    <section v-if="subView === 'incidents'" class="incidents-body">
      <div class="incidents-list-panel">
        <div class="filter-group" role="group" :aria-label="t('incidents.filterAll')">
          <button
            v-for="f in STATUS_FILTERS"
            :key="f.key"
            class="filter-btn"
            :class="{ active: state.incidents.statusFilter === f.key }"
            @click="setIncidentsStatusFilter(f.key)"
          >
            {{ f.label }}
          </button>
        </div>

        <div v-if="!state.incidents.loaded && state.incidents.loading" class="incidents-empty">
          {{ t("incidents.loading") }}
        </div>
        <div v-else-if="!state.incidents.items.length" class="incidents-empty">
          {{ state.incidents.statusFilter !== "all" ? t("incidents.noneWithFilter") : t("incidents.none") }}
        </div>

        <ul v-else class="incidents-list">
          <li
            v-for="incident in state.incidents.items"
            :key="incident.id"
            class="incident-row"
            :class="[`severity-${incident.severity}`, { active: state.incidents.selectedId === incident.id }]"
            @click="selectIncident(incident.id)"
          >
            <span class="incident-badge" :class="`badge-${incident.severity}`">{{
              t(`incidents.severity${incident.severity.charAt(0).toUpperCase()}${incident.severity.slice(1)}`)
            }}</span>
            <div class="incident-main">
              <span class="incident-title">{{ incident.title }}</span>
              <span class="incident-sub">{{ incident.targetValue || "system" }} · {{ incident.metric }}</span>
            </div>
            <span class="incident-status" :class="`status-${incident.status}`">{{
              STATUS_LABELS[incident.status] || incident.status
            }}</span>
          </li>
        </ul>
      </div>

      <div class="incident-detail-panel">
        <div v-if="!detail" class="incidents-empty">{{ t("incidents.selectPrompt") }}</div>
        <template v-else>
          <div class="detail-head">
            <h3>{{ t("incidents.detailTitle", { id: detail.id }) }}</h3>
            <span class="incident-status" :class="`status-${detail.status}`">{{
              STATUS_LABELS[detail.status] || detail.status
            }}</span>
          </div>
          <p class="detail-title">{{ detail.title }}</p>
          <dl class="detail-meta">
            <div>
              <dt>{{ t("incidents.target") }}</dt>
              <dd>{{ detail.targetValue || "system" }}</dd>
            </div>
            <div>
              <dt>{{ t("incidents.metric") }}</dt>
              <dd>{{ detail.metric }}</dd>
            </div>
            <div>
              <dt>{{ t("incidents.openedAt") }}</dt>
              <dd>{{ dateLabel(detail.openedAt) }}</dd>
            </div>
          </dl>

          <div v-if="can('incidents_manage')" class="detail-actions">
            <button
              v-for="action in availableActions"
              :key="action"
              class="filter-btn"
              @click="doTransition(action)"
            >
              {{ t(`incidents.${action}`) }}
            </button>
            <button class="filter-btn" @click="openSilenceForIncident">{{ t("incidents.silence") }}</button>
          </div>

          <h4 class="timeline-title">{{ t("incidents.timelineTitle") }}</h4>
          <div v-if="state.incidents.timelineLoading" class="incidents-empty">
            {{ t("incidents.timelineLoading") }}
          </div>
          <div v-else-if="!state.incidents.timeline.length" class="incidents-empty">
            {{ t("incidents.timelineEmpty") }}
          </div>
          <ul v-else class="timeline-list">
            <li v-for="entry in state.incidents.timeline" :key="entry.id" class="timeline-row">
              <span class="timeline-time">{{ dateLabel(entry.ts) }}</span>
              <span class="timeline-type">{{ TIMELINE_LABELS[entry.type] || entry.type }}</span>
              <span class="timeline-summary">{{ entry.summary }}</span>
            </li>
          </ul>
        </template>
      </div>
    </section>

    <section v-else class="silences-body">
      <div v-if="can('incidents_manage')" class="silences-actions">
        <button class="filter-btn" @click="showSilenceForm = !showSilenceForm">
          {{ t("incidents.newSilence") }}
        </button>
      </div>

      <form
        v-if="showSilenceForm && can('incidents_manage')"
        class="silence-form"
        @submit.prevent="submitSilence"
      >
        <label>
          {{ t("incidents.silenceScopeType") }}
          <select v-model="silenceForm.scopeType">
            <option value="rule">{{ t("incidents.silenceScopeRule") }}</option>
            <option value="process">{{ t("incidents.silenceScopeProcess") }}</option>
            <option value="tag">{{ t("incidents.silenceScopeTag") }}</option>
            <option value="environment">{{ t("incidents.silenceScopeEnvironment") }}</option>
            <option value="group">{{ t("incidents.silenceScopeGroup") }}</option>
          </select>
        </label>
        <label>
          {{ t("incidents.silenceScopeValue") }}
          <input
            v-model="silenceForm.scopeValue"
            type="text"
            :placeholder="t('incidents.silenceScopeValuePlaceholder')"
            required
          />
        </label>
        <label>
          {{ t("incidents.silenceTypeDuration") }} / {{ t("incidents.silenceTypeUntil") }}
          <select v-model="silenceForm.silenceType">
            <option value="duration">{{ t("incidents.silenceTypeDuration") }}</option>
            <option value="until">{{ t("incidents.silenceTypeUntil") }}</option>
          </select>
        </label>
        <label v-if="silenceForm.silenceType === 'duration'">
          {{ t("incidents.silenceDurationMinutes") }}
          <input v-model.number="silenceForm.durationMinutes" type="number" min="1" required />
        </label>
        <label v-else>
          {{ t("incidents.silenceUntil") }}
          <input v-model="silenceForm.until" type="datetime-local" required />
        </label>
        <label>
          {{ t("incidents.silenceReason") }}
          <input
            v-model="silenceForm.reason"
            type="text"
            :placeholder="t('incidents.silenceReasonPlaceholder')"
          />
        </label>
        <button type="submit" class="filter-btn active">{{ t("incidents.createSilence") }}</button>
      </form>

      <div v-if="state.incidents.silencesLoading" class="incidents-empty">{{ t("incidents.loading") }}</div>
      <div v-else-if="!state.incidents.silences.length" class="incidents-empty">
        {{ t("incidents.silencesEmpty") }}
      </div>
      <ul v-else class="silences-list">
        <li v-for="s in state.incidents.silences" :key="s.id" class="silence-row">
          <span class="silence-scope">{{ s.scopeType }}: {{ s.scopeValue }}</span>
          <span v-if="s.reason" class="silence-reason">{{ s.reason }}</span>
          <span class="silence-expires"
            >{{ t("incidents.silenceExpiresAt") }} {{ dateLabel(s.expiresAt) }}</span
          >
          <span class="silence-state" :class="s.active ? 'is-active' : 'is-inactive'">{{
            s.active ? t("incidents.silenceActive") : t("incidents.silenceCancelled")
          }}</span>
          <button
            v-if="can('incidents_manage') && s.active"
            class="filter-btn"
            @click="doCancelSilence(s.id)"
          >
            {{ t("incidents.cancelSilence") }}
          </button>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.incidents-view {
  flex: 1;
  overflow-y: auto;
  padding: 22px 24px 40px;
}

.incidents-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  max-width: 1200px;
  margin: 0 auto 16px;
}

.sub-tabs {
  display: flex;
  gap: 8px;
}

.incidents-body {
  display: flex;
  gap: 20px;
  max-width: 1200px;
  margin: 0 auto;
  align-items: flex-start;
}

.incidents-list-panel {
  flex: 1;
  min-width: 0;
}

.incident-detail-panel {
  flex: 1;
  min-width: 0;
  background: var(--panel, transparent);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}

.incidents-empty {
  padding: 32px 8px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.incidents-list,
.timeline-list,
.silences-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.incident-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
.incident-row.active {
  border-color: var(--accent, #5fa8d3);
}
.incident-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.incident-title {
  font-weight: 600;
}
.incident-sub {
  font-size: 12px;
  color: var(--text-muted);
}

.incident-badge,
.badge-critical,
.badge-warning,
.badge-info {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}
.badge-critical {
  background: rgba(232, 93, 93, 0.15);
  color: #e85d5d;
}
.badge-warning {
  background: rgba(224, 166, 79, 0.15);
  color: #e0a64f;
}
.badge-info {
  background: rgba(95, 168, 211, 0.15);
  color: #5fa8d3;
}

.incident-status {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  white-space: nowrap;
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.detail-title {
  font-weight: 600;
  margin: 4px 0 12px;
}
.detail-meta {
  display: flex;
  gap: 20px;
  margin: 0 0 12px;
}
.detail-meta dt {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
}
.detail-meta dd {
  margin: 0;
  font-size: 13px;
}
.detail-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.timeline-title {
  margin: 12px 0 8px;
}
.timeline-row {
  display: flex;
  gap: 10px;
  font-size: 13px;
  padding: 6px 4px;
  border-bottom: 1px dashed var(--border);
}
.timeline-time {
  color: var(--text-muted);
  white-space: nowrap;
}
.timeline-type {
  font-weight: 600;
  white-space: nowrap;
}
.timeline-summary {
  flex: 1;
  min-width: 0;
}

.silences-body {
  max-width: 900px;
  margin: 0 auto;
}
.silences-actions {
  margin-bottom: 12px;
}
.silence-form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 16px;
}
.silence-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}
.silence-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
}
.silence-scope {
  font-weight: 600;
}
.silence-reason,
.silence-expires {
  color: var(--text-muted);
}
.silence-state.is-active {
  color: #4fd68c;
}
.silence-state.is-inactive {
  color: var(--text-muted);
}
</style>
