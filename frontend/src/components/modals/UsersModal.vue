<script setup>
import { reactive, ref, onMounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { state, notifyError } from "../../store";
import { apiGet, apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

const { t } = useI18n();

function close() {
  state.modal = null;
}

const users = ref([]);
const catalog = reactive({ appActions: {}, globalActions: {} });
// Phase 18 — Advanced RBAC : catalogue des rôles prédéfinis (gabarits de
// permissions, voir lib/permissions.js#ROLES). Chargement tolérant à
// l'échec pour la même raison que /api/servers ci-dessous.
const roleCatalog = reactive({});
// Serveurs disponibles pour le scoping (Phase 10 — Multi-server). Chargement
// séparé et tolérant à l'échec : cette modale reste utilisable même si un
// user n'a pas accès à /api/servers (n'arrive pas en pratique ici, cette
// modale est réservée aux admins, mais évite de casser la gestion des
// utilisateurs si jamais ce endpoint échoue pour une autre raison).
const servers = ref([]);
const loading = ref(true);
const expanded = ref(null); // id du user dont le panneau de permissions est ouvert

const appNames = computed(() => {
  const names = state.processes.map((p) => p.name);
  return ["*", ...Array.from(new Set(names))];
});

const newUser = reactive({ username: "", password: "", isAdmin: false });

function load() {
  loading.value = true;
  return Promise.all([
    apiGet("/api/users"),
    apiGet("/api/permissions/catalog"),
    apiGet("/api/servers").catch(() => []),
    apiGet("/api/users/roles/catalog").catch(() => ({})),
  ])
    .then(([u, c, srv, roles]) => {
      users.value = u;
      catalog.appActions = c.appActions;
      catalog.globalActions = c.globalActions;
      servers.value = srv;
      Object.assign(roleCatalog, roles);
    })
    .catch(notifyError)
    .finally(() => {
      loading.value = false;
    });
}

onMounted(load);

function createUser() {
  if (!newUser.username || !newUser.password) return;
  apiPost("/api/users", { username: newUser.username, password: newUser.password, isAdmin: newUser.isAdmin })
    .then(() => {
      newUser.username = "";
      newUser.password = "";
      newUser.isAdmin = false;
      return load();
    })
    .catch(notifyError);
}

function deleteUser(u) {
  if (!confirm(t("usersModal.confirmDelete", { name: u.username }))) return;
  fetch(`/api/users/${u.id}`, { method: "DELETE" })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || t("common.error"));
      return load();
    })
    .catch(notifyError);
}

function toggleAdmin(u) {
  apiPut(u.id, { isAdmin: !u.isAdmin }).then(load).catch(notifyError);
}

function apiPut(id, body) {
  return fetch(`/api/users/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || t("common.error"));
    return data;
  });
}

function toggleExpand(u) {
  expanded.value = expanded.value === u.id ? null : u.id;
}

function hasPerm(u, appName, action) {
  return u.permissions.some((p) => p.appName === appName && p.action === action);
}

function togglePerm(u, appName, action) {
  const has = hasPerm(u, appName, action);
  const permissions = has
    ? u.permissions.filter((p) => !(p.appName === appName && p.action === action))
    : [...u.permissions, { appName, action }];
  apiPut(u.id, { permissions }).then(load).catch(notifyError);
}

// ---------- Portée serveurs (Phase 10 — Multi-server / Remote PM2) ----------
// Liste vide = pas de restriction (voit tous les serveurs que ses
// permissions habituelles autorisent) — voir lib/permissions.js#hasServerAccess
// et lib/services/servers/user-scope.js. Filtre orthogonal aux permissions
// app/action ci-dessus, pas un second système de permissions.
function hasServerScope(u, serverKey) {
  return Array.isArray(u.allowedServerKeys) && u.allowedServerKeys.includes(serverKey);
}

function toggleServerScope(u, serverKey) {
  const current = Array.isArray(u.allowedServerKeys) ? u.allowedServerKeys : [];
  const allowedServers = current.includes(serverKey)
    ? current.filter((k) => k !== serverKey)
    : [...current, serverKey];
  apiPut(u.id, { allowedServers }).then(load).catch(notifyError);
}

const pwdDrafts = reactive({});

function changePassword(u) {
  const pwd = pwdDrafts[u.id];
  if (!pwd) return;
  apiPut(u.id, { password: pwd })
    .then(() => {
      pwdDrafts[u.id] = "";
      state.toast = { kind: "info", message: t("usersModal.passwordUpdated", { name: u.username }) };
    })
    .catch(notifyError);
}

// ---------- Rôles prédéfinis (Phase 18 — Advanced RBAC) ---------------------
// Applique un gabarit de permissions en un clic (voir
// lib/permissions.js#ROLES / lib/user-store.js#applyRole) — remplace
// intégralement les permissions/le flag admin de l'utilisateur, exactement
// comme le ferait un admin en cochant les cases une par une ci-dessous.
const roleDrafts = reactive({});

function applyRole(u) {
  const role = roleDrafts[u.id];
  if (!role) return;
  if (
    !confirm(t("usersModal.confirmApplyRole", { name: u.username, role: roleCatalog[role]?.label || role }))
  )
    return;
  apiPut(u.id, { role })
    .then(() => {
      roleDrafts[u.id] = "";
      return load();
    })
    .catch(notifyError);
}
</script>

<template>
  <ModalBase :title="t('usersModal.title')" hide-confirm @close="close">
    <div v-if="loading" class="hint-text">{{ t("common.loading") }}</div>

    <template v-else>
      <div class="users-new">
        <div class="hint-text" style="margin-bottom: 6px">{{ t("usersModal.createUser") }}</div>
        <div class="users-new-row">
          <input v-model="newUser.username" type="text" :placeholder="t('usersModal.usernamePlaceholder')" />
          <input
            v-model="newUser.password"
            type="password"
            :placeholder="t('usersModal.passwordPlaceholder')"
          />
          <label class="chk"
            ><input v-model="newUser.isAdmin" type="checkbox" /> {{ t("usersModal.admin") }}</label
          >
          <button class="icon-btn go" type="button" @click="createUser">
            + {{ t("usersModal.create") }}
          </button>
        </div>
      </div>

      <div class="users-list">
        <div v-for="u in users" :key="u.id" class="user-row">
          <div class="user-row-head" @click="toggleExpand(u)">
            <span class="label">{{ u.username }}</span>
            <span v-if="u.isAdmin" class="badge-admin">{{ t("usersModal.admin") }}</span>
            <span v-else class="hint-text">{{
              t("usersModal.permissionsCount", { n: u.permissions.length })
            }}</span>
            <span v-if="u.role" class="badge-role" :title="t('usersModal.roleAppliedHint')">{{
              roleCatalog[u.role]?.label || u.role
            }}</span>
            <span style="flex: 1"></span>
            <button
              v-if="u.username !== state.auth.user.username"
              type="button"
              class="icon-btn"
              @click.stop="toggleAdmin(u)"
            >
              {{ u.isAdmin ? t("usersModal.removeAdmin") : t("usersModal.makeAdmin") }}
            </button>
            <button
              v-if="u.username !== state.auth.user.username"
              type="button"
              class="icon-btn danger-text"
              @click.stop="deleteUser(u)"
            >
              🗑
            </button>
          </div>

          <div v-if="expanded === u.id" class="user-row-body">
            <div v-if="Object.keys(roleCatalog).length" class="users-new-row" style="margin-bottom: 10px">
              <select v-model="roleDrafts[u.id]">
                <option value="" disabled>{{ t("usersModal.applyRolePlaceholder") }}</option>
                <option v-for="(role, name) in roleCatalog" :key="name" :value="name">
                  {{ role.label }}
                </option>
              </select>
              <button type="button" class="icon-btn" @click="applyRole(u)">
                {{ t("usersModal.applyRole") }}
              </button>
              <span class="hint-text">{{ t("usersModal.applyRoleHint") }}</span>
            </div>

            <div class="users-new-row" style="margin-bottom: 10px">
              <input
                v-model="pwdDrafts[u.id]"
                type="password"
                :placeholder="t('usersModal.newPasswordPlaceholder')"
              />
              <button type="button" class="icon-btn" @click="changePassword(u)">
                {{ t("usersModal.changePassword") }}
              </button>
            </div>

            <template v-if="!u.isAdmin">
              <div class="hint-text" style="margin-bottom: 4px">
                {{ t("usersModal.globalPermsHint") }}
              </div>
              <table class="perm-table">
                <thead>
                  <tr>
                    <th>{{ t("usersModal.app") }}</th>
                    <th v-for="(label, action) in catalog.appActions" :key="action" :title="label">
                      {{ action }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="appName in appNames" :key="appName">
                    <td>{{ appName }}</td>
                    <td v-for="(label, action) in catalog.appActions" :key="action">
                      <input
                        type="checkbox"
                        :checked="hasPerm(u, appName, action)"
                        @change="togglePerm(u, appName, action)"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>

              <div class="hint-text" style="margin: 10px 0 4px">{{ t("usersModal.globalActionsHint") }}</div>
              <div class="global-perms">
                <label
                  v-for="(label, action) in catalog.globalActions"
                  :key="action"
                  class="chk"
                  :title="label"
                >
                  <input
                    type="checkbox"
                    :checked="hasPerm(u, '*', action)"
                    @change="togglePerm(u, '*', action)"
                  />
                  {{ action }}
                </label>
              </div>

              <template v-if="servers.length">
                <div class="hint-text" style="margin: 10px 0 4px">
                  {{ t("usersModal.serverScopeHint") }}
                </div>
                <div class="global-perms">
                  <label v-for="srv in servers" :key="srv.serverKey" class="chk" :title="srv.hostname || ''">
                    <input
                      type="checkbox"
                      :checked="hasServerScope(u, srv.serverKey)"
                      @change="toggleServerScope(u, srv.serverKey)"
                    />
                    {{ srv.name }}
                  </label>
                </div>
                <div v-if="!u.allowedServerKeys || !u.allowedServerKeys.length" class="hint-text">
                  {{ t("usersModal.serverScopeUnrestricted") }}
                </div>
              </template>
            </template>
            <div v-else class="hint-text">{{ t("usersModal.adminHint") }}</div>
          </div>
        </div>
      </div>
    </template>
  </ModalBase>
</template>

<style scoped>
.users-new-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.users-new-row input[type="text"],
.users-new-row input[type="password"] {
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
  font: inherit;
  flex: 1;
  min-width: 140px;
}
.chk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  white-space: nowrap;
}
.users-list {
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
.badge-admin {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
}
.badge-role {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  color: var(--text-dim, inherit);
}
.users-new-row select {
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
  font: inherit;
}
.user-row-body {
  padding: 12px;
  border-top: 1px solid var(--border);
  background: var(--panel-raised);
}
.perm-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.perm-table th,
.perm-table td {
  padding: 4px 6px;
  text-align: center;
  border-bottom: 1px solid var(--border);
}
.perm-table td:first-child,
.perm-table th:first-child {
  text-align: left;
  font-family: var(--font-mono);
}
.global-perms {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
</style>
