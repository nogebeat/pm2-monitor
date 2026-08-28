"use strict";

/**
 * Registre des sections de backup (Phase 19). Chaque section sait :
 *  - s'exporter (lire la config pertinente, jamais les données runtime/
 *    temporaires — voir docs/backup-restore/README.md, section "Ce qui est
 *    sauvegardé") ;
 *  - se restaurer par FUSION (merge) plutôt que par remplacement destructif :
 *    un enregistrement existant est identifié par une CLÉ NATURELLE (nom,
 *    username, server_key, triplet (source,target,type)…) — jamais par son
 *    id numérique, qui n'a aucune raison de coïncider entre deux instances.
 *    S'il existe déjà, il est mis à jour (mode "overwrite") ou laissé tel
 *    quel et signalé en conflit (mode "skip", par défaut) ; sinon il est créé.
 *
 * Champs volontairement JAMAIS restaurés par ce module, quelle que soit la
 * section (voir docs/backup-restore/README.md pour le détail complet) :
 *  - toute colonne d'ÉTAT RUNTIME (status, last_seen_at, consecutive_*,
 *    last_snapshot…) : ce n'est pas de la configuration, la resynchronisation
 *    se fait naturellement au prochain cycle de collecte ;
 *  - toute colonne created_by/updated_by/acknowledged_by/actor_user_id
 *    référençant un id utilisateur d'une AUTRE section que `users` : l'id
 *    numérique d'origine n'a aucune raison d'exister sur l'instance cible,
 *    et deviner un mauvais mapping serait pire que de le vider (mis à NULL,
 *    ces colonnes sont toutes nullable) ;
 *  - tout secret exploitable tel quel (password_hash, token_hash, key_hash) —
 *    voir la section correspondante pour le traitement spécifique.
 *
 * Chaque restore(...) réutilise le store existant du domaine quand celui-ci
 * expose une primitive suffisante (validation + écriture), pour ne dupliquer
 * ni la validation métier ni les contraintes déjà appliquées ailleurs.
 */

const db = require("../../db");
const backupCrypto = require("./crypto");

const userStore = require("../../user-store");
const orgStore = require("../process-organization/store");
const alertRulesStore = require("../alerts/alert-rules-store");
const providerStore = require("../notifications/provider-store");
const routeStore = require("../notifications/routing/route-store");
const healthChecksStore = require("../health-checks/store");
const autoHealingSettingsStore = require("../auto-healing/settings-store");
const silenceStore = require("../incidents/silence-store");
const serversStore = require("../servers/store");
const serviceDependenciesStore = require("../service-dependencies/store");
const apiKeysStore = require("../api-keys/store");

const crypto = require("crypto");

// --- Utilitaires communs ----------------------------------------------------

function emptyResult() {
  return { created: 0, updated: 0, skipped: 0, conflicts: [] };
}

function addConflict(result, key, reason) {
  result.skipped += 1;
  result.conflicts.push({ key, reason });
}

/** Trouve un unique élément de `list` vérifiant `pred`. Signale une ambiguïté si plusieurs matchent. */
function findUnique(list, pred, key, result) {
  const matches = list.filter(pred);
  if (matches.length > 1) {
    addConflict(
      result,
      key,
      "Plusieurs éléments locaux correspondent à cette clé (nom non-unique) : restauration ignorée, à résoudre manuellement.",
    );
    return { ambiguous: true, match: null };
  }
  return { ambiguous: false, match: matches[0] || null };
}

/** Génère un mot de passe temporaire fort pour un utilisateur recréé sans secret (voir section "users"). */
function generateTempPassword() {
  return crypto.randomBytes(18).toString("base64url");
}

// --- users / permissions -----------------------------------------------------

const usersSection = {
  id: "users",
  label: "Utilisateurs",
  defaultIncluded: true,
  containsSecrets: false, // password_hash n'est jamais exporté par cette section (voir ci-dessous)
  async export() {
    const rows = await db.all(
      "SELECT username, is_admin, role, created_at FROM users ORDER BY username ASC",
      [],
    );
    return rows.map((r) => ({
      username: r.username,
      isAdmin: !!r.is_admin,
      role: r.role || null,
      createdAt: Number(r.created_at),
    }));
  },
  async restore(rows, ctx) {
    const result = emptyResult();
    ctx.userIdByUsername = ctx.userIdByUsername || new Map();
    ctx.generatedPasswords = ctx.generatedPasswords || [];

    for (const entry of rows || []) {
      const username = String(entry.username || "")
        .trim()
        .toLowerCase();
      if (!username) {
        addConflict(result, "(vide)", "username manquant, entrée ignorée.");
        continue;
      }
      const existing = await userStore.getByUsername(username);
      if (existing) {
        ctx.userIdByUsername.set(username, existing.id);
        if (ctx.onConflict === "overwrite") {
          if (!ctx.dryRun) {
            await userStore.setAdmin(existing.id, !!entry.isAdmin);
            if (entry.role) {
              await db.run("UPDATE users SET role = ? WHERE id = ?", [entry.role, existing.id]);
            }
          }
          result.updated += 1;
        } else {
          addConflict(result, username, "Utilisateur déjà existant (mot de passe/permissions non modifiés).");
        }
        continue;
      }

      if (ctx.dryRun) {
        // Pas de création réelle en mode validation : un identifiant
        // "sentinelle" (non numérique) est tout de même posé pour que les
        // sections dépendantes (permissions) ne signalent pas à tort
        // "utilisateur introuvable" pour un utilisateur qui SERA créé au
        // moment de la restauration réelle — voir permissionsSection.restore.
        ctx.userIdByUsername.set(username, `pending:${username}`);
        result.created += 1;
        continue;
      }

      // Aucun mot de passe dans le backup (jamais exporté, voir en-tête de
      // fichier) : un mot de passe temporaire fort est généré et retourné
      // UNE SEULE FOIS dans le résultat de restauration — même pattern que
      // la révélation d'un secret de clé API à sa création (voir
      // lib/services/api-keys/store.js). L'administrateur doit le
      // transmettre à l'utilisateur et lui demander de le changer.
      const tempPassword = generateTempPassword();
      const created = await userStore.createUser({
        username,
        password: tempPassword,
        isAdmin: !!entry.isAdmin,
      });
      if (entry.role) {
        await db.run("UPDATE users SET role = ? WHERE id = ?", [entry.role, created.id]);
      }
      ctx.userIdByUsername.set(username, created.id);
      ctx.generatedPasswords.push({ username, password: tempPassword });
      result.created += 1;
    }
    return result;
  },
};

const permissionsSection = {
  id: "permissions",
  label: "Permissions",
  defaultIncluded: true,
  containsSecrets: false,
  dependsOn: ["users"],
  async export() {
    const rows = await db.all(
      `SELECT u.username AS username, p.app_name AS app_name, p.action AS action
       FROM permissions p JOIN users u ON u.id = p.user_id
       ORDER BY u.username ASC, p.app_name ASC, p.action ASC`,
      [],
    );
    return rows.map((r) => ({ username: r.username, appName: r.app_name, action: r.action }));
  },
  async restore(rows, ctx) {
    // Fusion strictement ADDITIVE : une permission absente du backup n'est
    // jamais révoquée automatiquement (voir docs/backup-restore/README.md —
    // éviter qu'une restauration partielle ne retire silencieusement des
    // droits). `onConflict` n'a pas de sens ici (rien à écraser, une
    // permission existe ou pas) : ignoré pour cette section.
    const result = emptyResult();
    for (const entry of rows || []) {
      const username = String(entry.username || "")
        .trim()
        .toLowerCase();
      const userId = ctx.userIdByUsername && ctx.userIdByUsername.get(username);
      if (!userId) {
        addConflict(
          result,
          `${username}:${entry.appName}:${entry.action}`,
          "Utilisateur introuvable (section users non restaurée ou en conflit).",
        );
        continue;
      }
      if (!entry.appName || !entry.action) continue;
      if (!ctx.dryRun) {
        await userStore.grant(userId, entry.appName, entry.action);
      }
      result.created += 1;
    }
    return result;
  },
};

// --- Organisation des process (tags/environnements/groupes + assignations) --

const processOrganizationSection = {
  id: "processOrganization",
  label: "Tags / Environnements / Groupes",
  defaultIncluded: true,
  containsSecrets: false,
  async export() {
    const [tags, environments, groups, assignments] = await Promise.all([
      orgStore.listTags(),
      orgStore.listEnvironments(),
      orgStore.listGroups(),
      orgStore.listAssignments(),
    ]);
    return {
      tags: tags.map((t) => ({ name: t.name, color: t.color })),
      environments: environments.map((e) => ({ name: e.name, color: e.color })),
      groups: groups.map((g) => ({ name: g.name, description: g.description })),
      // `assignments` vient de listAssignments() (lib/services/process-organization/store.js) :
      // une ligne par process avec ses tags/environnement/groupes actuels.
      assignments: (assignments || []).map((a) => ({
        serverKey: a.serverKey,
        processName: a.processName,
        tags: (a.tags || []).map((t) => t.name),
        environment: a.environment ? a.environment.name : null,
        groups: (a.groups || []).map((g) => g.name),
      })),
    };
  },
  async restore(data, ctx) {
    const result = emptyResult();
    const tagIdByName = new Map();
    const environmentIdByName = new Map();
    const groupIdByName = new Map();

    async function upsertCatalog(store, list, idMap) {
      const existingList = await store.list();
      for (const entry of list || []) {
        const name = String(entry.name || "").trim();
        if (!name) continue;
        const existing = existingList.find((e) => e.name === name);
        if (existing) {
          idMap.set(name, existing.id);
          if (ctx.onConflict === "overwrite" && !ctx.dryRun) {
            await store.update(existing.id, entry);
          }
          if (ctx.onConflict !== "overwrite") {
            result.skipped += 1; // pas un vrai "conflit" bloquant : le catalogue existant est réutilisé tel quel
          } else {
            result.updated += 1;
          }
          continue;
        }
        if (ctx.dryRun) {
          result.created += 1;
          continue;
        }
        const created = await store.create(entry);
        idMap.set(name, created.id);
        result.created += 1;
      }
    }

    await upsertCatalog(
      { list: orgStore.listTags, create: orgStore.createTag, update: orgStore.updateTag },
      data.tags,
      tagIdByName,
      "tag",
    );
    await upsertCatalog(
      {
        list: orgStore.listEnvironments,
        create: orgStore.createEnvironment,
        update: orgStore.updateEnvironment,
      },
      data.environments,
      environmentIdByName,
      "environment",
    );
    await upsertCatalog(
      { list: orgStore.listGroups, create: orgStore.createGroup, update: orgStore.updateGroup },
      data.groups,
      groupIdByName,
      "group",
    );

    if (!ctx.dryRun) {
      for (const a of data.assignments || []) {
        const tagIds = (a.tags || []).map((n) => tagIdByName.get(n)).filter(Boolean);
        const environmentId = a.environment ? environmentIdByName.get(a.environment) || null : null;
        const groupIds = (a.groups || []).map((n) => groupIdByName.get(n)).filter(Boolean);
        await orgStore.assignProcess({
          processName: a.processName,
          serverKey: a.serverKey,
          tagIds,
          environmentId,
          groups: groupIds,
        });
      }
    }
    ctx.tagIdByName = tagIdByName;
    ctx.environmentIdByName = environmentIdByName;
    ctx.groupIdByName = groupIdByName;
    return result;
  },
};

// --- Alert rules --------------------------------------------------------

const alertRulesSection = {
  id: "alertRules",
  label: "Règles d'alerte",
  defaultIncluded: true,
  containsSecrets: false,
  async export() {
    const rules = await alertRulesStore.list();
    return rules.map((r) => ({
      name: r.name,
      description: r.description,
      enabled: r.enabled,
      targetType: r.targetType,
      targetValue: r.targetValue,
      metric: r.metric,
      operator: r.operator,
      threshold: r.threshold,
      durationSeconds: r.durationSeconds,
      severity: r.severity,
      cooldownSeconds: r.cooldownSeconds,
    }));
  },
  async restore(rows, ctx) {
    const result = emptyResult();
    const existingList = await alertRulesStore.list();
    for (const entry of rows || []) {
      const { ambiguous, match } = findUnique(existingList, (r) => r.name === entry.name, entry.name, result);
      if (ambiguous) continue;
      if (match) {
        if (ctx.onConflict === "overwrite") {
          if (!ctx.dryRun) await alertRulesStore.update(match.id, entry);
          result.updated += 1;
        } else {
          addConflict(result, entry.name, "Règle d'alerte de même nom déjà existante.");
        }
        continue;
      }
      if (!ctx.dryRun) await alertRulesStore.create(entry);
      result.created += 1;
    }
    return result;
  },
};

// --- Notifications (providers + routes/templates) --------------------------

const notificationsSection = {
  id: "notifications",
  label: "Notifications (providers, routing, templates)",
  defaultIncluded: true,
  containsSecrets: true, // uniquement si includeSecrets=true est demandé explicitement
  async export({ includeSecrets } = {}) {
    const providers = await providerStore.list();
    const providerExports = [];
    for (const p of providers) {
      const entry = {
        name: p.name,
        type: p.type,
        enabled: p.enabled,
        configuration: p.configuration,
        hasSecrets: p.hasSecrets,
      };
      if (includeSecrets && p.hasSecrets) {
        // Les secrets sont déchiffrés ici (clé NOTIFICATIONS_ENCRYPTION_KEY,
        // déjà en mémoire côté serveur) puis RE-chiffrés avec la clé dédiée
        // du backup (BACKUP_ENCRYPTION_KEY, voir crypto.js) — jamais stockés
        // en clair dans le fichier de backup, jamais avec la même clé que la
        // base de données source (voir crypto.js pour la justification).
        const plain = await providerStore.getDecryptedSecrets(p.id);
        entry.secretsEncrypted = backupCrypto.encrypt(plain);
      }
      providerExports.push(entry);
    }

    const routes = await routeStore.list();
    const providerNameById = new Map(providers.map((p) => [p.id, p.name]));
    const routeExports = routes.map((r) => ({
      name: r.name,
      enabled: r.enabled,
      conditions: r.conditions,
      providerNames: (r.providerIds || []).map((id) => providerNameById.get(id)).filter(Boolean),
      titleTemplate: r.titleTemplate,
      messageTemplate: r.messageTemplate,
      notifyOnResolve: r.notifyOnResolve,
    }));

    return { providers: providerExports, routes: routeExports };
  },
  async restore(data, ctx) {
    const result = emptyResult();
    const providerIdByName = new Map();

    const existingProviders = await providerStore.list();
    for (const entry of data.providers || []) {
      const key = `${entry.name} (${entry.type})`;
      const { ambiguous, match } = findUnique(
        existingProviders,
        (p) => p.name === entry.name && p.type === entry.type,
        key,
        result,
      );
      if (ambiguous) continue;

      let secrets;
      if (entry.secretsEncrypted !== undefined) {
        try {
          secrets = backupCrypto.decrypt(entry.secretsEncrypted);
        } catch (e) {
          addConflict(
            result,
            key,
            `Secrets du provider illisibles (${e.message}) — provider restauré sans secrets.`,
          );
          secrets = undefined;
        }
      }

      if (match) {
        if (ctx.onConflict === "overwrite") {
          if (!ctx.dryRun) {
            const changes = { enabled: entry.enabled, configuration: entry.configuration };
            if (secrets !== undefined) changes.secrets = secrets;
            await providerStore.update(match.id, changes);
          }
          providerIdByName.set(entry.name, match.id);
          result.updated += 1;
        } else {
          addConflict(result, key, "Provider de notification de même nom/type déjà existant.");
          providerIdByName.set(entry.name, match.id);
        }
        continue;
      }
      if (ctx.dryRun) {
        result.created += 1;
        continue;
      }
      const created = await providerStore.create({
        name: entry.name,
        type: entry.type,
        enabled: entry.enabled,
        configuration: entry.configuration,
        secrets: secrets || undefined,
      });
      providerIdByName.set(entry.name, created.id);
      result.created += 1;
    }

    const existingRoutes = await routeStore.list();
    for (const entry of data.routes || []) {
      const providerIds = (entry.providerNames || []).map((n) => providerIdByName.get(n)).filter(Boolean);
      const payload = {
        name: entry.name,
        enabled: entry.enabled,
        conditions: entry.conditions,
        providerIds,
        titleTemplate: entry.titleTemplate,
        messageTemplate: entry.messageTemplate,
        notifyOnResolve: entry.notifyOnResolve,
      };
      const { ambiguous, match } = findUnique(
        existingRoutes,
        (r) => r.name === entry.name,
        entry.name,
        result,
      );
      if (ambiguous) continue;
      if (match) {
        if (ctx.onConflict === "overwrite") {
          if (!ctx.dryRun) await routeStore.update(match.id, payload);
          result.updated += 1;
        } else {
          addConflict(result, entry.name, "Règle de routing de notification de même nom déjà existante.");
        }
        continue;
      }
      if (!ctx.dryRun) await routeStore.create(payload);
      result.created += 1;
    }

    return result;
  },
};

// --- Health checks -----------------------------------------------------

const healthChecksSection = {
  id: "healthChecks",
  label: "Health Checks",
  defaultIncluded: true,
  containsSecrets: false,
  async export() {
    const checks = await healthChecksStore.list();
    return checks.map((c) => ({
      name: c.name,
      processName: c.processName,
      type: c.type,
      enabled: c.enabled,
      url: c.url,
      method: c.method,
      expectedStatus: c.expectedStatus,
      expectedContent: c.expectedContent,
      host: c.host,
      port: c.port,
      command: c.command,
      commandArgs: c.commandArgs,
      expectedExitCode: c.expectedExitCode,
      timeoutMs: c.timeoutMs,
      intervalSeconds: c.intervalSeconds,
      degradedThresholdMs: c.degradedThresholdMs,
    }));
  },
  async restore(rows, ctx) {
    const result = emptyResult();
    ctx.healthCheckIdByName = ctx.healthCheckIdByName || new Map();
    for (const entry of rows || []) {
      const existing = await healthChecksStore.getByName(entry.name);
      if (existing) {
        ctx.healthCheckIdByName.set(entry.name, existing.id);
        if (ctx.onConflict === "overwrite") {
          if (!ctx.dryRun) await healthChecksStore.update(existing.id, entry);
          result.updated += 1;
        } else {
          addConflict(result, entry.name, "Health check de même nom déjà existant.");
        }
        continue;
      }
      if (ctx.dryRun) {
        result.created += 1;
        continue;
      }
      const created = await healthChecksStore.create(entry);
      ctx.healthCheckIdByName.set(entry.name, created.id);
      result.created += 1;
    }
    return result;
  },
};

// --- Auto-healing (configuration globale uniquement) ------------------------

const autoHealingSection = {
  id: "autoHealing",
  label: "Auto-Healing (configuration)",
  defaultIncluded: true,
  containsSecrets: false,
  async export() {
    const settings = await autoHealingSettingsStore.get();
    // enabled n'est PAS restauré automatiquement à true : redémarrer des
    // process automatiquement est une action à risque (voir
    // docs/auto-healing/README.md), une restauration ne doit jamais
    // réactiver silencieusement cette fonctionnalité sur une instance où
    // elle était éteinte. On l'exporte quand même pour référence/audit.
    return {
      enabled: settings.enabled,
      maxAttempts: settings.maxAttempts,
      backoffSeconds: settings.backoffSeconds,
    };
  },
  async restore(entry, ctx) {
    const result = emptyResult();
    if (!entry) return result;
    if (!ctx.dryRun) {
      await autoHealingSettingsStore.update({
        // `enabled` volontairement exclu de la restauration (voir export ci-dessus).
        maxAttempts: entry.maxAttempts,
        backoffSeconds: entry.backoffSeconds,
      });
    }
    result.updated += 1;
    return result;
  },
};

// --- Alert silences (uniquement les silences actifs, pas l'historique) -----

const alertSilencesSection = {
  id: "alertSilences",
  label: "Silences d'alerte actifs",
  defaultIncluded: false, // opt-in : donnée opérationnelle/temporaire, pas de la configuration pure
  containsSecrets: false,
  async export() {
    const silences = await silenceStore.listActive();
    return silences
      .filter((s) => s.active)
      .map((s) => ({
        scopeType: s.scopeType,
        scopeValue: s.scopeValue,
        silenceType: s.silenceType,
        expiresAt: s.expiresAt,
        reason: s.reason,
      }));
  },
  async restore(rows, ctx) {
    const result = emptyResult();
    const existing = await silenceStore.listActive();
    for (const entry of rows || []) {
      const isDuplicate = existing.some(
        (s) =>
          s.scopeType === entry.scopeType &&
          s.scopeValue === entry.scopeValue &&
          s.expiresAt === entry.expiresAt,
      );
      if (isDuplicate) {
        result.skipped += 1;
        continue;
      }
      if (entry.expiresAt <= Date.now()) {
        result.skipped += 1; // déjà expiré entre l'export et la restauration : rien à faire
        continue;
      }
      if (!ctx.dryRun) await silenceStore.create(entry);
      result.created += 1;
    }
    return result;
  },
};

// --- Servers (multi-server / intégrations) + scoping utilisateur -----------

const serversSection = {
  id: "servers",
  label: "Serveurs (multi-server) & accès utilisateurs",
  defaultIncluded: true,
  containsSecrets: false, // token_hash n'est jamais exporté (voir restore ci-dessous)
  dependsOn: ["users"],
  async export() {
    const servers = await serversStore.list();
    const userServersRows = await db.all(
      `SELECT u.username AS username, us.server_key AS server_key
       FROM user_servers us JOIN users u ON u.id = us.user_id
       ORDER BY u.username ASC, us.server_key ASC`,
      [],
    );
    return {
      servers: servers
        .filter((s) => s.kind !== "local") // le serveur "local" est recréé automatiquement au démarrage
        .map((s) => ({
          serverKey: s.serverKey,
          name: s.name,
          hostname: s.hostname,
          environment: s.environment,
          enabled: s.enabled,
        })),
      userServers: userServersRows.map((r) => ({ username: r.username, serverKey: r.server_key })),
    };
  },
  async restore(data, ctx) {
    // servers/store.js#create() génère toujours une nouvelle server_key +
    // un nouveau token (par design sécurité, voir ce fichier) : on ne peut
    // donc pas s'appuyer dessus pour restaurer l'identité EXACTE d'un
    // serveur existant. On écrit directement les colonnes de configuration
    // (jamais token_hash/status/last_seen_at/last_snapshot — voir en-tête
    // de fichier), en conservant server_key comme clé naturelle : un agent
    // restauré devra de toute façon être ré-approvisionné avec un nouveau
    // token (voir docs/backup-restore/README.md).
    const result = emptyResult();
    for (const entry of data.servers || []) {
      const existing = await serversStore.getByKey(entry.serverKey);
      if (existing) {
        if (ctx.onConflict === "overwrite") {
          if (!ctx.dryRun) {
            await db.run(
              "UPDATE servers SET name = ?, hostname = ?, environment = ?, enabled = ?, updated_at = ? WHERE server_key = ?",
              [
                entry.name,
                entry.hostname || null,
                entry.environment || "production",
                entry.enabled ? 1 : 0,
                Date.now(),
                entry.serverKey,
              ],
            );
          }
          result.updated += 1;
        } else {
          addConflict(result, entry.serverKey, "Serveur de même server_key déjà existant.");
        }
        continue;
      }
      if (!ctx.dryRun) {
        const now = Date.now();
        await db.run(
          `INSERT INTO servers
            (server_key, name, hostname, environment, kind, enabled, status, token_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'agent', ?, 'PENDING', NULL, ?, ?)`,
          [
            entry.serverKey,
            entry.name,
            entry.hostname || null,
            entry.environment || "production",
            entry.enabled ? 1 : 0,
            now,
            now,
          ],
        );
      }
      result.created += 1;
    }

    if (!ctx.dryRun) {
      for (const entry of data.userServers || []) {
        const userId =
          ctx.userIdByUsername && ctx.userIdByUsername.get(String(entry.username || "").toLowerCase());
        if (!userId) continue;
        await db.run(
          db.driver === "mysql"
            ? "INSERT IGNORE INTO user_servers (user_id, server_key, created_at) VALUES (?, ?, ?)"
            : "INSERT OR IGNORE INTO user_servers (user_id, server_key, created_at) VALUES (?, ?, ?)",
          [userId, entry.serverKey, Date.now()],
        );
      }
    }
    return result;
  },
};

// --- Service dependencies -----------------------------------------------

const serviceDependenciesSection = {
  id: "serviceDependencies",
  label: "Dépendances de service (intégrations)",
  defaultIncluded: true,
  containsSecrets: false,
  dependsOn: ["healthChecks"],
  async export() {
    const deps = await serviceDependenciesStore.list();
    const checks = await healthChecksStore.list();
    const nameById = new Map(checks.map((c) => [c.id, c.name]));
    return deps.map((d) => ({
      source: d.source,
      target: d.target,
      type: d.type,
      enabled: d.enabled,
      description: d.description,
      healthCheckName: d.healthCheckId ? nameById.get(d.healthCheckId) || null : null,
      metadata: d.metadata,
    }));
  },
  async restore(rows, ctx) {
    const result = emptyResult();
    for (const entry of rows || []) {
      const key = `${entry.source} → ${entry.target} (${entry.type})`;
      const existing = await serviceDependenciesStore.findDuplicate({
        source: entry.source,
        target: entry.target,
        type: entry.type,
      });
      const healthCheckId =
        entry.healthCheckName && ctx.healthCheckIdByName
          ? ctx.healthCheckIdByName.get(entry.healthCheckName) || null
          : null;
      const payload = {
        source: entry.source,
        target: entry.target,
        type: entry.type,
        enabled: entry.enabled,
        description: entry.description,
        healthCheckId,
        metadata: entry.metadata,
      };
      if (existing) {
        if (ctx.onConflict === "overwrite") {
          if (!ctx.dryRun) await serviceDependenciesStore.update(existing.id, payload);
          result.updated += 1;
        } else {
          addConflict(result, key, "Dépendance de service identique (source/target/type) déjà existante.");
        }
        continue;
      }
      if (!ctx.dryRun) {
        try {
          await serviceDependenciesStore.create(payload);
        } catch (e) {
          // Le store rejette une dépendance qui introduirait un cycle
          // (assertNoCycle) : signalé comme conflit plutôt que de faire
          // échouer toute la restauration pour une seule arête récursive.
          addConflict(result, key, e.message);
          continue;
        }
      }
      result.created += 1;
    }
    return result;
  },
};

// --- API keys (informatif uniquement — jamais restaurées telles quelles) ---

const apiKeysSection = {
  id: "apiKeys",
  label: "Clés API (informatif — non restaurable)",
  defaultIncluded: true,
  containsSecrets: false, // key_hash n'est jamais lu par apiKeysStore.list(), donc jamais exporté
  async export() {
    const keys = await apiKeysStore.list();
    return keys.map((k) => ({
      name: k.name,
      keyPrefix: k.keyPrefix,
      scopes: k.scopes,
      resourceScopes: k.resourceScopes,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
    }));
  },
  // Une clé API est authentifiée par key_hash (SHA-256 du secret en clair,
  // voir lib/services/api-keys/store.js) : sans le secret original — jamais
  // exporté, jamais récupérable — une ligne restaurée ne serait qu'un
  // simulacre inutilisable pour authentifier quoi que ce soit. Cette
  // section reste donc purement informative (liste des clés qui existaient
  // à l'export, pour référence/audit) ; la restauration ne crée aucune
  // ligne et se contente de compter les entrées listées.
  async restore(rows) {
    const result = emptyResult();
    result.skipped = (rows || []).length;
    if (result.skipped) {
      result.conflicts.push({
        key: "*",
        reason:
          "Les clés API ne sont jamais restaurées (secret non récupérable) : à recréer manuellement si besoin.",
      });
    }
    return result;
  },
};

// --- Registre ordonné (ordre de restauration = ordre des dépendances) ------

const SECTIONS = [
  usersSection,
  permissionsSection,
  processOrganizationSection,
  healthChecksSection,
  alertRulesSection,
  notificationsSection,
  autoHealingSection,
  alertSilencesSection,
  serversSection,
  serviceDependenciesSection,
  apiKeysSection,
];

function getSection(id) {
  return SECTIONS.find((s) => s.id === id);
}

module.exports = { SECTIONS, getSection, generateTempPassword };
