<script setup>
import { useI18n } from "vue-i18n";
import { state, notifyError, loadLogsStats, can } from "../../store";
import { apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

const { t } = useI18n();

const props = defineProps({
  process: { type: Object, required: true },
});

function close() {
  state.modal = null;
}

function scale() {
  state.modal = { type: "scale", process: props.process };
}

function toggleWatch() {
  close();
  apiPost(`/api/processes/${props.process.id}/watch`, { enable: !props.process.watching }).catch(notifyError);
}

function editEnv() {
  state.modal = { type: "env", process: props.process };
}

function editConfig() {
  state.modal = { type: "config", process: props.process };
}

function flush() {
  if (!confirm(t("moreMenu.confirmFlush", { name: props.process.name }))) return;
  close();
  apiPost(`/api/processes/${props.process.id}/flush`).then(loadLogsStats).catch(notifyError);
}

function reset() {
  close();
  apiPost(`/api/processes/${props.process.id}/reset`).catch(notifyError);
}

function del() {
  if (!confirm(t("moreMenu.confirmDelete", { name: props.process.name }))) return;
  close();
  apiPost(`/api/processes/${props.process.id}/delete`).catch(notifyError);
}
</script>

<template>
  <ModalBase :title="t('moreMenu.title', { name: process.name })" hide-confirm @close="close">
    <div class="hint-text">
      {{ t("moreMenu.quickActionsFor") }} <b>{{ process.name }}</b> (#{{ process.id }})
    </div>
    <div class="more-actions">
      <button v-if="can('scale', process.name)" class="icon-btn" @click="scale">
        📈 {{ t("moreMenu.scale", { n: process.instances }) }}
      </button>
      <button v-if="can('watch', process.name)" class="icon-btn" @click="toggleWatch">
        👁 {{ process.watching ? t("moreMenu.watchOff") : t("moreMenu.watchOn") }}
      </button>
      <button v-if="can('env', process.name)" class="icon-btn" @click="editEnv">
        🔧 {{ t("moreMenu.editEnv") }}
      </button>
      <button v-if="can('config', process.name)" class="icon-btn" @click="editConfig">
        ⚙️ {{ t("moreMenu.editConfig") }}
      </button>
      <button v-if="can('flush', process.name)" class="icon-btn" @click="flush">
        🧹 {{ t("moreMenu.flush") }}
      </button>
      <button v-if="can('reset', process.name)" class="icon-btn" @click="reset">
        ↺ {{ t("moreMenu.reset") }}
      </button>
      <button v-if="can('delete', process.name)" class="icon-btn danger-text" @click="del">
        🗑 {{ t("moreMenu.delete") }}
      </button>
    </div>
  </ModalBase>
</template>
