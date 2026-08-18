<script setup>
import { onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { state, runGlobalAction, can } from "../store";

const { t } = useI18n();

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
    <button v-if="can('pm2_save')" @click="run('save')">💾 {{ t("pm2Menu.save") }}</button>
    <button v-if="can('pm2_resurrect')" @click="run('resurrect')">♻️ {{ t("pm2Menu.resurrect") }}</button>
    <button v-if="can('pm2_flush_all')" @click="run('flush-all')">🧹 {{ t("pm2Menu.flushAll") }}</button>
    <button v-if="can('pm2_update')" @click="run('update')">⬆️ {{ t("pm2Menu.update") }}</button>
    <button v-if="can('pm2_kill')" class="danger" @click="run('kill')">☠️ {{ t("pm2Menu.kill") }}</button>
    <div v-if="!can('pm2_save') && !can('pm2_resurrect') && !can('pm2_flush_all') && !can('pm2_update') && !can('pm2_kill')" class="hint-text" style="padding:8px;">
      {{ t("pm2Menu.noAction") }}
    </div>
  </div>
</template>
