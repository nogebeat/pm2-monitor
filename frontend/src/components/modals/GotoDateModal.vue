<script setup>
import { ref, watch } from "vue";
import { state } from "../../store";
import { apiGet } from "../../api";
import ModalBase from "../ModalBase.vue";

const props = defineProps({
  process: { type: Object, required: true },
});

const dateValue = ref("");
const results = ref([]);
const status = ref("");

function close() {
  state.modal = null;
}

watch(dateValue, (v) => {
  const ts = new Date(v).getTime();
  if (Number.isNaN(ts)) return;
  status.value = "Recherche…";
  apiGet(`/api/processes/${props.process.id}/logs/search?from=${ts}&limit=50`)
    .then((r) => {
      results.value = r.results;
      status.value = r.results.length ? "" : "Rien trouvé après cette date.";
    })
    .catch((err) => {
      results.value = [];
      status.value = "Erreur : " + err.message;
    });
});
</script>

<template>
  <ModalBase title="Aller à une date" hide-confirm @close="close">
    <label>Date et heure</label>
    <input v-model="dateValue" type="datetime-local" />
    <div class="search-results">
      <div v-if="status && !results.length" class="hint-text">{{ status }}</div>
      <div v-for="(row, i) in results" :key="i" class="search-result-line">
        {{ new Date(row.t).toLocaleString("fr-FR") }} [{{ row.type }}]<br />{{ row.text }}
      </div>
    </div>
  </ModalBase>
</template>
