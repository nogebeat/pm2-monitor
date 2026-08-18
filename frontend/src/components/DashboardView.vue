<script setup>
import { computed, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { state, loadDashboard, selectProcess } from "../store";
import { fmtMem, fmtUptime, fmtRate, time } from "../format";

const { t } = useI18n();

// --- Chargement / rafraîchissement -----------------------------------------
// Le store (loadDashboard + scheduleDashboardRefresh) gère déjà le temps réel
// via les événements Socket.IO existants (voir store.js, section câblage
// WebSocket) : cette vue se contente de déclencher le premier chargement et
// de relire state.dashboard / state.system / state.processes, réutilisés tel
// quels — aucun second système temps réel ici.
let pollTimer = null;
onMounted(() => {
  loadDashboard();
  // Filet de sécurité : si un événement socket est manqué (reconnexion),
  // on revérifie périodiquement tant que l'onglet Dashboard est affiché.
  pollTimer = setInterval(() => {
    if (state.view === "dashboard") loadDashboard();
  }, 15000);
});
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});

const sys = computed(() => state.system);

const STATUS_LABEL = computed(() => ({
  HEALTHY: t("dashboard.statusHealthy"),
  WARNING: t("dashboard.statusWarning"),
  CRITICAL: t("dashboard.statusCritical"),
}));
const STATUS_ICON = { HEALTHY: "✓", WARNING: "⚠", CRITICAL: "✕" };

const globalStatus = computed(() => state.dashboard.globalStatus);
const globalStatusClass = computed(() => `status-${(globalStatus.value || "").toLowerCase()}`);

const overview = computed(() => state.dashboard.processesOverview);
const alerts = computed(() => state.dashboard.alerts);
const healthChecks = computed(() => state.dashboard.healthChecks);

// Map processName -> pire statut de health check (pour la colonne "health"
// du tableau process) — réutilise simplement les items déjà chargés,
// aucun nouvel appel réseau.
const healthByProcess = computed(() => {
  const map = {};
  const items = (healthChecks.value && healthChecks.value.items) || [];
  const rank = { DOWN: 3, DEGRADED: 2, UNKNOWN: 1, UP: 0 };
  for (const c of items) {
    if (!c.processName) continue;
    const current = map[c.processName];
    if (!current || rank[c.status] > rank[current]) map[c.processName] = c.status;
  }
  return map;
});

function healthFor(processName) {
  return healthByProcess.value[processName] || null;
}

const TIMELINE_ICON = {
  process_event: "⚙",
  alert: "▲",
  auto_healing: "✚",
};

function timelineLabel(item) {
  if (item.kind === "process_event") return item.type;
  if (item.kind === "alert") {
    if (item.type === "resolved") return t("dashboard.alertResolved", { name: item.ruleName || "?" });
    if (item.type === "acknowledged") return t("dashboard.alertAcknowledged", { name: item.ruleName || "?" });
    return t("dashboard.alertTriggered", { name: item.ruleName || "?" });
  }
  if (item.kind === "auto_healing") return t("dashboard.autoHealing", { type: item.type, result: item.result || "?" });
  return item.kind;
}

function timelineSeverityClass(item) {
  const sev = item.severity;
  if (item.kind === "alert" && item.type === "resolved") return "badge-info";
  if (sev === "critical") return "badge-critical";
  if (sev === "warning") return "badge-warning";
  return "badge-info";
}

// --- Clic sur un process : bascule vers sa page existante (onglet Process) --
function openProcess(id) {
  state.view = "process";
  selectProcess(id);
}

function statusDotClass(status) {
  return `status-${status}`;
}
</script>

<template>
  <main class="dashboard-view">
    <!-- 6. Global health status -->
    <div class="global-status-banner" :class="globalStatusClass">
      <div class="global-status-main">
        <span class="global-status-icon">{{ STATUS_ICON[globalStatus] || "…" }}</span>
        <div>
          <div class="global-status-label">{{ STATUS_LABEL[globalStatus] || t("dashboard.statusLoading") }}</div>
          <div class="global-status-sub">{{ t("dashboard.statusSub") }}</div>
        </div>
      </div>
      <ul v-if="state.dashboard.globalStatusReasons.length" class="global-status-reasons">
        <li v-for="(r, i) in state.dashboard.globalStatusReasons" :key="i">{{ r }}</li>
      </ul>
      <div v-else-if="state.dashboard.loaded" class="global-status-reasons global-status-reasons-empty">
        {{ t("dashboard.noAnomaly") }}
      </div>
    </div>

    <!-- 2. Vue système -->
    <section class="dash-section">
      <h2>{{ t("dashboard.system") }}</h2>
      <div class="system-grid">
        <div class="metric-card">
          <span class="metric-label">{{ t("dashboard.cpu") }}</span>
          <div class="metric-value">{{ sys ? sys.cpu + "%" : "–" }}</div>
          <div class="bar">
            <div
              class="bar-fill"
              :class="{ danger: (sys?.cpu || 0) >= 90, warn: (sys?.cpu || 0) >= 70 && (sys?.cpu || 0) < 90 }"
              :style="{ width: (sys?.cpu || 0) + '%' }"
            ></div>
          </div>
        </div>
        <div class="metric-card">
          <span class="metric-label">{{ t("dashboard.ram") }}</span>
          <div class="metric-value">{{ sys?.mem ? sys.mem.percent + "%" : "–" }}</div>
          <div class="bar">
            <div
              class="bar-fill"
              :class="{ danger: (sys?.mem?.percent || 0) >= 90, warn: (sys?.mem?.percent || 0) >= 75 && (sys?.mem?.percent || 0) < 90 }"
              :style="{ width: (sys?.mem?.percent || 0) + '%' }"
            ></div>
          </div>
        </div>
        <div class="metric-card">
          <span class="metric-label">{{ t("dashboard.disk") }}</span>
          <div class="metric-value">{{ sys?.disk ? sys.disk.percent + "%" : "–" }}</div>
          <div class="bar">
            <div
              class="bar-fill"
              :class="{ danger: (sys?.disk?.percent || 0) >= 90, warn: (sys?.disk?.percent || 0) >= 80 && (sys?.disk?.percent || 0) < 90 }"
              :style="{ width: (sys?.disk?.percent || 0) + '%' }"
            ></div>
          </div>
        </div>
        <div class="metric-card">
          <span class="metric-label">{{ t("dashboard.network") }}</span>
          <div class="metric-value">{{ sys?.net ? `↓ ${fmtRate(sys.net.rxRate)}` : "–" }}</div>
          <div class="metric-sub">{{ sys?.net ? `↑ ${fmtRate(sys.net.txRate)}` : t("system.netHint") }}</div>
        </div>
        <div class="metric-card">
          <span class="metric-label">{{ t("dashboard.cpuTemp") }}</span>
          <div class="metric-value">{{ sys?.temp ? sys.temp.celsius + "°C" : t("system.notAvailable") }}</div>
          <div class="metric-sub">{{ t("dashboard.linuxOnly") }}</div>
        </div>
      </div>
    </section>

    <div class="dash-cols">
      <!-- 3. Process overview -->
      <section class="dash-section dash-col">
        <h2>{{ t("dashboard.processes") }}</h2>
        <div v-if="overview" class="overview-grid">
          <div class="overview-item"><span class="overview-value">{{ overview.total }}</span><span class="overview-label">total</span></div>
          <div class="overview-item ok"><span class="overview-value">{{ overview.online }}</span><span class="overview-label">online</span></div>
          <div class="overview-item"><span class="overview-value">{{ overview.stopped }}</span><span class="overview-label">stopped</span></div>
          <div class="overview-item danger"><span class="overview-value">{{ overview.errored }}</span><span class="overview-label">errored</span></div>
          <div class="overview-item danger"><span class="overview-value">{{ overview.crashed }}</span><span class="overview-label">crashed</span></div>
          <div class="overview-item warn"><span class="overview-value">{{ overview.restarting }}</span><span class="overview-label">restarting</span></div>
        </div>
        <div v-else class="dash-empty">{{ t("dashboard.statusLoading") }}</div>
      </section>

      <!-- 4. Alert overview -->
      <section class="dash-section dash-col">
        <h2>{{ t("dashboard.alerts") }}</h2>
        <div v-if="alerts" class="overview-grid">
          <div class="overview-item"><span class="overview-value">{{ alerts.active }}</span><span class="overview-label">{{ t('dashboard.alertsActive') }}</span></div>
          <div class="overview-item danger"><span class="overview-value">{{ alerts.critical }}</span><span class="overview-label">{{ t('dashboard.alertsCritical') }}</span></div>
          <div class="overview-item warn"><span class="overview-value">{{ alerts.warning }}</span><span class="overview-label">warning</span></div>
          <div class="overview-item"><span class="overview-value">{{ alerts.acknowledged }}</span><span class="overview-label">{{ t('dashboard.alertsAcked') }}</span></div>
        </div>
        <div v-else class="dash-empty">{{ t("dashboard.alertsMissingPerm") }}</div>
      </section>
    </div>

    <!-- 5. Process table -->
    <section class="dash-section">
      <h2>{{ t("dashboard.processOverview") }}</h2>
      <div class="dash-table-wrap">
        <table v-if="state.processes.length" class="dash-table">
          <thead>
            <tr>
              <th>{{ t("dashboard.colApp") }}</th>
              <th>{{ t("dashboard.colStatus") }}</th>
              <th>CPU</th>
              <th>RAM</th>
              <th>{{ t("dashboard.colRestarts") }}</th>
              <th>{{ t("dashboard.colUptime") }}</th>
              <th>{{ t("dashboard.colHealth") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in state.processes" :key="p.id" class="dash-table-row" @click="openProcess(p.id)">
              <td class="dash-table-name">
                <span class="status-dot" :class="statusDotClass(p.status)"></span>
                {{ p.name }}
              </td>
              <td>{{ p.status }}</td>
              <td>{{ p.cpu }}%</td>
              <td>{{ fmtMem(p.memory) }}</td>
              <td>{{ p.restarts }}</td>
              <td>{{ fmtUptime(p.uptime) }}</td>
              <td>
                <span v-if="healthFor(p.name)" class="health-badge" :class="`health-${healthFor(p.name).toLowerCase()}`">
                  {{ healthFor(p.name) }}
                </span>
                <span v-else class="dash-empty-inline">–</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="dash-empty">{{ t("dashboard.noProcess") }}</div>
      </div>
    </section>

    <!-- 7. Recent timeline -->
    <section class="dash-section">
      <h2>{{ t("dashboard.recentTimeline") }}</h2>
      <ul v-if="state.dashboard.recentTimeline.length" class="dash-timeline">
        <li v-for="(item, i) in state.dashboard.recentTimeline" :key="i" class="dash-timeline-row">
          <span class="event-icon" aria-hidden="true">{{ TIMELINE_ICON[item.kind] || "•" }}</span>
          <span class="event-time">{{ time(item.at) }}</span>
          <span class="event-process">{{ item.process || t("dashboard.unknown") }}</span>
          <span class="event-type">{{ timelineLabel(item) }}</span>
          <span class="event-badge" :class="timelineSeverityClass(item)">{{ item.kind }}</span>
        </li>
      </ul>
      <div v-else class="dash-empty">{{ t("dashboard.noRecentEvent") }}</div>
    </section>
  </main>
</template>

<style scoped>
.dashboard-view { flex: 1; overflow-y: auto; padding: 22px 24px 40px; display: flex; flex-direction: column; gap: 20px; }

/* Bandeau de statut global (section 6) */
.global-status-banner {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 20px;
  background: var(--panel);
}
.global-status-main { display: flex; align-items: center; gap: 14px; }
.global-status-icon {
  width: 40px; height: 40px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; font-weight: 700; flex-shrink: 0;
  background: var(--text-muted); color: var(--bg);
}
.global-status-label { font-size: 18px; font-weight: 700; font-family: "Space Grotesk", sans-serif; }
.global-status-sub { font-size: 12px; color: var(--text-muted); }

.status-healthy .global-status-icon { background: var(--online); }
.status-healthy { border-color: var(--online); background: var(--online-dim); }
.status-warning .global-status-icon { background: var(--warn); }
.status-warning { border-color: var(--warn); background: var(--warn-dim); }
.status-critical .global-status-icon { background: var(--down); }
.status-critical { border-color: var(--down); background: var(--down-dim); }

.global-status-reasons { margin: 12px 0 0; padding-left: 18px; font-size: 13px; color: var(--text); }
.global-status-reasons-empty { list-style: none; padding-left: 0; color: var(--text-muted); margin-top: 8px; }

.dash-section h2 {
  font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--text-muted); margin: 0 0 10px;
}

.dash-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.dash-col { min-width: 0; }
@media (max-width: 860px) { .dash-cols { grid-template-columns: 1fr; } }

/* .system-grid / .metric-card / .bar / .bar-fill : classes globales déjà
   définies dans style.css et utilisées par SystemView.vue — réutilisées
   telles quelles ici, aucune redéfinition. */

.overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 10px; }
.overview-item {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 8px;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
}
.overview-value { font-size: 20px; font-weight: 700; font-family: "JetBrains Mono", monospace; }
.overview-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.overview-item.ok .overview-value { color: var(--online); }
.overview-item.warn .overview-value { color: var(--warn); }
.overview-item.danger .overview-value { color: var(--down); }

.dash-empty, .dash-empty-inline { color: var(--text-muted); font-size: 13px; }
.dash-empty { padding: 16px 4px; }

/* Tableau des process (section 5) */
.dash-table-wrap { overflow-x: auto; }
.dash-table { width: 100%; border-collapse: collapse; font-size: 13px; font-family: "JetBrains Mono", monospace; }
.dash-table th {
  text-align: left; font-family: "Space Grotesk", sans-serif; font-weight: 600;
  color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 8px 10px; border-bottom: 1px solid var(--border);
}
.dash-table td { padding: 9px 10px; border-bottom: 1px solid var(--border); }
.dash-table-row { cursor: pointer; }
.dash-table-row:hover { background: var(--accent-dim); }
.dash-table-name { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--text); }

.health-badge {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border);
}
.health-up { color: var(--online); border-color: var(--online); }
.health-down { color: var(--down); border-color: var(--down); }
.health-degraded, .health-unknown { color: var(--warn); border-color: var(--warn); }

/* Timeline (section 7) — mêmes classes que EventsView.vue */
.dash-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dash-timeline-row {
  display: flex; align-items: center; gap: 10px; padding: 9px 6px;
  border-bottom: 1px solid var(--border); font-size: 13px; font-family: "JetBrains Mono", monospace;
}
.dash-timeline-row:last-child { border-bottom: none; }
.event-icon { font-size: 13px; line-height: 1; }
.event-time { color: var(--text-muted); min-width: 68px; }
.event-process { color: var(--text); font-weight: 600; min-width: 110px; }
.event-type { color: var(--text-muted); flex: 1; }
.event-badge {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border);
}
.badge-info { color: var(--text-muted); }
.badge-warning { color: var(--warn); border-color: var(--warn); }
.badge-critical { color: var(--down); border-color: var(--down); }
</style>
