<script setup>
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const props = defineProps({
  title: { type: String, required: true },
  hideConfirm: { type: Boolean, default: false },
  confirmLabel: { type: String, default: "" },
});
const emit = defineEmits(["close", "confirm"]);

function onOverlayClick(e) {
  if (e.target === e.currentTarget) emit("close");
}
</script>

<template>
  <div class="modal-overlay" @click="onOverlayClick">
    <div class="modal">
      <div class="modal-head">
        <h3>{{ title }}</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <slot />
      </div>
      <div class="modal-foot">
        <button class="icon-btn" @click="emit('close')">{{ t("modalBase.cancel") }}</button>
        <button v-if="!hideConfirm" class="icon-btn go" @click="emit('confirm')">{{ confirmLabel || t("modalBase.confirm") }}</button>
      </div>
    </div>
  </div>
</template>
