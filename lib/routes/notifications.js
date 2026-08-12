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
 * Le routing (CRUD /routes) et les templates restent hors scope — prévus en
 * Phase 5D (voir la tâche).
 *
 * Monté dans server.js via `app.use("/api/notifications", require("./lib/routes/notifications")())`.
 */

const express = require("express");
const auth = require("../auth");
const { registry, manager, providerStore } = require("../services/notifications");

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
    try {
      const body = req.body || {};
      const type = body.type ? String(body.type).trim() : "";
      if (!type || !registry.hasProvider(type)) {
        return res.status(400).json({ error: unknownTypeError(type || "(vide)") });
      }

      const { configuration, secrets } = splitFields(type, body.fields || {});
      const validationErrors = manager.validateProviderConfig(type, { ...configuration, ...secrets });
      if (validationErrors.length) {
        return res.status(400).json({ error: validationErrors.join(" ") });
      }

      const created = await providerStore.create({
        name: body.name,
        type,
        enabled: body.enabled,
        configuration,
        secrets,
      });
      res.status(201).json(created);
    } catch (e) {
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
          return res.status(400).json({ error: validationErrors.join(" ") });
        }
      }

      const updated = await providerStore.update(id, changes);
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }
  router.patch("/providers/:id", auth.requirePermission("notifications_update"), updateProvider);
  router.put("/providers/:id", auth.requirePermission("notifications_update"), updateProvider);

  // --- Suppression ---------------------------------------------------------

  router.delete("/providers/:id", auth.requirePermission("notifications_delete"), async (req, res) => {
    try {
      const deleted = await providerStore.remove(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Configuration de provider introuvable." });
      res.json({ ok: true });
    } catch (e) {
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

  return router;
}

module.exports = createNotificationsRouter;
