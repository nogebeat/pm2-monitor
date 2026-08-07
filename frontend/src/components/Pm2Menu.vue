<script setup>
import { onMounted, onUnmounted } from "vue";
import { state, runGlobalAction, can } from "../store";

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
    <button v-if="can('pm2_save')" @click="run('save')">💾 Sauvegarder (pm2 save)</button>
    <button v-if="can('pm2_resurrect')" @click="run('resurrect')">♻️ Resurrect</button>
    <button v-if="can('pm2_flush_all')" @click="run('flush-all')">🧹 Flush tous les logs</button>
    <button v-if="can('pm2_update')" @click="run('update')">⬆️ Update PM2</button>
    <button v-if="can('pm2_kill')" class="danger" @click="run('kill')">☠️ Kill daemon PM2</button>
    <div v-if="!can('pm2_save') && !can('pm2_resurrect') && !can('pm2_flush_all') && !can('pm2_update') && !can('pm2_kill')" class="hint-text" style="padding:8px;">
      Aucune action globale autorisée pour ton compte.
    </div>
  </div>
</template>
