<script setup>
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { state } from "../../store";
import { apiGet } from "../../api";
import ModalBase from "../ModalBase.vue";

const { t, locale } = useI18n();

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
  status.value = t("gotoDateModal.searching");
  apiGet(`/api/processes/${props.process.id}/logs/search?from=${ts}&limit=50`)
    .then((r) => {
      results.value = r.results;
      status.value = r.results.length ? "" : t("gotoDateModal.notFound");
    })
    .catch((err) => {
      results.value = [];
      status.value = t("gotoDateModal.errorPrefix") + err.message;
    });
});
</script>

<template>
  <ModalBase :title="t('gotoDateModal.title')" hide-confirm @close="close">
    <label>{{ t("gotoDateModal.dateTime") }}</label>
    <input v-model="dateValue" type="datetime-local" />
    <div class="search-results">
      <div v-if="status && !results.length" class="hint-text">{{ status }}</div>
      <div v-for="(row, i) in results" :key="i" class="search-result-line">
        {{ new Date(row.t).toLocaleString(locale === "fr" ? "fr-FR" : "en-US") }} [{{ row.type }}]<br />{{
          row.text
        }}
      </div>
    </div>
  </ModalBase>
</template>
