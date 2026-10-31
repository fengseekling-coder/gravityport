// Real installation rehearsals for the macOS update helper. They build fake
// .app bundles (Info.plist + a shell executable, ad-hoc signed), zip them the
// same way the release pipeline does, and run the generated apply-update.sh
// against stub stand-ins for `open`, `codesign`, and `spctl`. The Trash
// location is overridden into the temp directory — these tests never touch the
// user's real ~/.Trash, /Applications, or any installed MOSA app.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { launchMacosUpdateHelper } from "../desktop/macos-updater.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

const MAY_RUN_HERE = process.platform === "darwin" && !(process.getuid && process.getuid() === 0);

const VERSION = "0.3.0";
const GIT_SHA = "a".repeat(40);
const UI_FINGERPRINT = "b".repeat(64);
const RUNTIME_FINGERPRINT = "c".repeat(64);
const TAB = "\t";

function identity(distribution) {
  return { gitSha: GIT_SHA, uiFingerprint: UI_FINGERPRINT, runtimeFingerprint: RUNTIME_FINGERPRINT, distribution };
}

function plistXml({ version, execName }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.azhuilab.mosa</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>${execName}</string>
</dict></plist>`;
}

async function writeExecutable(path, body) {
  await writeFile(path, body, { encoding: "utf8", mode: 0o755 });
}

// mode "ready": with --mosa-update-ready-file=<path> writes the readiness plist
// then lingers briefly so the helper observes a live process; without the
// argument it exits immediately (a relaunched previous app must not linger).
// mode "silent": never reports readiness and exits after a moment, which is
// how the helper's failure path is exercised.
// mode "upgraded-silent": like "silent", but first leaves the schema-upgrade
// marker next to the ready file, the way a version that upgraded the library
// schema does before it could report readiness.
function appExecutableBody({ version, distribution, mode }) {
  if (mode === "upgraded-silent") {
    return `#!/bin/sh
ready=""
for arg in "$@"; do
  case "\$arg" in
    --mosa-update-ready-file=*) ready="\${arg#--mosa-update-ready-file=}";;
  esac
done
if [ -z "\$ready" ]; then
  exit 0
fi
printf '{"from":15,"to":16}\\n' > "\$(dirname "\$ready")/schema-upgrade-started.json"
sleep 1
exit 43
`;
  }
  if (mode === "silent") {
    return `#!/bin/sh
# never reports readiness
sleep 1
exit 43
`;
  }
  return `#!/bin/sh
ready=""
for arg in "$@"; do
  case "\$arg" in
    --mosa-update-ready-file=*) ready="\${arg#--mosa-update-ready-file=}";;
  esac
done
if [ -z "\$ready" ]; then
  exit 0
fi
cat > "\$ready" <<MOSA_READY_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>version</key><string>${version}</string>
<key>gitSha</key><string>${GIT_SHA}</string>
<key>uiFingerprint</key><string>${UI_FINGERPRINT}</string>
<key>runtimeFingerprint</key><string>${RUNTIME_FINGERPRINT}</string>
<key>distribution</key><string>${distribution}</string>
</dict></plist>
MOSA_READY_EOF
sleep 2
`;
}

async function makeFakeApp({ root, appName, execName, version, distribution = "preview", mode = "ready", marker }) {
  const appPath = join(root, appName);
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(appPath, "Contents", "Info.plist"), plistXml({ version, execName }), "utf8");
  await writeExecutable(join(appPath, "Contents", "MacOS", execName), appExecutableBody({ version, distribution, mode }));
  await writeFile(join(appPath, "Contents", "version-marker"), marker || version, "utf8");
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "-s", "-", appPath]);
  return appPath;
}

async function makePayloadZip({ root, appName }) {
  const zipPath = join(root, `${appName.slice(0, -4)}-darwin-arm64-${VERSION}.zip`);
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", appName, zipPath], { cwd: root });
  return zipPath;
}

async function writeStubScripts(root, { stubCodesign = false, stubSpctl = false } = {}) {
  const stubs = {};
  const openStub = join(root, "stub-open.sh");
  await writeExecutable(openStub, `#!/bin/sh
# Minimal /usr/bin/open stand-in: run the bundle executable directly.
[ "\${1:-}" = "-n" ] && shift
app="\${1:-}"
[ \$# -gt 0 ] && shift
[ "\${1:-}" = "--args" ] && shift
printf '%s\n' "$app" >> "${join(root, "open.log")}"
# Which unpacked payloads are still in the transaction when the new app opens:
# a rename leaves none behind, a copy would still hold one.
printf 'open:%s\n' "$(ls -d "$(dirname "$app")"/.MOSA-update-*/extracted/* 2>/dev/null | tr '\n' ' ')" >> "${join(root, "open-payloads.log")}"
exe_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null || true)"
[ -n "$exe_name" ] || exe_name="$(basename "$app" .app)"
"$app/Contents/MacOS/$exe_name" "$@" &
exit 0
`);
  stubs.open = openStub;
  if (stubCodesign) {
    const codesignStub = join(root, "stub-codesign.sh");
    await writeExecutable(codesignStub, `#!/bin/sh
# codesign stand-in: real --verify, scripted TeamIdentifier answers.
for arg in "$@"; do
  case "$arg" in
    --verify|--deep|--strict) exec /usr/bin/codesign "$@";;
  esac
done
lookup=""
for arg in "$@"; do lookup="$arg"; done
case "$lookup" in
  *.MOSA-update-*/extracted/*) lookup="EXTRACTED_PAYLOAD";;
esac
team=""
map="\${MOSA_TEST_TEAM_MAP:-}"
if [ -n "$map" ] && [ -f "$map" ]; then
  while IFS="$(printf '\\t')" read -r t p; do
    [ "$p" = "$lookup" ] && team="$t"
  done < "$map"
fi
printf 'Executable=%s\\n' "$lookup"
printf 'flags=0x10000(runtime)\\n'
printf 'TeamIdentifier=%s\\n' "\${team:-not set}"
`);
    stubs.codesign = codesignStub;
  }
  if (stubSpctl) {
    const spctlStub = join(root, "stub-spctl.sh");
    await writeExecutable(spctlStub, `#!/bin/sh
# spctl stand-in: Gatekeeper acceptance is out of scope for rehearsals.
exit 0
`);
    stubs.spctl = spctlStub;
  }
  return stubs;
}

async function helperEnv(root, stubs, extra = {}) {
  const env = {
    MOSA_UPDATE_TRASH_DIR: join(root, "trash"),
    ...extra,
  };
  if (stubs.open) env.MOSA_UPDATE_OPEN_BIN = stubs.open;
  if (stubs.codesign) env.MOSA_UPDATE_CODESIGN_BIN = stubs.codesign;
  if (stubs.spctl) env.MOSA_UPDATE_SPCTL_BIN = stubs.spctl;
  return env;
}

async function launchHelper({ root, stubs, installAppPath, zipPath, appName, distribution = "preview", teamIdentifier = "", envExtra = {} }) {
  return launchMacosUpdateHelper({
    zipPath,
    installAppPath,
    version: VERSION,
    expectedIdentity: identity(distribution),
    processId: spawn("/bin/sleep", ["0.4"]).pid,
    libraryDir: join(root, "library"),
    appName,
    expectedTeamIdentifier: teamIdentifier,
    helperEnv: await helperEnv(root, stubs, envExtra),
    createUpdateHandoff: async () => ({}),
  });
}

async function waitFor(predicate, { timeoutMs = 20_000, stepMs = 100, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveStep) => setTimeout(resolveStep, stepMs));
  }
  throw new Error(`Rehearsal timed out waiting for ${label}`);
}

function transactionDirs(appsDir) {
  return existsSync(appsDir)
    ? readdirSync(appsDir).filter((name) => name.startsWith(".MOSA-update-"))
    : [];
}

function markerOf(appPath) {
  // The replacement window briefly has no app at the install path; the
  // polling predicates treat null as "not yet".
  try {
    return readFileSync(join(appPath, "Contents", "version-marker"), "utf8");
  } catch {
    return null;
  }
}

const previewScope = MAY_RUN_HERE ? test : test.skip;

previewScope("rehearsal: same-name preview update replaces the app in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-same-"));
  const appsDir = join(root, "apps");
  try {
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await makeFakeApp({ root: payloadRoot, appName: "MOSA.app", execName: "MOSA", version: VERSION, marker: "new" });
    const zipPath = await makePayloadZip({ root: payloadRoot, appName: "MOSA.app" });
    const stubs = await writeStubScripts(root);

    const { logPath, readyFile } = await launchHelper({
      root,
      stubs,
      installAppPath: join(appsDir, "MOSA.app"),
      zipPath,
      appName: "MOSA.app",
    });

    await waitFor(() => markerOf(join(appsDir, "MOSA.app")) === "new", { label: "same-name success (replacement installed)" });
    await waitFor(() => transactionDirs(appsDir).length === 0, { label: "same-name success (transaction cleanup)" });
    assert.equal(
      readFileSync(join(root, "open-payloads.log"), "utf8").includes("extracted/MOSA.app"),
      false,
      "the new app opens after the unpacked payload was renamed into place, not copied",
    );
    assert.equal(existsSync(logPath), false, `helper failure log must be absent, got: ${existsSync(logPath) ? readFileSync(logPath, "utf8") : ""}`);
    assert.equal(existsSync(readyFile), true, "the replacement reports readiness into the staging root");
    assert.match(readFileSync(readyFile, "utf8"), new RegExp(`<string>${VERSION}</string>`));
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

previewScope("rehearsal: cross-name preview update installs GravityPort.app and Trashes MOSA.app", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-cross-"));
  const appsDir = join(root, "apps");
  const trashDir = join(root, "trash");
  try {
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await makeFakeApp({ root: payloadRoot, appName: "GravityPort.app", execName: "GravityPort", version: VERSION, marker: "new" });
    const zipPath = await makePayloadZip({ root: payloadRoot, appName: "GravityPort.app" });
    const stubs = await writeStubScripts(root);

    const { readyFile } = await launchHelper({
      root,
      stubs,
      installAppPath: join(appsDir, "MOSA.app"),
      zipPath,
      appName: "GravityPort.app",
    });

    await waitFor(() => existsSync(join(appsDir, "GravityPort.app")) && !existsSync(join(appsDir, "MOSA.app")), {
      label: "cross-name success (target installed, previous gone)",
    });
    await waitFor(() => transactionDirs(appsDir).length === 0, { label: "cross-name success (transaction cleanup)" });
    assert.equal(markerOf(join(appsDir, "GravityPort.app")), "new");
    await waitFor(() => existsSync(join(trashDir, "MOSA.app")), { label: "previous app moved to the test Trash" });
    assert.equal(markerOf(join(trashDir, "MOSA.app")), "old");
    assert.equal(existsSync(readyFile), true, "the replacement reports readiness into the staging root");
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

previewScope("rehearsal: cross-name update with a silent payload rolls back to MOSA.app", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-fail-"));
  const appsDir = join(root, "apps");
  try {
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await makeFakeApp({
      root: payloadRoot,
      appName: "GravityPort.app",
      execName: "GravityPort",
      version: VERSION,
      marker: "new",
      mode: "silent",
    });
    const zipPath = await makePayloadZip({ root: payloadRoot, appName: "GravityPort.app" });
    const stubs = await writeStubScripts(root);

    const { logPath } = await launchHelper({
      root,
      stubs,
      installAppPath: join(appsDir, "MOSA.app"),
      zipPath,
      appName: "GravityPort.app",
    });

    await waitFor(() => existsSync(logPath), { label: "helper failure log" });
    assert.match(readFileSync(logPath, "utf8"), /failed \(exit \d+\)/);
    await waitFor(() => existsSync(join(appsDir, "MOSA.app")) && markerOf(join(appsDir, "MOSA.app")) === "old", {
      label: "previous app restored at the original path and name",
    });
    assert.equal(existsSync(join(appsDir, "GravityPort.app")), false, "failed replacement must be removed");
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

previewScope("rehearsal: a payload that upgraded the library is kept instead of rolled back", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-schema-"));
  const appsDir = join(root, "apps");
  try {
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "GravityPort.app", execName: "GravityPort", version: "0.3.2", marker: "old" });
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await makeFakeApp({
      root: payloadRoot,
      appName: "GravityPort.app",
      execName: "GravityPort",
      version: VERSION,
      marker: "new",
      mode: "upgraded-silent",
    });
    const zipPath = await makePayloadZip({ root: payloadRoot, appName: "GravityPort.app" });
    const stubs = await writeStubScripts(root);

    const { logPath } = await launchHelper({
      root,
      stubs,
      installAppPath: join(appsDir, "GravityPort.app"),
      zipPath,
      appName: "GravityPort.app",
    });

    await waitFor(() => existsSync(logPath), { label: "helper log" });
    assert.match(readFileSync(logPath, "utf8"), /kept the new version because it already upgraded the library/);
    assert.equal(markerOf(join(appsDir, "GravityPort.app")), "new", "the version that upgraded the library stays installed");
    // The new version stopped before reporting readiness: the helper starts it
    // again instead of reopening the previous version.
    await waitFor(() => readFileSync(join(root, "open.log"), "utf8").trim().split("\n").length === 2, { label: "relaunch of the kept version" });
    assert.deepEqual(readFileSync(join(root, "open.log"), "utf8").trim().split("\n"), [
      join(appsDir, "GravityPort.app"),
      join(appsDir, "GravityPort.app"),
    ]);
    // The previous copy stays parked in the transaction directory.
    const [transaction] = transactionDirs(appsDir);
    assert.ok(transaction, "the previous copy stays parked");
    assert.equal(markerOf(join(appsDir, transaction, "previous.app")), "old");
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

previewScope("rehearsal: a cross-name payload that upgraded the library is kept instead of rolled back", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-schema-cross-"));
  const appsDir = join(root, "apps");
  try {
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await makeFakeApp({
      root: payloadRoot,
      appName: "GravityPort.app",
      execName: "GravityPort",
      version: VERSION,
      marker: "new",
      mode: "upgraded-silent",
    });
    const zipPath = await makePayloadZip({ root: payloadRoot, appName: "GravityPort.app" });
    const stubs = await writeStubScripts(root);

    const { logPath } = await launchHelper({
      root,
      stubs,
      installAppPath: join(appsDir, "MOSA.app"),
      zipPath,
      appName: "GravityPort.app",
    });

    await waitFor(() => existsSync(logPath), { label: "helper log" });
    assert.match(readFileSync(logPath, "utf8"), /exit \d+/);
    assert.match(readFileSync(logPath, "utf8"), /kept the new version/);
    assert.equal(markerOf(join(appsDir, "GravityPort.app")), "new");
    assert.equal(existsSync(join(appsDir, "MOSA.app")), false, "the previous name is not restored over an upgraded library");
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

previewScope("rehearsal: cross-name update refuses to overwrite an existing GravityPort.app", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-block-"));
  const appsDir = join(root, "apps");
  try {
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    await makeFakeApp({ root: appsDir, appName: "GravityPort.app", execName: "GravityPort", version: "0.9.0", marker: "user-copy" });
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await makeFakeApp({ root: payloadRoot, appName: "GravityPort.app", execName: "GravityPort", version: VERSION, marker: "new" });
    const zipPath = await makePayloadZip({ root: payloadRoot, appName: "GravityPort.app" });
    const stubs = await writeStubScripts(root);

    await launchHelper({
      root,
      stubs,
      installAppPath: join(appsDir, "MOSA.app"),
      zipPath,
      appName: "GravityPort.app",
    });

    // Give a (wrong) full update flow time to make changes; none may appear.
    await new Promise((resolveWait) => setTimeout(resolveWait, 2500));
    assert.equal(markerOf(join(appsDir, "MOSA.app")), "old");
    assert.equal(markerOf(join(appsDir, "GravityPort.app")), "user-copy");
    assert.deepEqual(transactionDirs(appsDir), [], "a refused update must not create a transaction");
    assert.equal(existsSync(join(root, "trash")), false, "a refused update must not touch the Trash");
    // The previous app already quit for the update; the refusal must reopen it
    // and leave a log instead of silently leaving the user with nothing running.
    assert.equal(readFileSync(join(root, "open.log"), "utf8").trim(), join(appsDir, "MOSA.app"));
    assert.match(readFileSync(join(payloadRoot, "apply-update-error.log"), "utf8"), /exit 33/);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

previewScope("rehearsal: production team identifier rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-prod-"));
  const appsDir = join(root, "apps");
  try {
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await makeFakeApp({
      root: payloadRoot,
      appName: "MOSA.app",
      execName: "MOSA",
      version: VERSION,
      distribution: "production",
      marker: "new",
    });
    const zipPath = await makePayloadZip({ root: payloadRoot, appName: "MOSA.app" });
    const stubs = await writeStubScripts(root, { stubCodesign: true, stubSpctl: true });
    const installApp = join(appsDir, "MOSA.app");
    const failureLog = join(payloadRoot, "apply-update-error.log");

    // 1) old without a team, new signed by the manifest team -> succeeds.
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    await writeFile(join(root, "team-map-a.tsv"), `TEAMAAAAA1${TAB}EXTRACTED_PAYLOAD\n`, "utf8");
    await launchHelper({
      root,
      stubs,
      installAppPath: installApp,
      zipPath,
      appName: "MOSA.app",
      distribution: "production",
      teamIdentifier: "TEAMAAAAA1",
      envExtra: { MOSA_TEST_TEAM_MAP: join(root, "team-map-a.tsv") },
    });
    await waitFor(() => markerOf(installApp) === "new", { label: "old-none production success (replacement installed)" });
    await waitFor(() => transactionDirs(appsDir).length === 0, { label: "old-none production success (transaction cleanup)" });

    // 2) old with the same team as the payload and the manifest -> succeeds.
    await rm(appsDir, { recursive: true, force: true });
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    await writeFile(
      join(root, "team-map-b.tsv"),
      `TEAMAAAAA1${TAB}EXTRACTED_PAYLOAD\nTEAMAAAAA1${TAB}${installApp}\n`,
      "utf8",
    );
    await launchHelper({
      root,
      stubs,
      installAppPath: installApp,
      zipPath,
      appName: "MOSA.app",
      distribution: "production",
      teamIdentifier: "TEAMAAAAA1",
      envExtra: { MOSA_TEST_TEAM_MAP: join(root, "team-map-b.tsv") },
    });
    await waitFor(() => markerOf(installApp) === "new", { label: "same-team production success (replacement installed)" });
    await waitFor(() => transactionDirs(appsDir).length === 0, { label: "same-team production success (transaction cleanup)" });

    // 3) old team differs from the payload team -> refused, nothing changes.
    await rm(appsDir, { recursive: true, force: true });
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    await writeFile(
      join(root, "team-map-c.tsv"),
      `TEAMBBBBB2${TAB}EXTRACTED_PAYLOAD\nTEAMAAAAA1${TAB}${installApp}\n`,
      "utf8",
    );
    await launchHelper({
      root,
      stubs,
      installAppPath: installApp,
      zipPath,
      appName: "MOSA.app",
      distribution: "production",
      teamIdentifier: "TEAMBBBBB2",
      envExtra: { MOSA_TEST_TEAM_MAP: join(root, "team-map-c.tsv") },
    });
    await waitFor(() => existsSync(failureLog), { label: "team-mismatch failure log" });
    assert.equal(markerOf(installApp), "old", "a team-mismatched payload must never replace the app");

    // 4) payload team differs from the manifest team -> refused.
    await rm(appsDir, { recursive: true, force: true });
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    await rm(failureLog, { force: true });
    await launchHelper({
      root,
      stubs,
      installAppPath: installApp,
      zipPath,
      appName: "MOSA.app",
      distribution: "production",
      teamIdentifier: "TEAMCCCCC3",
      envExtra: { MOSA_TEST_TEAM_MAP: join(root, "team-map-c.tsv") },
    });
    await waitFor(() => existsSync(failureLog), { label: "manifest-mismatch failure log" });
    assert.equal(markerOf(installApp), "old");
    assert.equal(existsSync(join(root, "trash")), false, "nothing may reach the Trash on a refused payload");
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

// Failure rehearsals: each one breaks a single step and checks two things: the
// log's first line names that step, and the previous app is back in place and
// reopened. A failed attempt may leave its .MOSA-update-* folder beside the app
// (the rollback never removes it), so that is not asserted here.
const FAILURE_LINE = /^GP_UPDATE_FAILURE code=(\S+) exit=(\d+)$/;

async function assertFailureRestored({ root, appsDir, logPath, code }) {
  await waitFor(() => existsSync(logPath), { label: `${code} failure log` });
  const [firstLine] = readFileSync(logPath, "utf8").split("\n");
  const match = FAILURE_LINE.exec(firstLine);
  assert.ok(match, `first log line must be a GP_UPDATE_FAILURE code, got: ${firstLine}`);
  assert.equal(match[1], code);
  await waitFor(() => markerOf(join(appsDir, "MOSA.app")) === "old", { label: `${code} previous app restored` });
  assert.equal(readFileSync(join(root, "open.log"), "utf8").trim().split("\n").pop(), join(appsDir, "MOSA.app"));
}

previewScope("rehearsal failure: EXTRACT_FAILED when the downloaded ZIP is not an archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-extract-"));
  const appsDir = join(root, "apps");
  try {
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    const zipPath = join(root, `MOSA-darwin-arm64-${VERSION}.zip`);
    await writeFile(zipPath, "not a zip archive", "utf8");
    const stubs = await writeStubScripts(root);
    const { logPath } = await launchHelper({ root, stubs, installAppPath: join(appsDir, "MOSA.app"), zipPath, appName: "MOSA.app" });
    await assertFailureRestored({ root, appsDir, logPath, code: "EXTRACT_FAILED" });
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

previewScope("rehearsal failure: VERIFY_FAILED when the code signature check fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-verify-"));
  const appsDir = join(root, "apps");
  try {
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await makeFakeApp({ root: payloadRoot, appName: "MOSA.app", execName: "MOSA", version: VERSION, marker: "new" });
    const zipPath = await makePayloadZip({ root: payloadRoot, appName: "MOSA.app" });
    const stubs = await writeStubScripts(root);
    const failingCodesign = join(root, "stub-codesign-fails.sh");
    await writeExecutable(failingCodesign, "#!/bin/sh\nexit 1\n");
    stubs.codesign = failingCodesign;
    const { logPath } = await launchHelper({ root, stubs, installAppPath: join(appsDir, "MOSA.app"), zipPath, appName: "MOSA.app" });
    await assertFailureRestored({ root, appsDir, logPath, code: "VERIFY_FAILED" });
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

previewScope("rehearsal failure: TARGET_EXISTS when GravityPort.app is already installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-target-"));
  const appsDir = join(root, "apps");
  try {
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    await makeFakeApp({ root: appsDir, appName: "GravityPort.app", execName: "GravityPort", version: "0.9.0", marker: "user-copy" });
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await makeFakeApp({ root: payloadRoot, appName: "GravityPort.app", execName: "GravityPort", version: VERSION, marker: "new" });
    const zipPath = await makePayloadZip({ root: payloadRoot, appName: "GravityPort.app" });
    const stubs = await writeStubScripts(root);
    const { logPath } = await launchHelper({ root, stubs, installAppPath: join(appsDir, "MOSA.app"), zipPath, appName: "GravityPort.app" });
    await assertFailureRestored({ root, appsDir, logPath, code: "TARGET_EXISTS" });
    assert.equal(markerOf(join(appsDir, "GravityPort.app")), "user-copy");
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

previewScope("rehearsal failure: REPLACE_FAILED when the previous app cannot be moved aside", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-replace-"));
  const appsDir = join(root, "apps");
  const lockedApp = join(appsDir, "MOSA.app");
  try {
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    // An immutable bundle directory cannot be renamed, so moving the previous
    // app aside fails after the new app is already staged in the transaction.
    execFileSync("/usr/bin/chflags", ["uchg", lockedApp]);
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await makeFakeApp({ root: payloadRoot, appName: "MOSA.app", execName: "MOSA", version: VERSION, marker: "new" });
    const zipPath = await makePayloadZip({ root: payloadRoot, appName: "MOSA.app" });
    const stubs = await writeStubScripts(root);
    const { logPath } = await launchHelper({ root, stubs, installAppPath: lockedApp, zipPath, appName: "MOSA.app" });
    await assertFailureRestored({ root, appsDir, logPath, code: "REPLACE_FAILED" });
  } finally {
    if (existsSync(lockedApp)) execFileSync("/usr/bin/chflags", ["nouchg", lockedApp]);
    await removeTestPath(root, { recursive: true, force: true });
  }
});

previewScope("rehearsal failure: NEW_VERSION_FAILED when the new app exits without reporting readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-new-"));
  const appsDir = join(root, "apps");
  try {
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await makeFakeApp({ root: payloadRoot, appName: "MOSA.app", execName: "MOSA", version: VERSION, mode: "silent", marker: "new" });
    const zipPath = await makePayloadZip({ root: payloadRoot, appName: "MOSA.app" });
    const stubs = await writeStubScripts(root);
    const { logPath } = await launchHelper({ root, stubs, installAppPath: join(appsDir, "MOSA.app"), zipPath, appName: "MOSA.app" });
    await assertFailureRestored({ root, appsDir, logPath, code: "NEW_VERSION_FAILED" });
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

previewScope("rehearsal failure: a new app that upgraded the library is kept with GP_UPDATE_KEPT_NEW", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-kept-"));
  const appsDir = join(root, "apps");
  try {
    await mkdir(appsDir, { recursive: true });
    await makeFakeApp({ root: appsDir, appName: "MOSA.app", execName: "MOSA", version: "0.2.1-rc.34", marker: "old" });
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await makeFakeApp({ root: payloadRoot, appName: "MOSA.app", execName: "MOSA", version: VERSION, mode: "upgraded-silent", marker: "new" });
    const zipPath = await makePayloadZip({ root: payloadRoot, appName: "MOSA.app" });
    const stubs = await writeStubScripts(root);
    const { logPath } = await launchHelper({ root, stubs, installAppPath: join(appsDir, "MOSA.app"), zipPath, appName: "MOSA.app" });
    await waitFor(() => existsSync(logPath), { label: "kept-new log" });
    const [firstLine] = readFileSync(logPath, "utf8").split("\n");
    assert.equal(firstLine, "GP_UPDATE_KEPT_NEW exit=34");
    assert.equal(markerOf(join(appsDir, "MOSA.app")), "new", "the upgraded new version stays installed");
    assert.equal(existsSync(join(appsDir, "MOSA.app")), true);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});
