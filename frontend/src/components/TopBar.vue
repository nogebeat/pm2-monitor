<script setup>
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { state, logout, can, canAny, openLogExplorer } from "../store";
import LanguageSwitch from "./LanguageSwitch.vue";

const { t } = useI18n();

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
        🔔 {{ t("topbar.notifications") }}
      </button>
      <button
        v-if="can('health_checks_read')"
        class="icon-btn"
        :title="t('topbar.healthChecksTitle')"
        @click="openHealthChecks"
      >
        ❤ {{ t("topbar.healthChecks") }}
      </button>
      <button
        v-if="can('anomaly_read')"
        class="icon-btn"
        :title="t('topbar.anomalyDetectionTitle')"
        @click="openAnomalyDetection"
      >
        📊 {{ t("topbar.anomalyDetection") }}
      </button>
      <button
        v-if="can('audit_read')"
        class="icon-btn"
        :title="t('topbar.auditLogTitle')"
        @click="openAuditLog"
      >
        🧾 {{ t("topbar.auditLog") }}
      </button>
      <button
        v-if="can('process_org_read')"
        class="icon-btn"
        :title="t('topbar.organizationTitle')"
        @click="openOrganization"
      >
        🏷 {{ t("topbar.organization") }}
      </button>
      <button
        v-if="state.auth.user && state.auth.user.isAdmin"
        class="icon-btn"
        :title="t('topbar.usersTitle')"
        @click="openUsers"
      >
        👤 {{ t("topbar.users") }}
      </button>
      <button
        v-if="can('api_keys_read')"
        class="icon-btn"
        :title="t('topbar.apiKeysTitle')"
        @click="openApiKeys"
      >
        🔑 {{ t("topbar.apiKeys") }}
      </button>
      <button
        v-if="can('backup_export') || can('backup_restore')"
        class="icon-btn"
        :title="t('topbar.backupTitle')"
        @click="openBackup"
      >
        💾 {{ t("topbar.backup") }}
      </button>
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
