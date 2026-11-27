#!/usr/bin/env node
// install name from --app-name,
// the update ZIP is served from the local file under whichever first-party
// base the from-version asks for (downloads/ for releases, the development
// channel's releases/gravityport-dev/ for development builds, task 479).
// Rehearses one in-app macOS update step with real packages, isolated from the
// user's own install:
//   1. the running "from" app (started with launch-isolated.sh) is the target;
//   2. the update modules of the *from* version (its own source tree) check a
//      locally served feed signed with the real release key, download the real
//      update ZIP, and launch the real helper script;
//   3. the helper replaces the app in REHEARSAL_ROOT/Applications, starts the
//      new app and checks its readiness identity, exactly as in the field.
// The helper's `open -n` becomes launch-isolated.sh, so the new app never sees
// the real user data, library or port: helpers that support the
// MOSA_UPDATE_OPEN_BIN rehearsal override (0.3.0 and later) get open-standin.sh
// through it and run unmodified; older helpers (0.2.1-rc.x) have exactly two
// `/usr/bin/open -n "$INSTALL_APP"` lines (launch and rollback) swapped, and
// nothing else in the script changes. The network is replaced by a fetch stub
// that only answers the exact production URLs the from-version asks for.
//
// node rehearse-update.mjs --from-src <dir> --writer-src <dir> --root <dir>
//   --from-version <v> --to-version <v> --zip <update zip> --identity <build-identity.json>
//   --app-name <MOSA.app|GravityPort.app> --feed-url <url> --private-key <pem> [--port 43617]
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "from-src": { type: "string" }, "writer-src": { type: "string" }, root: { type: "string" },
    "from-version": { type: "string" }, "to-version": { type: "string" }, zip: { type: "string" },
    identity: { type: "string" }, "app-name": { type: "string" }, "feed-url": { type: "string" },
    "private-key": { type: "string" }, port: { type: "string", default: "43617" },
  },
});
const root = resolve(args.root);
const port = Number(args.port);
const launcher = resolve(dirname(new URL(import.meta.url).pathname), "launch-isolated.sh");
const installApp = join(root, "Applications", args["app-name"]);
const openStandin = resolve(dirname(new URL(import.meta.url).pathname), "open-standin.sh");
const stagingRoot = join(root, "user-data", "updates", "macos");
const libraryDir = join(root, "library");
const env = { ...process.env, REHEARSAL_ROOT: root, REHEARSAL_PORT: String(port) };
const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function appPid(appPath) {
  try {
    const out = execFileSync("/usr/bin/pgrep", ["-f", `^${appPath}/Contents/MacOS/`], { encoding: "utf8" });
    return Number(out.trim().split("\n")[0]) || null;
  } catch { return null; }
}

async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

async function waitFor(label, probe, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function schema(dbPath) {
  return execFileSync("/usr/bin/sqlite3", ["-readonly", dbPath, "select value from library_meta where key='schema_version';"], { encoding: "utf8" }).trim();
}

// --- 1. the running from-app ------------------------------------------------
const fromPid = appPid(installApp);
if (!fromPid) throw new Error(`${installApp} is not running; start it with launch-isolated.sh first`);
const before = await health();
log("from app", { pid: fromPid, version: before?.productVersion ?? before?.version, libraryDir: before?.libraryDir, schema: schema(join(libraryDir, "mosa.db")) });

// --- 2. a feed signed with the real release key -------------------------------
const { prepareDesktopReleaseManifest } = await import(join(resolve(args["writer-src"]), "scripts/prepare-desktop-release-manifest.mjs"));
const { formatNotesText, notesForVersion, readReleaseNotes } = await import(join(resolve(args["writer-src"]), "lib/release-notes.mjs"));
const toIdentity = JSON.parse(readFileSync(resolve(args.identity), "utf8"));
const notes = notesForVersion(readReleaseNotes(join(resolve(args["writer-src"]), "release-notes.json")), args["to-version"]);
// Development builds have no release-notes.json entry; their publisher writes
// the notes from the commit log.
if (!notes && toIdentity.distribution !== "development") throw new Error(`release-notes.json has no entry for ${args["to-version"]}`);
const manifest = await prepareDesktopReleaseManifest({
  version: args["to-version"],
  macArtifactPath: resolve(args.zip),
  macAppName: args["app-name"],
  macTeamIdentifier: "B5ZJT8TRPN",
  buildIdentity: toIdentity,
  // A writer that predates task 479 ignores this and only takes release builds.
  channel: toIdentity.distribution === "development" ? "development" : "release",
  signingPrivateKey: readFileSync(resolve(args["private-key"]), "utf8"),
  publishedAt: new Date().toISOString(),
  notes: notes
    ? { zh: formatNotesText(notes.zh), en: formatNotesText(notes.en) }
    : { zh: `开发版 ${args["to-version"]}（演练）。`, en: `Development build ${args["to-version"]} (rehearsal).` },
});
const manifestPath = join(root, "server", `${args["to-version"]}-latest.json`);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
log("signed feed", manifestPath, "keyId", manifest.signature.keyId.slice(0, 12));

const downloadSuffix = `/${basename(args.zip)}`;
const requested = [];
const fetchStub = async (url) => {
  const href = String(url);
  requested.push(href.split("?")[0]);
  if (href.split("?")[0] === args["feed-url"]) {
    return new Response(readFileSync(manifestPath, "utf8"), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (href.split("?")[0].startsWith("https://gravityport.azhuilab.com/") && href.split("?")[0].endsWith(downloadSuffix)) {
    return new Response(Readable.toWeb(createReadStream(resolve(args.zip))), {
      status: 200, headers: { "content-length": String(statSync(resolve(args.zip)).size), "content-type": "application/zip" },
    });
  }
  return new Response("not served in the rehearsal", { status: 404 });
};

// --- 3. the from-version's own update code -----------------------------------
const fromSrc = resolve(args["from-src"]);
const service = await import(join(fromSrc, "desktop/update-service.mjs"));
const updater = await import(join(fromSrc, "desktop/macos-updater.mjs"));
const signature = await import(join(fromSrc, "lib/release-manifest-signature.mjs"));
const fromIdentity = JSON.parse(readFileSync(join(root, "from-identity.json"), "utf8"));
const trust = signature.createReleaseManifestTrust(fromIdentity.releaseManifestTrust.publicKeyPem);
const release = await service.checkForMosaUpdate({
  currentVersion: args["from-version"], currentDistribution: fromIdentity.distribution, releaseManifestTrust: trust, fetchImpl: fetchStub,
});
log("update check", { latest: release.latestVersion, available: release.updateAvailable, mac: release.macArtifact?.file });
if (!release.updateAvailable || !release.macArtifact) throw new Error("the from-version did not offer the update");

const download = await updater.downloadMacosUpdate({
  artifact: release.macArtifact, version: release.latestVersion, stagingRoot, fetchImpl: fetchStub,
  // Same as desktop/main.mjs: the channel the feed was read from picks the
  // download base (older from-versions ignore it and use downloads/).
  downloadBaseUrl: release.downloadBaseUrl,
});
log("downloaded", download.zipPath);

let helperExit = null;
const supportsOpenOverride = updater.macosUpdateHelperScript().includes("MOSA_UPDATE_OPEN_BIN");
const spawnHelper = (command, helperArgs, options) => {
  if (supportsOpenOverride) {
    const child = spawn(command, helperArgs, { ...options, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => process.stderr.write(`[helper] ${chunk}`));
    child.on("exit", (code) => { helperExit = code; });
    return child;
  }
  const scriptPath = helperArgs[0];
  const script = readFileSync(scriptPath, "utf8");
  const launch = `/usr/bin/open -n "$INSTALL_APP" --args "--mosa-update-ready-file=$READY_FILE"`;
  const relaunch = `/usr/bin/open -n "$INSTALL_APP" >/dev/null 2>&1 || true`;
  const count = (needle) => script.split(needle).length - 1;
  if (count(launch) !== 1 || count(relaunch) !== 1 || count("/usr/bin/open") !== 2) {
    throw new Error(`unexpected helper script shape: launch=${count(launch)} relaunch=${count(relaunch)} open=${count("/usr/bin/open")}`);
  }
  const patched = script
    .replace(launch, `"${launcher}" "$INSTALL_APP" "--mosa-update-ready-file=$READY_FILE"`)
    .replace(relaunch, `"${launcher}" "$INSTALL_APP" >/dev/null 2>&1 || true`);
  execFileSync("/bin/cp", [scriptPath, `${scriptPath}.original`]);
  require_write(scriptPath, patched);
  const child = spawn(command, helperArgs, { ...options, env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => process.stderr.write(`[helper] ${chunk}`));
  child.on("exit", (code) => { helperExit = code; });
  return child;
};
function require_write(path, text) {
  execFileSync("/bin/sh", ["-c", 'cat > "$1"', "sh", path], { input: text });
}

const helper = await updater.launchMacosUpdateHelper({
  zipPath: download.zipPath, installAppPath: installApp, version: release.latestVersion,
  expectedIdentity: release.buildIdentity, processId: fromPid, libraryDir, spawnImpl: spawnHelper,
  // Same as desktop/main.mjs: the signed feed's team id goes to the helper (378).
  expectedTeamIdentifier: release.macArtifact.teamIdentifier || "",
  appName: release.macArtifact.appName ?? args["app-name"],
  helperEnv: { MOSA_UPDATE_OPEN_BIN: openStandin, REHEARSAL_ROOT: root, REHEARSAL_PORT: String(port) },
});
log("helper mode", supportsOpenOverride ? "MOSA_UPDATE_OPEN_BIN override, script unmodified" : "two open lines swapped");
log("helper started", helper.helperPid);

// The from-app quits itself after launching the helper; simulate that.
process.kill(fromPid, "SIGTERM");
await waitFor("from app exit", async () => !appPid(installApp) || (await sleep(0), false), 60_000).catch(() => {});
log("from app exited");

await waitFor("helper exit", async () => helperExit !== null, 240_000);
log("helper exit code", helperExit);
const logPath = helper.logPath;
if (existsSync(logPath)) log("helper error log:", (await readFile(logPath, "utf8")).trim());
if (helperExit !== 0) throw new Error(`helper failed with ${helperExit}`);

// --- 4. what the user ends up with ---------------------------------------------
const finalApp = join(root, "Applications", args["app-name"]);
const after = await waitFor("new app health", health, 60_000);
const plist = (key) => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(finalApp, "Contents/Info.plist")], { encoding: "utf8" }).trim();
const ready = JSON.parse(readFileSync(helper.readyFile, "utf8"));
console.log(JSON.stringify({
  ok: true,
  requested,
  finalApp,
  finalAppVersion: plist("CFBundleShortVersionString"),
  bundleId: plist("CFBundleIdentifier"),
  applications: execFileSync("/bin/ls", [join(root, "Applications")], { encoding: "utf8" }).trim().split("\n"),
  running: appPid(finalApp),
  health: { version: after.productVersion ?? after.version, gitSha: after.gitSha, libraryDir: after.libraryDir },
  ready: { version: ready.version, gitSha: ready.gitSha, distribution: ready.distribution },
  schema: schema(join(libraryDir, "mosa.db")),
}, null, 2));
