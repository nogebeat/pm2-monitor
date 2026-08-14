<script setup>
import { computed } from "vue";
import { state, logout, can } from "../store";

const online = computed(() => state.processes.filter((p) => p.status === "online").length);
const down = computed(() => state.processes.filter((p) => p.status !== "online").length);

function setView(v) {
  state.view = v;
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

function openNotifications() {
  state.modal = { type: "notifications" };
}

function openHealthChecks() {
  state.modal = { type: "healthChecks" };
}

function openAuditLog() {
  state.modal = { type: "auditLog" };
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <div>
        <h1>PM2 Monitor</h1>
        <p class="brand-sub">Vitaux des process, en direct</p>
      </div>
    </div>

    <nav class="view-tabs" role="tablist" aria-label="Vue">
      <button
        v-if="can('system')"
        class="view-tab"
        :class="{ active: state.view === 'dashboard' }"
        @click="setView('dashboard')"
      >
        Dashboard
      </button>
      <button class="view-tab" :class="{ active: state.view === 'process' }" @click="setView('process')">
        Process
      </button>
      <button
        v-if="can('system')"
        class="view-tab"
        :class="{ active: state.view === 'system' }"
        @click="setView('system')"
      >
        Système
      </button>
      <button
        v-if="can('events_read')"
        class="view-tab"
        :class="{ active: state.view === 'events' }"
        @click="setView('events')"
      >
        Timeline
      </button>
    </nav>

    <div class="topbar-stats">
      <div class="stat">
        <span class="stat-value">{{ state.processes.length || "–" }}</span>
        <span class="stat-label">apps</span>
      </div>
      <div class="stat">
        <span class="stat-value stat-online">{{ state.processes.length ? online : "–" }}</span>
        <span class="stat-label">en ligne</span>
      </div>
      <div class="stat">
        <span class="stat-value stat-down">{{ state.processes.length ? down : "–" }}</span>
        <span class="stat-label">arrêtées</span>
      </div>
      <div class="conn" :class="state.connected ? 'is-connected' : 'is-disconnected'">
        <span class="conn-dot"></span>
        <span class="conn-label">{{ state.connected ? "connecté" : "déconnecté" }}</span>
      </div>
      <button class="icon-btn" title="Actions globales PM2" @click="togglePm2Menu">PM2 ⋯</button>
      <button
        v-if="can('notifications_read')"
        class="icon-btn"
        title="Settings → Notifications (Providers / Routing)"
        @click="openNotifications"
      >
        🔔 Notifications
      </button>
      <button
        v-if="can('health_checks_read')"
        class="icon-btn"
        title="Settings → Health Checks (HTTP / TCP / Command)"
        @click="openHealthChecks"
      >
        ❤ Health Checks
      </button>
      <button
        v-if="can('audit_read')"
        class="icon-btn"
        title="Settings → Audit Log (actions sensibles)"
        @click="openAuditLog"
      >
        🧾 Audit Log
      </button>
      <button
        v-if="state.auth.user && state.auth.user.isAdmin"
        class="icon-btn"
        title="Gérer les utilisateurs et permissions"
        @click="openUsers"
      >
        👤 Utilisateurs
      </button>
      <button class="theme-toggle" title="Changer de thème" aria-label="Changer de thème" @click="toggleTheme">
        <span class="theme-icon">◐</span>
      </button>
      <div v-if="state.auth.authEnabled && state.auth.user" class="user-chip" :title="state.auth.user.username">
        <span>{{ state.auth.user.username }}</span>
        <button class="icon-btn" title="Se déconnecter" @click="logout">⏻</button>
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
