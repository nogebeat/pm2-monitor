<script setup>
/**
 * Settings → Notifications → Providers (Phase 5C).
 *
 * Liste des configurations de providers de notification (Discord, SMTP,
 * Telegram, Slack, Webhook générique — Phase 5B) + formulaire dynamique
 * d'ajout/édition, test réel, activation/désactivation, suppression.
 *
 * Les secrets (mot de passe SMTP, webhook URL, bot token…) ne sont jamais
 * reçus du backend en clair : seul `hasSecrets` (booléen) est renvoyé par
 * GET /api/notifications/providers. Ce composant affiche donc les champs
 * secrets vides avec un placeholder "••••••••" à l'édition ; les laisser
 * vides envoie `keepSecrets: true` (le backend conserve alors la valeur
 * déjà stockée pour ce champ précis, voir lib/routes/notifications.js).
 */
import { reactive, ref, computed, onMounted } from "vue";
import { state, notifyError } from "../../store";
import { apiGet, apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

function close() {
  state.modal = null;
}

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
    { key: "username", label: "Nom affiché (optionnel)", kind: "text" },
  ],
  telegram: [
    { key: "botToken", label: "Bot Token", kind: "password", secret: true, required: true },
    { key: "chatId", label: "Chat ID", kind: "text", required: true },
  ],
  slack: [
    { key: "webhookUrl", label: "Webhook URL", kind: "text", secret: true, required: true },
    { key: "channel", label: "Channel (optionnel)", kind: "text", placeholder: "#alerts" },
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
    { key: "payload", label: "Payload (JSON, optionnel)", kind: "json", placeholder: '{"text": "{{message}}"}' },
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
        throw new Error(`${f.label} : JSON invalide.`);
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
  if (!e.name || !e.name.trim()) return notifyError(new Error("Le nom est requis."));

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
    if (!r.ok || data.error) throw new Error(data.error || `Erreur HTTP ${r.status}`);
    return data;
  });
}

function toggleEnabled(p) {
  apiFetch(`/api/notifications/providers/${p.id}`, "PATCH", { enabled: !p.enabled }).then(load).catch(notifyError);
}

function del(p) {
  if (!confirm(`Supprimer la configuration "${p.name}" ?`)) return;
  apiFetch(`/api/notifications/providers/${p.id}`, "DELETE").then(load).catch(notifyError);
}

function test(p) {
  testResults[p.id] = { pending: true };
  apiFetch(`/api/notifications/providers/${p.id}/test`, "POST")
    .then((result) => {
      testResults[p.id] = {
        pending: false,
        success: result.success,
        message: result.success ? "Notification envoyée avec succès" : result.safeMessage || "Échec de l'envoi",
      };
    })
    .catch((e) => {
      testResults[p.id] = { pending: false, success: false, message: e.message };
    });
}
</script>

<template>
  <ModalBase title="Notifications — Providers" hide-confirm @close="close">
    <div v-if="loading" class="hint-text">Chargement…</div>

    <template v-else-if="editing">
      <div class="hint-text" style="margin-bottom: 10px">
        {{ editing.mode === "create" ? "Nouveau provider" : "Modifier le provider" }} — {{ TYPE_LABELS[editing.type] }}
      </div>

      <div class="notif-form">
        <label class="notif-field">
          <span>Name</span>
          <input v-model="editing.name" type="text" placeholder="ex: Discord Production" />
        </label>

        <label class="notif-field chk">
          <input v-model="editing.enabled" type="checkbox" />
          <span>Enabled</span>
        </label>

        <template v-for="f in currentSchema" :key="f.key">
          <label v-if="!(f.secret && editing.mode === 'edit' && editing.keepSecret[f.key])" class="notif-field">
            <span>{{ f.label }}<span v-if="f.required" title="requis"> *</span></span>
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
              <span class="hint-text">Password ••••••••</span>
              <label class="chk">
                <input type="checkbox" :checked="editing.keepSecret[f.key]" @change="toggleKeepSecret(f.key)" />
                Keep existing credential
              </label>
            </div>
          </div>
        </template>
      </div>

      <div class="notif-form-actions">
        <button class="icon-btn" type="button" @click="cancelEdit">Annuler</button>
        <button class="icon-btn go" type="button" :disabled="saving" @click="save">
          {{ saving ? "Enregistrement…" : "Save" }}
        </button>
      </div>
    </template>

    <template v-else>
      <div class="notif-add-row">
        <span class="hint-text">+ Add notification provider :</span>
        <button v-for="(label, type) in TYPE_LABELS" :key="type" class="icon-btn" type="button" @click="startCreate(type)">
          {{ label }}
        </button>
      </div>

      <div v-if="!providers.length" class="hint-text" style="margin-top: 12px">Aucun provider configuré.</div>

      <div class="notif-list">
        <div v-for="p in providers" :key="p.id" class="notif-row">
          <div class="notif-row-head">
            <span class="notif-status">{{ statusDot(p) }}</span>
            <span class="label">{{ p.name }}</span>
            <span class="hint-text">{{ TYPE_LABELS[p.type] || p.type }}</span>
            <span style="flex: 1"></span>
            <button class="icon-btn" type="button" @click="startEdit(p)">Edit</button>
            <button class="icon-btn" type="button" @click="test(p)">Test</button>
            <button class="icon-btn" type="button" @click="toggleEnabled(p)">{{ p.enabled ? "Disable" : "Enable" }}</button>
            <button class="icon-btn danger-text" type="button" @click="del(p)">Delete</button>
          </div>
          <div v-if="testResults[p.id]" class="notif-test-result" :class="{ ok: testResults[p.id].success, err: testResults[p.id].success === false }">
            <template v-if="testResults[p.id].pending">⏳ Envoi du test en cours…</template>
            <template v-else-if="testResults[p.id].success">🟢 {{ testResults[p.id].message }}</template>
            <template v-else>🔴 {{ testResults[p.id].message }}</template>
          </div>
        </div>
      </div>
    </template>
  </ModalBase>
</template>

<style scoped>
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
