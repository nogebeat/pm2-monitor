"use strict";

/**
 * Toutes les fonctions prennent (pm2, ...) et retournent une Promise.
 * pm2 = l'instance du module "pm2" déjà connectée (pm2.connect appelé côté serveur).
 */

function describeOne(pm2, id) {
  return new Promise((resolve, reject) => {
    pm2.describe(id, (err, list) => {
      if (err) return reject(err);
      if (!list || !list.length) return reject(new Error("Process introuvable."));
      resolve(list[0]);
    });
  });
}

function reload(pm2, id) {
  return new Promise((resolve, reject) => {
    pm2.reload(id, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Redémarrage simple via l'API programmatique PM2 (même appel que
 * POST /api/processes/:id/restart dans server.js). Utilisé par
 * lib/services/auto-healing/engine.js : jamais de commande shell, `id` est
 * toujours un nom/pm_id de process déjà connu du monitor (jamais une entrée
 * utilisateur libre transformée en commande).
 */
function restart(pm2, id) {
  return new Promise((resolve, reject) => {
    pm2.restart(id, (err) => (err ? reject(err) : resolve()));
  });
}

async function scale(pm2, id, instances) {
  const n = parseInt(instances, 10);
  if (Number.isNaN(n) || n < 1) throw new Error("Nombre d'instances invalide.");
  const proc = await describeOne(pm2, id);
  return new Promise((resolve, reject) => {
    pm2.scale(proc.name, n, (err) => (err ? reject(err) : resolve()));
  });
}

async function toggleWatch(pm2, id, enable) {
  return new Promise((resolve, reject) => {
    pm2.restart(id, { watch: !!enable }, (err) => (err ? reject(err) : resolve()));
  });
}

async function editEnv(pm2, id, envVars) {
  if (!envVars || typeof envVars !== "object") throw new Error("Variables d'environnement invalides.");
  const proc = await describeOne(pm2, id);
  // pm2.restart(id, {env}) refuse toujours ("--env sans ecosystem.config.js") : il faut passer
  // un objet de config (comme le ferait un ecosystem file) plutôt qu'un simple id de process.
  return new Promise((resolve, reject) => {
    pm2.restart({ name: proc.name, updateEnv: true, env: envVars }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Modifie script / args / mode d'exécution / instances : PM2 n'offre pas de "hot edit"
 * pour ces champs via l'API programmatique, donc on supprime puis on relance le process
 * avec la configuration fusionnée (le plus proche d'un "pm2 delete && pm2 start").
 */
async function editConfig(pm2, id, changes) {
  const proc = await describeOne(pm2, id);
  const env = proc.pm2_env || {};

  const merged = {
    name: env.name || proc.name,
    script: changes.script || env.pm_exec_path || env.script,
    args: changes.args !== undefined ? changes.args : env.args,
    exec_mode: changes.execMode || env.exec_mode || "fork",
    instances: changes.instances !== undefined ? parseInt(changes.instances, 10) : env.instances || 1,
    cwd: env.pm_cwd,
    env: env.env || {},
    watch: !!env.watch,
    autorestart: env.autorestart !== false,
    max_memory_restart: env.max_memory_restart || undefined,
  };

  await new Promise((resolve) => {
    // On supprime par NOM (pas par id) pour retirer toutes les instances du groupe
    // (en mode cluster, un id ne représente qu'une seule instance parmi plusieurs).
    pm2.delete(merged.name, () => resolve()); // continue même si déjà absent
  });

  return new Promise((resolve, reject) => {
    pm2.start(merged, (err) => (err ? reject(err) : resolve()));
  });
}

function save(pm2) {
  return new Promise((resolve, reject) => {
    pm2.dump((err) => (err ? reject(err) : resolve()));
  });
}

function resurrect(pm2) {
  return new Promise((resolve, reject) => {
    pm2.resurrect((err) => (err ? reject(err) : resolve()));
  });
}

function flush(pm2, id) {
  return new Promise((resolve, reject) => {
    if (id === undefined || id === null) {
      pm2.flush((err) => (err ? reject(err) : resolve()));
    } else {
      pm2.flush(id, (err) => (err ? reject(err) : resolve()));
    }
  });
}

function resetCounter(pm2, id) {
  return new Promise((resolve, reject) => {
    pm2.reset(id, (err) => (err ? reject(err) : resolve()));
  });
}

function updatePM2(pm2) {
  return new Promise((resolve, reject) => {
    pm2.updatePM2((err) => (err ? reject(err) : resolve()));
  });
}

function killDaemon(pm2) {
  return new Promise((resolve, reject) => {
    pm2.killDaemon((err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  describeOne,
  reload,
  restart,
  scale,
  toggleWatch,
  editEnv,
  editConfig,
  save,
  resurrect,
  flush,
  resetCounter,
  updatePM2,
  killDaemon,
};
