<script setup>
// Onglet "Docker" (Phase 22 — Docker Monitoring). Deux écrans dans la même
// vue : la liste des conteneurs, puis le détail d'UN conteneur (métadonnées,
// métriques, console de logs). Même mécanique que ServersView.vue (chargement
// initial + polling de secours à 15s, en plus du socket "docker.snapshot"
// qui rafraîchit déjà toutes les 5s côté serveur) et que LogsPanel.vue pour
// la console (mêmes classes globales .logs-body/.log-line/.filter-btn…).
// Strictement en lecture : aucun bouton start/stop/restart ici.
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import {
  state,
  can,
  loadDockerContainers,
  selectDockerContainer,
  unselectDockerContainer,
  selectedDockerContainer,
  visibleDockerLogs,
  toggleDockerPause,
  clearDockerLogs,
} from "../store";
import { fmtBytes, time, renderLogText } from "../format";

const { t } = useI18n();

let refreshTimer = null;
onMounted(() => {
  loadDockerContainers();
  refreshTimer = setInterval(() => {
    if (state.view === "docker") loadDockerContainers();
  }, 15000);
});
onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  // Quitter l'onglet ferme le flux de logs (section 5 du prompt maître).
  unselectDockerContainer();
});

// Réutilise les classes de statut globales des process PM2 (style.css) plutôt
// que d'inventer de nouvelles couleurs : running = online, exited = stopped
// (arrêt, pas forcément une erreur), dead = errored, le reste = transitoire.
function statusClass(c) {
  switch (c.state) {
    case "running":
      return "status-online";
    case "exited":
      return "status-stopped";
    case "dead":
      return "status-errored";
    default:
      return "status-launching";
  }
}

function stateLabel(s) {
  const key = `dockerView.state.${s}`;
  const label = t(key);
  return label === key ? s : label;
}

function barClass(p) {
  if (p >= 90) return "danger";
  if (p >= 70) return "warn";
  return "";
}

function fmtCpu(c) {
  return typeof c.cpuPercent === "number" ? `${c.cpuPercent.toFixed(1)}%` : "–";
}
function fmtMemUsage(c) {
  return c.memory && typeof c.memory.usageBytes === "number" ? fmtBytes(c.memory.usageBytes) : "–";
}
function fmtCreated(ts) {
  return ts ? new Date(ts).toLocaleString() : "–";
}
function shortId(id) {
  return (id || "").slice(0, 12);
}
function portsLabel(c) {
  return (c.ports || [])
    .filter((p) => p.publicPort)
    .map((p) => `${p.publicPort}→${p.privatePort}/${p.type}`)
    .join(", ");
}

// ---------- Console de logs (même mécanique d'auto-scroll que LogsPanel.vue) ----------
const logsBodyEl = ref(null);
// Compteur de lignes poussées plutôt que `.length` : la longueur se fige au plafond
// (voir le commentaire équivalent dans LogsPanel.vue).
watch([() => state.docker.logCounter, () => state.docker.logs.length], async () => {
  if (!state.docker.autoscroll) return;
  await nextTick();
  if (logsBodyEl.value) logsBodyEl.value.scrollTop = logsBodyEl.value.scrollHeight;
});
</script>

<template>
  <main class="docker-view">
    <div class="docker-panel">
      <h2 class="docker-title">{{ t("dockerView.title") }}</h2>
      <p class="hint-text">{{ t("dockerView.subtitle") }}</p>

      <!-- Docker désactivé / indisponible : le reste de PM2 Monitor n'est jamais affecté. -->
      <div v-if="!state.docker.loaded" class="events-empty">{{ t("common.loading") }}</div>
      <div v-else-if="!state.docker.available" class="docker-unavailable">
        <strong>{{ t("dockerView.unavailableTitle") }}</strong>
        <p class="hint-text">{{ t("dockerView.unavailableHint") }}</p>
      </div>

      <!-- ===== Détail d'un conteneur ===== -->
      <template v-else-if="selectedDockerContainer()">
        <template v-for="c in [selectedDockerContainer()]" :key="c.id">
          <button class="icon-btn docker-back" type="button" @click="unselectDockerContainer()">
            ← {{ t("dockerView.back") }}
          </button>

          <div class="docker-detail-head">
            <span class="status-dot" :class="statusClass(c)"></span>
            <strong class="docker-name">{{ c.name }}</strong>
            <span class="hint-text">{{ stateLabel(c.state) }} · {{ c.status }}</span>
          </div>

          <div class="docker-stats">
            <div class="docker-stat">
              <div class="docker-label">{{ t("dockerView.colCpu") }}</div>
              <div class="docker-value">{{ fmtCpu(c) }}</div>
              <div v-if="typeof c.cpuPercent === 'number'" class="bar">
                <div
                  class="bar-fill"
                  :class="barClass(c.cpuPercent)"
                  :style="{ width: Math.min(100, c.cpuPercent) + '%' }"
                ></div>
              </div>
            </div>
            <div class="docker-stat">
              <div class="docker-label">{{ t("dockerView.colMemory") }}</div>
              <div class="docker-value">
                {{ fmtMemUsage(c) }}
                <span v-if="c.memory && c.memory.limitBytes" class="hint-text"
                  >/ {{ fmtBytes(c.memory.limitBytes) }}</span
                >
              </div>
              <div v-if="c.memory && typeof c.memory.percent === 'number'" class="bar">
                <div
                  class="bar-fill"
                  :class="barClass(c.memory.percent)"
                  :style="{ width: Math.min(100, c.memory.percent) + '%' }"
                ></div>
              </div>
            </div>
            <div class="docker-stat">
              <div class="docker-label">{{ t("dockerView.detail.network") }}</div>
              <div v-if="c.network" class="docker-value">
                ↓ {{ fmtBytes(c.network.rxBytes) }} · ↑ {{ fmtBytes(c.network.txBytes) }}
              </div>
              <div v-else class="hint-text">{{ t("dockerView.detail.notExposed") }}</div>
            </div>
            <div class="docker-stat">
              <div class="docker-label">{{ t("dockerView.detail.disk") }}</div>
              <div v-if="c.blockIo" class="docker-value">
                {{ t("dockerView.detail.read") }} {{ fmtBytes(c.blockIo.readBytes) }} ·
                {{ t("dockerView.detail.write") }} {{ fmtBytes(c.blockIo.writeBytes) }}
              </div>
              <div v-else class="hint-text">{{ t("dockerView.detail.notExposed") }}</div>
            </div>
          </div>

          <dl class="docker-meta">
            <dt>{{ t("dockerView.detail.id") }}</dt>
            <dd class="mono">{{ c.id }}</dd>
            <dt>{{ t("dockerView.detail.image") }}</dt>
            <dd>{{ c.image }}</dd>
            <dt>{{ t("dockerView.colStatus") }}</dt>
            <dd>{{ stateLabel(c.state) }}</dd>
            <dt>{{ t("dockerView.colUptime") }}</dt>
            <dd>{{ c.status }}</dd>
            <dt>{{ t("dockerView.detail.created") }}</dt>
            <dd>{{ fmtCreated(c.created) }}</dd>
            <template v-if="typeof c.pids === 'number'">
              <dt>{{ t("dockerView.detail.pids") }}</dt>
              <dd>{{ c.pids }}</dd>
            </template>
            <template v-if="portsLabel(c)">
              <dt>Ports</dt>
              <dd>{{ portsLabel(c) }}</dd>
            </template>
          </dl>

          <!-- ===== Logs ===== -->
          <section class="logs-panel docker-logs">
            <div class="logs-head">
              <div class="logs-title">
                <h2>{{ t("dockerView.logsTitle", { name: c.name }) }}</h2>
              </div>
            </div>
            <div v-if="!can('docker_logs')" class="empty-state">{{ t("dockerView.logsUnavailable") }}</div>
            <template v-else>
              <div class="logs-toolbar">
                <div class="logs-toolbar-row">
                  <div class="filter-group" role="group">
                    <button
                      class="filter-btn"
                      :class="{ active: state.docker.selectedFilter === 'all' }"
                      @click="state.docker.selectedFilter = 'all'"
                    >
                      {{ t("logs.filterAll") }}
                    </button>
                    <button
                      class="filter-btn"
                      :class="{ active: state.docker.selectedFilter === 'out' }"
                      @click="state.docker.selectedFilter = 'out'"
                    >
                      stdout
                    </button>
                    <button
                      class="filter-btn"
                      :class="{ active: state.docker.selectedFilter === 'err' }"
                      @click="state.docker.selectedFilter = 'err'"
                    >
                      stderr
                    </button>
                  </div>
                  <label class="autoscroll">
                    <input v-model="state.docker.autoscroll" type="checkbox" />
                    {{ t("logs.autoscroll") }}
                  </label>
                  <button class="icon-btn" :title="t('logs.pauseTitle')" @click="toggleDockerPause">
                    {{
                      state.docker.paused
                        ? `▶ ${t("logs.resume", { count: state.docker.pausedQueue.length })}`
                        : `⏸ ${t("logs.pause")}`
                    }}
                  </button>
                  <button class="icon-btn" :title="t('logs.clearTitle')" @click="clearDockerLogs">
                    {{ t("logs.clear") }}
                  </button>
                </div>
              </div>
              <div v-if="state.docker.logsError" class="docker-log-error">
                {{ t("dockerView.logsError", { error: state.docker.logsError }) }}
              </div>

              <div ref="logsBodyEl" class="logs-body">
                <div v-if="!state.docker.logs.length" class="empty-state">
                  {{ t("dockerView.waitingForLogs") }}
                </div>
                <template v-for="entry in visibleDockerLogs()" :key="entry.n">
                  <div v-if="entry.kind === 'event'" class="log-line">
                    <span class="log-time">{{ time(entry.at) }}</span>
                    <span class="log-event">— {{ entry.event }} —</span>
                  </div>
                  <div v-else class="log-line" :class="{ 'log-backlog': entry.backlog }">
                    <span class="log-time">{{ time(entry.at) }}</span>
                    <span class="log-tag" :class="entry.type">{{ entry.type }}</span>
                    <span
                      class="log-text"
                      :class="{ err: entry.type === 'err' }"
                      v-html="renderLogText(entry.text, true)"
                    ></span>
                  </div>
                </template>
              </div>
            </template>
          </section>
        </template>
      </template>

      <!-- ===== Liste des conteneurs ===== -->
      <div v-else-if="!state.docker.containers.length" class="events-empty">{{ t("dockerView.none") }}</div>
      <table v-else class="docker-table">
        <thead>
          <tr>
            <th>{{ t("dockerView.colName") }}</th>
            <th>{{ t("dockerView.colStatus") }}</th>
            <th>{{ t("dockerView.colCpu") }}</th>
            <th>{{ t("dockerView.colMemory") }}</th>
            <th>{{ t("dockerView.colUptime") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in state.docker.containers"
            :key="c.id"
            class="docker-row"
            @click="selectDockerContainer(c.id)"
          >
            <td>
              <span class="status-dot" :class="statusClass(c)"></span>
              <strong>{{ c.name }}</strong>
              <div class="hint-text">{{ c.image }} · {{ shortId(c.id) }}</div>
            </td>
            <td>{{ stateLabel(c.state) }}</td>
            <td>{{ fmtCpu(c) }}</td>
            <td>{{ fmtMemUsage(c) }}</td>
            <td>{{ c.status }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</template>

<style scoped>
.docker-view {
  flex: 1;
  overflow-y: auto;
  padding: 22px 24px 40px;
}
.docker-panel {
  max-width: 1000px;
  margin: 0 auto;
}
.docker-title {
  margin: 0 0 4px;
}
.docker-unavailable {
  border: 1px solid var(--warn);
  border-radius: 10px;
  padding: 12px 14px;
  margin-top: 14px;
  background: var(--panel-raised);
}
.events-empty {
  padding: 32px 8px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.docker-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 14px;
}
.docker-table th {
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
}
.docker-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  vertical-align: top;
}
.docker-row {
  cursor: pointer;
}
.docker-row:hover {
  background: var(--panel-raised);
}

.docker-back {
  margin: 14px 0 10px;
}
.docker-detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.docker-name {
  font-size: 16px;
}
.docker-stats {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.docker-stat {
  min-width: 180px;
  flex: 1;
}
.docker-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.docker-value {
  font-size: 15px;
  margin: 2px 0 4px;
}
.docker-meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
  margin: 0 0 18px;
  font-size: 13px;
}
.docker-meta dt {
  color: var(--text-muted);
}
.docker-meta dd {
  margin: 0;
  word-break: break-all;
}
.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}
.docker-logs {
  min-height: 320px;
}
.docker-log-error {
  padding: 6px 12px;
  color: var(--danger, #e5484d);
  font-size: 12px;
}
</style>
