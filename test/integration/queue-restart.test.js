"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.join(__dirname, "..", "..");

/**
 * Petit script one-shot exécuté dans un process Node séparé : ouvre la DB,
 * exécute une action, ferme la DB, quitte. Utilisé pour simuler des
 * "process A" / "process B" distincts qui ne partagent que le fichier
 * SQLite sur disque — le vrai test d'un redémarrage.
 */
function workerScript(action) {
  return `
    process.env.DB_SQLITE_PATH = ${JSON.stringify(process.env.__TEST_DB_PATH__)};
    const db = require(${JSON.stringify(path.join(PROJECT_ROOT, "lib", "db"))});
    const { createQueue } = require(${JSON.stringify(
      path.join(PROJECT_ROOT, "lib", "services", "queue")
    )});
    const migrator = require(${JSON.stringify(path.join(PROJECT_ROOT, "lib", "db", "migrator"))});

    (async () => {
      await db.init();
      await migrator.up();
      const q = createQueue("restart-integration");
      ${action}
      await db.close();
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
}

async function runWorker(dbPath, action) {
  const scriptPath = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-worker-"));
  const file = path.join(scriptPath, "worker.js");
  process.env.__TEST_DB_PATH__ = dbPath;
  fs.writeFileSync(file, workerScript(action));
  const { stdout, stderr } = await execFileAsync(process.execPath, [file], { cwd: PROJECT_ROOT });
  return { stdout, stderr };
}

test("job survit à un redémarrage réel du process (deux processus Node distincts)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-monitor-restart-test-"));
  const dbPath = path.join(dir, "monitor.db");

  // Process A : crée un job puis "s'arrête" (le process se termine, la DB est fermée proprement).
  await runWorker(
    dbPath,
    `
      const id = await q.add({ task: "hello-from-process-A" });
      console.log("CREATED:" + id);
    `
  );

  // Rien ne tourne plus : simulate un vrai redémarrage (nouveau process Node,
  // aucun état en mémoire partagé avec le précédent).

  // Process B : "redémarre", récupère les jobs orphelins, et traite la file.
  const { stdout } = await runWorker(
    dbPath,
    `
      await q.recoverStaleActiveJobs();
      const pending = await q.listByStatus("pending");
      console.log("PENDING_COUNT:" + pending.length);
      const processed = await q.processOne(async (payload) => {
        console.log("PROCESSED:" + JSON.stringify(payload));
      });
      console.log("PROCESSED_ID:" + (processed ? processed.id : "none"));
    `
  );

  assert.match(stdout, /PENDING_COUNT:1/, "le job créé par le process A doit être visible par le process B");
  assert.match(stdout, /PROCESSED:\{"task":"hello-from-process-A"\}/);
  assert.match(stdout, /PROCESSED_ID:\d+/);

  fs.rmSync(dir, { recursive: true, force: true });
});
