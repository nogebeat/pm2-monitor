<script setup>
/**
 * ApiKeysModal.vue — Phase 18 (Advanced RBAC & API Keys), suite : écran de
 * gestion des clés API M2M, résolvant le problème connu "pas d'UI dédiée"
 * (voir docs/rbac-api-keys/README.md). Même pattern que UsersModal.vue /
 * HealthChecksModal.vue : liste + formulaire de création + panneau
 * d'édition dépliable par ligne.
 *
 * Toute la logique d'autorisation vit côté serveur (lib/routes/api-keys.js) :
 * ce composant ne fait qu'afficher/masquer selon can("api_keys_read"/"api_keys_manage"),
 * confort d'UI seulement — voir store.js#can().
 */
import { reactive, ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { state, notifyError, can } from "../../store";
import { apiGet, apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

const { t } = useI18n();

function close() {
  state.modal = null;
}

const canManage = can("api_keys_manage");

const keys = ref([]);
const scopeCatalog = reactive({});
const loading = ref(true);
const expanded = ref(null);
// Secret affiché une seule fois juste après la création (voir
// lib/services/api-keys/store.js#create) — jamais réaffiché après un
// rechargement de la liste, jamais persisté côté client au-delà de cette
// variable en mémoire.
const revealedSecret = ref(null);

function load() {
  loading.value = true;
  return Promise.all([apiGet("/api/api-keys"), apiGet("/api/api-keys/scopes")])
    .then(([list, scopes]) => {
      keys.value = list;
      Object.assign(scopeCatalog, scopes);
    })
    .catch(notifyError)
    .finally(() => {
      loading.value = false;
    });
}

onMounted(load);

function apiPatch(id, body) {
  return fetch(`/api/api-keys/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || t("common.error"));
    return data;
  });
}

// ---------- Création ----------
const newKey = reactive({ name: "", scopes: [], processesText: "", expiresAt: "" });

function toggleNewScope(scope) {
  const i = newKey.scopes.indexOf(scope);
  if (i === -1) newKey.scopes.push(scope);
  else newKey.scopes.splice(i, 1);
}

function createKey() {
  if (!newKey.name || !newKey.scopes.length) return;
  const processes = newKey.processesText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const body = {
    name: newKey.name,
    scopes: [...newKey.scopes],
    resourceScopes: processes.length ? { processes } : undefined,
    expiresAt: newKey.expiresAt ? new Date(newKey.expiresAt).getTime() : undefined,
  };
  apiPost("/api/api-keys", body)
    .then(({ apiKey, secret }) => {
      revealedSecret.value = { name: apiKey.name, secret };
      newKey.name = "";
      newKey.scopes = [];
      newKey.processesText = "";
      newKey.expiresAt = "";
      return load();
    })
    .catch(notifyError);
}

function dismissSecret() {
  revealedSecret.value = null;
}

function copySecret() {
  if (!revealedSecret.value) return;
  navigator.clipboard?.writeText(revealedSecret.value.secret).catch(() => {});
}

// ---------- Édition / révocation ----------
const editDrafts = reactive({});

function toggleExpand(k) {
  if (expanded.value === k.id) {
    expanded.value = null;
    return;
  }
  expanded.value = k.id;
  editDrafts[k.id] = {
    scopes: [...k.scopes],
    processesText: (k.resourceScopes && k.resourceScopes.processes ? k.resourceScopes.processes : []).join(", "),
  };
}

function toggleEditScope(k, scope) {
  const draft = editDrafts[k.id];
  const i = draft.scopes.indexOf(scope);
  if (i === -1) draft.scopes.push(scope);
  else draft.scopes.splice(i, 1);
}

function saveEdit(k) {
  const draft = editDrafts[k.id];
  if (!draft.scopes.length) return;
  const processes = draft.processesText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  apiPatch(k.id, { scopes: [...draft.scopes], resourceScopes: processes.length ? { processes } : null })
    .then(() => {
      expanded.value = null;
      return load();
    })
    .catch(notifyError);
}

function revokeKey(k) {
  if (!confirm(t("apiKeysModal.confirmRevoke", { name: k.name }))) return;
  fetch(`/api/api-keys/${k.id}/revoke`, { method: "POST" })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || t("common.error"));
      return load();
    })
    .catch(notifyError);
}

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleString() : "—";
}

function keyStatus(k) {
  if (k.revokedAt) return { label: t("apiKeysModal.statusRevoked"), cls: "badge-revoked" };
  if (k.expiresAt && k.expiresAt < Date.now()) return { label: t("apiKeysModal.statusExpired"), cls: "badge-revoked" };
  return { label: t("apiKeysModal.statusActive"), cls: "badge-active" };
}
</script>

<template>
  <ModalBase :title="t('apiKeysModal.title')" hide-confirm @close="close">
    <div v-if="loading" class="hint-text">{{ t("common.loading") }}</div>

    <template v-else>
      <div v-if="revealedSecret" class="secret-reveal">
        <div class="hint-text" style="margin-bottom: 6px">
          {{ t("apiKeysModal.secretRevealHint", { name: revealedSecret.name }) }}
        </div>
        <div class="secret-value">
          <code>{{ revealedSecret.secret }}</code>
          <button type="button" class="icon-btn" @click="copySecret">{{ t("apiKeysModal.copy") }}</button>
        </div>
        <button type="button" class="icon-btn" style="margin-top: 8px" @click="dismissSecret">
          {{ t("apiKeysModal.dismissSecret") }}
        </button>
      </div>

      <div v-if="canManage" class="apikeys-new">
        <div class="hint-text" style="margin-bottom: 6px">{{ t("apiKeysModal.createKey") }}</div>
        <div class="apikeys-new-row">
          <input v-model="newKey.name" type="text" :placeholder="t('apiKeysModal.namePlaceholder')" />
          <input v-model="newKey.expiresAt" type="date" :title="t('apiKeysModal.expiresAtHint')" />
        </div>
        <div class="global-perms" style="margin: 8px 0">
          <label v-for="(label, scope) in scopeCatalog" :key="scope" class="chk" :title="label">
            <input type="checkbox" :checked="newKey.scopes.includes(scope)" @change="toggleNewScope(scope)" />
            {{ scope }}
          </label>
        </div>
        <input
          v-model="newKey.processesText"
          type="text"
          class="processes-input"
          :placeholder="t('apiKeysModal.processesPlaceholder')"
        />
        <div>
          <button
            class="icon-btn go"
            type="button"
            :disabled="!newKey.name || !newKey.scopes.length"
            style="margin-top: 8px"
            @click="createKey"
          >
            + {{ t("apiKeysModal.create") }}
          </button>
        </div>
      </div>

      <div class="apikeys-list">
        <div v-for="k in keys" :key="k.id" class="user-row">
          <div class="user-row-head" @click="toggleExpand(k)">
            <span class="label">{{ k.name }}</span>
            <span class="hint-text mono">{{ k.keyPrefix }}…</span>
            <span :class="['badge-status', keyStatus(k).cls]">{{ keyStatus(k).label }}</span>
            <span style="flex: 1"></span>
            <button
              v-if="canManage && !k.revokedAt"
              type="button"
              class="icon-btn danger-text"
              @click.stop="revokeKey(k)"
            >
              {{ t("apiKeysModal.revoke") }}
            </button>
          </div>

          <div v-if="expanded === k.id" class="user-row-body">
            <div class="apikeys-meta">
              <div>{{ t("apiKeysModal.scopes") }}: {{ k.scopes.join(", ") }}</div>
              <div v-if="k.resourceScopes && k.resourceScopes.processes && k.resourceScopes.processes.length">
                {{ t("apiKeysModal.scopedProcesses") }}: {{ k.resourceScopes.processes.join(", ") }}
              </div>
              <div>{{ t("apiKeysModal.createdAt") }}: {{ fmtDate(k.createdAt) }}</div>
              <div>{{ t("apiKeysModal.expiresAt") }}: {{ k.expiresAt ? fmtDate(k.expiresAt) : t("apiKeysModal.never") }}</div>
              <div>{{ t("apiKeysModal.lastUsedAt") }}: {{ k.lastUsedAt ? fmtDate(k.lastUsedAt) : t("apiKeysModal.never") }}</div>
            </div>

            <template v-if="canManage && !k.revokedAt && editDrafts[k.id]">
              <div class="hint-text" style="margin: 10px 0 4px">{{ t("apiKeysModal.editScopes") }}</div>
              <div class="global-perms">
                <label v-for="(label, scope) in scopeCatalog" :key="scope" class="chk" :title="label">
                  <input
                    type="checkbox"
                    :checked="editDrafts[k.id].scopes.includes(scope)"
                    @change="toggleEditScope(k, scope)"
                  />
                  {{ scope }}
                </label>
              </div>
              <input
                v-model="editDrafts[k.id].processesText"
                type="text"
                class="processes-input"
                style="margin-top: 8px"
                :placeholder="t('apiKeysModal.processesPlaceholder')"
              />
              <div>
                <button type="button" class="icon-btn" style="margin-top: 8px" @click="saveEdit(k)">
                  {{ t("apiKeysModal.save") }}
                </button>
              </div>
            </template>
          </div>
        </div>
        <div v-if="!keys.length" class="hint-text">{{ t("apiKeysModal.empty") }}</div>
      </div>
    </template>
  </ModalBase>
</template>

<style scoped>
.apikeys-new-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.apikeys-new-row input[type="text"] {
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
  font: inherit;
  flex: 1;
  min-width: 140px;
}
.apikeys-new-row input[type="date"] {
  padding: 6px 9px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
  font: inherit;
}
.processes-input {
  width: 100%;
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
  font: inherit;
  box-sizing: border-box;
}
.chk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  white-space: nowrap;
}
.global-perms {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.apikeys-list {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.user-row {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.user-row-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  cursor: pointer;
}
.user-row-body {
  padding: 12px;
  border-top: 1px solid var(--border);
  background: var(--panel-raised);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.apikeys-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 4px;
}
.mono {
  font-family: var(--font-mono);
}
.badge-status {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 999px;
}
.badge-active {
  background: var(--accent-dim);
  color: var(--accent);
}
.badge-revoked {
  background: var(--danger-dim, rgba(220, 60, 60, 0.15));
  color: var(--danger, #d33);
}
.secret-reveal {
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 14px;
  background: var(--panel-raised);
}
.secret-value {
  display: flex;
  align-items: center;
  gap: 8px;
}
.secret-value code {
  flex: 1;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--bg);
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
}
</style>
