"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { fetchReleases, slimRelease, safeUrl } = require("../../lib/services/updates/release-source");

/**
 * Lecture des releases contre un FAUX serveur GitHub local (vrai HTTP, aucun
 * accès réseau externe) : réponses nominales, 304, limite de débit, 404,
 * réponses invalides ou trop grosses, délai dépassé.
 */

function startFake(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

const RELEASE = {
  tag_name: "v4.2.0",
  name: "v4.2.0",
  draft: false,
  prerelease: false,
  published_at: "2026-11-09T10:00:00Z",
  html_url: "https://github.com/nogebeat/pm2-monitor/releases/tag/v4.2.0",
  body: "Notes",
  author: { login: "ne-doit-pas-sortir" },
};

test("fetchReleases", async (t) => {
  await t.test("200 : releases réduites à une liste blanche de champs + ETag", async () => {
    const { server, requests, base } = await startFake((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", ETag: '"abc"' });
      res.end(JSON.stringify([RELEASE]));
    });
    const r = await fetchReleases({ repo: "nogebeat/pm2-monitor", apiBaseUrl: base });
    server.close();
    assert.equal(r.ok, true);
    assert.equal(r.etag, '"abc"');
    assert.equal(r.releases[0].tag, "v4.2.0");
    assert.equal(r.releases[0].author, undefined);
    assert.equal(requests[0].url, "/repos/nogebeat/pm2-monitor/releases?per_page=20");
  });

  await t.test("n'envoie aucune donnée de l'installation (User-Agent générique)", async () => {
    const { server, requests, base } = await startFake((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    });
    await fetchReleases({ repo: "a/b", apiBaseUrl: base });
    server.close();
    const h = requests[0].headers;
    assert.equal(h["user-agent"], "pm2-monitor-update-check");
    assert.equal(h.cookie, undefined);
    assert.equal(h.authorization, undefined);
  });

  await t.test("renvoie If-None-Match et gère le 304", async () => {
    const { server, requests, base } = await startFake((req, res) => {
      res.writeHead(304);
      res.end();
    });
    const r = await fetchReleases({ repo: "a/b", apiBaseUrl: base, etag: '"abc"' });
    server.close();
    assert.equal(requests[0].headers["if-none-match"], '"abc"');
    assert.deepEqual(
      { ok: r.ok, notModified: r.notModified, etag: r.etag },
      { ok: true, notModified: true, etag: '"abc"' },
    );
  });

  await t.test("limite de débit : rate_limited avec l'heure de reprise", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const { server, base } = await startFake((req, res) => {
      res.writeHead(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
      res.end("{}");
    });
    const r = await fetchReleases({ repo: "a/b", apiBaseUrl: base });
    server.close();
    assert.equal(r.ok, false);
    assert.equal(r.code, "rate_limited");
    assert.equal(r.retryAt, reset * 1000);
  });

  await t.test("404, 500, JSON invalide, objet au lieu d'un tableau", async () => {
    const cases = [
      [404, "{}", "not_found"],
      [500, "{}", "http_500"],
      [200, "pas du json", "bad_response"],
      [200, "{}", "bad_response"],
    ];
    for (const [status, body, code] of cases) {
      const { server, base } = await startFake((req, res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      });
      const r = await fetchReleases({ repo: "a/b", apiBaseUrl: base });
      server.close();
      assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code });
    }
  });

  await t.test("réponse trop volumineuse : abandon (too_large)", async () => {
    const { server, base } = await startFake((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("[");
      const chunk = '"' + "x".repeat(64 * 1024) + '",';
      for (let i = 0; i < 40; i++) res.write(chunk);
      res.end("]");
    });
    const r = await fetchReleases({ repo: "a/b", apiBaseUrl: base });
    server.close();
    assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: "too_large" });
  });

  await t.test("délai dépassé : timeout", async () => {
    const { server, base } = await startFake(() => {
      /* ne répond jamais */
    });
    const r = await fetchReleases({ repo: "a/b", apiBaseUrl: base, timeoutMs: 150 });
    server.closeAllConnections();
    server.close();
    assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: "timeout" });
  });

  await t.test("serveur injoignable : network, sans exception", async () => {
    const r = await fetchReleases({ repo: "a/b", apiBaseUrl: "http://127.0.0.1:1" });
    assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: "network" });
  });

  await t.test("URL de base invalide : bad_config", async () => {
    const r = await fetchReleases({ repo: "a/b", apiBaseUrl: "pas une url" });
    assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: "bad_config" });
  });
});

test("slimRelease / safeUrl — contenu distant non fiable", async (t) => {
  await t.test("rejette les schémas dangereux dans html_url", () => {
    const r = slimRelease({ ...RELEASE, html_url: "javascript:alert(1)" }, "https://github.com/a/b/releases");
    assert.equal(r.url, "https://github.com/a/b/releases");
    assert.equal(safeUrl("data:text/html,x", "F"), "F");
    assert.equal(safeUrl("https://github.com/x", "F"), "https://github.com/x");
  });
  await t.test("plafonne la taille des notes", () => {
    const r = slimRelease({ ...RELEASE, body: "x".repeat(50_000) }, "F");
    assert.equal(r.body.length, 3000);
  });
  await t.test("ignore les entrées sans tag", () => {
    assert.equal(slimRelease({ name: "sans tag" }, "F"), null);
    assert.equal(slimRelease(null, "F"), null);
  });
});
