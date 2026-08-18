<script setup>
import { useI18n } from "vue-i18n";
import { state } from "../store";
import ProcessCard from "./ProcessCard.vue";

const { t } = useI18n();
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-head">
      <h2>{{ t("sidebar.title") }}</h2>
      <span class="hint">{{ t("sidebar.hint") }}</span>
    </div>
    <div class="process-list">
      <div v-if="!state.processes.length" class="empty-state">{{ t("sidebar.connecting") }}</div>
      <ProcessCard v-for="p in state.processes" :key="p.id" :process="p" />
    </div>
  </aside>
</template>
