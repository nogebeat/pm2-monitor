<script setup>
import { computed } from "vue";
import { state, selectProcess, runProcessAction, can } from "../store";
import { apiPost } from "../api";
import { notifyError } from "../store";
import { fmtMem, fmtUptime } from "../format";

const props = defineProps({
  process: { type: Object, required: true },
});

const isActive = computed(() => state.selected === props.process.id);
const errCount = computed(() => state.errCounts[props.process.id] || 0);

const bars = computed(() => {
  const hist = state.cpuHistory[props.process.id] || [];
  const maxCpu = Math.max(10, ...hist);
  return hist.map((v) => Math.max(6, (v / maxCpu) * 100));
});

function select() {
  selectProcess(props.process.id);
}

function quickAction(action) {
  if (action === "reload") {
    return apiPost(`/api/processes/${props.process.id}/reload`).catch(notifyError);
  }
  runProcessAction(props.process.id, action);
}

function openMore() {
  state.modal = { type: "more", process: props.process };
}

const canAny = (...actions) => actions.some((a) => can(a, props.process.name));
</script>

<template>
  <div class="proc-card" :class="{ active: isActive }" @click="select">
    <div class="proc-card-top">
      <div class="proc-name">
        <span class="status-dot" :class="`status-${process.status}`"></span>
        <span class="label">{{ process.name }}</span>
      </div>
      <div style="display:flex; align-items:center; gap:6px;">
        <span v-if="errCount" class="err-badge">{{ errCount }}</span>
        <span class="proc-id">#{{ process.id }}</span>
      </div>
    </div>

    <div class="proc-meta">
      <span>CPU <b>{{ process.cpu }}%</b></span>
      <span>MEM <b>{{ fmtMem(process.memory) }}</b></span>
      <span>↻ <b>{{ process.restarts }}</b></span>
      <span>{{ fmtUptime(process.uptime) }}</span>
      <span>{{ process.execMode }}{{ process.instances > 1 ? " x" + process.instances : "" }}</span>
      <span v-if="process.watching" title="watch actif">👁</span>
    </div>

    <div class="vitals">
      <span v-for="(h, i) in bars" :key="i" :style="{ height: h + '%' }"></span>
    </div>

    <div class="proc-actions">
      <button v-if="can('start', process.name)" class="go" @click.stop="quickAction('start')">Start</button>
      <button v-if="can('restart', process.name)" @click.stop="quickAction('restart')">Restart</button>
      <button v-if="can('reload', process.name)" @click.stop="quickAction('reload')">Reload</button>
      <button v-if="can('stop', process.name)" class="danger" @click.stop="quickAction('stop')">Stop</button>
      <button
        v-if="canAny('scale', 'watch', 'env', 'config', 'flush', 'reset', 'delete')"
        class="more"
        @click.stop="openMore"
      >
        ⋯ Plus
      </button>
    </div>
  </div>
</template>
