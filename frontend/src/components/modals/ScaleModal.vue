<script setup>
import { ref } from "vue";
import { state, notifyError } from "../../store";
import { apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

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
  <ModalBase :title="`Scale — ${process.name}`" @close="close" @confirm="confirm">
    <label>Nombre d'instances</label>
    <input v-model.number="instances" type="number" min="1" max="64" />
    <p class="hint-text">Uniquement pertinent en mode cluster.</p>
  </ModalBase>
</template>
