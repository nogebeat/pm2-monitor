<script setup>
/**
 * Mises à jour (Phase 23, étape 1 : LECTURE SEULE).
 *
 * Cette modale INFORME, elle n'exécute rien : version installée, release
 * disponible avec ses notes, diagnostic de l'installation (peut-elle se mettre
 * à jour avec `deploy.sh update` ?) et la commande à lancer soi-même sur le
 * serveur. Aucun bouton ne lance de mise à jour — voir docs/updates/README.md
 * pour le raisonnement.
 *
 * Backend : lib/routes/updates.js, lib/services/updates/. Les notes de release
 * viennent de GitHub (contenu distant non fiable) : elles sont affichées en
 * TEXTE BRUT (interpolation Vue, jamais v-html), et seuls des liens http(s)
 * validés par le serveur sont proposés.
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { state, loadUpdateStatus, loadUpdateDiagnostics, checkUpdatesNow, notifyInfo } from "../../store";
import ModalBase from "../ModalBase.vue";

const { t, te, locale } = useI18n();

function close() {
  state.modal = null;
}

const loading = ref(true);
const throttled = ref(false);
const copied = ref(false);

const status = computed(() => state.updates.status);
const diagnostics = computed(() => state.updates.diagnostics);

onMounted(async () => {
  await Promise.all([loadUpdateStatus(), loadUpdateDiagnostics()]);
  loading.value = false;
});

async function recheck() {
  throttled.value = false;
  throttled.value = (await checkUpdatesNow()) === true;
  await loadUpdateDiagnostics(true);
}

function formatDate(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );
  } catch (e) {
    return String(value);
  }
}

const TYPE_LABEL = {
  patch: "updatesModal.typePatch",
  minor: "updatesModal.typeMinor",
  major: "updatesModal.typeMajor",
};

const hasMajor = computed(() => (status.value?.pending || []).some((p) => p.type === "major"));

function errorText(error) {
  if (!error) return "";
  const key = `updatesModal.error.${error.code}`;
  return te(key) ? t(key) : t("updatesModal.error.generic", { code: error.code });
}

// --- Diagnostic -----------------------------------------------------------

const ICON = { ok: "✓", warn: "⚠", fail: "✗", info: "ℹ" };

function checkLabel(check) {
  return t(`updatesModal.check.${check.id}`);
}

// `detail` est soit un texte brut (« Node 22.1.0 (>= 22) »), soit un code (« not_pm2 »,
// « detached:v4.1.2 ») que l'on traduit quand une clé existe.
function detailText(check) {
  const detail = check.detail;
  if (!detail) return "";
  const [code, ...rest] = String(detail).split(":");
  const key = `updatesModal.detail.${check.id}.${code}`;
  return te(key) ? t(key, { value: rest.join(":") }) : String(detail);
}

const installNote = computed(() => {
  const type = diagnostics.value?.install?.type;
  if (type === "container") return t("updatesModal.noteContainer");
  if (type === "archive") return t("updatesModal.noteArchive");
  return "";
});

const databaseKind = computed(
  () => diagnostics.value?.checks?.find((c) => c.id === "database")?.detail || "sqlite",
);

async function copyCommand() {
  const text = diagnostics.value?.command;
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // Contexte non sécurisé (HTTP) : le presse-papiers moderne est indisponible.
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
    }
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch (e) {
    notifyInfo(t("updatesModal.copyFailed"));
  }
}
</script>

<template>
  <ModalBase :title="t('updatesModal.title')" hide-confirm @close="close">
    <div class="up-modal">
      <div v-if="loading" class="up-muted">{{ t("updatesModal.loading") }}</div>

      <template v-else-if="status">
        <section class="up-card" :class="{ 'is-available': status.updateAvailable }">
          <div class="up-row">
            <span class="up-label">{{ t("updatesModal.installed") }}</span>
            <strong>v{{ status.current.version }}</strong>
            <span v-if="diagnostics?.install?.commit" class="up-muted up-mono">
              · {{ diagnostics.install.branch || diagnostics.install.tag || "HEAD" }} @
              {{ diagnostics.install.commit }}
            </span>
          </div>

          <div v-if="!status.enabled" class="up-muted">{{ t("updatesModal.disabled") }}</div>
          <template v-else>
            <div v-if="status.updateAvailable" class="up-row up-available">
              <span>{{ t("updatesModal.available", { version: status.latest.version }) }}</span>
              <span class="up-type" :class="`type-${status.latest.type}`">{{
                t(TYPE_LABEL[status.latest.type])
              }}</span>
            </div>
            <div v-else-if="status.current.valid && status.checkedAt" class="up-row up-ok">
              ✓ {{ t("updatesModal.upToDate") }}
            </div>
            <div v-else-if="!status.current.valid" class="up-row up-warn">
              {{ t("updatesModal.invalidCurrent") }}
            </div>

            <div class="up-row up-muted">
              <span v-if="status.checkedAt">
                {{ t("updatesModal.checkedAt", { date: formatDate(status.checkedAt) }) }}
              </span>
              <span v-else>{{ t("updatesModal.neverChecked") }}</span>
              <button class="icon-btn up-recheck" :disabled="state.updates.checking" @click="recheck">
                {{ state.updates.checking ? t("updatesModal.checking") : t("updatesModal.recheck") }}
              </button>
            </div>
            <div v-if="throttled" class="up-muted">{{ t("updatesModal.throttled") }}</div>
            <div v-if="status.error" class="up-error">{{ errorText(status.error) }}</div>
          </template>
        </section>

        <section v-if="status.pending.length" class="up-section">
          <h4>{{ t("updatesModal.notes") }}</h4>
          <div v-if="hasMajor" class="up-banner up-banner-major">{{ t("updatesModal.majorWarning") }}</div>
          <details v-for="(p, i) in status.pending" :key="p.tag" class="up-release" :open="i === 0">
            <summary>
              <strong>{{ p.tag }}</strong>
              <span class="up-type" :class="`type-${p.type}`">{{ t(TYPE_LABEL[p.type]) }}</span>
              <span v-if="p.publishedAt" class="up-muted">{{ formatDate(p.publishedAt) }}</span>
            </summary>
            <pre v-if="p.notes" class="up-notes">{{ p.notes }}</pre>
            <p v-else class="up-muted">{{ t("updatesModal.noNotes") }}</p>
            <a :href="p.url" target="_blank" rel="noopener noreferrer" class="up-link"
              >{{ t("updatesModal.viewOnGithub") }} ↗</a
            >
          </details>
        </section>

        <section v-if="diagnostics" class="up-section">
          <h4>{{ t("updatesModal.diagnostic") }}</h4>
          <p class="up-summary" :class="diagnostics.canSelfUpdate ? 'up-ok' : 'up-warn'">
            {{ diagnostics.canSelfUpdate ? t("updatesModal.canUpdate") : t("updatesModal.cannotUpdate") }}
          </p>
          <ul class="up-checks">
            <li v-for="c in diagnostics.checks" :key="c.id" :class="`check-${c.status}`">
              <span class="up-icon" aria-hidden="true">{{ ICON[c.status] }}</span>
              <span class="up-check-label">{{ checkLabel(c) }}</span>
              <span v-if="detailText(c)" class="up-muted up-check-detail">{{ detailText(c) }}</span>
            </li>
          </ul>
        </section>

        <section v-if="diagnostics" class="up-section">
          <h4>{{ t("updatesModal.howTo") }}</h4>
          <template v-if="diagnostics.command">
            <p class="up-muted">{{ t("updatesModal.runOnServer") }}</p>
            <div class="up-command">
              <code>{{ diagnostics.command }}</code>
              <button class="icon-btn" @click="copyCommand">
                {{ copied ? t("updatesModal.copied") : t("updatesModal.copy") }}
              </button>
            </div>
            <p v-if="diagnostics.install.branch" class="up-muted">
              {{ t("updatesModal.branchNote", { branch: diagnostics.install.branch }) }}
            </p>
          </template>
          <p v-else class="up-muted">{{ installNote }}</p>
          <p class="up-banner">
            {{ t(`updatesModal.backupHint.${databaseKind === "mysql" ? "mysql" : "sqlite"}`) }}
          </p>
          <p class="up-muted">{{ t("updatesModal.readOnly") }}</p>
        </section>
      </template>

      <div v-else class="up-muted">{{ t("updatesModal.unavailable") }}</div>
    </div>
  </ModalBase>
</template>

<style scoped>
.up-modal {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  min-width: 0;
}
.up-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.up-card.is-available {
  border-color: var(--accent);
}
.up-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.up-label {
  opacity: 0.7;
  font-size: 12px;
}
.up-muted {
  opacity: 0.7;
  font-size: 12px;
}
.up-mono {
  font-family: var(--mono, ui-monospace, monospace);
}
.up-available {
  font-weight: 600;
  color: var(--accent);
}
.up-ok {
  color: var(--ok, #3fb27f);
}
.up-warn {
  color: var(--warn, #d9a441);
}
.up-error {
  color: var(--err, #e5534b);
  font-size: 12px;
}
.up-recheck {
  margin-left: auto;
}
.up-type {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
}
.up-type.type-major {
  color: var(--err, #e5534b);
  border-color: currentColor;
}
.up-type.type-minor {
  color: var(--accent);
  border-color: currentColor;
}
.up-section h4 {
  margin: 0 0 6px;
  font-size: 13px;
}
.up-banner {
  font-size: 12px;
  border-left: 3px solid var(--warn, #d9a441);
  padding: 6px 10px;
  margin: 8px 0;
  background: color-mix(in srgb, var(--warn, #d9a441) 10%, transparent);
}
.up-banner-major {
  border-left-color: var(--err, #e5534b);
  background: color-mix(in srgb, var(--err, #e5534b) 10%, transparent);
}
.up-release {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 8px;
}
.up-release summary {
  cursor: pointer;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.up-notes {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  max-height: 220px;
  overflow: auto;
  margin: 8px 0;
  font-family: inherit;
}
.up-link {
  font-size: 12px;
  color: var(--accent);
}
.up-summary {
  margin: 0 0 6px;
  font-size: 13px;
}
.up-checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.up-checks li {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 12px;
}
.up-icon {
  width: 14px;
  text-align: center;
}
.check-ok .up-icon {
  color: var(--ok, #3fb27f);
}
.check-warn .up-icon {
  color: var(--warn, #d9a441);
}
.check-fail .up-icon {
  color: var(--err, #e5534b);
}
.up-check-detail {
  overflow-wrap: anywhere;
}
.up-command {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.up-command code {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  user-select: all;
}
</style>
