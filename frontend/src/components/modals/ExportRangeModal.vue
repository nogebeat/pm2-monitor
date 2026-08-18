<script setup>
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { state } from "../../store";
import ModalBase from "../ModalBase.vue";

const { t } = useI18n();

const props = defineProps({
  process: { type: Object, required: true },
});

const from = ref("");
const to = ref("");
const type = ref("all");

function close() {
  state.modal = null;
}

function confirm() {
  const fromTs = from.value ? new Date(from.value).getTime() : 0;
  const toTs = to.value ? new Date(to.value).getTime() : Date.now();
  window.open(`/api/processes/${props.process.id}/logs/export-range?from=${fromTs}&to=${toTs}&type=${type.value}`, "_blank");
  close();
}
</script>

<template>
  <ModalBase :title="t('exportRangeModal.title')" :confirm-label="t('exportRangeModal.confirmLabel')" @close="close" @confirm="confirm">
    <label>{{ t("exportRangeModal.from") }}</label>
    <input v-model="from" type="datetime-local" />
    <label>{{ t("exportRangeModal.to") }}</label>
    <input v-model="to" type="datetime-local" />
    <label>{{ t("exportRangeModal.stream") }}</label>
    <select v-model="type">
      <option value="all">{{ t("exportRangeModal.all") }}</option>
      <option value="out">stdout</option>
      <option value="err">stderr</option>
    </select>
  </ModalBase>
</template>
