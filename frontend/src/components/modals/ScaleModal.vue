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

const instances = ref(props.process.instances || 1);

function close() {
  state.modal = null;
}

function confirm() {
  apiPost(`/api/processes/${props.process.id}/scale`, { instances: instances.value })
    .then(close)
    .catch(notifyError);
}
</script>

<template>
  <ModalBase :title="t('scaleModal.title', { name: process.name })" @close="close" @confirm="confirm">
    <label>{{ t("scaleModal.instances") }}</label>
    <input v-model.number="instances" type="number" min="1" max="64" />
    <p class="hint-text">{{ t("scaleModal.hint") }}</p>
  </ModalBase>
</template>
