<script setup>
import { state, notifyError, loadLogsStats } from "../../store";
import { apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

const props = defineProps({
  process: { type: Object, required: true },
});

function close() {
  state.modal = null;
}

function scale() {
  state.modal = { type: "scale", process: props.process };
}

function toggleWatch() {
  close();
  apiPost(`/api/processes/${props.process.id}/watch`, { enable: !props.process.watching }).catch(notifyError);
}

function editEnv() {
  state.modal = { type: "env", process: props.process };
}

function editConfig() {
  state.modal = { type: "config", process: props.process };
}

function flush() {
  if (!confirm(`Vider les logs de "${props.process.name}" ?`)) return;
  close();
  apiPost(`/api/processes/${props.process.id}/flush`).then(loadLogsStats).catch(notifyError);
}

function reset() {
  close();
  apiPost(`/api/processes/${props.process.id}/reset`).catch(notifyError);
}

function del() {
  if (!confirm(`Supprimer définitivement "${props.process.name}" de PM2 ?`)) return;
  close();
  apiPost(`/api/processes/${props.process.id}/delete`).catch(notifyError);
}
</script>

<template>
  <ModalBase :title="`Actions — ${process.name}`" hide-confirm @close="close">
    <div class="hint-text">Actions rapides pour <b>{{ process.name }}</b> (#{{ process.id }})</div>
    <div class="more-actions">
      <button class="icon-btn" @click="scale">📈 Scale (instances actuelles : {{ process.instances }})</button>
      <button class="icon-btn" @click="toggleWatch">👁 Watch {{ process.watching ? "OFF" : "ON" }}</button>
      <button class="icon-btn" @click="editEnv">🔧 Modifier les variables d'environnement</button>
      <button class="icon-btn" @click="editConfig">⚙️ Modifier script / arguments / mode</button>
      <button class="icon-btn" @click="flush">🧹 Flush les logs de cette app</button>
      <button class="icon-btn" @click="reset">↺ Réinitialiser le compteur de restarts</button>
      <button class="icon-btn danger-text" @click="del">🗑 Supprimer le process</button>
    </div>
  </ModalBase>
</template>
