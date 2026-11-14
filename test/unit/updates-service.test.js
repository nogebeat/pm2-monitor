"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUpdateService } = require("../../lib/services/updates");

/**
 * Service de vérification des mises à jour : sélection des releases,
 * cache disque, intervalle, backoff après erreur, limitation du « forcer ».
 * Aucun réseau : la lecture des releases est injectée.
 */

const rel = (tag, extra = {}) => ({
  tag,
  name: tag,
  draft: false,
  prerelease: false,
  publishedAt: "2026-11-09T10:00:00Z",
  url: `https://github.com/nogebeat/pm2-monitor/releases/tag/${tag}`,
  body: `Notes ${tag}`,
  ...extra,
});

function makeService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-updates-"));
  const clock = { t: 1_000_000_000_000 };
  const calls = [];
  const fetchReleases =
    overrides.fetchReleases ||
    (async (args) => {
      calls.push(args);
      return { ok: true, notModified: false, etag: '"e1"', releases: [rel("v4.2.0"), rel("v4.1.2")] };
    });
  const service = createUpdateService({
    currentVersion: "4.1.2",
    cachePath: path.join(dir, "cache.json"),
    now: () => clock.t,
    fetchReleases,
    ...overrides.options,
  });
  return { service, clock, calls, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("getStatus — sélection des releases", async (t) => {
  await t.test("signale une mise à jour avec son type et ses notes", async () => {
    const { service, cleanup } = makeService();
    await service.check();
    const s = service.getStatus();
    cleanup();
    assert.equal(s.updateAvailable, true);
    assert.deepEqual(s.latest, { tag: "v4.2.0", version: "4.2.0", type: "minor" });
    assert.equal(s.pending.length, 1);
    assert.equal(s.pending[0].notes, "Notes v4.2.0");
  });

  await t.test("ignore brouillons, pré-versions et tags non stables", async () => {
    const { service, cleanup } = makeService({
      fetchReleases: async () => ({
        ok: true,
        notModified: false,
        etag: null,
        releases: [
          rel("v9.0.0", { draft: true }),
          rel("v8.0.0", { prerelease: true }),
          rel("v7.0.0-rc1"),
          rel("nightly"),
          rel("v4.1.3"),
        ],
      }),
    });
    await service.check();
    const s = service.getStatus();
    cleanup();
    assert.deepEqual(s.latest, { tag: "v4.1.3", version: "4.1.3", type: "patch" });
    assert.equal(s.pending.length, 1);
  });

  await t.test(
    "liste les versions intermédiaires (la plus récente d'abord) et signale le majeur",
    async () => {
      const { service, cleanup } = makeService({
        fetchReleases: async () => ({
          ok: true,
          notModified: false,
          etag: null,
          releases: [rel("v4.1.3"), rel("v5.0.0"), rel("v4.2.0"), rel("v4.0.0")],
        }),
      });
      await service.check();
      const s = service.getStatus();
      cleanup();
      assert.deepEqual(
        s.pending.map((p) => `${p.tag}:${p.type}`),
        ["v5.0.0:major", "v4.2.0:minor", "v4.1.3:patch"],
      );
    },
  );

  await t.test("à jour : aucune mise à jour", async () => {
    const { service, cleanup } = makeService({
      fetchReleases: async () => ({
        ok: true,
        notModified: false,
        etag: null,
        releases: [rel("v4.1.2"), rel("v4.0.0")],
      }),
    });
    await service.check();
    const s = service.getStatus();
    cleanup();
    assert.equal(s.updateAvailable, false);
    assert.equal(s.latest, null);
  });

  await t.test("plafonne à 5 versions en attente", async () => {
    const many = ["v4.1.3", "v4.1.4", "v4.1.5", "v4.1.6", "v4.1.7", "v4.1.8", "v4.1.9"].map((tag) =>
      rel(tag),
    );
    const { service, cleanup } = makeService({
      fetchReleases: async () => ({ ok: true, notModified: false, etag: null, releases: many }),
    });
    await service.check();
    const s = service.getStatus();
    cleanup();
    assert.equal(s.pending.length, 5);
    assert.equal(s.pending[0].tag, "v4.1.9");
  });
});

test("check — fraîcheur, cache disque, backoff, forçage", async (t) => {
  await t.test("ne ré-interroge pas tant que le résultat est frais, puis oui une fois périmé", async () => {
    const { service, clock, calls, cleanup } = makeService();
    await service.check();
    await service.check();
    assert.equal(calls.length, 1);
    clock.t += service.INTERVAL_MS + 1;
    await service.check();
    cleanup();
    assert.equal(calls.length, 2);
  });

  await t.test("réutilise l'ETag et garde les releases sur un 304", async () => {
    let n = 0;
    const seen = [];
    const { service, clock, cleanup } = makeService({
      fetchReleases: async ({ etag }) => {
        seen.push(etag);
        n++;
        return n === 1
          ? { ok: true, notModified: false, etag: '"e1"', releases: [rel("v4.2.0")] }
          : { ok: true, notModified: true, etag: '"e1"', releases: [] };
      },
    });
    await service.check();
    clock.t += service.INTERVAL_MS + 1;
    await service.check();
    const s = service.getStatus();
    cleanup();
    assert.deepEqual(seen, [null, '"e1"']);
    assert.equal(s.updateAvailable, true);
  });

  await t.test("un redémarrage relit le cache disque et n'interroge pas GitHub", async () => {
    const first = makeService();
    await first.service.check();
    const calls2 = [];
    const second = createUpdateService({
      currentVersion: "4.1.2",
      cachePath: path.join(first.dir, "cache.json"),
      now: () => first.clock.t,
      fetchReleases: async (a) => {
        calls2.push(a);
        return { ok: true, notModified: false, etag: null, releases: [] };
      },
    });
    assert.equal(second.getStatus().updateAvailable, true); // servi depuis le cache
    await second.check();
    first.cleanup();
    assert.equal(calls2.length, 0);
  });

  await t.test(
    "erreur : statut d'erreur conservé, nouvelle tentative au plus tôt 30 min plus tard",
    async () => {
      let n = 0;
      const { service, clock, cleanup } = makeService({
        fetchReleases: async () => {
          n++;
          return { ok: false, code: "network" };
        },
      });
      await service.check();
      assert.equal(service.getStatus().error.code, "network");
      clock.t += 10 * 60 * 1000;
      await service.check();
      assert.equal(n, 1);
      clock.t += 21 * 60 * 1000;
      await service.check();
      cleanup();
      assert.equal(n, 2);
    },
  );

  await t.test("limite de débit : attend l'heure de reprise annoncée par GitHub", async () => {
    let n = 0;
    const { service, clock, cleanup } = makeService({
      fetchReleases: async () => {
        n++;
        return { ok: false, code: "rate_limited", retryAt: 1_000_000_000_000 + 2 * 60 * 60 * 1000 };
      },
    });
    await service.check();
    clock.t += 60 * 60 * 1000;
    await service.check();
    assert.equal(n, 1);
    clock.t += 61 * 60 * 1000;
    await service.check();
    cleanup();
    assert.equal(n, 2);
  });

  await t.test("vérification forcée : au plus une par minute, ignore la fraîcheur", async () => {
    const { service, clock, calls, cleanup } = makeService();
    await service.check();
    const first = await service.check({ force: true });
    const second = await service.check({ force: true });
    assert.equal(first.ran, true);
    assert.equal(second.throttled, true);
    assert.equal(calls.length, 2);
    clock.t += 61 * 1000;
    await service.check({ force: true });
    cleanup();
    assert.equal(calls.length, 3);
  });

  await t.test("deux vérifications simultanées ne font qu'un appel réseau", async () => {
    const { service, calls, cleanup } = makeService();
    await Promise.all([service.check(), service.check()]);
    cleanup();
    assert.equal(calls.length, 1);
  });
});

test("configuration", async (t) => {
  await t.test("UPDATE_CHECK_ENABLED=0 : aucun appel sortant, statut explicite", async () => {
    const { service, calls, cleanup } = makeService({ options: { env: { UPDATE_CHECK_ENABLED: "0" } } });
    const r = await service.check({ force: true });
    const s = service.getStatus();
    cleanup();
    assert.equal(r.ran, false);
    assert.equal(calls.length, 0);
    assert.equal(s.enabled, false);
  });

  await t.test("dépôt invalide dans UPDATE_CHECK_REPO : retombe sur le dépôt par défaut", () => {
    const { service, cleanup } = makeService({ options: { env: { UPDATE_CHECK_REPO: "../../etc/passwd" } } });
    cleanup();
    assert.equal(service.REPO, "nogebeat/pm2-monitor");
  });

  await t.test("intervalle minimum 1 h, valeurs absurdes ignorées", () => {
    const low = makeService({ options: { env: { UPDATE_CHECK_INTERVAL_MS: "1000" } } });
    const bad = makeService({ options: { env: { UPDATE_CHECK_INTERVAL_MS: "abc" } } });
    low.cleanup();
    bad.cleanup();
    assert.equal(low.service.INTERVAL_MS, 60 * 60 * 1000);
    assert.equal(bad.service.INTERVAL_MS, 6 * 60 * 60 * 1000);
  });

  await t.test("version installée invalide : pas de comparaison, signalé", async () => {
    const { service, cleanup } = makeService({ options: { currentVersion: "n'importe quoi" } });
    await service.check();
    const s = service.getStatus();
    cleanup();
    assert.equal(s.current.valid, false);
    assert.equal(s.updateAvailable, false);
  });
});

test("getDiagnostics — mis en cache 60 s, rafraîchissable", async () => {
  let n = 0;
  const { service, clock, cleanup } = makeService({
    options: {
      runDiagnostics: async () => {
        n++;
        return { canSelfUpdate: true, checks: [] };
      },
    },
  });
  await service.getDiagnostics();
  await service.getDiagnostics();
  assert.equal(n, 1);
  await service.getDiagnostics({ force: true });
  assert.equal(n, 2);
  clock.t += 61 * 1000;
  await service.getDiagnostics();
  cleanup();
  assert.equal(n, 3);
});

test("getDiagnostics — la cible de la commande est la dernière release NON majeure ; une majeure seule reste visée sans option dangereuse", async () => {
  const seen = [];
  let releases = [rel("v4.2.0"), rel("v4.1.2")];
  const { service, clock, cleanup } = makeService({
    fetchReleases: async () => ({ ok: true, notModified: false, etag: null, releases }),
    options: {
      runDiagnostics: async (args) => {
        seen.push(args.target);
        return { canSelfUpdate: true, checks: [] };
      },
    },
  });
  await service.getDiagnostics(); // pas encore de vérification : aucune cible connue
  await service.check();
  await service.getDiagnostics(); // v4.2.0 (mineure)
  await service.getDiagnostics(); // même cible, cache valide : pas de recalcul
  // Une majeure apparaît EN PLUS : la cible par défaut reste la mineure
  releases = [rel("v5.0.0"), rel("v4.2.0"), rel("v4.1.2")];
  clock.t += service.INTERVAL_MS + 1;
  await service.check();
  await service.getDiagnostics(); // recalculé (le cache de 60 s a expiré) mais la cible reste v4.2.0, jamais la majeure
  // Plus rien d'autre qu'une majeure à installer
  releases = [rel("v5.0.0"), rel("v4.1.2")];
  clock.t += service.INTERVAL_MS + 1;
  await service.check();
  await service.getDiagnostics(); // nouvelle cible : la majeure (sans --allow-major dans la commande)
  cleanup();
  assert.deepEqual(seen, [
    null,
    { tag: "v4.2.0", type: "minor" },
    { tag: "v4.2.0", type: "minor" },
    { tag: "v5.0.0", type: "major" },
  ]);
});

test("getStatus — recommended : la plus récente version non majeure", async (t) => {
  await t.test("majeure + mineure : la mineure est recommandée, la majeure reste latest", async () => {
    const { service, cleanup } = makeService({
      fetchReleases: async () => ({
        ok: true,
        notModified: false,
        etag: null,
        releases: [rel("v5.0.0"), rel("v4.2.0"), rel("v4.1.3")],
      }),
    });
    await service.check();
    const s = service.getStatus();
    cleanup();
    assert.deepEqual(s.latest, { tag: "v5.0.0", version: "5.0.0", type: "major" });
    assert.deepEqual(s.recommended, { tag: "v4.2.0", version: "4.2.0", type: "minor" });
  });
  await t.test("majeure seule : aucune release recommandée", async () => {
    const { service, cleanup } = makeService({
      fetchReleases: async () => ({
        ok: true,
        notModified: false,
        etag: null,
        releases: [rel("v5.0.0"), rel("v4.1.2")],
      }),
    });
    await service.check();
    const s = service.getStatus();
    cleanup();
    assert.equal(s.recommended, null);
    assert.equal(s.latest.type, "major");
  });
  await t.test("à jour : ni latest ni recommended", async () => {
    const { service, cleanup } = makeService({
      fetchReleases: async () => ({ ok: true, notModified: false, etag: null, releases: [rel("v4.1.2")] }),
    });
    await service.check();
    const s = service.getStatus();
    cleanup();
    assert.equal(s.recommended, null);
    assert.equal(s.latest, null);
  });
});
