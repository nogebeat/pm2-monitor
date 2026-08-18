<script setup>
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { state, loadEvents, setEventsFilter, loadMoreEvents } from "../store";
import { time } from "../format";

const { t, locale } = useI18n();

const FILTERS = computed(() => [
  { key: "all", label: t("events.filterAll") },
  { key: "started", label: t("events.filterStarts") },
  { key: "stopped", label: t("events.filterStops") },
  { key: "restarted", label: t("events.filterRestarts") },
  { key: "crashed", label: t("events.filterCrashes") },
  { key: "errored", label: t("events.filterErrors") },
]);

const ICONS = {
  started: "🟢",
  online: "🟢",
  stopped: "⏹️",
  offline: "⚫",
  restarted: "🔄",
  crashed: "🔴",
  errored: "⚠️",
};

const LABELS = {
  started: "started",
  online: "online",
  stopped: "stopped",
  offline: "offline",
  restarted: "restarted",
  crashed: "crashed",
  errored: "error",
};

function dateLabel(ts) {
  if (!ts) return "–";
  return new Date(ts).toLocaleDateString(locale.value === "fr" ? "fr-FR" : "en-US", { day: "2-digit", month: "2-digit", year: "numeric" });
}

onMounted(() => {
  if (!state.events.loaded) loadEvents();
});
</script>

<template>
  <main class="events-view">
    <div class="chart-panel events-panel">
      <div class="chart-head">
        <h2>{{ t("events.title") }}</h2>
        <div class="filter-group" role="group" :aria-label="t('events.filterLabel')">
          <button
            v-for="f in FILTERS"
            :key="f.key"
            class="filter-btn"
            :class="{ active: state.events.filter === f.key }"
            @click="setEventsFilter(f.key)"
          >
            {{ f.label }}
          </button>
        </div>
      </div>

      <div v-if="!state.events.loaded && state.events.loading" class="events-empty">{{ t("events.loading") }}</div>

      <div v-else-if="!state.events.items.length" class="events-empty">
        {{ state.events.filter !== "all" ? t("events.noneWithFilter") : t("events.none") }}
      </div>

      <ul v-else class="events-list">
        <li v-for="ev in state.events.items" :key="ev.id" class="event-row" :class="`severity-${ev.severity}`">
          <span class="event-icon" aria-hidden="true">{{ ICONS[ev.type] || "•" }}</span>
          <span class="event-time" :title="dateLabel(ev.timestamp)">{{ time(ev.timestamp) }}</span>
          <span class="event-process">{{ ev.process || t("events.unknown") }}</span>
          <span class="event-type">{{ LABELS[ev.type] || ev.type }}</span>
          <span v-if="ev.exitCode !== null && ev.exitCode !== undefined" class="event-detail">
            exit {{ ev.exitCode }}<template v-if="ev.signal"> ({{ ev.signal }})</template>
          </span>
          <span v-else-if="ev.signal" class="event-detail">{{ ev.signal }}</span>
          <span class="event-badge" :class="`badge-${ev.severity}`">{{ ev.severity }}</span>
        </li>
      </ul>

      <div v-if="state.events.items.length && state.events.items.length < state.events.total" class="events-more">
        <button class="filter-btn" :disabled="state.events.loading" @click="loadMoreEvents">
          {{ state.events.loading ? t("events.loadingMore") : t("events.loadMore", { loaded: state.events.items.length, total: state.events.total }) }}
        </button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.events-view { flex: 1; overflow-y: auto; padding: 22px 24px 40px; }
.events-panel { max-width: 900px; margin: 0 auto; }

.events-empty {
  padding: 32px 8px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.events-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }

.event-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 6px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-family: "JetBrains Mono", monospace;
}
.event-row:last-child { border-bottom: none; }

.event-icon { font-size: 13px; line-height: 1; }
.event-time { color: var(--text-muted); min-width: 68px; }
.event-process { color: var(--text); font-weight: 600; min-width: 110px; }
.event-type { color: var(--text-muted); flex: 1; }
.event-detail { color: var(--text-muted); font-size: 12px; }

.event-badge {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
}
.badge-info { color: var(--text-muted); }
.badge-warning { color: var(--warn); border-color: var(--warn); }
.badge-critical { color: var(--down); border-color: var(--down); }

.severity-critical .event-process { color: var(--down); }

.events-more { display: flex; justify-content: center; padding-top: 14px; }
</style>
