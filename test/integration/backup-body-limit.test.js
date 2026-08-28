"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");

/**
 * Vérifie le comportement documenté dans server.js (Phase 19 — voir le
 * commentaire juste avant `app.use("/api/backup", express.json({ limit: ... }))`) :
 * un parseur JSON à limite plus haute, scopé à /api/backup et monté AVANT
 * le parseur générique, sans changer la limite (100 Ko, défaut
 * express.json()) appliquée à toutes les autres routes. Reproduit
 * exactement le même ordre de montage que server.js, sur une app minimale
 * (pas besoin de PM2/DB pour ce test — uniquement le comportement du body
 * parser lui-même).
 */
function buildApp() {
  const app = express();
  app.use("/api/backup", express.json({ limit: "2mb" }));
  app.use(express.json()); // limite par défaut (100 Ko) pour tout le reste

  app.post("/api/backup/echo", (req, res) => res.json({ size: JSON.stringify(req.body).length }));
  app.post("/api/other/echo", (req, res) => res.json({ size: JSON.stringify(req.body).length }));

  // Gestionnaire d'erreur express : un corps trop volumineux fait échouer
  // le body-parser avec une erreur (statut 413), à traiter explicitement
  // sinon Express répond 500 (comportement par défaut, pas testé ici).
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  return app;
}

function bigPayload(approxBytes) {
  return { blob: "x".repeat(approxBytes) };
}

test("server.js — limite de taille de corps dédiée à /api/backup", async (t) => {
  const app = buildApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  t.after(() => new Promise((resolve) => server.close(resolve)));

  await t.test("un corps > 100 Ko est accepté sur /api/backup (limite dédiée)", async () => {
    const payload = bigPayload(200 * 1024); // ~200 Ko, au-delà de la limite globale par défaut
    const res = await fetch(`${base}/api/backup/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
  });

  await t.test("le même corps est rejeté (413) sur une autre route (limite globale inchangée)", async () => {
    const payload = bigPayload(200 * 1024);
    const res = await fetch(`${base}/api/other/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 413);
  });

  await t.test(
    "un petit corps JSON reste parsé normalement sur /api/backup (pas de double-parse)",
    async () => {
      const res = await fetch(`${base}/api/backup/echo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.size > 0);
    },
  );
});
