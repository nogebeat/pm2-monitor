<script setup>
import { reactive } from "vue";
import { state, notifyError } from "../../store";
import { apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

const props = defineProps({
  process: { type: Object, required: true },
});

const entries = Object.entries(props.process.env || {}).filter(([k]) => !/^(npm_|PATH$|PM2_)/.test(k));
const rows = reactive((entries.length ? entries : [["", ""]]).map(([k, v]) => ({ k, v })));

function addRow() {
  rows.push({ k: "", v: "" });
}

function removeRow(i) {
  rows.splice(i, 1);
}

function close() {
  state.modal = null;
}

function confirm() {
  const env = {};
  rows.forEach((row) => {
    const k = row.k.trim();
    if (k) env[k] = row.v;
  });
  apiPost(`/api/processes/${props.process.id}/env`, { env }).then(close).catch(notifyError);
}
</script>

<template>
  <ModalBase :title="`Variables d'environnement — ${process.name}`" @close="close" @confirm="confirm">
    <p class="hint-text">Ces variables seront appliquées au redémarrage du process (pm2 restart --update-env).</p>
    <div>
      <div v-for="(row, i) in rows" :key="i" class="env-row">
        <input v-model="row.k" type="text" placeholder="CLÉ" />
        <input v-model="row.v" type="text" placeholder="valeur" />
        <button type="button" @click="removeRow(i)">✕</button>
      </div>
    </div>
    <button type="button" class="icon-btn" style="margin-top:6px;" @click="addRow">+ Ajouter une variable</button>
  </ModalBase>
</template>
