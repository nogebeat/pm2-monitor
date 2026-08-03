const socket = io();

const state = {
  processes: [],
  selected: null, // pm_id
  filter: "all",
  levelFilter: "all",
  search: "",
  regexMode: false,
  ansiOn: true,
  lineNumOn: false,
  history: {}, // pm_id -> [cpu samples] (mini sparkline dans la sidebar)
  errCounts: {}, // pm_id -> nombre d'erreurs non vues
  autoscroll: true,
  paused: false,
  pausedQueue: [],
  lineCounter: 0,
  view: "process",
  historyRange: "1h",
};

const els = {
  list: document.getElementById("process-list"),
  logsBody: document.getElementById("logs-body"),
  logsTitle: document.getElementById("logs-title"),
  logsSub: document.getElementById("logs-sub"),
  conn: document.getElementById("conn-indicator"),
  statTotal: document.getElementById("stat-total"),
  statOnline: document.getElementById("stat-online"),
  statDown: document.getElementById("stat-down"),
  clearLogs: document.getElementById("clear-logs"),
  autoscroll: document.getElementById("autoscroll"),
  themeToggle: document.getElementById("theme-toggle"),
  search: document.getElementById("log-search"),
  regex: document.getElementById("log-regex"),
  level: document.getElementById("log-level"),
  ansi: document.getElementById("log-ansi"),
  linenum: document.getElementById("log-linenum"),
  pauseBtn: document.getElementById("pause-logs"),
  exportBtn: document.getElementById("export-logs"),
  exportType: document.getElementById("export-type"),
  logsStats: document.getElementById("logs-stats"),
  pm2MenuBtn: document.getElementById("pm2-menu-btn"),
  pm2Menu: document.getElementById("pm2-menu"),
  modalOverlay: document.getElementById("modal-overlay"),
  modalTitle: document.getElementById("modal-title"),
  modalBody: document.getElementById("modal-body"),
  modalClose: document.getElementById("modal-close"),
  modalCancel: document.getElementById("modal-cancel"),
  modalConfirm: document.getElementById("modal-confirm"),
  viewProcess: document.getElementById("view-process"),
  viewSystem: document.getElementById("view-system"),
  openFulltext: document.getElementById("open-fulltext"),
  openGotoDate: document.getElementById("open-goto-date"),
  openExportRange: document.getElementById("open-export-range"),
};

// ---------- Connexion ----------

socket.on("connect", () => {
  els.conn.className = "conn is-connected";
  els.conn.querySelector(".conn-label").textContent = "connecté";
});

socket.on("disconnect", () => {
  els.conn.className = "conn is-disconnected";
  els.conn.querySelector(".conn-label").textContent = "déconnecté";
});

// ---------- Helpers réseau ----------

function apiPost(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || `Erreur HTTP ${r.status}`);
      return data;
    });
}

function apiGet(url) {
  return fetch(url).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || `Erreur HTTP ${r.status}`);
    return data;
  });
}

function notifyError(err) {
  alert("Erreur : " + (err && err.message ? err.message : err));
}

// ---------- Onglets Process / Système ----------

document.querySelectorAll(".view-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.view = tab.dataset.view;
    els.viewProcess.hidden = state.view !== "process";
    els.viewSystem.hidden = state.view !== "system";
    if (state.view === "system") loadHistoryChart();
  });
});

// ---------- Menu global PM2 ----------

els.pm2MenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  els.pm2Menu.hidden = !els.pm2Menu.hidden;
});

document.addEventListener("click", () => {
  els.pm2Menu.hidden = true;
});

els.pm2Menu.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.pm2Menu.hidden = true;
    const action = btn.dataset.pm2action;
    runGlobalAction(action);
  });
});

function runGlobalAction(action) {
  const routes = {
    save: { url: "/api/pm2/save", confirm: null },
    resurrect: { url: "/api/pm2/resurrect", confirm: null },
    "flush-all": { url: "/api/pm2/flush-all", confirm: "Vider TOUS les logs de TOUS les process ?" },
    update: { url: "/api/pm2/update", confirm: "Mettre à jour le daemon PM2 (pm2 update) ?" },
    kill: { url: "/api/pm2/kill", confirm: "⚠️ Ceci va tuer le daemon PM2. Les apps managées perdront leur supervision. Continuer ?" },
  };
  const r = routes[action];
  if (!r) return;
  if (r.confirm && !confirm(r.confirm)) return;
  apiPost(r.url).catch(notifyError);
}

// ---------- Liste des process ----------

socket.on("processes", (list) => {
  state.processes = list;

  list.forEach((p) => {
    if (!state.history[p.id]) state.history[p.id] = [];
    state.history[p.id].push(p.cpu);
    if (state.history[p.id].length > 20) state.history[p.id].shift();
  });

  renderList();
  renderStats();
  if (state.selected !== null) renderLogsHead();
});

function renderStats() {
  const online = state.processes.filter((p) => p.status === "online").length;
  const down = state.processes.filter((p) => p.status !== "online").length;
  els.statTotal.textContent = state.processes.length;
  els.statOnline.textContent = online;
  els.statDown.textContent = down;
}

function fmtMem(bytes) {
  if (!bytes) return "0 Mo";
  return (bytes / 1024 / 1024).toFixed(1) + " Mo";
}

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return "–";
  if (bytes < 1024) return bytes + " o";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " Ko";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " Mo";
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " Go";
}

function fmtRate(bytesPerSec) {
  return fmtBytes(bytesPerSec) + "/s";
}

function fmtUptime(ts) {
  if (!ts) return "–";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "j";
}

function renderList() {
  if (state.processes.length === 0) {
    els.list.innerHTML = '<div class="empty-state">Aucun process PM2 trouvé.</div>';
    return;
  }

  els.list.innerHTML = "";
  state.processes.forEach((p) => {
    const card = document.createElement("div");
    card.className = "proc-card" + (state.selected === p.id ? " active" : "");
    card.dataset.id = p.id;

    const hist = state.history[p.id] || [];
    const maxCpu = Math.max(10, ...hist);
    const bars = hist
      .map((v) => `<span style="height:${Math.max(6, (v / maxCpu) * 100)}%"></span>`)
      .join("");

    card.innerHTML = `
      <div class="proc-card-top">
        <div class="proc-name">
          <span class="status-dot status-${p.status}"></span>
          <span class="label">${escapeHtml(p.name)}</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          ${state.errCounts[p.id] ? `<span class="err-badge">${state.errCounts[p.id]}</span>` : ""}
          <span class="proc-id">#${p.id}</span>
        </div>
      </div>
      <div class="proc-meta">
        <span>CPU <b>${p.cpu}%</b></span>
        <span>MEM <b>${fmtMem(p.memory)}</b></span>
        <span>↻ <b>${p.restarts}</b></span>
        <span>${fmtUptime(p.uptime)}</span>
        <span>${escapeHtml(p.execMode)}${p.instances > 1 ? " x" + p.instances : ""}</span>
        ${p.watching ? '<span title="watch actif">👁</span>' : ""}
      </div>
      <div class="vitals">${bars}</div>
      <div class="proc-actions">
        <button class="go" data-action="start">Start</button>
        <button data-action="restart">Restart</button>
        <button data-action="reload">Reload</button>
        <button class="danger" data-action="stop">Stop</button>
        <button class="more" data-action="more">⋯ Plus</button>
      </div>
    `;

    card.addEventListener("click", (e) => {
      if (e.target.tagName === "BUTTON") return;
      selectProcess(p.id);
    });

    card.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === "more") return openMoreMenu(p);
        if (action === "reload") return apiPost(`/api/processes/${p.id}/reload`).catch(notifyError);
        callAction(p.id, action);
      });
    });

    els.list.appendChild(card);
  });
}

function callAction(id, action) {
  fetch(`/api/processes/${id}/${action}`, { method: "POST" }).catch(() => {});
}

function selectProcess(id) {
  state.selected = id;
  state.errCounts[id] = 0;
  state.lineCounter = 0;
  state.paused = false;
  state.pausedQueue = [];
  updatePauseUi();
  els.logsBody.innerHTML = "";
  renderList();
  renderLogsHead();
  loadLogsStats();
}

function renderLogsHead() {
  const p = state.processes.find((x) => x.id === state.selected);
  if (!p) return;
  els.logsTitle.textContent = p.name;
  els.logsSub.textContent = `#${p.id} · ${p.status} · pid ${p.pid || "–"}`;
}

function loadLogsStats() {
  if (state.selected === null) return;
  apiGet(`/api/processes/${state.selected}/logs/stats`)
    .then((s) => {
      els.logsStats.textContent = `${s.files} fichier(s) · ${s.archivedFiles} compressé(s) · ${fmtBytes(s.totalBytes)}`;
    })
    .catch(() => {
      els.logsStats.textContent = "";
    });
}

// ---------- Actions étendues par process (modal "Plus") ----------

function openMoreMenu(p) {
  const body = `
    <div class="hint-text">Actions rapides pour <b>${escapeHtml(p.name)}</b> (#${p.id})</div>
    <div style="display:flex; flex-direction:column; gap:6px; margin-top:12px;">
      <button class="icon-btn" data-more="scale">📈 Scale (instances actuelles : ${p.instances})</button>
      <button class="icon-btn" data-more="watch">👁 Watch ${p.watching ? "OFF" : "ON"}</button>
      <button class="icon-btn" data-more="env">🔧 Modifier les variables d'environnement</button>
      <button class="icon-btn" data-more="config">⚙️ Modifier script / arguments / mode</button>
      <button class="icon-btn" data-more="flush">🧹 Flush les logs de cette app</button>
      <button class="icon-btn" data-more="reset">↺ Réinitialiser le compteur de restarts</button>
      <button class="icon-btn" style="color:var(--down); border-color:var(--down);" data-more="delete">🗑 Supprimer le process</button>
    </div>
  `;
  openModal(`Actions — ${p.name}`, body, null, { hideConfirm: true });

  els.modalBody.querySelectorAll("[data-more]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.more;
      closeModal();
      handleMoreAction(p, action);
    });
  });
}

function handleMoreAction(p, action) {
  if (action === "scale") return openScaleModal(p);
  if (action === "watch") return apiPost(`/api/processes/${p.id}/watch`, { enable: !p.watching }).catch(notifyError);
  if (action === "env") return openEnvModal(p);
  if (action === "config") return openConfigModal(p);
  if (action === "flush") {
    if (!confirm(`Vider les logs de "${p.name}" ?`)) return;
    return apiPost(`/api/processes/${p.id}/flush`).then(loadLogsStats).catch(notifyError);
  }
  if (action === "reset") {
    return apiPost(`/api/processes/${p.id}/reset`).catch(notifyError);
  }
  if (action === "delete") {
    if (!confirm(`Supprimer définitivement "${p.name}" de PM2 ?`)) return;
    return apiPost(`/api/processes/${p.id}/delete`).catch(notifyError);
  }
}

function openScaleModal(p) {
  const body = `
    <label>Nombre d'instances</label>
    <input type="number" id="scale-input" min="1" max="64" value="${p.instances || 1}" />
    <p class="hint-text">Uniquement pertinent en mode cluster.</p>
  `;
  openModal(`Scale — ${p.name}`, body, () => {
    const n = document.getElementById("scale-input").value;
    return apiPost(`/api/processes/${p.id}/scale`, { instances: n });
  });
}

function openEnvModal(p) {
  const entries = Object.entries(p.env || {}).filter(([k]) => !/^(npm_|PATH$|PM2_)/.test(k));
  const rowsHtml = (entries.length ? entries : [["", ""]])
    .map(
      ([k, v]) => `
      <div class="env-row">
        <input type="text" placeholder="CLÉ" class="env-key" value="${escapeAttr(k)}" />
        <input type="text" placeholder="valeur" class="env-val" value="${escapeAttr(v)}" />
        <button type="button" class="env-remove">✕</button>
      </div>`
    )
    .join("");

  const body = `
    <p class="hint-text">Ces variables seront appliquées au redémarrage du process (pm2 restart --update-env).</p>
    <div id="env-rows">${rowsHtml}</div>
    <button type="button" class="icon-btn" id="env-add" style="margin-top:6px;">+ Ajouter une variable</button>
  `;
  openModal(`Variables d'environnement — ${p.name}`, body, () => {
    const env = {};
    document.querySelectorAll("#env-rows .env-row").forEach((row) => {
      const k = row.querySelector(".env-key").value.trim();
      const v = row.querySelector(".env-val").value;
      if (k) env[k] = v;
    });
    return apiPost(`/api/processes/${p.id}/env`, { env });
  });

  document.getElementById("env-add").addEventListener("click", () => {
    const div = document.createElement("div");
    div.className = "env-row";
    div.innerHTML = `
      <input type="text" placeholder="CLÉ" class="env-key" />
      <input type="text" placeholder="valeur" class="env-val" />
      <button type="button" class="env-remove">✕</button>
    `;
    document.getElementById("env-rows").appendChild(div);
    wireEnvRemove(div);
  });
  document.querySelectorAll("#env-rows .env-row").forEach(wireEnvRemove);
}

function wireEnvRemove(row) {
  row.querySelector(".env-remove").addEventListener("click", () => row.remove());
}

function openConfigModal(p) {
  const body = `
    <p class="hint-text">⚠️ Ceci supprime puis relance le process avec la nouvelle configuration (équivalent à pm2 delete + pm2 start).</p>
    <label>Script</label>
    <input type="text" id="cfg-script" value="${escapeAttr(p.script || "")}" />
    <label>Arguments (séparés par des espaces)</label>
    <input type="text" id="cfg-args" value="${escapeAttr((p.args || []).join(" "))}" />
    <label>Mode d'exécution</label>
    <select id="cfg-mode">
      <option value="fork" ${p.execMode === "fork_mode" || p.execMode === "fork" ? "selected" : ""}>fork</option>
      <option value="cluster" ${p.execMode === "cluster_mode" || p.execMode === "cluster" ? "selected" : ""}>cluster</option>
    </select>
    <label>Instances</label>
    <input type="number" id="cfg-instances" min="1" max="64" value="${p.instances || 1}" />
  `;
  openModal(`Configuration — ${p.name}`, body, () => {
    const script = document.getElementById("cfg-script").value.trim();
    const args = document.getElementById("cfg-args").value.trim().split(/\s+/).filter(Boolean);
    const execMode = document.getElementById("cfg-mode").value;
    const instances = document.getElementById("cfg-instances").value;
    return apiPost(`/api/processes/${p.id}/config`, { script, args, execMode, instances });
  });
}

// ---------- Modal générique ----------

let modalConfirmHandler = null;

function openModal(title, bodyHtml, onConfirm, opts = {}) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = bodyHtml;
  els.modalOverlay.hidden = false;
  els.modalConfirm.style.display = opts.hideConfirm ? "none" : "";
  modalConfirmHandler = onConfirm;
}

function closeModal() {
  els.modalOverlay.hidden = true;
  els.modalBody.innerHTML = "";
  modalConfirmHandler = null;
}

els.modalClose.addEventListener("click", closeModal);
els.modalCancel.addEventListener("click", closeModal);
els.modalOverlay.addEventListener("click", (e) => {
  if (e.target === els.modalOverlay) closeModal();
});

els.modalConfirm.addEventListener("click", () => {
  if (!modalConfirmHandler) return closeModal();
  Promise.resolve(modalConfirmHandler())
    .then(() => closeModal())
    .catch((err) => notifyError(err));
});

// ---------- Logs ----------

socket.on("log", (entry) => {
  const p = state.processes.find((x) => x.id === entry.pm_id);
  if (!p) return;

  if (entry.type === "err" && state.selected !== entry.pm_id) {
    state.errCounts[entry.pm_id] = (state.errCounts[entry.pm_id] || 0) + 1;
    renderList();
  }

  if (state.selected !== entry.pm_id) return;

  if (state.paused) {
    state.pausedQueue.push(entry);
    updatePauseUi();
    return;
  }

  if (!passesFilters(entry)) return;
  appendLog(entry);
});

socket.on("event", (entry) => {
  if (state.selected !== entry.pm_id) return;
  const line = document.createElement("div");
  line.className = "log-line";
  line.innerHTML = `<span class="log-time">${time(entry.at)}</span><span class="log-event">— ${escapeHtml(entry.event)} —</span>`;
  els.logsBody.appendChild(line);
  scrollMaybe();
});

function passesFilters(entry) {
  if (state.filter !== "all" && state.filter !== entry.type) return false;
  if (state.levelFilter !== "all" && entry.level && state.levelFilter !== entry.level) return false;
  if (state.search) {
    if (state.regexMode) {
      try {
        const re = new RegExp(state.search, "i");
        if (!re.test(entry.data)) return false;
      } catch (e) {
        /* regex invalide : on n'exclut rien */
      }
    } else if (!entry.data.toLowerCase().includes(state.search)) {
      return false;
    }
  }
  return true;
}

function appendLog(entry) {
  if (els.logsBody.querySelector(".empty-state")) els.logsBody.innerHTML = "";
  state.lineCounter++;
  const line = document.createElement("div");
  line.className = "log-line";
  line.dataset.text = entry.data.toLowerCase();

  const lineNumHtml = state.lineNumOn ? `<span class="log-line-num">${state.lineCounter}</span>` : "";
  const textHtml = state.ansiOn ? ansiToHtml(escapeHtml(entry.data).trimEnd()) : escapeHtml(entry.data).trimEnd();
  const levelBadge = entry.level && entry.level !== "info" ? `<span class="log-tag ${entry.level}">${entry.level}</span>` : "";

  line.innerHTML = `
    ${lineNumHtml}
    <span class="log-time">${time(entry.at)}</span>
    <span class="log-tag ${entry.type}">${entry.type}</span>
    ${levelBadge}
    <span class="log-text ${entry.type === "err" ? "err" : ""}">${textHtml}</span>
    <button class="log-copy" title="Copier la ligne">⧉</button>
  `;
  line.querySelector(".log-copy").addEventListener("click", () => {
    navigator.clipboard?.writeText(entry.data.trim()).catch(() => {});
  });

  els.logsBody.appendChild(line);
  scrollMaybe();
}

// ---------- Coloration ANSI ----------

const ANSI_FG = {
  30: "#5c6570", 31: "#e85d5d", 32: "#4fd68c", 33: "#e0a64f",
  34: "#5fa8d3", 35: "#c17fd6", 36: "#4fc2d6", 37: "#e4e9ea",
  90: "#7c8a8f", 91: "#f0a3a3", 92: "#8fe3b6", 93: "#eec688",
  94: "#8fc4e6", 95: "#d6adea", 96: "#8fdcea", 97: "#ffffff",
};

function ansiToHtml(escapedText) {
  // escapedText est déjà passé par escapeHtml() : les codes ESC[...m restent intacts (pas de < > &)
  const ESC = /\x1b\[([0-9;]*)m/g;
  let result = "";
  let openSpan = false;
  let lastIndex = 0;
  let match;

  while ((match = ESC.exec(escapedText)) !== null) {
    result += escapedText.slice(lastIndex, match.index);
    lastIndex = ESC.lastIndex;

    const codes = match[1].split(";").filter(Boolean).map(Number);
    if (!codes.length || codes.includes(0)) {
      if (openSpan) result += "</span>";
      openSpan = false;
      continue;
    }
    const fg = codes.find((c) => ANSI_FG[c]);
    const bold = codes.includes(1);
    if (fg || bold) {
      if (openSpan) result += "</span>";
      const style = [fg ? `color:${ANSI_FG[fg]}` : "", bold ? "font-weight:600" : ""].filter(Boolean).join(";");
      result += `<span style="${style}">`;
      openSpan = true;
    }
  }
  result += escapedText.slice(lastIndex);
  if (openSpan) result += "</span>";
  return result;
}

function scrollMaybe() {
  if (!state.autoscroll) return;
  els.logsBody.scrollTop = els.logsBody.scrollHeight;
}

function time(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("fr-FR", { hour12: false });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

// ---------- Pause du flux ----------

els.pauseBtn.addEventListener("click", () => {
  state.paused = !state.paused;
  if (!state.paused) {
    // on rejoue la file d'attente
    state.pausedQueue.forEach((entry) => {
      if (passesFilters(entry)) appendLog(entry);
    });
    state.pausedQueue = [];
  }
  updatePauseUi();
});

function updatePauseUi() {
  if (state.paused) {
    els.pauseBtn.textContent = `▶ Reprendre (${state.pausedQueue.length})`;
  } else {
    els.pauseBtn.textContent = "⏸ Pause";
  }
}

// ---------- Contrôles UI logs ----------

document.querySelectorAll(".filter-btn[data-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn[data-filter]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.filter = btn.dataset.filter;
  });
});

els.level.addEventListener("change", (e) => {
  state.levelFilter = e.target.value;
});

els.regex.addEventListener("change", (e) => {
  state.regexMode = e.target.checked;
});

els.ansi.addEventListener("change", (e) => {
  state.ansiOn = e.target.checked;
});

els.linenum.addEventListener("change", (e) => {
  state.lineNumOn = e.target.checked;
});

els.clearLogs.addEventListener("click", () => {
  els.logsBody.innerHTML = '<div class="empty-state">En attente de logs…</div>';
  state.lineCounter = 0;
});

els.autoscroll.addEventListener("change", (e) => {
  state.autoscroll = e.target.checked;
});

// ---------- Thème clair / sombre ----------

els.themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("pm2-monitor-theme", next);
  if (state.view === "system") setTimeout(loadHistoryChart, 50);
});

// ---------- Recherche live (client) ----------

let searchDebounce;
els.search.addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.search = state.regexMode ? e.target.value.trim() : e.target.value.trim().toLowerCase();
    applyLiveFilters();
  }, 120);
});

els.level.addEventListener("change", applyLiveFilters);
document.querySelectorAll(".filter-btn[data-filter]").forEach((btn) => btn.addEventListener("click", applyLiveFilters));

function applyLiveFilters() {
  els.logsBody.querySelectorAll(".log-line").forEach((line) => {
    if (!line.dataset.text) return; // ligne d'événement, toujours visible
    let visible = true;
    if (state.search) {
      if (state.regexMode) {
        try {
          visible = new RegExp(state.search, "i").test(line.dataset.text);
        } catch (e) {
          visible = true;
        }
      } else {
        visible = line.dataset.text.includes(state.search);
      }
    }
    line.classList.toggle("log-hidden", !visible);
  });
}

// ---------- Export des logs (brut PM2) ----------

els.exportBtn.addEventListener("click", () => {
  if (state.selected === null) {
    alert("Sélectionne d'abord une app dans la liste.");
    return;
  }
  const type = els.exportType.value;
  window.open(`/api/processes/${state.selected}/logs/export?type=${type}`, "_blank");
});

// ---------- Recherche plein texte (fichier complet, côté serveur) ----------

els.openFulltext.addEventListener("click", () => {
  if (state.selected === null) return alert("Sélectionne d'abord une app.");
  const body = `
    <label>Recherche</label>
    <input type="text" id="ft-query" placeholder="texte ou regex…" />
    <label class="chk-inline" style="margin-top:8px;"><input type="checkbox" id="ft-regex" /> Regex</label>
    <label>Niveau</label>
    <select id="ft-level">
      <option value="all">tous</option>
      <option value="info">info</option>
      <option value="warn">warn</option>
      <option value="error">error</option>
      <option value="debug">debug</option>
    </select>
    <div id="ft-results" class="search-results"></div>
  `;
  openModal("Recherche complète dans les logs", body, null, { hideConfirm: true });

  const run = () => {
    const q = document.getElementById("ft-query").value.trim();
    const regex = document.getElementById("ft-regex").checked ? "1" : "0";
    const level = document.getElementById("ft-level").value;
    const results = document.getElementById("ft-results");
    if (!q) {
      results.innerHTML = "";
      return;
    }
    results.innerHTML = '<div class="hint-text">Recherche…</div>';
    apiGet(`/api/processes/${state.selected}/logs/search?q=${encodeURIComponent(q)}&regex=${regex}&level=${level}&limit=200`)
      .then((r) => {
        if (!r.results.length) {
          results.innerHTML = '<div class="hint-text">Aucun résultat.</div>';
          return;
        }
        results.innerHTML = r.results
          .map(
            (row) =>
              `<div class="search-result-line">#${row.line} · ${new Date(row.t).toLocaleString("fr-FR")} [${row.type}/${row.level}]<br>${escapeHtml(row.text)}</div>`
          )
          .join("") + (r.truncated ? `<div class="hint-text">… ${r.total} résultats au total, affichage limité.</div>` : "");
      })
      .catch((err) => {
        results.innerHTML = `<div class="hint-text">Erreur : ${escapeHtml(err.message)}</div>`;
      });
  };

  let debounce;
  document.getElementById("ft-query").addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(run, 200);
  });
  document.getElementById("ft-regex").addEventListener("change", run);
  document.getElementById("ft-level").addEventListener("change", run);
});

// ---------- Aller à une date ----------

els.openGotoDate.addEventListener("click", () => {
  if (state.selected === null) return alert("Sélectionne d'abord une app.");
  const body = `
    <label>Date et heure</label>
    <input type="datetime-local" id="goto-date" />
    <div id="goto-results" class="search-results"></div>
  `;
  openModal("Aller à une date", body, null, { hideConfirm: true });

  document.getElementById("goto-date").addEventListener("change", (e) => {
    const ts = new Date(e.target.value).getTime();
    if (Number.isNaN(ts)) return;
    const results = document.getElementById("goto-results");
    results.innerHTML = '<div class="hint-text">Recherche…</div>';
    apiGet(`/api/processes/${state.selected}/logs/search?from=${ts}&limit=50`)
      .then((r) => {
        if (!r.results.length) {
          results.innerHTML = '<div class="hint-text">Rien trouvé après cette date.</div>';
          return;
        }
        results.innerHTML = r.results
          .map(
            (row) =>
              `<div class="search-result-line">${new Date(row.t).toLocaleString("fr-FR")} [${row.type}]<br>${escapeHtml(row.text)}</div>`
          )
          .join("");
      })
      .catch((err) => {
        results.innerHTML = `<div class="hint-text">Erreur : ${escapeHtml(err.message)}</div>`;
      });
  });
});

// ---------- Exporter une période précise ----------

els.openExportRange.addEventListener("click", () => {
  if (state.selected === null) return alert("Sélectionne d'abord une app.");
  const body = `
    <label>Depuis</label>
    <input type="datetime-local" id="range-from" />
    <label>Jusqu'à</label>
    <input type="datetime-local" id="range-to" />
    <label>Flux</label>
    <select id="range-type">
      <option value="all">tout</option>
      <option value="out">stdout</option>
      <option value="err">stderr</option>
    </select>
  `;
  openModal("Exporter une période précise", body, () => {
    const from = document.getElementById("range-from").value;
    const to = document.getElementById("range-to").value;
    const type = document.getElementById("range-type").value;
    const fromTs = from ? new Date(from).getTime() : 0;
    const toTs = to ? new Date(to).getTime() : Date.now();
    window.open(
      `/api/processes/${state.selected}/logs/export-range?from=${fromTs}&to=${toTs}&type=${type}`,
      "_blank"
    );
    return Promise.resolve();
  });
});

// ---------- Vue Système : métriques temps réel ----------

socket.on("system", (snap) => {
  if (state.view !== "system") return;
  renderSystemMetrics(snap);
});

function renderSystemMetrics(snap) {
  document.getElementById("m-load1").textContent = snap.load ? snap.load["1m"].toFixed(2) : "–";
  document.getElementById("m-load-sub").textContent = snap.load
    ? `${snap.load["1m"].toFixed(2)} / ${snap.load["5m"].toFixed(2)} / ${snap.load["15m"].toFixed(2)} · ${snap.load.cores} cœurs`
    : "–";

  if (snap.mem) {
    document.getElementById("m-mem").textContent = `${snap.mem.percent}%`;
    document.getElementById("m-mem-bar").style.width = snap.mem.percent + "%";
  }

  if (snap.swap) {
    document.getElementById("m-swap").textContent = snap.swap.total ? `${snap.swap.percent}%` : "aucun swap";
    document.getElementById("m-swap-bar").style.width = snap.swap.percent + "%";
  }

  if (snap.disk) {
    document.getElementById("m-disk").textContent = `${snap.disk.percent}%`;
    document.getElementById("m-disk-bar").style.width = snap.disk.percent + "%";
    document.getElementById("m-disk-bar").className = "bar-fill" + (snap.disk.percent > 90 ? " danger" : snap.disk.percent > 75 ? " warn" : "");
  }

  document.getElementById("m-temp").textContent = snap.temp ? `${snap.temp.celsius}°C` : "n/d";

  if (snap.net) {
    document.getElementById("m-net").textContent = `↓ ${fmtRate(snap.net.rxRate)}`;
    document.getElementById("m-net-sub").textContent = `↑ ${fmtRate(snap.net.txRate)}`;
  }

  document.getElementById("m-procs").textContent = snap.processes ?? "–";
  document.getElementById("m-cores").textContent = snap.load ? snap.load.cores : "–";
}

// ---------- Graphiques d'historique (Chart.js) ----------

let historyChart = null;
let networkChart = null;

document.querySelectorAll(".filter-btn[data-range]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn[data-range]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.historyRange = btn.dataset.range;
    loadHistoryChart();
  });
});

function chartColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    accent: styles.getPropertyValue("--accent").trim(),
    online: styles.getPropertyValue("--online").trim(),
    warn: styles.getPropertyValue("--warn").trim(),
    text: styles.getPropertyValue("--text-muted").trim(),
    grid: styles.getPropertyValue("--border").trim(),
  };
}

function loadHistoryChart() {
  if (typeof Chart === "undefined") return; // CDN indisponible (offline) : on n'affiche pas de graphique
  apiGet(`/api/system/history?range=${state.historyRange}`)
    .then((r) => {
      const labels = r.samples.map((s) => new Date(s.t).toLocaleTimeString("fr-FR", { hour12: false }));
      const c = chartColors();

      const cpuData = r.samples.map((s) => s.cpu);
      const memData = r.samples.map((s) => s.memPercent);
      const rxData = r.samples.map((s) => (s.netRx || 0) / 1024);
      const txData = r.samples.map((s) => (s.netTx || 0) / 1024);

      const ctx1 = document.getElementById("history-chart");
      if (historyChart) historyChart.destroy();
      historyChart = new Chart(ctx1, {
        type: "line",
        data: {
          labels,
          datasets: [
            { label: "CPU %", data: cpuData, borderColor: c.accent, backgroundColor: "transparent", tension: 0.25, pointRadius: 0, borderWidth: 1.6 },
            { label: "RAM %", data: memData, borderColor: c.online, backgroundColor: "transparent", tension: 0.25, pointRadius: 0, borderWidth: 1.6 },
          ],
        },
        options: chartOptions(c, "%"),
      });

      const ctx2 = document.getElementById("network-chart");
      if (networkChart) networkChart.destroy();
      networkChart = new Chart(ctx2, {
        type: "line",
        data: {
          labels,
          datasets: [
            { label: "↓ Ko/s", data: rxData, borderColor: c.accent, backgroundColor: "transparent", tension: 0.25, pointRadius: 0, borderWidth: 1.6 },
            { label: "↑ Ko/s", data: txData, borderColor: c.warn, backgroundColor: "transparent", tension: 0.25, pointRadius: 0, borderWidth: 1.6 },
          ],
        },
        options: chartOptions(c, "Ko/s"),
      });
    })
    .catch(() => {});
}

function chartOptions(c, unitLabel) {
  return {
    responsive: true,
    animation: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { ticks: { color: c.text, maxTicksLimit: 8, font: { family: "JetBrains Mono", size: 10 } }, grid: { color: c.grid } },
      y: { ticks: { color: c.text, font: { family: "JetBrains Mono", size: 10 }, callback: (v) => v + (unitLabel === "%" ? "%" : "") }, grid: { color: c.grid } },
    },
    plugins: {
      legend: { labels: { color: c.text, font: { family: "Space Grotesk", size: 11 } } },
    },
  };
}

// ---------- Chargement initial ----------

fetch("/api/processes")
  .then((r) => r.json())
  .then((list) => {
    state.processes = list;
    renderList();
    renderStats();
  })
  .catch(() => {
    els.list.innerHTML = '<div class="empty-state">Impossible de joindre le serveur.</div>';
  });

apiGet("/api/system").then(renderSystemMetrics).catch(() => {});
