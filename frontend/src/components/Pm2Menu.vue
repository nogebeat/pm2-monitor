<script setup>
import { onMounted, onUnmounted } from "vue";
import { state, runGlobalAction } from "../store";

function run(action) {
  state.pm2MenuOpen = false;
  runGlobalAction(action);
}

function closeOnOutsideClick() {
  state.pm2MenuOpen = false;
}

onMounted(() => document.addEventListener("click", closeOnOutsideClick));
onUnmounted(() => document.removeEventListener("click", closeOnOutsideClick));
</script>

<template>
  <div class="pm2-menu" @click.stop>
    <button @click="run('save')">💾 Sauvegarder (pm2 save)</button>
    <button @click="run('resurrect')">♻️ Resurrect</button>
    <button @click="run('flush-all')">🧹 Flush tous les logs</button>
    <button @click="run('update')">⬆️ Update PM2</button>
    <button class="danger" @click="run('kill')">☠️ Kill daemon PM2</button>
  </div>
</template>
