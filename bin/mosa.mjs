#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { resolveLibraryLocation } from "../lib/library-location.mjs";
import { createDerivativeWorker } from "../lib/derivative-worker.js";
import { assertExistingSqliteLibrary, migrateLegacyLibrary, verifySqliteLibrary } from "../lib/library-migration.js";
import { createLibraryBackup, restoreLibraryBackup, verifyLibraryBackup } from "../lib/library-backup.js";
import { verifyVisualModelPack } from "../lib/visual-model-pack.mjs";

const managerDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(process.env.MOSA_PROJECT_DIR || dirname(managerDir));
const args = process.argv.slice(2);
const command = args.shift();

if (!command || command === "--help" || command === "help") {
  printHelp();
  process.exitCode = command ? 0 : 1;
} else if (command === "migrate") {
  await runMigrate(args);
} else if (command === "verify") {
  await runVerify(args);
} else if (command === "backup") {
  await runBackup(args);
} else if (command === "backup-verify") {
  await runBackupVerify(args);
} else if (command === "restore") {
  await runRestore(args);
} else if (command === "visual-model-verify") {
  await runVisualModelVerify(args);
} else if (command === "thumbnails") {
  await runThumbnails(args);
} else {
  console.error(`Unknown GravityPort command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function runMigrate(values) {
  const options = parseOptions(values);
  const report = await migrateLegacyLibrary({
    managerDir,
    projectRoot,
    libraryDir: options.library,
    legacyAssetsRoot: options.from,
    dryRun: options.dryRun,
    resume: options.resume,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.issues.length || (!options.dryRun && !report.completed)) process.exitCode = 1;
}

async function runVerify(values) {
  const options = parseOptions(values);
  const report = await verifySqliteLibrary({ managerDir, projectRoot, libraryDir: options.library });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok || report.migration?.migration_state !== "completed") process.exitCode = 1;
}

async function runBackup(values) {
  const options = parseOptions(values);
  if (!options.to) throw new Error("backup requires --to <backup-dir>.");
  const report = await createLibraryBackup({
    managerDir,
    projectRoot,
    libraryDir: options.library,
    destinationDir: options.to,
  });
  console.log(JSON.stringify(report, null, 2));
}

async function runBackupVerify(values) {
  const options = parseOptions(values);
  if (!options.explicitFrom) throw new Error("backup-verify requires --from <backup-dir>.");
  const report = await verifyLibraryBackup({ managerDir, projectRoot, backupDir: options.from });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

async function runRestore(values) {
  const options = parseOptions(values);
  if (!options.explicitFrom) throw new Error("restore requires --from <backup-dir>.");
  if (!options.to) throw new Error("restore requires --to <empty-library-dir>.");
  const report = await restoreLibraryBackup({
    managerDir,
    projectRoot,
    backupDir: options.from,
    destinationDir: options.to,
  });
  console.log(JSON.stringify(report, null, 2));
}

async function runVisualModelVerify(values) {
  const options = parseOptions(values);
  if (!options.explicitFrom) throw new Error("visual-model-verify requires --from <model-pack-dir>.");
  const report = await verifyVisualModelPack({ packDir: options.from });
  console.log(JSON.stringify(report, null, 2));
}

async function runThumbnails(values) {
  const action = values.shift();
  if (!new Set(["rebuild", "repair"]).has(action)) {
    console.error("Usage: gravityport thumbnails <rebuild|repair> [--library <path>]");
    process.exitCode = 1;
    return;
  }
  const options = parseOptions(values);
  // Refuse before any store is opened: thumbnails must never materialize a
  // fresh mosa.db in a directory that holds no library.
  try {
    await assertExistingSqliteLibrary(options.library);
  } catch (error) {
    throw new Error(`${error.message} Run \`mosa migrate\` successfully before rebuilding derivatives.`);
  }
  const store = createSqliteAssetStore({ managerDir, projectRoot, libraryDir: options.library, storage: "sqlite" });
  try {
    const migration = await store.migrationStatus();
    if (migration.migration_state !== "completed") throw new Error("Run `mosa migrate` successfully before rebuilding derivatives.");
    const queued = await store.enqueueMissingDerivatives({ mode: action });
    const worker = createDerivativeWorker({ store });
    worker.start();
    try {
      const idleTimeoutMs = 5 * 60 * 1000;
      let lastProgressAt = Date.now();
      let lastSignature = "";
      while (true) {
        const status = await store.derivativeStatus();
        if (!status.pending && !status.running) {
          console.log(JSON.stringify({ queued, status, mode: action }, null, 2));
          process.exitCode = status.failed ? 1 : 0;
          break;
        }
        const signature = JSON.stringify(status);
        if (signature !== lastSignature) {
          lastSignature = signature;
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt >= idleTimeoutMs) {
          throw new Error("Thumbnail processing made no progress for 5 minutes; aborting instead of waiting forever.");
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    } finally {
      worker.stop();
    }
  } finally {
    store.close();
  }
}

function parseOptions(values) {
  const options = {
    library: resolveLibraryLocation({ homeDir: homedir(), envLibraryDir: process.env.MOSA_LIBRARY_DIR }).libraryDir,
    from: join(managerDir, "assets"),
    explicitFrom: false,
    to: "",
    dryRun: false,
    resume: false,
  };
  while (values.length) {
    const value = values.shift();
    if (value === "--library") options.library = resolve(requiredValue(value, values.shift()));
    else if (value === "--from") {
      options.from = resolve(requiredValue(value, values.shift()));
      options.explicitFrom = true;
    }
    else if (value === "--to") options.to = resolve(requiredValue(value, values.shift()));
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--resume") options.resume = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function requiredValue(flag, value) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a path.`);
  return value;
}

function printHelp() {
  console.log(`GravityPort local library commands

  gravityport migrate [--library <path>] [--from <legacy-assets>] [--dry-run] [--resume]
  gravityport verify [--library <path>]
  gravityport backup [--library <path>] --to <backup-dir>
  gravityport backup-verify --from <backup-dir>
  gravityport restore --from <backup-dir> --to <empty-library-dir>
  gravityport visual-model-verify --from <model-pack-dir>
  gravityport thumbnails <rebuild|repair> [--library <path>]
    rebuild  regenerate every eligible asset's derivatives from the original, present or not
    repair   enqueue only assets with missing derivative metadata or derivative files missing on disk

The mosa command still works as an alias of gravityport.
`);
}
