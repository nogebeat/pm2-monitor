<script setup>
/**
 * BackupModal.vue — Phase 19 (Backup & Restore). Même pattern que
 * ApiKeysModal.vue : toute la logique/validation vit côté serveur
 * (lib/routes/backup.js, lib/services/backup/) — ce composant affiche/masque
 * selon can("backup_export"/"backup_restore") pour le confort d'UI, la
 * vérité est toujours revalidée par l'API.
 *
 * Flux de restauration en deux temps, jamais un simple bouton "restaurer" :
 * 1) coller/charger le JSON -> POST /validate (dry-run, résumé + conflits) ;
 * 2) uniquement après avoir VU ce résumé, un second bouton envoie
 *    POST /restore avec confirm=true — voir cahier des charges Phase 19,
 *    "afficher résumé, détecter conflits, demander confirmation".
 */
import { reactive, ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { notifyError, can, state } from "../../store";
import { apiGet, apiPost } from "../../api";
import ModalBase from "../ModalBase.vue";

const { t } = useI18n();

function close() {
  state.modal = null;
}

const canExport = can("backup_export");
const canRestore = can("backup_restore");

const loading = ref(true);
const sectionsCatalog = ref([]);
const secretsAvailable = ref(false);
const selectedSections = reactive(new Set());
const includeSecrets = ref(false);

function load() {
  loading.value = true;
  return apiGet("/api/backup/sections")
    .then((r) => {
      sectionsCatalog.value = r.sections;
      secretsAvailable.value = r.secretsAvailable;
      selectedSections.clear();
      r.sections.filter((s) => s.defaultIncluded).forEach((s) => selectedSections.add(s.id));
    })
    .catch(notifyError)
    .finally(() => {
      loading.value = false;
    });
}

onMounted(load);

function toggleSection(id) {
  if (selectedSections.has(id)) selectedSections.delete(id);
  else selectedSections.add(id);
}

// ---------- Export ----------
const exporting = ref(false);

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function runExport() {
  exporting.value = true;
  apiPost("/api/backup/export", {
    sections: [...selectedSections],
    includeSecrets: includeSecrets.value,
  })
    .then((backup) => {
      const date = new Date().toISOString().slice(0, 10);
      downloadJson(backup, `pm2-monitor-backup-${date}.json`);
    })
    .catch(notifyError)
    .finally(() => {
      exporting.value = false;
    });
}

// ---------- Restore ----------
const restoreJsonText = ref("");
const onConflict = ref("skip");
const validating = ref(false);
const restoring = ref(false);
const validation = ref(null); // résumé du dernier /validate (dry-run)
const restoreResult = ref(null); // résultat du dernier /restore réel

function onFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    restoreJsonText.value = String(reader.result || "");
    validation.value = null;
    restoreResult.value = null;
  };
  reader.readAsText(file);
}

function parseRestoreBackup() {
  try {
    return JSON.parse(restoreJsonText.value);
  } catch (e) {
    notifyError(new Error(t("backupModal.invalidJson")));
    return null;
  }
}

function runValidate() {
  const backup = parseRestoreBackup();
  if (!backup) return;
  validating.value = true;
  restoreResult.value = null;
  apiPost("/api/backup/validate", { backup, onConflict: onConflict.value })
    .then((result) => {
      validation.value = { ...result, backup };
    })
    .catch(notifyError)
    .finally(() => {
      validating.value = false;
    });
}

function runRestore() {
  if (!validation.value) return;
  if (!confirm(t("backupModal.confirmRestore"))) return;
  restoring.value = true;
  apiPost("/api/backup/restore", {
    backup: validation.value.backup,
    onConflict: onConflict.value,
    confirm: true,
  })
    .then((result) => {
      restoreResult.value = result;
      validation.value = null;
    })
    .catch(notifyError)
    .finally(() => {
      restoring.value = false;
    });
}

function resetRestore() {
  restoreJsonText.value = "";
  validation.value = null;
  restoreResult.value = null;
}
</script>

<template>
  <ModalBase :title="t('backupModal.title')" hide-confirm @close="close">
    <div v-if="loading" class="hint-text">{{ t("common.loading") }}</div>

    <template v-else>
      <!-- ---------- Export ---------- -->
      <section v-if="canExport" class="backup-section">
        <div class="backup-section-title">{{ t("backupModal.exportTitle") }}</div>
        <div class="hint-text" style="margin-bottom: 8px">{{ t("backupModal.exportHint") }}</div>

        <div class="sections-grid">
          <label v-for="s in sectionsCatalog" :key="s.id" class="chk" :title="s.id">
            <input type="checkbox" :checked="selectedSections.has(s.id)" @change="toggleSection(s.id)" />
            {{ s.label }}
          </label>
        </div>

        <label v-if="secretsAvailable" class="chk" style="margin-top: 10px">
          <input v-model="includeSecrets" type="checkbox" />
          {{ t("backupModal.includeSecrets") }}
        </label>
        <div v-else class="hint-text" style="margin-top: 10px">
          {{ t("backupModal.secretsUnavailable") }}
        </div>

        <div>
          <button
            type="button"
            class="icon-btn go"
            style="margin-top: 10px"
            :disabled="exporting || !selectedSections.size"
            @click="runExport"
          >
            💾 {{ t("backupModal.exportButton") }}
          </button>
        </div>
      </section>

      <hr v-if="canExport && canRestore" class="backup-sep" />

      <!-- ---------- Restore ---------- -->
      <section v-if="canRestore" class="backup-section">
        <div class="backup-section-title">{{ t("backupModal.restoreTitle") }}</div>
        <div class="hint-text" style="margin-bottom: 8px">{{ t("backupModal.restoreHint") }}</div>

        <input type="file" accept="application/json" @change="onFileChange" />
        <textarea
          v-model="restoreJsonText"
          class="restore-textarea"
          rows="6"
          :placeholder="t('backupModal.pastePlaceholder')"
        ></textarea>

        <div class="restore-row">
          <label class="hint-text">
            {{ t("backupModal.onConflict") }}
            <select v-model="onConflict">
              <option value="skip">{{ t("backupModal.onConflictSkip") }}</option>
              <option value="overwrite">{{ t("backupModal.onConflictOverwrite") }}</option>
            </select>
          </label>
          <button
            type="button"
            class="icon-btn"
            :disabled="validating || !restoreJsonText"
            @click="runValidate"
          >
            {{ t("backupModal.validateButton") }}
          </button>
          <button type="button" class="icon-btn" @click="resetRestore">{{ t("backupModal.reset") }}</button>
        </div>

        <div v-if="validation" class="restore-summary">
          <div class="hint-text">
            {{
              t("backupModal.summaryFor", {
                date: new Date(validation.metadata.createdAt || Date.now()).toLocaleString(),
              })
            }}
          </div>
          <div v-for="s in validation.summary" :key="s.section" class="summary-line">
            <strong>{{ s.label }}</strong> —
            {{
              t("backupModal.summaryCounts", { created: s.created, updated: s.updated, skipped: s.skipped })
            }}
            <div v-if="s.conflicts.length" class="conflicts">
              <div v-for="(c, i) in s.conflicts" :key="i" class="conflict-line">
                ⚠ {{ c.key }} — {{ c.reason }}
              </div>
            </div>
          </div>
          <button
            type="button"
            class="icon-btn go"
            style="margin-top: 10px"
            :disabled="restoring"
            @click="runRestore"
          >
            {{ t("backupModal.confirmRestoreButton") }}
          </button>
        </div>

        <div v-if="restoreResult" class="restore-summary">
          <div class="hint-text">{{ t("backupModal.restoreDone") }}</div>
          <div v-for="s in restoreResult.summary" :key="s.section" class="summary-line">
            <strong>{{ s.label }}</strong> —
            {{
              t("backupModal.summaryCounts", { created: s.created, updated: s.updated, skipped: s.skipped })
            }}
          </div>
          <div v-if="restoreResult.generatedPasswords.length" class="secret-reveal" style="margin-top: 10px">
            <div class="hint-text" style="margin-bottom: 6px">
              {{ t("backupModal.generatedPasswordsHint") }}
            </div>
            <div v-for="p in restoreResult.generatedPasswords" :key="p.username" class="secret-value">
              <code>{{ p.username }} : {{ p.password }}</code>
            </div>
          </div>
        </div>
      </section>
    </template>
  </ModalBase>
</template>

<style scoped>
.backup-section {
  display: flex;
  flex-direction: column;
}
.backup-section-title {
  font-weight: 600;
  margin-bottom: 4px;
}
.backup-sep {
  border: none;
  border-top: 1px solid var(--border);
  margin: 16px 0;
}
.sections-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.chk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  white-space: nowrap;
}
.restore-textarea {
  width: 100%;
  margin-top: 8px;
  padding: 8px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
  font: 12px var(--font-mono);
  box-sizing: border-box;
  resize: vertical;
}
.restore-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.restore-row select {
  margin-left: 6px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
}
.restore-summary {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--panel-raised);
}
.summary-line {
  font-size: 13px;
  margin-top: 6px;
}
.conflicts {
  margin-top: 3px;
  margin-left: 8px;
}
.conflict-line {
  font-size: 12px;
  color: var(--danger, #d33);
}
.secret-reveal {
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--panel-raised);
}
.secret-value code {
  display: block;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--bg);
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  margin-top: 4px;
}
</style>
