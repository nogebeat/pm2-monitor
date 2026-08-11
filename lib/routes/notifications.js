"use strict";

/**
 * Routes REST du notification system — Phase 5A uniquement (fondations).
 * Toute la logique vit dans lib/services/notifications/ ; ce module ne fait
 * que valider la requête HTTP, appeler le service, et formater la réponse —
 * même découpage que lib/routes/alerts.js et lib/routes/events.js.
 *
 * IMPORTANT : seuls deux GET existent dans cette phase. Le CRUD complet des
 * providers (POST/PUT/DELETE /providers), le test de configuration
 * (POST /providers/:id/test), l'historique détaillé (GET /history) et le
 * routing (CRUD /routes) sont volontairement absents — prévus en
 * Phase 5B/5C (voir la tâche, section 11 "API minimale"). Les permissions
 * correspondantes existent déjà dans lib/permissions.js pour éviter une
 * migration de permissions supplémentaire à ce moment-là.
 *
 * Monté dans server.js via `app.use("/api/notifications", require("./lib/routes/notifications")())`.
 */

const express = require("express");
const auth = require("../auth");
const { registry, manager, providerStore } = require("../services/notifications");

function createNotificationsRouter() {
  const router = express.Router();

  // Catalogue des types de providers connus (placeholders en Phase 5A —
  // `implemented: false` tant que send()/test() ne sont pas branchés,
  // voir lib/services/notifications/types.js). Utile pour construire un
  // formulaire côté frontend, même schéma que GET /api/alerts/catalog.
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
        return res.status(400).json({ error: `Type de provider inconnu : "${type}".` });
      }
      res.json(await providerStore.list({ type }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createNotificationsRouter;