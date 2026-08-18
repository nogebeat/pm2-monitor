<script setup>
import { onMounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { state, bootstrap, fetchMe } from "./store";
import TopBar from "./components/TopBar.vue";
import Pm2Menu from "./components/Pm2Menu.vue";
import ProcessSidebar from "./components/ProcessSidebar.vue";
import LogsPanel from "./components/LogsPanel.vue";
import SystemView from "./components/SystemView.vue";
import EventsView from "./components/EventsView.vue";
import DashboardView from "./components/DashboardView.vue";
import ModalHost from "./components/ModalHost.vue";
import LoginScreen from "./components/LoginScreen.vue";

const { t } = useI18n();

const authed = computed(() => !state.auth.authEnabled || !!state.auth.user);

onMounted(() => {
  fetchMe().then(bootstrap);
});
</script>

<template>
  <div class="app">
    <div v-if="!state.auth.ready" class="auth-loading">{{ t("app.loading") }}</div>

    <LoginScreen v-else-if="!authed" />

    <template v-else>
      <TopBar />
      <Pm2Menu v-if="state.pm2MenuOpen" />

      <main v-show="state.view === 'process'" class="layout">
        <ProcessSidebar />
        <LogsPanel />
      </main>

      <DashboardView v-if="state.view === 'dashboard'" />
      <SystemView v-if="state.view === 'system'" />
      <EventsView v-if="state.view === 'events'" />

      <ModalHost v-if="state.modal" />

      <Transition name="fade">
        <div v-if="state.toast" class="toast">{{ state.toast.message }}</div>
      </Transition>
    </template>
  </div>
</template>

<style>
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
