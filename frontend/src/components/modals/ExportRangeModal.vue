<script setup>
import { ref } from "vue";
import { state } from "../../store";
import ModalBase from "../ModalBase.vue";

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
  <ModalBase title="Exporter une période précise" confirm-label="Exporter" @close="close" @confirm="confirm">
    <label>Depuis</label>
    <input v-model="from" type="datetime-local" />
    <label>Jusqu'à</label>
    <input v-model="to" type="datetime-local" />
    <label>Flux</label>
    <select v-model="type">
      <option value="all">tout</option>
      <option value="out">stdout</option>
      <option value="err">stderr</option>
    </select>
  </ModalBase>
</template>
