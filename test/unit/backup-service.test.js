"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");

const backupService = require("../../lib/services/backup");
const format = require("../../lib/services/backup/format");
const backupCrypto = require("../../lib/services/backup/crypto");

const userStore = require("../../lib/user-store");
const alertRulesStore = require("../../lib/services/alerts/alert-rules-store");
const providerStore = require("../../lib/services/notifications/provider-store");
const healthChecksStore = require("../../lib/services/health-checks/store");
const serviceDependenciesStore = require("../../lib/services/service-dependencies/store");
const apiKeysStore = require("../../lib/services/api-keys/store");

test("services/backup — format/validateBackup", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("rejette un objet qui n'a pas la forme d'un backup", async () => {
    await assert.rejects(() => backupService.validateBackup(null), /objet JSON/);
    await assert.rejects(() => backupService.validateBackup({}), /format/);
  });

  await t.test("rejette une formatVersion future inconnue", async () => {
    const backup = { format: format.FORMAT_MARKER, formatVersion: 999, metadata: {}, data: {} };
    await assert.rejects(() => backupService.validateBackup(backup), /non supportée/);
  });

  await t.test("rejette une formatVersion obsolète", async () => {
    const backup = { format: format.FORMAT_MARKER, formatVersion: 0, metadata: {}, data: {} };
    await assert.rejects(() => backupService.validateBackup(backup), /obsolète/);
  });

  await t.test("un backup vide mais bien formé est valide (aucune section)", async () => {
    const result = await backupService.validateBackup({
      format: format.FORMAT_MARKER,
      formatVersion: 1,
      metadata: {},
      data: {},
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.summary, []);
  });

  t.after(() => cleanupDb(dbCtx));
});

test("services/backup — createBackup()", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await alertRulesStore.create({
    name: "cpu-high",
    targetType: "system",
    metric: "cpu",
    operator: ">",
    threshold: "90",
  });
  await userStore.createUser({ username: "alice", password: "password123", isAdmin: false });

  await t.test("inclut les sections par défaut, exclut les secrets par défaut", async () => {
    const backup = await backupService.createBackup({});
    assert.equal(backup.format, format.FORMAT_MARKER);
    assert.equal(backup.formatVersion, 1);
    assert.ok(backup.metadata.sections.includes("alertRules"));
    assert.ok(backup.metadata.sections.includes("users"));
    // alertSilences est opt-in (defaultIncluded=false) — absent par défaut.
    assert.ok(!backup.metadata.sections.includes("alertSilences"));
    assert.equal(backup.data.alertRules.length, 1);
    assert.equal(backup.data.alertRules[0].name, "cpu-high");
    assert.equal(backup.metadata.secrets.included, false);
    // password_hash ne doit JAMAIS apparaître, même sérialisé en JSON.
    assert.ok(!JSON.stringify(backup).includes("password_hash"));
  });

  await t.test("un sous-ensemble explicite de sections limite l'export", async () => {
    const backup = await backupService.createBackup({ sections: ["alertRules"] });
    assert.deepEqual(backup.metadata.sections, ["alertRules"]);
    assert.equal(backup.data.users, undefined);
  });

  await t.test("includeSecrets sans BACKUP_ENCRYPTION_KEY échoue explicitement", async () => {
    delete process.env.BACKUP_ENCRYPTION_KEY;
    await assert.rejects(
      () => backupService.createBackup({ sections: ["notifications"], includeSecrets: true }),
      /BACKUP_ENCRYPTION_KEY/,
    );
  });

  await t.test("includeSecrets avec BACKUP_ENCRYPTION_KEY chiffre les secrets, jamais en clair", async () => {
    process.env.BACKUP_ENCRYPTION_KEY = "test-backup-key-not-for-production";
    await providerStore.create({
      name: "slack-eng",
      type: "slack",
      configuration: { channel: "#eng" },
      secrets: { webhookUrl: "https://hooks.example/super-secret-path" },
    });

    const backup = await backupService.createBackup({ sections: ["notifications"], includeSecrets: true });
    const [provider] = backup.data.notifications.providers;
    assert.equal(provider.hasSecrets, true);
    assert.ok(provider.secretsEncrypted);
    assert.ok(!JSON.stringify(backup).includes("super-secret-path"));

    const decrypted = backupCrypto.decrypt(provider.secretsEncrypted);
    assert.equal(decrypted.webhookUrl, "https://hooks.example/super-secret-path");

    delete process.env.BACKUP_ENCRYPTION_KEY;
  });

  t.after(() => cleanupDb(dbCtx));
});

test("services/backup — restoreBackup() fusion (merge)", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("restore() sans confirm=true échoue", async () => {
    const backup = await backupService.createBackup({});
    await assert.rejects(() => backupService.restoreBackup(backup, {}), /Confirmation requise/);
  });

  await t.test(
    "crée un nouvel utilisateur avec un mot de passe temporaire, jamais dans le backup",
    async () => {
      const backup = {
        format: format.FORMAT_MARKER,
        formatVersion: 1,
        metadata: {},
        data: { users: [{ username: "restored-user", isAdmin: false, role: null }] },
      };
      const result = await backupService.restoreBackup(backup, { confirm: true });
      assert.equal(result.summary[0].created, 1);
      assert.equal(result.generatedPasswords.length, 1);
      assert.equal(result.generatedPasswords[0].username, "restored-user");
      assert.ok(result.generatedPasswords[0].password.length >= 16);

      const created = await userStore.getByUsername("restored-user");
      assert.ok(created);
      // Le mot de passe généré doit réellement fonctionner pour se connecter.
      const verified = await userStore.verifyCredentials(
        "restored-user",
        result.generatedPasswords[0].password,
      );
      assert.ok(verified);
    },
  );

  await t.test("permissions : fusion additive, jamais de révocation", async () => {
    const user = await userStore.createUser({ username: "perm-user", password: "password123" });
    await userStore.grant(user.id, "app-a", "view");

    const backup = {
      format: format.FORMAT_MARKER,
      formatVersion: 1,
      metadata: {},
      data: {
        users: [{ username: "perm-user", isAdmin: false, role: null }],
        permissions: [{ username: "perm-user", appName: "app-b", action: "view" }],
      },
    };
    await backupService.restoreBackup(backup, { confirm: true });
    const withPerms = await userStore.getUserWithPermissions(user.id);
    const keys = withPerms.permissions.map((p) => `${p.appName}:${p.action}`);
    assert.ok(keys.includes("app-a:view")); // permission pré-existante conservée
    assert.ok(keys.includes("app-b:view")); // permission du backup ajoutée
  });

  await t.test("onConflict=skip (défaut) ne modifie jamais un enregistrement existant", async () => {
    const rule = await alertRulesStore.create({
      name: "mem-high",
      targetType: "system",
      metric: "memory",
      operator: ">",
      threshold: "80",
    });
    const backup = {
      format: format.FORMAT_MARKER,
      formatVersion: 1,
      metadata: {},
      data: {
        alertRules: [
          { name: "mem-high", targetType: "system", metric: "memory", operator: ">", threshold: "95" },
        ],
      },
    };
    const result = await backupService.restoreBackup(backup, { confirm: true, onConflict: "skip" });
    assert.equal(result.summary[0].skipped, 1);
    assert.equal(result.summary[0].conflicts.length, 1);
    const unchanged = await alertRulesStore.getById(rule.id);
    assert.equal(unchanged.threshold, "80");
  });

  await t.test("onConflict=overwrite met à jour l'enregistrement existant", async () => {
    const rule = await alertRulesStore.create({
      name: "disk-high",
      targetType: "system",
      metric: "disk",
      operator: ">",
      threshold: "80",
    });
    const backup = {
      format: format.FORMAT_MARKER,
      formatVersion: 1,
      metadata: {},
      data: {
        alertRules: [
          { name: "disk-high", targetType: "system", metric: "disk", operator: ">", threshold: "97" },
        ],
      },
    };
    const result = await backupService.restoreBackup(backup, { confirm: true, onConflict: "overwrite" });
    assert.equal(result.summary[0].updated, 1);
    const updated = await alertRulesStore.getById(rule.id);
    assert.equal(updated.threshold, "97");
  });

  await t.test("healthChecks restaurés avant serviceDependencies : le lien se résout par nom", async () => {
    const backup = {
      format: format.FORMAT_MARKER,
      formatVersion: 1,
      metadata: {},
      data: {
        healthChecks: [{ name: "api-health", type: "http", url: "http://localhost:3000/health" }],
        serviceDependencies: [
          { source: "web", target: "api", type: "HTTP", healthCheckName: "api-health", metadata: {} },
        ],
      },
    };
    await backupService.restoreBackup(backup, { confirm: true });
    const dep = await serviceDependenciesStore.findDuplicate({ source: "web", target: "api", type: "HTTP" });
    assert.ok(dep);
    const check = await healthChecksStore.getByName("api-health");
    assert.equal(dep.healthCheckId, check.id);
  });

  await t.test("apiKeys : jamais restaurées (informatif uniquement)", async () => {
    const backup = {
      format: format.FORMAT_MARKER,
      formatVersion: 1,
      metadata: {},
      data: { apiKeys: [{ name: "ci-key", keyPrefix: "pmk_abcd", scopes: ["metrics_read"] }] },
    };
    const before = await apiKeysStore.list();
    const result = await backupService.restoreBackup(backup, { confirm: true });
    assert.equal(result.summary[0].skipped, 1);
    const after = await apiKeysStore.list();
    assert.equal(after.length, before.length);
  });

  await t.test(
    "noms ambigus (plusieurs règles locales du même nom) -> conflit signalé, restauration ignorée",
    async () => {
      // Contrairement à alert_rules.name (pas de contrainte UNIQUE en base),
      // deux règles peuvent légitimement partager un nom localement.
      await alertRulesStore.create({
        name: "dup",
        targetType: "system",
        metric: "cpu",
        operator: ">",
        threshold: "1",
      });
      await alertRulesStore.create({
        name: "dup",
        targetType: "system",
        metric: "cpu",
        operator: ">",
        threshold: "2",
      });
      const backup = {
        format: format.FORMAT_MARKER,
        formatVersion: 1,
        metadata: {},
        data: {
          alertRules: [{ name: "dup", targetType: "system", metric: "cpu", operator: ">", threshold: "3" }],
        },
      };
      const result = await backupService.restoreBackup(backup, { confirm: true });
      assert.equal(result.summary[0].skipped, 1);
      assert.match(result.summary[0].conflicts[0].reason, /non-unique/);
    },
  );

  t.after(() => cleanupDb(dbCtx));
});

test("services/backup — restoreBackup() rollback transactionnel", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("une erreur dans une section restaure AUCUNE des sections précédentes", async () => {
    const usersBefore = (await userStore.listUsers()).length;

    const backup = {
      format: format.FORMAT_MARKER,
      formatVersion: 1,
      metadata: {},
      data: {
        users: [{ username: "rollback-user", isAdmin: false, role: null }],
        // targetType invalide : alertRulesStore.create() lève une exception
        // (validate()), ce qui doit annuler la création de l'utilisateur
        // ci-dessus (déjà "committée" dans la même transaction SQL).
        alertRules: [
          { name: "broken", targetType: "not-a-real-type", metric: "cpu", operator: ">", threshold: "1" },
        ],
      },
    };

    await assert.rejects(() => backupService.restoreBackup(backup, { confirm: true }));

    const usersAfter = (await userStore.listUsers()).length;
    assert.equal(usersAfter, usersBefore, "aucun utilisateur ne doit avoir été créé après rollback");
    assert.ok(!(await userStore.getByUsername("rollback-user")));
  });

  t.after(() => cleanupDb(dbCtx));
});

test("services/backup — validateBackup() est un dry-run (aucune écriture)", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test(
    "preview les créations sans rien écrire, et rend le même résultat au restore réel",
    async () => {
      const usersBefore = (await userStore.listUsers()).length;
      const backup = {
        format: format.FORMAT_MARKER,
        formatVersion: 1,
        metadata: {},
        data: {
          users: [{ username: "preview-user", isAdmin: false, role: null }],
          permissions: [{ username: "preview-user", appName: "app-a", action: "view" }],
        },
      };
      const preview = await backupService.validateBackup(backup);
      assert.equal(preview.summary.find((s) => s.section === "users").created, 1);
      assert.equal(preview.summary.find((s) => s.section === "permissions").created, 1);
      assert.equal((await userStore.listUsers()).length, usersBefore, "validateBackup ne doit rien écrire");

      await backupService.restoreBackup(backup, { confirm: true });
      assert.equal((await userStore.listUsers()).length, usersBefore + 1);
    },
  );

  t.after(() => cleanupDb(dbCtx));
});

test("services/backup — crypto (chiffrement dédié des secrets de backup)", async (t) => {
  await t.test("encrypt()/decrypt() round-trip, isConfigured() reflète BACKUP_ENCRYPTION_KEY", () => {
    process.env.BACKUP_ENCRYPTION_KEY = "another-test-key";
    assert.equal(backupCrypto.isConfigured(), true);
    const enc = backupCrypto.encrypt({ token: "abc123" });
    assert.notEqual(enc, null);
    assert.ok(!enc.includes("abc123"));
    assert.deepEqual(backupCrypto.decrypt(enc), { token: "abc123" });
    delete process.env.BACKUP_ENCRYPTION_KEY;
  });

  await t.test("encrypt() sans clé configurée lève une erreur explicite", () => {
    delete process.env.BACKUP_ENCRYPTION_KEY;
    assert.throws(() => backupCrypto.encrypt({ a: 1 }), /BACKUP_ENCRYPTION_KEY/);
  });

  await t.test("null/undefined passent au travers sans erreur", () => {
    process.env.BACKUP_ENCRYPTION_KEY = "yet-another-test-key";
    assert.equal(backupCrypto.encrypt(null), null);
    assert.equal(backupCrypto.decrypt(null), null);
    delete process.env.BACKUP_ENCRYPTION_KEY;
  });
});
