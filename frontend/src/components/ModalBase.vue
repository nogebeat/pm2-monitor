<script setup>
const props = defineProps({
  title: { type: String, required: true },
  hideConfirm: { type: Boolean, default: false },
  confirmLabel: { type: String, default: "Confirmer" },
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
        <button class="icon-btn" @click="emit('close')">Annuler</button>
        <button v-if="!hideConfirm" class="icon-btn go" @click="emit('confirm')">{{ confirmLabel }}</button>
      </div>
    </div>
  </div>
</template>
