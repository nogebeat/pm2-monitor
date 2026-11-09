"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  runDiagnostics,
  maskRemoteUrl,
  buildUpdateCommand,
  shellQuote,
} = require("../../lib/services/updates/diagnostics");

/**
 * Diagnostic d'installation contre de VRAIS dépôts git temporaires (git est
 * déjà requis par deploy.sh) : branche, HEAD détaché sur un tag, absence de
 * branche amont, modifications locales, archive sans .git, secrets du remote.
 */

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function makeRepo({ withDeployScript = true, executable = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-diag-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  if (withDeployScript) {
    fs.writeFileSync(path.join(dir, "deploy.sh"), "#!/bin/bash\n", { mode: executable ? 0o755 : 0o644 });
  }
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const byId = (r, id) => r.checks.find((c) => c.id === id);
const base = { env: {}, getuid: () => 1000, enginesNode: ">=22", nodeVersion: "22.1.0" };

test("runDiagnostics — dépôt git sain", async () => {
  const dir = makeRepo();
  try {
    git(dir, "remote", "add", "origin", "https://github.com/nogebeat/pm2-monitor.git");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(dir, "branch", "--set-upstream-to=origin/main", "main");
    const r = await runDiagnostics({
      ...base,
      rootDir: dir,
      repo: "nogebeat/pm2-monitor",
      env: { pm_id: "0" },
    });
    assert.equal(r.install.type, "git");
    assert.equal(r.install.branch, "main");
    assert.equal(byId(r, "git_branch").status, "ok");
    assert.equal(byId(r, "git_upstream").status, "ok");
    assert.equal(byId(r, "git_clean").status, "ok");
    assert.equal(byId(r, "git_remote").status, "ok");
    assert.equal(byId(r, "deploy_script").status, "ok");
    assert.equal(byId(r, "process_manager").status, "ok");
    assert.equal(r.canSelfUpdate, true);
    assert.equal(r.command, `cd '${dir}' && ./deploy.sh update`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDiagnostics — cas bloquants et avertissements", async (t) => {
  await t.test("HEAD détaché sur un tag : bloquant (deploy.sh update tire une branche)", async () => {
    const dir = makeRepo();
    try {
      git(dir, "tag", "v1.0.0");
      git(dir, "checkout", "-q", "--detach", "v1.0.0");
      const r = await runDiagnostics({ ...base, rootDir: dir });
      assert.equal(byId(r, "git_branch").status, "fail");
      assert.equal(byId(r, "git_branch").detail, "detached:v1.0.0");
      assert.equal(r.install.tag, "v1.0.0");
      assert.equal(r.canSelfUpdate, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("branche sans amont : bloquant", async () => {
    const dir = makeRepo();
    try {
      const r = await runDiagnostics({ ...base, rootDir: dir });
      assert.equal(byId(r, "git_upstream").status, "fail");
      assert.equal(r.canSelfUpdate, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("autre branche que main : avertissement", async () => {
    const dir = makeRepo();
    try {
      git(dir, "checkout", "-q", "-b", "feature");
      const r = await runDiagnostics({ ...base, rootDir: dir });
      assert.equal(byId(r, "git_branch").status, "warn");
      assert.equal(r.install.branch, "feature");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test(
    "modifications locales : avertissement listant les fichiers (deploy.sh les mettrait de côté)",
    async () => {
      const dir = makeRepo();
      try {
        fs.writeFileSync(path.join(dir, "a.txt"), "modifié");
        const r = await runDiagnostics({ ...base, rootDir: dir });
        assert.equal(byId(r, "git_clean").status, "warn");
        assert.match(byId(r, "git_clean").detail, /a\.txt/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "fichiers NON suivis (data/, build…) : pas d'avertissement, deploy.sh ne les met pas de côté",
    async () => {
      const dir = makeRepo();
      try {
        fs.mkdirSync(path.join(dir, "data"));
        fs.writeFileSync(path.join(dir, "data", "monitor.db"), "x");
        fs.writeFileSync(path.join(dir, "notes-locales.txt"), "x");
        const r = await runDiagnostics({ ...base, rootDir: dir });
        assert.equal(byId(r, "git_clean").status, "ok");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "le dossier public/ (généré par le build) ne compte pas comme modification locale",
    async () => {
      const dir = makeRepo();
      try {
        fs.mkdirSync(path.join(dir, "public"));
        fs.writeFileSync(path.join(dir, "public", "index.html"), "x");
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "public");
        fs.writeFileSync(path.join(dir, "public", "index.html"), "rebuild");
        const r = await runDiagnostics({ ...base, rootDir: dir });
        assert.equal(byId(r, "git_clean").status, "ok");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test("remote qui ne correspond pas au dépôt suivi (fork) : avertissement", async () => {
    const dir = makeRepo();
    try {
      git(dir, "remote", "add", "origin", "https://github.com/someone/fork.git");
      const r = await runDiagnostics({ ...base, rootDir: dir, repo: "nogebeat/pm2-monitor" });
      assert.equal(byId(r, "git_remote").status, "warn");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("deploy.sh sans bit d'exécution : avertissement et commande via bash", async () => {
    const dir = makeRepo({ executable: false });
    try {
      const r = await runDiagnostics({ ...base, rootDir: dir });
      assert.equal(byId(r, "deploy_script").status, "warn");
      assert.match(r.command, /&& bash deploy\.sh update$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("deploy.sh absent : bloquant", async () => {
    const dir = makeRepo({ withDeployScript: false });
    try {
      const r = await runDiagnostics({ ...base, rootDir: dir });
      assert.equal(byId(r, "deploy_script").status, "fail");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("runDiagnostics — hors dépôt git et environnement", async (t) => {
  await t.test(
    "archive (zip) sans .git : non gérée, aucune commande git lancée, pas de commande proposée",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-diag-"));
      let gitCalls = 0;
      try {
        const r = await runDiagnostics({
          ...base,
          rootDir: dir,
          exec: async () => {
            gitCalls++;
            return { stdout: "" };
          },
        });
        assert.equal(r.install.type, "archive");
        assert.equal(r.canSelfUpdate, false);
        assert.equal(r.command, null);
        assert.equal(gitCalls, 0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test("conteneur : non géré", async () => {
    const dir = makeRepo();
    try {
      const r = await runDiagnostics({ ...base, rootDir: dir, env: { container: "docker" } });
      assert.equal(r.install.type, "container");
      assert.equal(r.canSelfUpdate, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("Node trop ancien : bloquant", async () => {
    const dir = makeRepo();
    try {
      const r = await runDiagnostics({ ...base, rootDir: dir, nodeVersion: "18.19.0" });
      assert.equal(byId(r, "node_version").status, "fail");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("service lancé en root : avertissement ; base de données signalée", async () => {
    const dir = makeRepo();
    try {
      const r = await runDiagnostics({ ...base, rootDir: dir, getuid: () => 0, env: { DB_DRIVER: "MySQL" } });
      assert.equal(byId(r, "run_as_root").status, "warn");
      assert.equal(byId(r, "database").detail, "mysql");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("n'exécute que des commandes git d'inspection, avec --no-optional-locks", async () => {
    const dir = makeRepo();
    const seen = [];
    try {
      await runDiagnostics({
        ...base,
        rootDir: dir,
        exec: async (file, args) => {
          seen.push([file, ...args]);
          return { stdout: "main\n" };
        },
      });
      assert.ok(seen.length > 0);
      const allowed = new Set(["--version", "rev-parse", "describe", "status", "remote"]);
      const forbidden = [
        "add",
        "commit",
        "checkout",
        "reset",
        "stash",
        "pull",
        "fetch",
        "clean",
        "merge",
        "rebase",
        "push",
        "gc",
      ];
      for (const [file, ...args] of seen) {
        assert.equal(file, "git");
        assert.ok(
          args.some((a) => allowed.has(a)),
          `sous-commande inattendue: ${args.join(" ")}`,
        );
        assert.ok(!args.some((a) => forbidden.includes(a)), `commande de modification: ${args.join(" ")}`);
      }
      assert.ok(seen.filter((s) => s[1] !== "--version").every((s) => s[1] === "--no-optional-locks"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("maskRemoteUrl — jamais d'identifiants dans la réponse", async (t) => {
  await t.test("retire utilisateur et jeton d'une URL https", () => {
    assert.equal(maskRemoteUrl("https://user:ghp_SECRET@github.com/a/b.git\n"), "https://github.com/a/b.git");
    assert.equal(maskRemoteUrl("https://ghp_SECRET@github.com/a/b.git"), "https://github.com/a/b.git");
  });
  await t.test("garde une URL sans identifiant telle quelle", () => {
    assert.equal(maskRemoteUrl("https://github.com/a/b.git"), "https://github.com/a/b.git");
  });
  await t.test("forme scp : ne fuit rien de secret", () => {
    assert.ok(!maskRemoteUrl("git@github.com:a/b.git").includes("SECRET"));
  });
});

test("buildUpdateCommand / shellQuote — chemin sûr à copier-coller", async (t) => {
  await t.test("met le chemin entre apostrophes", () => {
    assert.equal(buildUpdateCommand("/opt/pm2 monitor"), "cd '/opt/pm2 monitor' && ./deploy.sh update");
  });
  await t.test("neutralise une apostrophe dans le chemin", () => {
    assert.equal(shellQuote("/tmp/it's"), "'/tmp/it'\\''s'");
  });
  await t.test("un vrai shell relit exactement le chemin, sans exécuter son contenu", () => {
    const evil = "/tmp/a'; echo PWNED; '$(echo PWNED)`echo PWNED`";
    const out = execFileSync("sh", ["-c", `printf %s ${shellQuote(evil)}`]).toString();
    assert.equal(out, evil);
  });
});
