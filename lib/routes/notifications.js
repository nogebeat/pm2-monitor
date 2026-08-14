"use strict";

/**
 * Routes REST du notification system. Toute la logique vit dans
 * lib/services/notifications/ ; ce module ne fait que valider la requête
 * HTTP, appeler le service, et formater la réponse — même découpage que
 * lib/routes/alerts.js et lib/routes/events.js.
 *
 * Phase 5C : CRUD complet des providers (POST/PUT/PATCH/DELETE), test d'une
 * configuration exposé en HTTP (les providers savent déjà le faire en
 * interne depuis la Phase 5B, voir lib/services/notifications/types.js#test).
 *
 * Phase 5D : CRUD des règles de routing (`/routes`, permission
 * `notifications_manage` en écriture — voir lib/permissions.js) et lecture
 * de l'historique d'envoi (`/history`, permission `notifications_history`).
 * Le matching des conditions et le dispatch effectif (templates + envoi)
 * vivent dans lib/services/notifications/routing/engine.js, branché sur
 * l'Alert Engine depuis server.js — ce routeur ne fait qu'exposer le CRUD
 * du modèle de règle et la lecture de l'historique qu'il produit.
 *
 * Monté dans server.js via `app.use("/api/notifications", require("./lib/routes/notifications")())`.
 *
 * Phase 9 : audit sur create/update/delete des providers ET des règles de
 * routing — zone la plus sensible de tout l'audit (SMTP password, webhooks
 * Discord/Slack, tokens Telegram). Règle stricte respectée partout ici :
 * `metadata` ne contient JAMAIS de valeur de champ, seulement des CLÉS
 * (noms de champs modifiés/fournis) — voir `changedFieldKeys()` ci-dessous.
 * `sanitizeAuditMetadata()` (appelé systématiquement par recordEvent) reste
 * le filet de sécurité final, mais ce module ne s'appuie pas dessus pour
 * décider quoi logger : aucune valeur de `fields`/`secrets` ne quitte jamais
 * cette fonction vers `metadata`.
 */

const express = require("express");
const auth = require("../auth");
const { registry, manager, providerStore, routeStore, historyStore } = require("../services/notifications");
const { recordEvent, ACTIONS } = require("../services/audit");

/**
 * Ne retourne QUE les noms de clés d'un objet `fields` (jamais les valeurs) —
 * utilisé pour peupler `metadata.fields` dans l'audit d'un provider. Un
 * champ secret (webhookUrl, smtpPassword, apiKey…) ou public (name, url…)
 * apparaît donc dans l'audit uniquement comme "ce champ a été modifié", sans
 * jamais exposer ce qu'il contient.
 */
function changedFieldKeys(fields) {
  return Object.keys(fields || {});
}

/**
 * Scinde un objet `fields` (formulaire admin fusionné : champs publics +
 * secrets) en `configuration` (public) / `secrets` (chiffré), en se basant
 * sur `provider.secretFields` — jamais de connaissance de provider en dur
 * ici (voir types.js).
 */
function splitFields(type, fields) {
  const provider = registry.getProvider(type);
  const secretKeys = new Set((provider && provider.secretFields) || []);
  const configuration = {};
  const secrets = {};
  let hasSecrets = false;
  for (const [key, value] of Object.entries(fields || {})) {
    if (secretKeys.has(key)) {
      secrets[key] = value;
      hasSecrets = true;
    } else {
      configuration[key] = value;
    }
  }
  return { configuration, secrets: hasSecrets ? secrets : undefined };
}

/** Erreur "type inconnu" normalisée (même message en create/update/test). */
function unknownTypeError(type) {
  return `Type de provider inconnu : "${type}".`;
}

function createNotificationsRouter() {
  const router = express.Router();

  // --- Lecture -------------------------------------------------------------

  // Catalogue des types de providers connus (`implemented: true` depuis la
  // Phase 5B — voir lib/services/notifications/manager.js). Utile pour
  // construire un formulaire côté frontend, même schéma que GET
  // /api/alerts/catalog.
  router.get("/provider-types", auth.requirePermission("notifications_read"), (req, res) => {
    res.json(manager.listProviderTypes());
  });

  // Configurations de providers déjà enregistrées. Les secrets ne sont
  // jamais renvoyés (voir provider-store.js#rowToProvider : uniquement
  // `hasSecrets`, jamais leur contenu déchiffré).
  router.get("/providers", auth.requirePermission("notifications_read"), async (req, res) => {
    try {
      const type = req.query.type || undefined;
      if (type && !registry.hasProvider(type)) {
        return res.status(400).json({ error: unknownTypeError(type) });
      }
      res.json(await providerStore.list({ type }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/providers/:id", auth.requirePermission("notifications_read"), async (req, res) => {
    try {
      const provider = await providerStore.getById(Number(req.params.id));
      if (!provider) return res.status(404).json({ error: "Configuration de provider introuvable." });
      res.json(provider);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Création --------------------------------------------------------------

  router.post("/providers", auth.requirePermission("notifications_create"), async (req, res) => {
    const body = req.body || {};
    const type = body.type ? String(body.type).trim() : "";
    try {
      if (!type || !registry.hasProvider(type)) {
        recordEvent({
          user: req.user,
          action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
          targetType: "notification_provider",
          status: "failed",
          ip: req.ip,
          metadata: { op: "create_provider", type: type || null, error: "type inconnu" },
        });
        return res.status(400).json({ error: unknownTypeError(type || "(vide)") });
      }

      const { configuration, secrets } = splitFields(type, body.fields || {});
      const validationErrors = manager.validateProviderConfig(type, { ...configuration, ...secrets });
      if (validationErrors.length) {
        recordEvent({
          user: req.user,
          action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
          targetType: "notification_provider",
          status: "failed",
          ip: req.ip,
          // Jamais les valeurs de fields, seulement les clés fournies.
          metadata: { op: "create_provider", type, fields: changedFieldKeys(body.fields), error: "validation" },
        });
        return res.status(400).json({ error: validationErrors.join(" ") });
      }

      const created = await providerStore.create({
        name: body.name,
        type,
        enabled: body.enabled,
        configuration,
        secrets,
      });
      recordEvent({
        user: req.user,
        action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
        target: created.name || String(created.id),
        targetType: "notification_provider",
        status: "success",
        ip: req.ip,
        metadata: { op: "create_provider", providerId: created.id, type, fields: changedFieldKeys(body.fields) },
      });
      res.status(201).json(created);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
        targetType: "notification_provider",
        status: "failed",
        ip: req.ip,
        metadata: { op: "create_provider", type: type || null, error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  });

  // --- Modification ------------------------------------------------------

  /**
   * PATCH (partiel) et PUT (remplacement complet) partagent la même
   * logique : le `type` d'une configuration ne peut pas être changé une
   * fois créée (les champs publics/secrets d'un provider à l'autre ne sont
   * pas compatibles — recréer une configuration plutôt que la migrer).
   *
   * Secrets : un champ secret absent de `fields` = "☑ Keep existing
   * credential" côté UI (Section 4 de la tâche) — la valeur déjà stockée
   * est conservée pour cette clé précise. Un champ secret présent (même
   * vide) remplace la valeur existante.
   */
  async function updateProvider(req, res) {
    try {
      const id = Number(req.params.id);
      const existing = await providerStore.getById(id);
      if (!existing) return res.status(404).json({ error: "Configuration de provider introuvable." });

      const body = req.body || {};
      if (body.type !== undefined && String(body.type).trim() !== existing.type) {
        recordEvent({
          user: req.user,
          action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
          target: existing.name || String(existing.id),
          targetType: "notification_provider",
          status: "failed",
          ip: req.ip,
          metadata: { op: "update_provider", providerId: id, error: "changement de type refusé" },
        });
        return res.status(400).json({
          error: "Le type d'une configuration de provider ne peut pas être modifié (supprime puis recrée).",
        });
      }

      const changes = {};
      if (body.name !== undefined) changes.name = body.name;
      if (body.enabled !== undefined) changes.enabled = body.enabled;

      let mergedConfiguration = existing.configuration;
      let mergedSecrets;
      if (body.fields !== undefined) {
        const { configuration, secrets } = splitFields(existing.type, body.fields || {});
        mergedConfiguration = { ...existing.configuration, ...configuration };
        changes.configuration = mergedConfiguration;
        if (secrets !== undefined) {
          const existingSecrets = (await providerStore.getDecryptedSecrets(id)) || {};
          mergedSecrets = { ...existingSecrets, ...secrets };
          changes.secrets = mergedSecrets;
        }
      }

      // Valide la configuration résultante (existante + changements fusionnés)
      // uniquement si des champs de config/secrets ont effectivement bougé —
      // un simple renommage ou enable/disable ne doit pas re-déclencher une
      // validation de champs qui n'ont pas changé.
      if (body.fields !== undefined) {
        const existingSecrets = mergedSecrets || (await providerStore.getDecryptedSecrets(id)) || {};
        const validationErrors = manager.validateProviderConfig(existing.type, {
          ...mergedConfiguration,
          ...existingSecrets,
        });
        if (validationErrors.length) {
          recordEvent({
            user: req.user,
            action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
            target: existing.name || String(existing.id),
            targetType: "notification_provider",
            status: "failed",
            ip: req.ip,
            // Seulement les clés modifiées (body.fields), jamais leurs valeurs.
            metadata: { op: "update_provider", providerId: id, fields: changedFieldKeys(body.fields), error: "validation" },
          });
          return res.status(400).json({ error: validationErrors.join(" ") });
        }
      }

      const updated = await providerStore.update(id, changes);
      recordEvent({
        user: req.user,
        action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
        target: updated.name || String(updated.id),
        targetType: "notification_provider",
        status: "success",
        ip: req.ip,
        // metadata.fields = union des clés effectivement modifiées (name/enabled/fields du body),
        // jamais une valeur — voir changedFieldKeys().
        metadata: { op: "update_provider", providerId: id, fields: Object.keys(body).filter((k) => k !== "type") },
      });
      res.json(updated);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
        target: String(req.params.id),
        targetType: "notification_provider",
        status: "failed",
        ip: req.ip,
        metadata: { op: "update_provider", providerId: Number(req.params.id), error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  }
  router.patch("/providers/:id", auth.requirePermission("notifications_update"), updateProvider);
  router.put("/providers/:id", auth.requirePermission("notifications_update"), updateProvider);

  // --- Suppression ---------------------------------------------------------

  router.delete("/providers/:id", auth.requirePermission("notifications_delete"), async (req, res) => {
    try {
      const existing = await providerStore.getById(Number(req.params.id));
      const deleted = await providerStore.remove(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Configuration de provider introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
        target: (existing && existing.name) || String(req.params.id),
        targetType: "notification_provider",
        status: "success",
        ip: req.ip,
        metadata: { op: "delete_provider", providerId: Number(req.params.id) },
      });
      res.json({ ok: true });
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
        target: String(req.params.id),
        targetType: "notification_provider",
        status: "failed",
        ip: req.ip,
        metadata: { op: "delete_provider", providerId: Number(req.params.id), error: e.message },
      });
      res.status(500).json({ error: e.message });
    }
  });

  // --- Test ------------------------------------------------------------------

  // Envoie réellement une notification de test avec la configuration stockée
  // (secrets déchiffrés en mémoire pour cet appel uniquement — jamais
  // renvoyés dans la réponse, voir types.js#test / providers/shared.js).
  router.post("/providers/:id/test", auth.requirePermission("notifications_test"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const provider = await providerStore.getById(id);
      if (!provider) return res.status(404).json({ error: "Configuration de provider introuvable." });

      const implementation = registry.getProvider(provider.type);
      if (!implementation) return res.status(400).json({ error: unknownTypeError(provider.type) });

      const secrets = (await providerStore.getDecryptedSecrets(id)) || {};
      const config = { ...provider.configuration, ...secrets };
      const result = await implementation.test(config);
      // `result` est déjà un résultat normalisé (jamais de secret dedans,
      // voir providers/shared.js) : renvoyé tel quel.
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: "Échec du test (erreur interne)." });
    }
  });

  // --- Routing (Phase 5D) ---------------------------------------------------

  // Lecture : notifications_read (cohérent avec /providers ci-dessus).
  router.get("/routes", auth.requirePermission("notifications_read"), async (req, res) => {
    try {
      const enabledOnly = req.query.enabledOnly === "1" || req.query.enabledOnly === "true";
      res.json(await routeStore.list({ enabledOnly }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/routes/:id", auth.requirePermission("notifications_read"), async (req, res) => {
    try {
      const route = await routeStore.getById(Number(req.params.id));
      if (!route) return res.status(404).json({ error: "Règle de routing introuvable." });
      res.json(route);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Écriture (create/update/delete) : notifications_manage — distinct de
  // notifications_create/update/delete (qui ne couvrent que les providers,
  // voir lib/permissions.js), une règle de routing n'est pas une
  // configuration de provider.
  router.post("/routes", auth.requirePermission("notifications_manage"), async (req, res) => {
    const body = req.body || {};
    try {
      const created = await routeStore.create({
        name: body.name,
        enabled: body.enabled,
        conditions: body.conditions,
        providerIds: body.providerIds,
        titleTemplate: body.titleTemplate,
        messageTemplate: body.messageTemplate,
        notifyOnResolve: body.notifyOnResolve,
      });
      recordEvent({
        user: req.user,
        action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
        target: created.name || String(created.id),
        targetType: "notification_route",
        status: "success",
        ip: req.ip,
        // Une règle de routing ne porte pas de secret (name/conditions/
        // providerIds/templates), mais on reste sur des clés par cohérence
        // avec l'audit des providers, pas les valeurs (peuvent référencer un
        // titre/message de template écrit par l'utilisateur).
        metadata: { op: "create_route", routeId: created.id, fields: changedFieldKeys(body) },
      });
      res.status(201).json(created);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
        targetType: "notification_route",
        status: "failed",
        ip: req.ip,
        metadata: { op: "create_route", fields: changedFieldKeys(body), error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  });

  async function updateRoute(req, res) {
    const id = Number(req.params.id);
    const body = req.body || {};
    try {
      const changes = {};
      if (body.name !== undefined) changes.name = body.name;
      if (body.enabled !== undefined) changes.enabled = body.enabled;
      if (body.conditions !== undefined) changes.conditions = body.conditions;
      if (body.providerIds !== undefined) changes.providerIds = body.providerIds;
      if (body.titleTemplate !== undefined) changes.titleTemplate = body.titleTemplate;
      if (body.messageTemplate !== undefined) changes.messageTemplate = body.messageTemplate;
      if (body.notifyOnResolve !== undefined) changes.notifyOnResolve = body.notifyOnResolve;

      const updated = await routeStore.update(id, changes);
      if (!updated) return res.status(404).json({ error: "Règle de routing introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
        target: updated.name || String(updated.id),
        targetType: "notification_route",
        status: "success",
        ip: req.ip,
        metadata: { op: "update_route", routeId: id, fields: changedFieldKeys(changes) },
      });
      res.json(updated);
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
        target: String(id),
        targetType: "notification_route",
        status: "failed",
        ip: req.ip,
        metadata: { op: "update_route", routeId: id, fields: changedFieldKeys(body), error: e.message },
      });
      res.status(400).json({ error: e.message });
    }
  }
  router.patch("/routes/:id", auth.requirePermission("notifications_manage"), updateRoute);
  router.put("/routes/:id", auth.requirePermission("notifications_manage"), updateRoute);

  router.delete("/routes/:id", auth.requirePermission("notifications_manage"), async (req, res) => {
    try {
      const existing = await routeStore.getById(Number(req.params.id));
      const deleted = await routeStore.remove(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Règle de routing introuvable." });
      recordEvent({
        user: req.user,
        action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
        target: (existing && existing.name) || String(req.params.id),
        targetType: "notification_route",
        status: "success",
        ip: req.ip,
        metadata: { op: "delete_route", routeId: Number(req.params.id) },
      });
      res.json({ ok: true });
    } catch (e) {
      recordEvent({
        user: req.user,
        action: ACTIONS.NOTIFICATION_CONFIG_CHANGE,
        target: String(req.params.id),
        targetType: "notification_route",
        status: "failed",
        ip: req.ip,
        metadata: { op: "delete_route", routeId: Number(req.params.id), error: e.message },
      });
      res.status(500).json({ error: e.message });
    }
  });

  // --- Historique (Phase 5D) --------------------------------------------

  // Permission dédiée (notifications_history) — plus précise que
  // notifications_read : voir l'historique détaillé (métadonnées d'envoi
  // par tentative) est une capacité séparée de "voir les configurations de
  // provider". Ne renvoie jamais de secret (voir history-store.js : `metadata`
  // ne doit jamais en contenir, et routing/engine.js n'y écrit que des
  // détails d'exécution : statut, code d'erreur, temps de réponse).
  router.get("/history", auth.requirePermission("notifications_history"), async (req, res) => {
    try {
      const { providerId, alertId, status, limit } = req.query;
      res.json(
        await historyStore.list({
          providerId: providerId !== undefined ? Number(providerId) : undefined,
          alertId: alertId !== undefined ? Number(alertId) : undefined,
          status: status || undefined,
          limit: limit !== undefined ? Number(limit) : undefined,
        })
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createNotificationsRouter;
