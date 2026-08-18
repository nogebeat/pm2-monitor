<script setup>
/**
 * Settings → Notifications — Providers (Phase 5C) + Routing (Phase 5D).
 *
 * Deux onglets dans la même modale :
 *  - "Providers" : configurations de providers (Discord, SMTP, Telegram,
 *    Slack, Webhook générique — Phase 5B/5C), inchangé.
 *  - "Routing" : règles de routing (`notification_routes`) qui matchent une
 *    alerte (severity/alertType/process/server/tag) et la routent vers un
 *    ou plusieurs providers, avec un template de titre/message optionnel et
 *    une option "notifier aussi à la résolution" — voir
 *    lib/services/notifications/routing/ et
 *    docs/notifications/README.md#routing-phase-5d.
 *
 * Les secrets (mot de passe SMTP, webhook URL, bot token…) ne sont jamais
 * reçus du backend en clair : seul `hasSecrets` (booléen) est renvoyé par
 * GET /api/notifications/providers. Ce composant affiche donc les champs
 * secrets vides avec un placeholder "••••••••" à l'édition ; les laisser
 * vides envoie `keepSecrets: true` (le backend conserve alors la valeur
 * déjà stockée pour ce champ précis, voir lib/routes/notifications.js).
 *
 * Note i18n : les labels de champs techniques (Host, Port, Webhook URL…)
 * restent en anglais dans les deux langues — ce sont des termes techniques
 * internationaux standards dans ce domaine (SMTP, webhooks…), cohérent
 * avec le choix fait pour les catalogues d'actions/permissions.
 */
import { reactive, ref, computed, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { state, notifyError, can } from "../../store";
import { apiGet, apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

const { t } = useI18n();

function close() {
  state.modal = null;
}

const tab = ref("providers"); // "providers" | "routing"

// ---------- Description des formulaires par type de provider ----------
// Champ : { key, label, kind, secret, placeholder, required, options }
// `secret: true` => stocké dans `secrets` (jamais renvoyé par le backend).
const FIELD_SCHEMAS = {
  email: [
    { key: "host", label: "Host", kind: "text", placeholder: "smtp.example.com", required: true },
    { key: "port", label: "Port", kind: "number", placeholder: "587", required: true },
    {
      key: "security",
      label: "Security",
      kind: "select",
      options: [
        { value: "none", label: "None" },
        { value: "starttls", label: "STARTTLS" },
        { value: "ssl_tls", label: "SSL/TLS" },
      ],
      required: true,
    },
    { key: "username", label: "Username", kind: "text", secret: true },
    { key: "password", label: "Password", kind: "password", secret: true },
    { key: "fromName", label: "From Name", kind: "text" },
    { key: "fromEmail", label: "From Email", kind: "text", placeholder: "alerts@example.com", required: true },
    { key: "to", label: "Recipients", kind: "text", placeholder: "ops@example.com, oncall@example.com" },
  ],
  discord: [
    { key: "webhookUrl", label: "Webhook URL", kind: "text", secret: true, required: true },
    { key: "username", label: "Display name (optional)", kind: "text" },
  ],
  telegram: [
    { key: "botToken", label: "Bot Token", kind: "password", secret: true, required: true },
    { key: "chatId", label: "Chat ID", kind: "text", required: true },
  ],
  slack: [
    { key: "webhookUrl", label: "Webhook URL", kind: "text", secret: true, required: true },
    { key: "channel", label: "Channel (optional)", kind: "text", placeholder: "#alerts" },
  ],
  webhook: [
    { key: "url", label: "URL", kind: "text", required: true },
    {
      key: "method",
      label: "Method",
      kind: "select",
      options: ["GET", "POST", "PUT", "PATCH"].map((m) => ({ value: m, label: m })),
    },
    { key: "headers", label: "Headers (JSON)", kind: "json", secret: true, placeholder: '{"Authorization": "Bearer …"}' },
    { key: "timeout", label: "Timeout (ms)", kind: "number", placeholder: "10000" },
    { key: "payload", label: "Payload (JSON, optional)", kind: "json", placeholder: '{"text": "{{message}}"}' },
  ],
};

const TYPE_LABELS = { email: "Email / SMTP", discord: "Discord", telegram: "Telegram", slack: "Slack", webhook: "Generic Webhook" };

// ---------- État ----------
const providers = ref([]);
const loading = ref(true);
const testResults = reactive({}); // id -> { pending, success, message }

// null = liste ; { mode: "create"|"edit", id?, type, name, enabled, values, keepSecret: {key: bool} }
const editing = ref(null);

function load() {
  loading.value = true;
  return apiGet("/api/notifications/providers")
    .then((list) => {
      providers.value = list;
    })
    .catch(notifyError)
    .finally(() => {
      loading.value = false;
    });
}
onMounted(load);

function statusDot(p) {
  return p.enabled ? "🟢" : "⚪";
}

function startCreate(type) {
  const values = {};
  for (const f of FIELD_SCHEMAS[type]) values[f.key] = f.kind === "json" ? "" : "";
  editing.value = { mode: "create", type, name: "", enabled: true, values, keepSecret: {} };
}

function startEdit(p) {
  const values = { ...p.configuration };
  const keepSecret = {};
  for (const f of FIELD_SCHEMAS[p.type] || []) {
    if (f.secret) {
      values[f.key] = f.kind === "json" ? "" : "";
      keepSecret[f.key] = true; // par défaut : ne pas toucher au secret existant
    }
  }
  editing.value = { mode: "edit", id: p.id, type: p.type, name: p.name, enabled: p.enabled, values, keepSecret };
}

function cancelEdit() {
  editing.value = null;
}

const currentSchema = computed(() => (editing.value ? FIELD_SCHEMAS[editing.value.type] || [] : []));

function toggleKeepSecret(key) {
  editing.value.keepSecret[key] = !editing.value.keepSecret[key];
  if (editing.value.keepSecret[key]) editing.value.values[key] = "";
}

function buildFieldsPayload() {
  const e = editing.value;
  const fields = {};
  for (const f of currentSchema.value) {
    if (f.secret && e.mode === "edit" && e.keepSecret[f.key]) continue; // omis = "keep existing"
    let raw = e.values[f.key];
    if (f.kind === "json") {
      if (raw === "" || raw === undefined || raw === null) continue;
      try {
        raw = JSON.parse(raw);
      } catch {
        throw new Error(t("notificationsModal.invalidJson", { label: f.label }));
      }
    } else if (f.kind === "number") {
      if (raw === "" || raw === undefined || raw === null) continue;
      raw = Number(raw);
    }
    if (raw === "" && !f.secret) continue; // champ public vide : ne pas l'envoyer (repli sur défaut backend)
    fields[f.key] = raw;
  }
  return fields;
}

const saving = ref(false);

function save() {
  const e = editing.value;
  if (!e.name || !e.name.trim()) return notifyError(new Error(t("notificationsModal.nameRequired")));

  let fields;
  try {
    fields = buildFieldsPayload();
  } catch (err) {
    return notifyError(err);
  }

  saving.value = true;
  const body = { name: e.name.trim(), type: e.type, enabled: e.enabled, fields };
  const req =
    e.mode === "create"
      ? apiPost("/api/notifications/providers", body)
      : apiFetch(`/api/notifications/providers/${e.id}`, "PATCH", body);

  req
    .then(() => {
      editing.value = null;
      return load();
    })
    .catch(notifyError)
    .finally(() => {
      saving.value = false;
    });
}

// apiPost() (api.js) est fixé sur POST — PATCH/DELETE utilisent fetch() directement,
// même pattern que UsersModal.vue#apiPut().
function apiFetch(url, method, body) {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || `HTTP Error ${r.status}`);
    return data;
  });
}

function toggleEnabled(p) {
  apiFetch(`/api/notifications/providers/${p.id}`, "PATCH", { enabled: !p.enabled }).then(load).catch(notifyError);
}

function del(p) {
  if (!confirm(t("notificationsModal.confirmDeleteProvider", { name: p.name }))) return;
  apiFetch(`/api/notifications/providers/${p.id}`, "DELETE").then(load).catch(notifyError);
}

function test(p) {
  testResults[p.id] = { pending: true };
  apiFetch(`/api/notifications/providers/${p.id}/test`, "POST")
    .then((result) => {
      testResults[p.id] = {
        pending: false,
        success: result.success,
        message: result.success ? t("notificationsModal.testSuccess") : result.safeMessage || t("notificationsModal.testFailure"),
      };
    })
    .catch((e) => {
      testResults[p.id] = { pending: false, success: false, message: e.message };
    });
}

// ---------- Routing (Phase 5D) ----------
// conditions : { severity?, alertType?, process?, server?, tag? }, chacun
// un tableau de valeurs — voir lib/services/notifications/routing/engine.js#routeMatches.
// Saisie utilisateur en champs texte "valeur1, valeur2" ; converti en
// tableau au save() (parseListInput), reconverti en chaîne à l'édition
// (joinListInput) — même approche que "Recipients" côté provider email.
const SEVERITY_OPTIONS = ["info", "warning", "critical"];

const routes = ref([]);
const routesLoading = ref(true);
const routingCanManage = computed(() => can("notifications_manage"));

// null = liste ; { mode: "create"|"edit", id?, name, enabled, severity[], alertType, process, server, providerIds[], titleTemplate, messageTemplate, notifyOnResolve }
const routeEditing = ref(null);
const routeSaving = ref(false);

function loadRoutes() {
  routesLoading.value = true;
  return apiGet("/api/notifications/routes")
    .then((list) => {
      routes.value = list;
    })
    .catch(notifyError)
    .finally(() => {
      routesLoading.value = false;
    });
}

function joinListInput(arr) {
  return Array.isArray(arr) ? arr.join(", ") : "";
}

function parseListInput(str) {
  return String(str || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function startCreateRoute() {
  routeEditing.value = {
    mode: "create",
    name: "",
    enabled: true,
    severity: [],
    alertType: "",
    process: "",
    server: "",
    providerIds: [],
    titleTemplate: "",
    messageTemplate: "",
    notifyOnResolve: false,
  };
}

function startEditRoute(r) {
  const c = r.conditions || {};
  routeEditing.value = {
    mode: "edit",
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    severity: Array.isArray(c.severity) ? [...c.severity] : [],
    alertType: joinListInput(c.alertType),
    process: joinListInput(c.process),
    server: joinListInput(c.server),
    providerIds: Array.isArray(r.providerIds) ? [...r.providerIds] : [],
    titleTemplate: r.titleTemplate || "",
    messageTemplate: r.messageTemplate || "",
    notifyOnResolve: !!r.notifyOnResolve,
  };
}

function cancelEditRoute() {
  routeEditing.value = null;
}

function toggleRouteSeverity(sev) {
  const e = routeEditing.value;
  const i = e.severity.indexOf(sev);
  if (i === -1) e.severity.push(sev);
  else e.severity.splice(i, 1);
}

function toggleRouteProvider(id) {
  const e = routeEditing.value;
  const i = e.providerIds.indexOf(id);
  if (i === -1) e.providerIds.push(id);
  else e.providerIds.splice(i, 1);
}

function saveRoute() {
  const e = routeEditing.value;
  if (!e.name || !e.name.trim()) return notifyError(new Error(t("notificationsModal.nameRequired")));

  const body = {
    name: e.name.trim(),
    enabled: e.enabled,
    conditions: {
      severity: e.severity,
      alertType: parseListInput(e.alertType),
      process: parseListInput(e.process),
      server: parseListInput(e.server),
    },
    providerIds: e.providerIds,
    titleTemplate: e.titleTemplate.trim() || null,
    messageTemplate: e.messageTemplate.trim() || null,
    notifyOnResolve: e.notifyOnResolve,
  };

  routeSaving.value = true;
  const req =
    e.mode === "create"
      ? apiPost("/api/notifications/routes", body)
      : apiFetch(`/api/notifications/routes/${e.id}`, "PATCH", body);

  req
    .then(() => {
      routeEditing.value = null;
      return loadRoutes();
    })
    .catch(notifyError)
    .finally(() => {
      routeSaving.value = false;
    });
}

function toggleRouteEnabled(r) {
  apiFetch(`/api/notifications/routes/${r.id}`, "PATCH", { enabled: !r.enabled }).then(loadRoutes).catch(notifyError);
}

function deleteRoute(r) {
  if (!confirm(t("notificationsModal.confirmDeleteRoute", { name: r.name }))) return;
  apiFetch(`/api/notifications/routes/${r.id}`, "DELETE").then(loadRoutes).catch(notifyError);
}

function providerName(id) {
  const p = providers.value.find((x) => x.id === id);
  return p ? p.name : `#${id}`;
}

function conditionsSummary(r) {
  const c = r.conditions || {};
  const parts = [];
  if (c.severity && c.severity.length) parts.push(`severity: ${c.severity.join(", ")}`);
  if (c.alertType && c.alertType.length) parts.push(`alertType: ${c.alertType.join(", ")}`);
  if (c.process && c.process.length) parts.push(`process: ${c.process.join(", ")}`);
  if (c.server && c.server.length) parts.push(`server: ${c.server.join(", ")}`);
  if (c.tag && c.tag.length) parts.push(`tag: ${c.tag.join(", ")}`);
  return parts.length ? parts.join(" · ") : t("notificationsModal.allAlerts");
}

// Charge la liste des routes (et les providers, nécessaires pour choisir la
// cible d'une règle et afficher leur nom) au premier passage sur l'onglet
// Routing plutôt qu'au montage — évite un appel réseau inutile si
// l'utilisateur ne consulte que les providers.
let routesLoaded = false;
watch(tab, (t2) => {
  if (t2 === "routing" && !routesLoaded) {
    routesLoaded = true;
    loadRoutes();
  }
});
</script>

<template>
  <ModalBase :title="t('notificationsModal.title')" hide-confirm @close="close">
    <div class="notif-tabs">
      <button class="icon-btn" :class="{ active: tab === 'providers' }" type="button" @click="tab = 'providers'">{{ t("notificationsModal.tabProviders") }}</button>
      <button v-if="routingCanManage || can('notifications_read')" class="icon-btn" :class="{ active: tab === 'routing' }" type="button" @click="tab = 'routing'">
        {{ t("notificationsModal.tabRouting") }}
      </button>
    </div>

    <template v-if="tab === 'providers'">
    <div v-if="loading" class="hint-text">{{ t("notificationsModal.loading") }}</div>

    <template v-else-if="editing">
      <div class="hint-text" style="margin-bottom: 10px">
        {{ editing.mode === "create" ? t("notificationsModal.newProvider") : t("notificationsModal.editProvider") }} — {{ TYPE_LABELS[editing.type] }}
      </div>

      <div class="notif-form">
        <label class="notif-field">
          <span>{{ t("notificationsModal.name") }}</span>
          <input v-model="editing.name" type="text" :placeholder="t('notificationsModal.namePlaceholder')" />
        </label>

        <label class="notif-field chk">
          <input v-model="editing.enabled" type="checkbox" />
          <span>{{ t("notificationsModal.enabled") }}</span>
        </label>

        <template v-for="f in currentSchema" :key="f.key">
          <label v-if="!(f.secret && editing.mode === 'edit' && editing.keepSecret[f.key])" class="notif-field">
            <span>{{ f.label }}<span v-if="f.required" :title="t('notificationsModal.required')"> *</span></span>
            <select v-if="f.kind === 'select'" v-model="editing.values[f.key]">
              <option value="">—</option>
              <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <textarea
              v-else-if="f.kind === 'json'"
              v-model="editing.values[f.key]"
              rows="2"
              :placeholder="f.placeholder"
            ></textarea>
            <input v-else :type="f.kind === 'password' ? 'password' : f.kind" v-model="editing.values[f.key]" :placeholder="f.placeholder" />
          </label>
          <div v-else class="notif-field">
            <span>{{ f.label }}</span>
            <div class="secret-kept">
              <span class="hint-text">{{ t("notificationsModal.passwordKept") }}</span>
              <label class="chk">
                <input type="checkbox" :checked="editing.keepSecret[f.key]" @change="toggleKeepSecret(f.key)" />
                {{ t("notificationsModal.keepCredential") }}
              </label>
            </div>
          </div>
        </template>
      </div>

      <div class="notif-form-actions">
        <button class="icon-btn" type="button" @click="cancelEdit">{{ t("common.cancel") }}</button>
        <button class="icon-btn go" type="button" :disabled="saving" @click="save">
          {{ saving ? t("common.saving") : t("common.save") }}
        </button>
      </div>
    </template>

    <template v-else>
      <div class="notif-add-row">
        <span class="hint-text">{{ t("notificationsModal.addProvider") }}</span>
        <button v-for="(label, type) in TYPE_LABELS" :key="type" class="icon-btn" type="button" @click="startCreate(type)">
          {{ label }}
        </button>
      </div>

      <div v-if="!providers.length" class="hint-text" style="margin-top: 12px">{{ t("notificationsModal.noProvider") }}</div>

      <div class="notif-list">
        <div v-for="p in providers" :key="p.id" class="notif-row">
          <div class="notif-row-head">
            <span class="notif-status">{{ statusDot(p) }}</span>
            <span class="label">{{ p.name }}</span>
            <span class="hint-text">{{ TYPE_LABELS[p.type] || p.type }}</span>
            <span style="flex: 1"></span>
            <button class="icon-btn" type="button" @click="startEdit(p)">{{ t("notificationsModal.edit") }}</button>
            <button class="icon-btn" type="button" @click="test(p)">{{ t("notificationsModal.test") }}</button>
            <button class="icon-btn" type="button" @click="toggleEnabled(p)">{{ p.enabled ? t("notificationsModal.disable") : t("notificationsModal.enable") }}</button>
            <button class="icon-btn danger-text" type="button" @click="del(p)">{{ t("notificationsModal.delete") }}</button>
          </div>
          <div v-if="testResults[p.id]" class="notif-test-result" :class="{ ok: testResults[p.id].success, err: testResults[p.id].success === false }">
            <template v-if="testResults[p.id].pending">{{ t("notificationsModal.testPending") }}</template>
            <template v-else-if="testResults[p.id].success">🟢 {{ testResults[p.id].message }}</template>
            <template v-else>🔴 {{ testResults[p.id].message }}</template>
          </div>
        </div>
      </div>
    </template>
    </template>

    <template v-else-if="tab === 'routing'">
      <div v-if="routesLoading" class="hint-text">{{ t("notificationsModal.loading") }}</div>

      <template v-else-if="routeEditing">
        <div class="hint-text" style="margin-bottom: 10px">
          {{ routeEditing.mode === "create" ? t("notificationsModal.newRoute") : t("notificationsModal.editRoute") }}
        </div>

        <div class="notif-form">
          <label class="notif-field">
            <span>{{ t("notificationsModal.name") }}</span>
            <input v-model="routeEditing.name" type="text" placeholder="ex: Critical alerts to Discord" />
          </label>

          <label class="notif-field chk">
            <input v-model="routeEditing.enabled" type="checkbox" />
            <span>{{ t("notificationsModal.enabled") }}</span>
          </label>

          <div class="notif-field">
            <span>{{ t("notificationsModal.severityHint") }}</span>
            <div class="route-chip-row">
              <label v-for="sev in SEVERITY_OPTIONS" :key="sev" class="chk route-chip">
                <input type="checkbox" :checked="routeEditing.severity.includes(sev)" @change="toggleRouteSeverity(sev)" />
                {{ sev }}
              </label>
            </div>
          </div>

          <label class="notif-field">
            <span>{{ t("notificationsModal.alertTypeHint") }}</span>
            <input v-model="routeEditing.alertType" type="text" placeholder="cpu, memory" />
          </label>

          <label class="notif-field">
            <span>{{ t("notificationsModal.processHint") }}</span>
            <input v-model="routeEditing.process" type="text" placeholder="api-prod, worker" />
          </label>

          <label class="notif-field">
            <span>{{ t("notificationsModal.serverHint") }}</span>
            <input v-model="routeEditing.server" type="text" placeholder="local" />
          </label>

          <div class="notif-field">
            <span>{{ t("notificationsModal.targetedProviders") }}</span>
            <div v-if="!providers.length" class="hint-text">
              {{ t("notificationsModal.noProviderYet") }}
            </div>
            <div v-else class="route-chip-row">
              <label v-for="p in providers" :key="p.id" class="chk route-chip">
                <input type="checkbox" :checked="routeEditing.providerIds.includes(p.id)" @change="toggleRouteProvider(p.id)" />
                {{ p.name }}
              </label>
            </div>
          </div>

          <label class="notif-field">
            <span v-pre>Title template (optional — {{ '{{severity}}' }}, {{ '{{ruleName}}' }}, {{ '{{metric}}' }}, {{ '{{value}}' }}, {{ '{{targetValue}}' }}…)</span>
            <input v-pre v-model="routeEditing.titleTemplate" type="text" placeholder="'[{{severity}}] {{ruleName}}'" />
          </label>

          <label class="notif-field">
            <span>{{ t("notificationsModal.messageTemplateHint") }}</span>
            <textarea v-pre v-model="routeEditing.messageTemplate" rows="2" placeholder="'{{metric}} {{operator}} {{threshold}} sur {{targetValue}} (valeur : {{value}})'"></textarea>
          </label>

          <label class="notif-field chk">
            <input v-model="routeEditing.notifyOnResolve" type="checkbox" />
            <span>{{ t("notificationsModal.notifyOnResolve") }}</span>
          </label>
        </div>

        <div class="notif-form-actions">
          <button class="icon-btn" type="button" @click="cancelEditRoute">{{ t("common.cancel") }}</button>
          <button class="icon-btn go" type="button" :disabled="routeSaving" @click="saveRoute">
            {{ routeSaving ? t("common.saving") : t("common.save") }}
          </button>
        </div>
      </template>

      <template v-else>
        <div class="notif-add-row">
          <span class="hint-text">{{ t("notificationsModal.routingDescription") }}</span>
          <button v-if="routingCanManage" class="icon-btn" type="button" @click="startCreateRoute">{{ t("notificationsModal.addRoute") }}</button>
        </div>

        <div v-if="!routes.length" class="hint-text" style="margin-top: 12px">{{ t("notificationsModal.noRoute") }}</div>

        <div class="notif-list">
          <div v-for="r in routes" :key="r.id" class="notif-row">
            <div class="notif-row-head">
              <span class="notif-status">{{ r.enabled ? "🟢" : "⚪" }}</span>
              <span class="label">{{ r.name }}</span>
              <span class="hint-text">{{ conditionsSummary(r) }}</span>
              <span style="flex: 1"></span>
              <template v-if="routingCanManage">
                <button class="icon-btn" type="button" @click="startEditRoute(r)">{{ t("notificationsModal.edit") }}</button>
                <button class="icon-btn" type="button" @click="toggleRouteEnabled(r)">{{ r.enabled ? t("notificationsModal.disable") : t("notificationsModal.enable") }}</button>
                <button class="icon-btn danger-text" type="button" @click="deleteRoute(r)">{{ t("notificationsModal.delete") }}</button>
              </template>
            </div>
            <div class="notif-test-result">
              <span class="hint-text">
                {{ t("notificationsModal.providersLabel", { list: r.providerIds && r.providerIds.length ? r.providerIds.map(providerName).join(", ") : t("notificationsModal.none") }) }}
                <template v-if="r.notifyOnResolve">{{ t("notificationsModal.alsoNotifiesOnResolve") }}</template>
              </span>
            </div>
          </div>
        </div>
      </template>
    </template>
  </ModalBase>
</template>

<style scoped>
.notif-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.notif-tabs .icon-btn.active {
  background: var(--accent, #2f81f7);
  color: #fff;
  border-color: transparent;
}
.route-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.route-chip {
  font-size: 13px;
}
.notif-add-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.notif-list {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.notif-row {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.notif-row-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
}
.notif-status {
  font-size: 12px;
}
.notif-test-result {
  padding: 6px 12px 10px;
  font-size: 13px;
  border-top: 1px solid var(--border);
}
.notif-test-result.ok {
  color: var(--stat-online, #3fb950);
}
.notif-test-result.err {
  color: var(--stat-down, #f85149);
}
.notif-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.notif-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.notif-field.chk {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.notif-field input[type="text"],
.notif-field input[type="password"],
.notif-field input[type="number"],
.notif-field select,
.notif-field textarea {
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
  font: inherit;
  font-family: var(--font-mono);
}
.secret-kept {
  display: flex;
  align-items: center;
  gap: 12px;
}
.notif-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
</style>
