"use strict";

/**
 * lib/services/updates/diagnostics.js — "cette installation peut-elle se
 * mettre à jour avec `./deploy.sh update` ?"
 *
 * STRICTEMENT EN LECTURE SEULE : ce module n'exécute que des commandes git
 * d'inspection (`--version`, `rev-parse`, `describe`, `status`, `remote
 * get-url`), avec des arguments FIXES (aucune entrée utilisateur, jamais de
 * shell : execFile), un délai maximum et `--no-optional-locks` (même un
 * `git status` ne doit pas écrire dans le dépôt). Il ne modifie rien et ne
 * lance aucune mise à jour.
 *
 * Les contrôles reflètent le comportement RÉEL de deploy.sh update : la commande
 * proposée (`update --to vX.Y.Z` / `--latest`) avance sur UN TAG précis avec
 * `git merge --ff-only` (elle n'a besoin ni d'une branche amont ni d'une branche
 * courante), met de côté les modifications locales avec `git stash`, et
 * sauvegarde la base avant les migrations (donc `mysqldump` est requis en MySQL).
 * Le mode historique (`update` sans option) tire la branche avec `git pull`.
 *
 * Statuts : ok | warn | fail | info. `canSelfUpdate` = aucun `fail`.
 * Les dépendances (exec, fs, env…) sont injectables pour les tests.
 */

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const snapshot = require("../../db/snapshot");
const { parseReleaseTag } = require("./semver");

const GIT_TIMEOUT_MS = 5000;
const DISK_WARN_BYTES = 500 * 1024 * 1024;
const DISK_FAIL_BYTES = 100 * 1024 * 1024;

function defaultExec(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      file,
      args,
      {
        ...options,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout: String(stdout) });
      },
    );
  });
}

/** Retire identifiants/jetons d'une URL de remote (https://user:token@github.com/...). */
function maskRemoteUrl(value) {
  const raw = String(value || "").trim();
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch (e) {
    // forme scp ("git@github.com:owner/repo.git") : pas d'identifiant secret, juste "git@"
    return raw.replace(/^[^@/\s]+:[^@/\s]+@/, "");
  }
}

/** Échappe une valeur pour l'insérer entre apostrophes dans une commande shell copiée-collée. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Commande à copier-coller. deploy.sh est versionné SANS le bit d'exécution
 * (le README demande un `chmod +x` à l'installation) : s'il manque, `./deploy.sh`
 * échouerait, on propose donc `bash deploy.sh` qui fonctionne dans les deux cas.
 */
function buildUpdateCommand(workdir, { executable = true, target = null } = {}) {
  const script = executable ? "./deploy.sh" : "bash deploy.sh";
  // Le tag vient d'un contenu DISTANT (GitHub) et la commande sera collée dans un terminal,
  // parfois root : on ne l'y insère QUE s'il est strictement vMAJEUR.MINEUR.PATCH.
  const tag = target && parseReleaseTag(target.tag) ? target.tag : null;
  // `--allow-major` n'y figure JAMAIS : le copier-coller aveugle contournerait la garde que cette
  // option impose. Pour une version majeure, deploy.sh refuse avec un message explicite et c'est
  // à l'administrateur de l'ajouter en connaissance de cause après avoir lu les notes.
  const options = tag ? ` --to ${tag}` : " --latest";
  return `cd ${shellQuote(workdir)} && ${script} update${options}`;
}

function requiredNodeMajor(enginesNode) {
  const m = /^>=\s*(\d+)/.exec(String(enginesNode || "").trim());
  return m ? Number(m[1]) : null;
}

function runDiagnostics(deps = {}) {
  const rootDir = deps.rootDir || path.join(__dirname, "..", "..", "..");
  const exec = deps.exec || defaultExec;
  const fsApi = deps.fs || fs;
  const env = deps.env || process.env;
  const getuid = deps.getuid !== undefined ? deps.getuid : process.getuid && process.getuid.bind(process);
  const nodeVersion = deps.nodeVersion || process.versions.node;
  const enginesNode =
    deps.enginesNode !== undefined ? deps.enginesNode : require("../../../package.json").engines?.node;
  const repo = deps.repo || null;
  const target = deps.target || null;

  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail: detail || null });
  const git = (args) => exec("git", ["--no-optional-locks", ...args], { cwd: rootDir });
  const gitMessage = (err) =>
    String((err && (err.stderr || err.message)) || "erreur git")
      .trim()
      .split("\n")[0]
      .slice(0, 200);

  return (async () => {
    const install = { type: "git", branch: null, tag: null, commit: null, remote: null };

    // 1. Type d'installation — hors dépôt git (archive/zip) ou conteneur, pas de mise à jour automatique.
    const inContainer =
      fsApi.existsSync("/.dockerenv") || env.container === "docker" || env.container === "podman";
    const hasGit = fsApi.existsSync(path.join(rootDir, ".git"));
    if (inContainer) {
      install.type = "container";
      add("install_type", "fail", "container");
    } else if (!hasGit) {
      install.type = "archive";
      add("install_type", "fail", "archive");
    } else {
      add("install_type", "ok", "git");
    }

    // 2. Environnement local (indépendant de git)
    const major = Number(String(nodeVersion).split(".")[0]);
    const needMajor = requiredNodeMajor(enginesNode);
    if (needMajor === null) add("node_version", "info", `Node ${nodeVersion}`);
    else if (major >= needMajor) add("node_version", "ok", `Node ${nodeVersion} (>= ${needMajor})`);
    else add("node_version", "fail", `too_old:${needMajor}`);

    add(
      "process_manager",
      env.pm_id !== undefined ? "ok" : "warn",
      env.pm_id !== undefined ? `pm2:${env.pm_id}` : "not_pm2",
    );

    if (typeof getuid === "function") {
      const uid = getuid();
      add("run_as_root", uid === 0 ? "warn" : "info", uid === 0 ? "root" : `uid ${uid}`);
    }

    add("database", "info", String(env.DB_DRIVER || "sqlite").toLowerCase());

    // Sauvegarde de la base avant migration (faite par deploy.sh) : prérequis présents ?
    try {
      const dbConfig = snapshot.configFromEnv(env);
      const prereq = snapshot.checkPrerequisites(dbConfig, { rootDir, env });
      // Une base SQLite pas encore créée n'empêche rien (aucune donnée à sauvegarder).
      const problems = prereq.problems.filter((p) => p !== "no_db_file");
      add(
        "db_backup",
        problems.length ? "fail" : "ok",
        problems.length ? problems.join(",") : dbConfig.driver,
      );
    } catch (e) {
      add("db_backup", "fail", "invalid_driver");
    }

    try {
      fsApi.accessSync(rootDir, fsApi.constants.W_OK);
      if (hasGit) fsApi.accessSync(path.join(rootDir, ".git"), fsApi.constants.W_OK);
      add("write_access", "ok");
    } catch (e) {
      add("write_access", "fail", "not_writable");
    }

    try {
      const stat = fsApi.statfsSync(rootDir);
      const free = Number(stat.bavail) * Number(stat.bsize);
      // Unité neutre (Mo/MB selon la langue) : ni "Mo" ni "MB" dans un texte destiné aux deux langues.
      const gb = free / (1024 * 1024 * 1024);
      const label = gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(free / (1024 * 1024))} MB`;
      const status = free < DISK_FAIL_BYTES ? "fail" : free < DISK_WARN_BYTES ? "warn" : "ok";
      add("disk_space", status, label);
    } catch (e) {
      add("disk_space", "info", "indisponible");
    }

    let deployExecutable = true;
    try {
      fsApi.accessSync(path.join(rootDir, "deploy.sh"), fsApi.constants.R_OK);
      try {
        fsApi.accessSync(path.join(rootDir, "deploy.sh"), fsApi.constants.X_OK);
        add("deploy_script", "ok");
      } catch (e) {
        deployExecutable = false;
        add("deploy_script", "warn", "not_executable");
      }
    } catch (e) {
      add("deploy_script", "fail", "missing");
    }

    // 3. Contrôles git — seulement pour une vraie installation git
    if (install.type === "git") {
      let gitOk = true;
      try {
        await exec("git", ["--version"], { cwd: rootDir });
        add("git_available", "ok");
      } catch (e) {
        gitOk = false;
        add("git_available", "fail", "git est introuvable.");
      }

      if (gitOk) {
        // Branche courante
        try {
          const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
          install.commit = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim() || null;
          if (branch === "HEAD") {
            try {
              install.tag = (await git(["describe", "--tags", "--exact-match"])).stdout.trim() || null;
            } catch (e) {
              /* HEAD détaché hors tag : rien de plus à dire */
            }
            add("git_branch", "warn", install.tag ? `detached:${install.tag}` : "detached");
          } else {
            install.branch = branch;
            add("git_branch", branch === "main" ? "ok" : "warn", branch);
          }
        } catch (e) {
          add("git_branch", "fail", gitMessage(e));
        }

        // Branche amont (sans elle, `git pull --ff-only` échoue)
        if (install.branch) {
          try {
            const upstream = (await git(["rev-parse", "--abbrev-ref", "@{u}"])).stdout.trim();
            add("git_upstream", "ok", upstream);
          } catch (e) {
            add("git_upstream", "warn", "no_upstream");
          }
        }

        // Modifications locales : deploy.sh les met de côté avec `git stash` (sans -u), donc
        // SEULS les fichiers SUIVIS comptent. Les fichiers non suivis (data/, build…) n'y sont
        // pas touchés — les compter déclencherait un avertissement permanent sur toute installation.
        try {
          const out = (
            await git([
              "-c",
              "core.fileMode=false",
              "status",
              "--porcelain",
              "--untracked-files=no",
              "--",
              ".",
              ":(exclude)public",
            ])
          ).stdout;
          const files = out.split("\n").filter(Boolean);
          if (files.length === 0) add("git_clean", "ok");
          else
            add(
              "git_clean",
              "warn",
              `${files.length} · ${files
                .slice(0, 5)
                .map((l) => l.slice(3))
                .join(", ")}`,
            );
        } catch (e) {
          add("git_clean", "warn", gitMessage(e));
        }

        // Dépôt d'origine (fork ?) — l'URL est nettoyée de tout identifiant avant d'être renvoyée
        try {
          const remote = maskRemoteUrl((await git(["remote", "get-url", "origin"])).stdout);
          install.remote = remote;
          const matches = !repo || remote.toLowerCase().includes(String(repo).toLowerCase());
          add("git_remote", matches ? "ok" : "warn", remote);
        } catch (e) {
          add("git_remote", "warn", "no_origin");
        }
      }
    }

    return {
      checkedAt: Date.now(),
      canSelfUpdate: !checks.some((c) => c.status === "fail"),
      install,
      workdir: rootDir,
      command:
        install.type === "git" ? buildUpdateCommand(rootDir, { executable: deployExecutable, target }) : null,
      checks,
    };
  })();
}

module.exports = { runDiagnostics, maskRemoteUrl, buildUpdateCommand, shellQuote };
