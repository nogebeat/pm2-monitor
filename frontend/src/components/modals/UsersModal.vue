<script setup>
import { reactive, ref, onMounted, computed } from "vue";
import { state, notifyError } from "../../store";
import { apiGet, apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

function close() {
  state.modal = null;
}

const users = ref([]);
const catalog = reactive({ appActions: {}, globalActions: {} });
const loading = ref(true);
const expanded = ref(null); // id du user dont le panneau de permissions est ouvert

const appNames = computed(() => {
  const names = state.processes.map((p) => p.name);
  return ["*", ...Array.from(new Set(names))];
});

const newUser = reactive({ username: "", password: "", isAdmin: false });

function load() {
  loading.value = true;
  return Promise.all([apiGet("/api/users"), apiGet("/api/permissions/catalog")])
    .then(([u, c]) => {
      users.value = u;
      catalog.appActions = c.appActions;
      catalog.globalActions = c.globalActions;
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
  if (!confirm(`Supprimer l'utilisateur "${u.username}" ?`)) return;
  fetch(`/api/users/${u.id}`, { method: "DELETE" })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || "Erreur");
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
    if (!r.ok || data.error) throw new Error(data.error || "Erreur");
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

const pwdDrafts = reactive({});

function changePassword(u) {
  const pwd = pwdDrafts[u.id];
  if (!pwd) return;
  apiPut(u.id, { password: pwd })
    .then(() => {
      pwdDrafts[u.id] = "";
      state.toast = { kind: "info", message: `Mot de passe mis à jour pour ${u.username}.` };
    })
    .catch(notifyError);
}
</script>

<template>
  <ModalBase title="Utilisateurs & permissions" hide-confirm @close="close">
    <div v-if="loading" class="hint-text">Chargement…</div>

    <template v-else>
      <div class="users-new">
        <div class="hint-text" style="margin-bottom:6px;">Créer un utilisateur</div>
        <div class="users-new-row">
          <input v-model="newUser.username" type="text" placeholder="identifiant" />
          <input v-model="newUser.password" type="password" placeholder="mot de passe (8+ car.)" />
          <label class="chk"><input v-model="newUser.isAdmin" type="checkbox" /> admin</label>
          <button class="icon-btn go" type="button" @click="createUser">+ Créer</button>
        </div>
      </div>

      <div class="users-list">
        <div v-for="u in users" :key="u.id" class="user-row">
          <div class="user-row-head" @click="toggleExpand(u)">
            <span class="label">{{ u.username }}</span>
            <span v-if="u.isAdmin" class="badge-admin">admin</span>
            <span v-else class="hint-text">{{ u.permissions.length }} permission(s)</span>
            <span style="flex:1"></span>
            <button
              v-if="u.username !== state.auth.user.username"
              type="button"
              class="icon-btn"
              @click.stop="toggleAdmin(u)"
            >
              {{ u.isAdmin ? "Retirer admin" : "Rendre admin" }}
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
            <div class="users-new-row" style="margin-bottom:10px;">
              <input v-model="pwdDrafts[u.id]" type="password" placeholder="nouveau mot de passe" />
              <button type="button" class="icon-btn" @click="changePassword(u)">Changer le mot de passe</button>
            </div>

            <template v-if="!u.isAdmin">
              <div class="hint-text" style="margin-bottom:4px;">
                Permissions globales ("*" dans une colonne = toutes les apps/actions)
              </div>
              <table class="perm-table">
                <thead>
                  <tr>
                    <th>App</th>
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

              <div class="hint-text" style="margin:10px 0 4px;">Actions globales (daemon PM2, système…)</div>
              <div class="global-perms">
                <label v-for="(label, action) in catalog.globalActions" :key="action" class="chk" :title="label">
                  <input
                    type="checkbox"
                    :checked="hasPerm(u, '*', action)"
                    @change="togglePerm(u, '*', action)"
                  />
                  {{ action }}
                </label>
              </div>
            </template>
            <div v-else class="hint-text">Les administrateurs ont tous les droits, sur toutes les apps.</div>
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
