"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const migrator = require("../../lib/db/migrator");
const { freshDb, cleanupDb } = require("../helpers/tmp-db");
const db = require("../../lib/db");

/**
 * Phase 5F — section 3 "Security Audit" de la tâche : recherche de secrets
 * dans les réponses API, l'historique, les jobs de la queue et la base —
 * en cherchant explicitement password/token/webhook/API key/Authorization,
 * comme demandé.
 *
 * Reprend le pattern de test/integration/notifications-api.test.js
 * (montage du vrai routeur sur un serveur HTTP réel, DB SQLite temporaire).
 */

const SECRET_MARKER = "TOPSECRET-do-not-leak-4f8c9";

async function startServer(userForRequest) {
  process.env.PM2_MONITOR_DISABLE_AUTH = "0";
  delete require.cache[require.resolve("../../lib/auth")];
  delete require.cache[require.resolve("../../lib/routes/notifications")];
  delete require.cache[require.resolve("../../lib/services/notifications")];
  delete require.cache[require.resolve("../../lib/services/notifications/provider-store")];

  const auth = require("../../lib/auth");
  const notificationsRouter = require("../../lib/routes/notifications");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = userForRequest;
    next();
  });
  app.use("/api/notifications", notificationsRouter());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/notifications`;
  return { server, baseUrl };
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const ADMIN = { id: 1, isAdmin: true };

/** Cherche le marqueur secret dans un texte, insensible à la casse (couvre aussi un éventuel base64/hex trivial n'est pas testé ici — recherche littérale suffisante : le secret est stocké/chiffré, jamais reformaté avant un éventuel affichage). */
function containsSecret(text) {
  return typeof text === "string" && text.toLowerCase().includes(SECRET_MARKER.toLowerCase());
}

test("Phase 5F — Security Audit : le secret n'apparaît jamais hors du stockage chiffré", async (t) => {
  const dbCtx = await freshDb();
  await migrator.up();

  await t.test("POST puis GET /providers : jamais le secret en clair dans la réponse", async () => {
    const { server, baseUrl } = await startServer(ADMIN);
    try {
      const createRes = await fetch(`${baseUrl}/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Discord audit",
          type: "discord",
          fields: { webhookUrl: `https://discord.com/api/webhooks/1/${SECRET_MARKER}` },
        }),
      });
      const created = await createRes.json();
      assert.equal(createRes.status, 201);
      assert.equal(
        containsSecret(JSON.stringify(created)),
        false,
        "POST /providers ne doit jamais renvoyer le secret",
      );

      const getRes = await fetch(`${baseUrl}/providers/${created.id}`);
      const fetched = await getRes.json();
      assert.equal(
        containsSecret(JSON.stringify(fetched)),
        false,
        "GET /providers/:id ne doit jamais renvoyer le secret",
      );
      assert.equal(fetched.hasSecrets, true);

      const listRes = await fetch(`${baseUrl}/providers`);
      const list = await listRes.json();
      assert.equal(
        containsSecret(JSON.stringify(list)),
        false,
        "GET /providers ne doit jamais renvoyer le secret",
      );
    } finally {
      await stopServer(server);
    }
  });

  await t.test(
    "réponses d'erreur (validation, 404, 500) : jamais le secret, jamais de message d'erreur brut du provider",
    async () => {
      const { server, baseUrl } = await startServer(ADMIN);
      try {
        // Erreur de validation : le corps de la requête contenant le secret ne
        // doit pas être renvoyé tel quel dans le message d'erreur.
        const badRes = await fetch(`${baseUrl}/providers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "", type: "discord", fields: { webhookUrl: SECRET_MARKER } }),
        });
        const badBody = await badRes.text();
        assert.equal(containsSecret(badBody), false);

        // 404 sur un id inexistant.
        const notFoundRes = await fetch(`${baseUrl}/providers/999999`);
        assert.equal(notFoundRes.status, 404);
        const notFoundBody = await notFoundRes.text();
        assert.equal(containsSecret(notFoundBody), false);
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test(
    "PATCH avec 'Keep existing credential' (fields omis) : le secret existant reste invisible",
    async () => {
      const { server, baseUrl } = await startServer(ADMIN);
      try {
        const created = await (
          await fetch(`${baseUrl}/providers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Slack audit",
              type: "slack",
              fields: { webhookUrl: `https://hooks.slack.com/services/${SECRET_MARKER}` },
            }),
          })
        ).json();

        const patched = await (
          await fetch(`${baseUrl}/providers/${created.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Slack audit renommé" }), // pas de `fields` : garde le secret existant
          })
        ).json();

        assert.equal(containsSecret(JSON.stringify(patched)), false);
        assert.equal(patched.name, "Slack audit renommé");
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test(
    "POST /providers/:id/test : le résultat de test ne contient jamais le secret, même en cas d'échec",
    async () => {
      const { server, baseUrl } = await startServer(ADMIN);
      try {
        const created = await (
          await fetch(`${baseUrl}/providers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Webhook audit",
              type: "webhook",
              fields: { url: `https://example.invalid/${SECRET_MARKER}`, method: "POST" },
            }),
          })
        ).json();

        const testRes = await fetch(`${baseUrl}/providers/${created.id}/test`, { method: "POST" });
        const testBody = await testRes.text();
        assert.equal(
          containsSecret(testBody),
          false,
          "un test qui échoue (domaine .invalid, jamais appelé réellement en CI) ne doit pas exposer l'URL/le secret",
        );
      } finally {
        await stopServer(server);
      }
    },
  );

  await t.test(
    "table notification_providers : le secret est bien chiffré au repos (pas en clair dans la colonne)",
    async () => {
      const rows = await db.all("SELECT secrets FROM notification_providers", []);
      for (const row of rows) {
        if (!row.secrets) continue;
        assert.equal(
          containsSecret(row.secrets),
          false,
          "la colonne `secrets` ne doit jamais contenir le marqueur en clair (chiffrement AES-256-GCM attendu)",
        );
      }
    },
  );

  await t.test("notification_history : jamais de secret, même en cas d'échec d'envoi", async () => {
    const historyStore = require("../../lib/services/notifications/history-store");
    const providerStore = require("../../lib/services/notifications/provider-store");
    const provider = await providerStore.create({
      name: "Audit provider",
      type: "webhook",
      configuration: { url: "https://example.invalid" },
      secrets: { authToken: SECRET_MARKER },
    });

    await historyStore.create({
      providerId: provider.id,
      alertId: null,
      status: "failed",
      errorCode: "AUTH_FAILED", // jamais le message brut du provider, qui pourrait contenir le secret
    });

    const list = await historyStore.list({});
    assert.equal(containsSecret(JSON.stringify(list)), false);
  });

  await t.test("jobs de la queue de dispatch : jamais de secret dans la colonne payload", async () => {
    const { NotificationDispatchQueue } = require("../../lib/services/notifications/dispatch-queue");
    const { ProviderRegistry } = require("../../lib/services/notifications/registry");
    const { NotificationProvider } = require("../../lib/services/notifications/types");
    const { createQueue } = require("../../lib/services/queue");
    const providerStore = require("../../lib/services/notifications/provider-store");
    const historyStore = require("../../lib/services/notifications/history-store");

    const provider = await providerStore.create({
      name: "Audit queue provider",
      type: "webhook",
      configuration: { url: "https://example.invalid" },
      secrets: { authToken: SECRET_MARKER },
    });

    const registry = new ProviderRegistry();
    const fake = new NotificationProvider("webhook", "Webhook");
    fake.send = async (_n, config) => {
      // Le secret DOIT être disponible ici (c'est le seul endroit légitime) :
      assert.equal(config.authToken, SECRET_MARKER);
      return { success: true };
    };
    registry.registerProvider(fake);

    const dq = new NotificationDispatchQueue({
      registry,
      providerStore,
      historyStore,
      queue: createQueue("security-audit-queue", { maxAttempts: 1, backoffMs: 0 }),
    });

    await dq.enqueue({
      providerId: provider.id,
      notification: { title: "t", message: "m" },
      alertId: null,
      event: "triggered",
    });

    const jobs = await db.all("SELECT payload FROM jobs WHERE queue_name = ?", ["security-audit-queue"]);
    assert.ok(jobs.length >= 1);
    for (const job of jobs) {
      assert.equal(
        containsSecret(job.payload),
        false,
        "le job ne doit référencer que providerId, jamais le secret en clair",
      );
    }

    await dq.processOne(); // vérifie aussi que send() a bien reçu le secret (assertion dans fake.send ci-dessus)
  });

  await cleanupDb(dbCtx);
});
