<script setup>
import { onMounted } from "vue";
import { state, bootstrap } from "./store";
import TopBar from "./components/TopBar.vue";
import Pm2Menu from "./components/Pm2Menu.vue";
import ProcessSidebar from "./components/ProcessSidebar.vue";
import LogsPanel from "./components/LogsPanel.vue";
import SystemView from "./components/SystemView.vue";
import ModalHost from "./components/ModalHost.vue";

onMounted(bootstrap);
</script>

<template>
  <div class="app">
    <TopBar />
    <Pm2Menu v-if="state.pm2MenuOpen" />

    <main v-show="state.view === 'process'" class="layout">
      <ProcessSidebar />
      <LogsPanel />
    </main>

    <SystemView v-if="state.view === 'system'" />

    <ModalHost v-if="state.modal" />

    <Transition name="fade">
      <div v-if="state.toast" class="toast">{{ state.toast.message }}</div>
    </Transition>
  </div>
</template>

<style>
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
