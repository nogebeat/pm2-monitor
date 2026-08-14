"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AutoHealingService } = require("../../lib/services/auto-healing/engine");

/**
 * Fakes en mémoire, même contrat que settings-store.js / state-store.js /
 * audit-store.js — pas de DB réelle ici (couverture "vraie DB + API +
 * permissions" dans test/integration/auto-healing-api.test.js).
 */
function fakeSettingsStore(overrides) {
  let settings = { enabled: true, maxAttempts: 3, backoffSeconds: [60, 300, 900], ...overrides };
  return {
    async get() {
      return { ...settings, backoffSeconds: [...settings.backoffSeconds] };
    },
    async update(changes) {
      settings = { ...settings, ...changes };
      return this.get();
    },
  };
}

function fakeStateStore() {
  const rows = new Map();
  return {
    async get(processName) {
      return (
        rows.get(processName) || {
          processName,
          attempts: 0,
          blocked: false,
          blockedAt: null,
          blockedReason: null,
          lastAttemptAt: null,
          nextAllowedAt: null,
        }
      );
    },
    async upsert(processName, fields) {
      const current = await this.get(processName);
      const merged = { ...current, ...fields };
      rows.set(processName, merged);
      return { ...merged };
    },
    async reset(processName, { unblockedBy } = {}) {
      return this.upsert(processName, {
        attempts: 0,
        blocked: false,
        blockedAt: null,
        blockedReason: null,
        nextAllowedAt: null,
        unblockedBy: unblockedBy ?? null,
      });
    },
    _rows: rows,
  };
}

function fakeAuditStore() {
  const entries = [];
  return {
    async record(entry) {
      const stored = { id: entries.length + 1, createdAt: Date.now(), ...entry };
      entries.push(stored);
      return stored;
    },
    entries,
  };
}

function build({ settings, now } = {}) {
  const settingsStore = fakeSettingsStore(settings);
  const stateStore = fakeStateStore();
  const auditStore = fakeAuditStore();
  let clock = now ?? 1_000_000;
  const restarts = [];
  const service = new AutoHealingService({
    settingsStore,
    stateStore,
    auditStore,
    restart: async (processName) => {
      restarts.push(processName);
    },
    now: () => clock,
  });
  return {
    service,
    settingsStore,
    stateStore,
    auditStore,
    restarts,
    advance: (ms) => (clock += ms),
  };
}

// --- Garde-fous d'abord (section 9 du prompt maître) -----------------------

test("Auto-Healing — désactivé par défaut : trigger() ne fait rien", async () => {
  const { service, restarts } = build({ settings: { enabled: false } });
  const result = await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  assert.equal(result.skipped, "disabled");
  assert.equal(restarts.length, 0);
});

test("Auto-Healing — maximum attempts : exactement N tentatives puis BLOCKED", async () => {
  const { service, stateStore, restarts } = build({ settings: { maxAttempts: 3, backoffSeconds: [0, 0, 0] } });

  const r1 = await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  const r2 = await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  const r3 = await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  const r4 = await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });

  assert.equal(r1.action, "restart");
  assert.equal(r2.action, "restart");
  assert.equal(r3.action, "restart");
  assert.equal(r4.action, "block");
  assert.equal(restarts.length, 3); // pas de 4e restart

  const state = await stateStore.get("api");
  assert.equal(state.blocked, true);
});

test("Auto-Healing — cooldown : un second événement pendant le cooldown ne redémarre pas", async () => {
  const { service, restarts } = build({ settings: { maxAttempts: 3, backoffSeconds: [60, 300, 900] } });

  const r1 = await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  assert.equal(r1.action, "restart");
  assert.equal(restarts.length, 1);

  // Même seconde : encore dans le cooldown de 60s.
  const r2 = await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  assert.equal(r2.skipped, "cooldown");
  assert.equal(restarts.length, 1); // pas de second restart
});

test("Auto-Healing — backoff : les délais suivent la config (60s, puis 300s, puis 900s)", async () => {
  const { service, stateStore, advance } = build({
    settings: { maxAttempts: 3, backoffSeconds: [60, 300, 900] },
  });

  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  let state = await stateStore.get("api");
  assert.equal(state.nextAllowedAt - state.lastAttemptAt, 60_000);

  advance(60_000); // fin du 1er cooldown
  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  state = await stateStore.get("api");
  assert.equal(state.nextAllowedAt - state.lastAttemptAt, 300_000);

  advance(300_000); // fin du 2e cooldown
  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  state = await stateStore.get("api");
  assert.equal(state.nextAllowedAt - state.lastAttemptAt, 900_000);
});

test("Auto-Healing — blocking : échecs répétés après le cooldown -> BLOCKED", async () => {
  const { service, stateStore, advance } = build({
    settings: { maxAttempts: 2, backoffSeconds: [0, 0] },
  });

  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  advance(1);
  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  advance(1);
  const r3 = await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });

  assert.equal(r3.action, "block");
  const state = await stateStore.get("api");
  assert.equal(state.blocked, true);
});

test("Auto-Healing — recovery : un health check redevenu sain remet les tentatives à zéro (process non bloqué)", async () => {
  const { service, stateStore } = build({ settings: { maxAttempts: 3, backoffSeconds: [0, 0, 0] } });

  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  let state = await stateStore.get("api");
  assert.equal(state.attempts, 1);

  await service.recordRecovery("api");
  state = await stateStore.get("api");
  assert.equal(state.attempts, 0);
  assert.equal(state.nextAllowedAt, null);
});

test("Auto-Healing — recovery ne débloque JAMAIS un process bloqué (déblocage manuel obligatoire)", async () => {
  const { service, stateStore } = build({ settings: { maxAttempts: 1, backoffSeconds: [0] } });

  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" }); // attempt 1
  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" }); // -> block

  let state = await stateStore.get("api");
  assert.equal(state.blocked, true);

  await service.recordRecovery("api");
  state = await stateStore.get("api");
  assert.equal(state.blocked, true, "recordRecovery() ne doit pas débloquer un process bloqué");

  await service.unblock("api", { id: 1, username: "admin" });
  state = await stateStore.get("api");
  assert.equal(state.blocked, false);
  assert.equal(state.attempts, 0);
});

test("Auto-Healing — un process bloqué reste bloqué même après un nouvel événement (pas de tentative supplémentaire)", async () => {
  const { service, stateStore, restarts } = build({ settings: { maxAttempts: 1, backoffSeconds: [0] } });

  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" }); // attempt 1
  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" }); // -> block
  assert.equal(restarts.length, 1);

  const result = await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" });
  assert.equal(result.skipped, "blocked");
  assert.equal(restarts.length, 1); // toujours pas de 2e restart
});

// --- Audit (section 8) -------------------------------------------------

test("Auto-Healing — audit : chaque tentative (succès, échec, blocage) est enregistrée", async () => {
  const restart404 = new Error("Process introuvable.");
  const settingsStore = fakeSettingsStore({ maxAttempts: 2, backoffSeconds: [0, 0] });
  const stateStore = fakeStateStore();
  const auditStore = fakeAuditStore();
  let call = 0;
  const service = new AutoHealingService({
    settingsStore,
    stateStore,
    auditStore,
    restart: async () => {
      call += 1;
      if (call === 2) throw restart404; // 2e tentative échoue
    },
    now: () => 0,
  });

  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" }); // success
  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" }); // failure
  await service.trigger({ processName: "api", source: "pm2_event", reason: "process crashed" }); // blocked

  assert.equal(auditStore.entries.length, 3);
  assert.equal(auditStore.entries[0].result, "success");
  assert.equal(auditStore.entries[1].result, "failure");
  assert.equal(auditStore.entries[2].result, "blocked");
});

// --- Sécurité (section 10) ----------------------------------------------

test("Auto-Healing — résolution health_check -> process : n'agit que si health_checks.process_name est explicitement renseigné", async () => {
  // Couvre le correctif du problème connu de la Phase 7 initiale : une
  // alerte targetType="health_check" porte le nom du *check*
  // (alert.targetValue), pas forcément celui d'un process PM2. Vérifié ici
  // au niveau de l'adaptateur (lib/services/auto-healing/index.js), pas de
  // l'engine (qui ne connaît que des processName déjà résolus).
  const { feedFromAlertTransition } = require("../../lib/services/auto-healing/index");
  const originalGetByName = require("../../lib/services/health-checks/store").getByName;
  const healthChecksStore = require("../../lib/services/health-checks/store");

  const { service, restarts } = build({ settings: { maxAttempts: 3, backoffSeconds: [0, 0, 0] } });

  healthChecksStore.getByName = async (name) => {
    if (name === "api-check-no-link") return { name, processName: null };
    if (name === "api-check-linked") return { name, processName: "api-prod" };
    return null;
  };
  try {
    // Check sans process_name renseigné -> ignoré, pas de restart.
    const r1 = await feedFromAlertTransition(service, {
      targetType: "health_check",
      targetValue: "api-check-no-link",
      state: "active",
      metric: "status",
      operator: "==",
      threshold: "DOWN",
    });
    assert.equal(r1, null);
    assert.equal(restarts.length, 0);

    // Check avec process_name renseigné -> restart du bon process.
    const r2 = await feedFromAlertTransition(service, {
      targetType: "health_check",
      targetValue: "api-check-linked",
      state: "active",
      metric: "status",
      operator: "==",
      threshold: "DOWN",
    });
    assert.equal(r2.action, "restart");
    assert.deepEqual(restarts, ["api-prod"]);
  } finally {
    healthChecksStore.getByName = originalGetByName;
  }
});

test("Auto-Healing — sécurité : reason/processName ne sont jamais interprétés, seule l'API PM2 restart est appelée", async () => {
  const { service, restarts } = build({ settings: { maxAttempts: 3, backoffSeconds: [0, 0, 0] } });

  // Une chaîne malveillante en `reason` ou `processName` ne doit jamais se
  // retrouver exécutée : le fake `restart()` ne reçoit que le nom du
  // process tel quel, jamais concaténé à une commande.
  const malicious = "api; rm -rf / #";
  await service.trigger({ processName: malicious, source: "pm2_event", reason: "$(whoami)" });

  assert.deepEqual(restarts, [malicious]); // passé tel quel à l'API PM2, jamais interprété comme shell
});
