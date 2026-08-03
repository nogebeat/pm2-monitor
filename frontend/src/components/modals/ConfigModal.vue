<script setup>
import { ref } from "vue";
import { state, notifyError } from "../../store";
import { apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

const props = defineProps({
  process: { type: Object, required: true },
});

const script = ref(props.process.script || "");
const argsStr = ref((props.process.args || []).join(" "));
const execMode = ref(
  props.process.execMode === "cluster_mode" || props.process.execMode === "cluster" ? "cluster" : "fork"
);
const instances = ref(props.process.instances || 1);

function close() {
  state.modal = null;
}

function confirm() {
  const args = argsStr.value.trim().split(/\s+/).filter(Boolean);
  apiPost(`/api/processes/${props.process.id}/config`, {
    script: script.value.trim(),
    args,
    execMode: execMode.value,
    instances: instances.value,
  })
    .then(close)
    .catch(notifyError);
}
</script>

<template>
  <ModalBase :title="`Configuration — ${process.name}`" @close="close" @confirm="confirm">
    <p class="hint-text">⚠️ Ceci supprime puis relance le process avec la nouvelle configuration (équivalent à pm2 delete + pm2 start).</p>
    <label>Script</label>
    <input v-model="script" type="text" />
    <label>Arguments (séparés par des espaces)</label>
    <input v-model="argsStr" type="text" />
    <label>Mode d'exécution</label>
    <select v-model="execMode">
      <option value="fork">fork</option>
      <option value="cluster">cluster</option>
    </select>
    <label>Instances</label>
    <input v-model.number="instances" type="number" min="1" max="64" />
  </ModalBase>
</template>
