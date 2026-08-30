<script setup>
import { computed } from "vue";
import { state } from "../store";

import MoreMenuModal from "./modals/MoreMenuModal.vue";
import ScaleModal from "./modals/ScaleModal.vue";
import EnvModal from "./modals/EnvModal.vue";
import ConfigModal from "./modals/ConfigModal.vue";
import FullTextSearchModal from "./modals/FullTextSearchModal.vue";
import GotoDateModal from "./modals/GotoDateModal.vue";
import ExportRangeModal from "./modals/ExportRangeModal.vue";
import UsersModal from "./modals/UsersModal.vue";
import ApiKeysModal from "./modals/ApiKeysModal.vue";
import NotificationsModal from "./modals/NotificationsModal.vue";
import HealthChecksModal from "./modals/HealthChecksModal.vue";
import AuditLogModal from "./modals/AuditLogModal.vue";
import OrganizationModal from "./modals/OrganizationModal.vue";
import AnomalyDetectionModal from "./modals/AnomalyDetectionModal.vue";
import BackupModal from "./modals/BackupModal.vue";
import PluginsModal from "./modals/PluginsModal.vue";

const componentMap = {
  more: MoreMenuModal,
  scale: ScaleModal,
  env: EnvModal,
  config: ConfigModal,
  fulltext: FullTextSearchModal,
  gotodate: GotoDateModal,
  exportrange: ExportRangeModal,
  users: UsersModal,
  apiKeys: ApiKeysModal,
  notifications: NotificationsModal,
  healthChecks: HealthChecksModal,
  auditLog: AuditLogModal,
  organization: OrganizationModal,
  anomalyDetection: AnomalyDetectionModal,
  backup: BackupModal,
  plugins: PluginsModal,
};

const current = computed(() => (state.modal ? componentMap[state.modal.type] : null));
const process = computed(() => state.modal?.process || null);
</script>

<template>
  <component :is="current" v-if="current" :process="process" />
</template>
