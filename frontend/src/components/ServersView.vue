<script setup>
import { reactive, ref, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import {
  state,
  can,
  notifyError,
  loadServers,
  createServer,
  updateServer,
  setServerEnabled,
  deleteServer,
  regenerateServerToken,
  runRemoteAction,
} from "../store";
import { fmtBytes, fmtUptime } from "../format";

const { t } = useI18n();

// Le store gère déjà le temps réel (server.snapshot / server.status, voir
// store.js) : cette vue déclenche juste le premier chargement, puis
// revérifie périodiquement (filet de sécurité en cas d'événement manqué à
// la reconnexion) — même modèle que DashboardView.vue.
let pollTimer = null;
onMounted(() => {
  loadServers();
  pollTimer = setInterval(() => {
    if (state.view === "servers") loadServers();
  }, 15000);
});
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});

const canManage = () => can("servers_manage");

// ---------- Création ----------
const showCreate = ref(false);
const newServer = reactive({ name: "", hostname: "", environment: "production" });
const justCreatedToken = ref(null); // { server, token } — affiché une seule fois

function submitCreate() {
  if (!newServer.name.trim()) return;
  createServer({ ...newServer })
    .then((r) => {
      justCreatedToken.value = r;
      newServer.name = "";
      newServer.hostname = "";
      newServer.environment = "production";
      showCreate.value = false;
    })
    .catch(notifyError);
}

// ---------- Édition ----------
const editing = ref(null); // serverKey en cours d'édition
const editDraft = reactive({ name: "", hostname: "", environment: "production" });

function startEdit(server) {
  editing.value = server.serverKey;
  editDraft.name = server.name;
  editDraft.hostname = server.hostname || "";
  editDraft.environment = server.environment;
}

function saveEdit(server) {
  updateServer(server.serverKey, { ...editDraft })
    .then(() => {
      editing.value = null;
    })
    .catch(notifyError);
}

function cancelEdit() {
  editing.value = null;
}

// ---------- Actions serveur ----------
function toggleEnabled(server) {
  setServerEnabled(server.serverKey, !server.enabled).catch(notifyError);
}

function removeServer(server) {
  if (!confirm(t("serversView.confirmDelete", { name: server.name }))) return;
  deleteServer(server.serverKey).catch(notifyError);
}

const regeneratedToken = ref(null); // { server, token }
function regenToken(server) {
  if (!confirm(t("serversView.confirmRegenerate", { name: server.name }))) return;
  regenerateServerToken(server.serverKey)
    .then((r) => {
      regeneratedToken.value = r;
    })
    .catch(notifyError);
}

// ---------- Processus distants (expand) ----------
const expanded = ref(null);
function toggleExpand(server) {
  expanded.value = expanded.value === server.serverKey ? null : server.serverKey;
}

const REMOTE_ACTIONS = ["start", "stop", "restart", "reload"];
function remoteAction(server, processName, action) {
  runRemoteAction(server.serverKey, action, processName).catch(notifyError);
}

function statusLabel(status) {
  return t(`serversView.status.${(status || "OFFLINE").toLowerCase()}`);
}

function pct(n) {
  return typeof n === "number" ? Math.round(n) : 0;
}
</script>

<template>
  <main class="servers-view">
    <div class="chart-panel servers-panel">
      <div class="chart-head">
        <h2>{{ t("serversView.title") }}</h2>
        <button v-if="canManage()" class="icon-btn go" type="button" @click="showCreate = !showCreate">
          + {{ t("serversView.addServer") }}
        </button>
      </div>

      <p class="hint-text">{{ t("serversView.subtitle") }}</p>

      <div v-if="showCreate" class="server-form">
        <input v-model="newServer.name" type="text" :placeholder="t('serversView.namePlaceholder')" />
        <input
          v-model="newServer.hostname"
          type="text"
          :placeholder="t('serversView.hostnamePlaceholder')"
        />
        <select v-model="newServer.environment">
          <option value="production">{{ t("serversView.envProduction") }}</option>
          <option value="staging">{{ t("serversView.envStaging") }}</option>
          <option value="development">{{ t("serversView.envDevelopment") }}</option>
          <option value="custom">{{ t("serversView.envCustom") }}</option>
        </select>
        <button class="icon-btn go" type="button" @click="submitCreate">{{ t("serversView.register") }}</button>
      </div>

      <div v-if="justCreatedToken" class="token-panel">
        <div class="token-panel-title">
          {{ t("serversView.tokenTitle", { name: justCreatedToken.server.name }) }}
        </div>
        <p class="hint-text">{{ t("serversView.tokenHint") }}</p>
        <code class="token-value">{{ justCreatedToken.token }}</code>
        <p class="hint-text">
          {{ t("serversView.tokenEnvHint", { key: justCreatedToken.server.serverKey }) }}
        </p>
        <button class="icon-btn" type="button" @click="justCreatedToken = null">
          {{ t("serversView.tokenDismiss") }}
        </button>
      </div>

      <div v-if="regeneratedToken" class="token-panel">
        <div class="token-panel-title">
          {{ t("serversView.tokenTitle", { name: regeneratedToken.server.name }) }}
        </div>
        <p class="hint-text">{{ t("serversView.tokenHint") }}</p>
        <code class="token-value">{{ regeneratedToken.token }}</code>
        <button class="icon-btn" type="button" @click="regeneratedToken = null">
          {{ t("serversView.tokenDismiss") }}
        </button>
      </div>

      <div v-if="state.servers.loading && !state.servers.loaded" class="events-empty">
        {{ t("common.loading") }}
      </div>
      <div v-else-if="!state.servers.items.length" class="events-empty">
        {{ t("serversView.none") }}
      </div>

      <ul v-else class="servers-list">
        <li v-for="s in state.servers.items" :key="s.serverKey" class="server-row">
          <div class="server-row-head" @click="toggleExpand(s)">
            <span class="status-dot" :class="`status-${s.status === 'ONLINE' ? 'online' : s.status === 'PENDING' ? 'launching' : 'errored'}`"></span>
            <span class="label">{{ s.name }}</span>
            <span v-if="s.kind === 'local'" class="badge-admin">{{ t("serversView.local") }}</span>
            <span class="hint-text">{{ s.hostname || "–" }}</span>
            <span class="hint-text env-badge">{{ t(`serversView.env${s.environment.charAt(0).toUpperCase()}${s.environment.slice(1)}`) }}</span>
            <span class="hint-text">{{ statusLabel(s.status) }}</span>
            <span class="hint-text">
              {{ t("serversView.processCount", { n: s.kind === "local" ? state.processes.length : (s.processes || []).length }) }}
            </span>
            <span class="hint-text">{{ t("serversView.lastSeen", { time: s.lastSeen ? fmtUptime(s.lastSeen) : "–" }) }}</span>
            <span style="flex: 1"></span>
            <template v-if="canManage() && s.kind !== 'local'">
              <button type="button" class="icon-btn" @click.stop="startEdit(s)">✎</button>
              <button type="button" class="icon-btn" @click.stop="toggleEnabled(s)">
                {{ s.enabled ? t("serversView.disable") : t("serversView.enable") }}
              </button>
              <button type="button" class="icon-btn" @click.stop="regenToken(s)">
                {{ t("serversView.regenerateToken") }}
              </button>
              <button type="button" class="icon-btn danger-text" @click.stop="removeServer(s)">🗑</button>
            </template>
          </div>

          <div v-if="s.snapshot" class="server-stats">
            <div class="server-stat">
              <span class="hint-text">CPU {{ pct(s.snapshot.cpu) }}%</span>
              <div class="bar"><div class="bar-fill" :style="{ width: pct(s.snapshot.cpu) + '%' }"></div></div>
            </div>
            <div class="server-stat">
              <span class="hint-text">RAM {{ s.snapshot.mem ? pct(s.snapshot.mem.percent) : 0 }}%</span>
              <div class="bar">
                <div class="bar-fill" :style="{ width: (s.snapshot.mem ? pct(s.snapshot.mem.percent) : 0) + '%' }"></div>
              </div>
              <span v-if="s.snapshot.mem" class="hint-text">{{ fmtBytes(s.snapshot.mem.used) }} / {{ fmtBytes(s.snapshot.mem.total) }}</span>
            </div>
            <div v-if="s.snapshot.disk" class="server-stat">
              <span class="hint-text">{{ t("serversView.disk") }} {{ pct(s.snapshot.disk.percent) }}%</span>
              <div class="bar"><div class="bar-fill" :style="{ width: pct(s.snapshot.disk.percent) + '%' }"></div></div>
              <span class="hint-text">{{ fmtBytes(s.snapshot.disk.used) }} / {{ fmtBytes(s.snapshot.disk.total) }}</span>
            </div>
            <div v-if="s.snapshot.temp" class="server-stat">
              <span class="hint-text">{{ t("serversView.temperature") }} {{ s.snapshot.temp.celsius }}°C</span>
            </div>
          </div>

          <div v-if="editing === s.serverKey" class="server-form">
            <input v-model="editDraft.name" type="text" :placeholder="t('serversView.namePlaceholder')" />
            <input v-model="editDraft.hostname" type="text" :placeholder="t('serversView.hostnamePlaceholder')" />
            <select v-model="editDraft.environment">
              <option value="production">{{ t("serversView.envProduction") }}</option>
              <option value="staging">{{ t("serversView.envStaging") }}</option>
              <option value="development">{{ t("serversView.envDevelopment") }}</option>
              <option value="custom">{{ t("serversView.envCustom") }}</option>
            </select>
            <button class="icon-btn go" type="button" @click="saveEdit(s)">{{ t("common.save") }}</button>
            <button class="icon-btn" type="button" @click="cancelEdit">{{ t("common.cancel") }}</button>
          </div>

          <div v-if="expanded === s.serverKey && s.kind !== 'local'" class="server-processes">
            <div v-if="!(s.processes || []).length" class="hint-text">{{ t("serversView.noProcesses") }}</div>
            <div v-for="p in s.processes || []" :key="p.id" class="server-process-row">
              <span class="status-dot" :class="`status-${p.status === 'online' ? 'online' : 'errored'}`"></span>
              <span class="label">{{ p.name }}</span>
              <span class="hint-text">{{ p.status }}</span>
              <span class="hint-text">CPU {{ pct(p.cpu) }}%</span>
              <span class="hint-text">{{ fmtBytes(p.memory) }}</span>
              <span style="flex: 1"></span>
              <button
                v-for="a in REMOTE_ACTIONS"
                v-show="can(a, p.name)"
                :key="a"
                type="button"
                class="icon-btn"
                @click="remoteAction(s, p.name, a)"
              >
                {{ t(`serversView.action.${a}`) }}
              </button>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </main>
</template>

<style scoped>
.servers-view {
  flex: 1;
  overflow-y: auto;
  padding: 22px 24px 40px;
}
.servers-panel {
  max-width: 1000px;
  margin: 0 auto;
}

.server-form {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  margin: 10px 0 16px;
}
.server-form input,
.server-form select {
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
  font: inherit;
  min-width: 140px;
}

.token-panel {
  border: 1px solid var(--warn);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 16px;
  background: var(--panel-raised);
}
.token-panel-title {
  font-weight: 600;
  margin-bottom: 6px;
}
.token-value {
  display: block;
  word-break: break-all;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  margin: 8px 0;
  font-family: var(--font-mono);
  font-size: 12px;
}

.servers-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.server-row {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.server-row-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  flex-wrap: wrap;
}
.env-badge {
  text-transform: capitalize;
}

.server-stats {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  padding: 0 12px 12px;
}
.server-stat {
  min-width: 140px;
  flex: 1;
}

.server-processes {
  border-top: 1px solid var(--border);
  padding: 8px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.server-process-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.events-empty {
  padding: 32px 8px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
