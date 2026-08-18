<script setup>
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { state, login } from "../store";

const { t } = useI18n();
const username = ref("");
const password = ref("");

function submit() {
  if (!username.value || !password.value) return;
  login(username.value, password.value);
}
</script>

<template>
  <div class="login-screen">
    <form class="login-card" @submit.prevent="submit">
      <div class="brand" style="justify-content: center; margin-bottom: 8px;">
        <span class="brand-mark" aria-hidden="true"></span>
        <div>
          <h1>PM2 Monitor</h1>
          <p class="brand-sub">{{ t("login.subtitle") }}</p>
        </div>
      </div>

      <label class="login-field">
        <span>{{ t("login.username") }}</span>
        <input v-model="username" type="text" autocomplete="username" autofocus />
      </label>

      <label class="login-field">
        <span>{{ t("login.password") }}</span>
        <input v-model="password" type="password" autocomplete="current-password" />
      </label>

      <div v-if="state.auth.loginError" class="login-error">{{ state.auth.loginError }}</div>

      <button class="go" type="submit" :disabled="state.auth.loggingIn">
        {{ state.auth.loggingIn ? t("login.connecting") : t("login.submit") }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-screen {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.login-card {
  width: 100%;
  max-width: 340px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 28px;
  border-radius: 14px;
  background: var(--panel, #171a21);
  border: 1px solid var(--border, #2a2f3a);
}
.login-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  opacity: 0.9;
}
.login-field input {
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid var(--border, #2a2f3a);
  background: var(--bg, #0d0f14);
  color: inherit;
  font: inherit;
}
.login-error {
  color: #ff6b6b;
  font-size: 13px;
}
</style>
