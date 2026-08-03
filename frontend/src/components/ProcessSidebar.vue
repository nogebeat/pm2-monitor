<script setup>
import { state } from "../store";
import ProcessCard from "./ProcessCard.vue";
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-head">
      <h2>Process</h2>
      <span class="hint">clique pour voir les logs</span>
    </div>
    <div class="process-list">
      <div v-if="!state.processes.length" class="empty-state">Connexion à PM2…</div>
      <ProcessCard v-for="p in state.processes" :key="p.id" :process="p" />
    </div>
  </aside>
</template>
