<script setup>
import { useI18n } from "vue-i18n";
import { setLocale } from "../i18n";

const { locale, t } = useI18n();

function toggle() {
  setLocale(locale.value === "fr" ? "en" : "fr");
}
</script>

<template>
  <button
    class="icon-btn lang-toggle"
    type="button"
    :title="t('topbar.language')"
    :aria-label="t('topbar.language')"
    @click="toggle"
  >
    {{ locale === "fr" ? "🇫🇷 FR" : "🇬🇧 EN" }}
  </button>
</template>

<style scoped>
.lang-toggle {
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  white-space: nowrap;
}
</style>
