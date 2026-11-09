<script setup>
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { state, logout, can, canAny, openLogExplorer } from "../store";
import LanguageSwitch from "./LanguageSwitch.vue";

const { t } = useI18n();

const updateAvailable = computed(() => state.updates.status?.updateAvailable === true);
const updateVersion = computed(() => state.updates.status?.latest?.version || "");

function openUpdates() {
  state.modal = { type: "updates" };
}

const online = computed(() => state.processes.filter((p) => p.status === "online").length);
const down = computed(() => state.processes.filter((p) => p.status !== "online").length);

function setView(v) {
  state.view = v;
}

function goLogExplorer() {
  if (state.view === "logExplorer") return;
  openLogExplorer();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("pm2-monitor-theme", next);
  } catch (e) {
    /* stockage indisponible : le thème reste appliqué pour la session en cours */
  }
}

function togglePm2Menu(e) {
  e.stopPropagation();
  // Le menu est en position: fixed : on l'ancre sous le bouton, où qu'il soit (la barre
  // peut passer sur plusieurs lignes ou défiler horizontalement), au lieu d'un `top`
  // codé en dur qui ne tombait juste que sur un seul affichage.
  const rect = e.currentTarget.getBoundingClientRect();
  const menuWidth = 240;
  const right = Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - menuWidth - 8));
  state.pm2MenuPos = { top: Math.round(rect.bottom + 6), right: Math.round(right) };
  state.pm2MenuOpen = !state.pm2MenuOpen;
}

function openUsers() {
  state.modal = { type: "users" };
}

function openApiKeys() {
  state.modal = { type: "apiKeys" };
}

function openNotifications() {
  state.modal = { type: "notifications" };
}

function openHealthChecks() {
  state.modal = { type: "healthChecks" };
}

function openAuditLog() {
  state.modal = { type: "auditLog" };
}

function openOrganization() {
  state.modal = { type: "organization" };
}

function openAnomalyDetection() {
  state.modal = { type: "anomalyDetection" };
}

function openBackup() {
  state.modal = { type: "backup" };
}

function openPlugins() {
  state.modal = { type: "plugins" };
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <div>
        <h1>PM2 Monitor</h1>
        <p class="brand-sub">{{ t("topbar.tagline") }}</p>
      </div>
    </div>

    <nav class="view-tabs" role="tablist" :aria-label="t('topbar.viewLabel')">
      <button
        v-if="can('system')"
        class="view-tab"
        :class="{ active: state.view === 'dashboard' }"
        @click="setView('dashboard')"
      >
        {{ t("topbar.tabDashboard") }}
      </button>
      <button class="view-tab" :class="{ active: state.view === 'process' }" @click="setView('process')">
        {{ t("topbar.tabProcess") }}
      </button>
      <button
        v-if="can('system')"
        class="view-tab"
        :class="{ active: state.view === 'system' }"
        @click="setView('system')"
      >
        {{ t("topbar.tabSystem") }}
      </button>
      <button
        v-if="can('events_read')"
        class="view-tab"
        :class="{ active: state.view === 'events' }"
        @click="setView('events')"
      >
        {{ t("topbar.tabTimeline") }}
      </button>
      <button
        v-if="can('servers_read')"
        class="view-tab"
        :class="{ active: state.view === 'servers' }"
        @click="setView('servers')"
      >
        {{ t("topbar.tabServers") }}
      </button>
      <button
        v-if="can('incidents_read')"
        class="view-tab"
        :class="{ active: state.view === 'incidents' }"
        @click="setView('incidents')"
      >
        {{ t("topbar.tabIncidents") }}
      </button>
      <button
        v-if="can('dependencies_read')"
        class="view-tab"
        :class="{ active: state.view === 'serviceDependencies' }"
        @click="setView('serviceDependencies')"
      >
        {{ t("topbar.tabServiceDependencies") }}
      </button>
      <button
        v-if="can('reports_read')"
        class="view-tab"
        :class="{ active: state.view === 'reports' }"
        @click="setView('reports')"
      >
        {{ t("topbar.tabReports") }}
      </button>
      <button
        v-if="can('docker_read')"
        class="view-tab"
        :class="{ active: state.view === 'docker' }"
        @click="setView('docker')"
      >
        {{ t("topbar.tabDocker") }}
      </button>
      <button
        v-if="canAny('logs')"
        class="view-tab"
        :class="{ active: state.view === 'logExplorer' }"
        @click="goLogExplorer"
      >
        {{ t("topbar.tabLogExplorer") }}
      </button>
    </nav>

    <div class="topbar-stats">
      <div class="stat">
        <span class="stat-value">{{ state.processes.length || "–" }}</span>
        <span class="stat-label">{{ t("topbar.apps") }}</span>
      </div>
      <div class="stat">
        <span class="stat-value stat-online">{{ state.processes.length ? online : "–" }}</span>
        <span class="stat-label">{{ t("topbar.online") }}</span>
      </div>
      <div class="stat">
        <span class="stat-value stat-down">{{ state.processes.length ? down : "–" }}</span>
        <span class="stat-label">{{ t("topbar.down") }}</span>
      </div>
      <div class="conn" :class="state.connected ? 'is-connected' : 'is-disconnected'">
        <span class="conn-dot"></span>
        <span class="conn-label">{{
          state.connected ? t("topbar.connected") : t("topbar.disconnected")
        }}</span>
      </div>
      <button class="icon-btn" :title="t('topbar.pm2Actions')" @click="togglePm2Menu">PM2 ⋯</button>
      <button
        v-if="can('notifications_read')"
        class="icon-btn"
        :title="t('topbar.notificationsTitle')"
        @click="openNotifications"
      >
        <span class="btn-ico" aria-hidden="true">🔔</span>
        <span class="btn-label">{{ t("topbar.notifications") }}</span>
      </button>
      <button
        v-if="can('health_checks_read')"
        class="icon-btn"
        :title="t('topbar.healthChecksTitle')"
        @click="openHealthChecks"
      >
        <span class="btn-ico" aria-hidden="true">❤</span>
        <span class="btn-label">{{ t("topbar.healthChecks") }}</span>
      </button>
      <button
        v-if="can('anomaly_read')"
        class="icon-btn"
        :title="t('topbar.anomalyDetectionTitle')"
        @click="openAnomalyDetection"
      >
        <span class="btn-ico" aria-hidden="true">📊</span>
        <span class="btn-label">{{ t("topbar.anomalyDetection") }}</span>
      </button>
      <button
        v-if="can('audit_read')"
        class="icon-btn"
        :title="t('topbar.auditLogTitle')"
        @click="openAuditLog"
      >
        <span class="btn-ico" aria-hidden="true">🧾</span>
        <span class="btn-label">{{ t("topbar.auditLog") }}</span>
      </button>
      <button
        v-if="can('process_org_read')"
        class="icon-btn"
        :title="t('topbar.organizationTitle')"
        @click="openOrganization"
      >
        <span class="btn-ico" aria-hidden="true">🏷</span>
        <span class="btn-label">{{ t("topbar.organization") }}</span>
      </button>
      <button
        v-if="state.auth.user && state.auth.user.isAdmin"
        class="icon-btn"
        :title="t('topbar.usersTitle')"
        @click="openUsers"
      >
        <span class="btn-ico" aria-hidden="true">👤</span>
        <span class="btn-label">{{ t("topbar.users") }}</span>
      </button>
      <button
        v-if="can('api_keys_read')"
        class="icon-btn"
        :title="t('topbar.apiKeysTitle')"
        @click="openApiKeys"
      >
        <span class="btn-ico" aria-hidden="true">🔑</span>
        <span class="btn-label">{{ t("topbar.apiKeys") }}</span>
      </button>
      <button
        v-if="can('backup_export') || can('backup_restore')"
        class="icon-btn"
        :title="t('topbar.backupTitle')"
        @click="openBackup"
      >
        <span class="btn-ico" aria-hidden="true">💾</span>
        <span class="btn-label">{{ t("topbar.backup") }}</span>
      </button>
      <button
        v-if="can('plugins_read')"
        class="icon-btn"
        :title="t('topbar.pluginsTitle')"
        @click="openPlugins"
      >
        <span class="btn-ico" aria-hidden="true">🧩</span>
        <span class="btn-label">{{ t("topbar.plugins") }}</span>
      </button>
      <button
        v-if="can('updates_read')"
        class="icon-btn update-btn"
        :class="{ 'has-update': updateAvailable }"
        :title="
          updateAvailable
            ? t('topbar.updatesAvailableTitle', { version: updateVersion })
            : t('topbar.updatesTitle')
        "
        @click="openUpdates"
      >
        <span class="btn-ico" aria-hidden="true">⬆</span>
        <span class="btn-label">{{ updateAvailable ? `v${updateVersion}` : t("topbar.updates") }}</span>
      </button>
    </div>

    <div class="topbar-controls">
      <LanguageSwitch />
      <button
        class="theme-toggle"
        :title="t('topbar.themeToggle')"
        :aria-label="t('topbar.themeToggle')"
        @click="toggleTheme"
      >
        <span class="theme-icon">◐</span>
      </button>
      <div
        v-if="state.auth.authEnabled && state.auth.user"
        class="user-chip"
        :title="state.auth.user.username"
      >
        <span>{{ state.auth.user.username }}</span>
        <button class="icon-btn" :title="t('topbar.logout')" @click="logout">⏻</button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.user-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  padding-left: 8px;
  border-left: 1px solid var(--border);
}
</style>
