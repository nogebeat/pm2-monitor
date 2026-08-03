<script setup>
import { ref, watch } from "vue";
import { state } from "../../store";
import { apiGet } from "../../api";
import ModalBase from "../ModalBase.vue";

const props = defineProps({
  process: { type: Object, required: true },
});

const query = ref("");
const regex = ref(false);
const level = ref("all");
const results = ref([]);
const status = ref("");
let debounceTimer = null;

function close() {
  state.modal = null;
}

function run() {
  const q = query.value.trim();
  if (!q) {
    results.value = [];
    status.value = "";
    return;
  }
  status.value = "Recherche…";
  apiGet(
    `/api/processes/${props.process.id}/logs/search?q=${encodeURIComponent(q)}&regex=${regex.value ? "1" : "0"}&level=${level.value}&limit=200`
  )
    .then((r) => {
      results.value = r.results;
      status.value = r.results.length ? (r.truncated ? `… ${r.total} résultats au total, affichage limité.` : "") : "Aucun résultat.";
    })
    .catch((err) => {
      results.value = [];
      status.value = "Erreur : " + err.message;
    });
}

watch(query, () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(run, 200);
});
watch([regex, level], run);
</script>

<template>
  <ModalBase title="Recherche complète dans les logs" hide-confirm @close="close">
    <label>Recherche</label>
    <input v-model="query" type="text" placeholder="texte ou regex…" />
    <label class="chk-inline" style="margin-top:8px;"><input v-model="regex" type="checkbox" /> Regex</label>
    <label>Niveau</label>
    <select v-model="level">
      <option value="all">tous</option>
      <option value="info">info</option>
      <option value="warn">warn</option>
      <option value="error">error</option>
      <option value="debug">debug</option>
    </select>
    <div class="search-results">
      <div v-if="status && !results.length" class="hint-text">{{ status }}</div>
      <div v-for="row in results" :key="row.line" class="search-result-line">
        #{{ row.line }} · {{ new Date(row.t).toLocaleString("fr-FR") }} [{{ row.type }}/{{ row.level }}]<br />{{ row.text }}
      </div>
      <div v-if="status && results.length" class="hint-text">{{ status }}</div>
    </div>
  </ModalBase>
</template>
