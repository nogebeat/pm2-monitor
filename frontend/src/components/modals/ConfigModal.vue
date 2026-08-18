<script setup>
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { state, notifyError } from "../../store";
import { apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

const { t } = useI18n();

const props = defineProps({
  process: { type: Object, required: true },
});

const script = ref(props.process.script || "");
const argsStr = ref((props.process.args || []).join(" "));
const execMode = ref(
  props.process.execMode === "cluster_mode" || props.process.execMode === "cluster" ? "cluster" : "fork",
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
  <ModalBase :title="t('configModal.title', { name: process.name })" @close="close" @confirm="confirm">
    <p class="hint-text">{{ t("configModal.warning") }}</p>
    <label>{{ t("configModal.script") }}</label>
    <input v-model="script" type="text" />
    <label>{{ t("configModal.args") }}</label>
    <input v-model="argsStr" type="text" />
    <label>{{ t("configModal.execMode") }}</label>
    <select v-model="execMode">
      <option value="fork">fork</option>
      <option value="cluster">cluster</option>
    </select>
    <label>{{ t("configModal.instances") }}</label>
    <input v-model.number="instances" type="number" min="1" max="64" />
  </ModalBase>
</template>
