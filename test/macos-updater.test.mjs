import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  downloadMacosUpdate,
  evaluateMacosInstallLocation,
  launchMacosUpdateHelper,
  macosUpdateDownloadUrl,
  macosUpdateHelperScript,
  normalizeMacosUpdateAppName,
  resolveMacosInstallAppPath,
  resolveMacosUpdateReadyFile,
  validateMacosUpdateArtifact,
  macosUpdateHelperEnv,
} from "../desktop/macos-updater.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

function artifactFor(bytes, version = "0.3.0", { appName = "MOSA.app", teamIdentifier = "" } = {}) {
  const stem = appName.slice(0, -4);
  return {
    platform: "macOS",
    arch: "arm64",
    appName,
    file: `${stem}-darwin-arm64-${version}.zip`,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(teamIdentifier ? { teamIdentifier } : {}),
  };
}

const EXPECTED_IDENTITY = Object.freeze({
  gitSha: "a".repeat(40),
  uiFingerprint: "b".repeat(64),
  runtimeFingerprint: "c".repeat(64),
  distribution: "preview",
});

test("macOS update artifacts are pinned to the official filename and HTTPS download origin", () => {
  const artifact = artifactFor(Buffer.from("zip"));
  assert.deepEqual(validateMacosUpdateArtifact(artifact, "0.3.0"), artifact);
  assert.equal(
    macosUpdateDownloadUrl(artifact),
    "https://gravityport.azhuilab.com/downloads/MOSA-darwin-arm64-0.3.0.zip",
  );
  const renamed = artifactFor(Buffer.from("zip"), "0.3.0", { appName: "GravityPort.app" });
  assert.deepEqual(validateMacosUpdateArtifact(renamed, "0.3.0"), renamed);
  assert.equal(
    macosUpdateDownloadUrl(renamed),
    "https://gravityport.azhuilab.com/downloads/GravityPort-darwin-arm64-0.3.0.zip",
  );
  // An appName that disagrees with the filename prefix is refused.
  assert.throws(() => validateMacosUpdateArtifact({ ...renamed, appName: "MOSA.app" }, "0.3.0"), /filename/);
  assert.throws(() => validateMacosUpdateArtifact({ ...renamed, teamIdentifier: "not-a-team" }, "0.3.0"), /team identifier/);
  assert.throws(() => validateMacosUpdateArtifact({ ...artifact, appName: "Evil.app" }, "0.3.0"), /app name/);
  assert.throws(() => validateMacosUpdateArtifact({ ...artifact, appName: "sub/MOSA.app" }, "0.3.0"), /app name/);
  assert.throws(() => macosUpdateDownloadUrl({ ...renamed, file: "../../etc/passwd.zip" }), /Unsafe macOS update filename/);
  assert.throws(() => validateMacosUpdateArtifact({ ...artifact, file: "other.zip" }, "0.3.0"), /filename/);
  assert.throws(() => validateMacosUpdateArtifact({ ...artifact, sha256: "bad" }, "0.3.0"), /SHA-256/);
});

test("macOS updater downloads to userData staging and verifies exact size plus SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-mac-update-"));
  const bytes = Buffer.from("fake-macos-zip-payload");
  const artifact = artifactFor(bytes);
  const progress = [];
  try {
    const result = await downloadMacosUpdate({
      artifact,
      version: "0.3.0",
      stagingRoot: root,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (name) => name === "content-length" ? String(bytes.length) : null },
        body: Readable.from([bytes]),
      }),
      onProgress: (entry) => progress.push(entry.percent),
    });
    assert.deepEqual(await readFile(result.zipPath), bytes);
    assert.equal(progress.at(-1), 100);

    await assert.rejects(downloadMacosUpdate({
      artifact: { ...artifact, sha256: "f".repeat(64) },
      version: "0.3.0",
      stagingRoot: root,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => String(bytes.length) },
        body: Readable.from([bytes]),
      }),
    }), /SHA-256 verification failed/);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("macOS updater reuses a staged package that matches the manifest and re-downloads otherwise", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-mac-reuse-"));
  const bytes = Buffer.from("fake-macos-zip-payload");
  const artifact = artifactFor(bytes);
  const fetchCalls = [];
  const offlineFetch = async () => {
    fetchCalls.push(1);
    throw new Error("network unavailable");
  };
  const downloadFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => name === "content-length" ? String(bytes.length) : null },
    body: Readable.from([bytes]),
  });
  try {
    const first = await downloadMacosUpdate({ artifact, version: "0.3.0", stagingRoot: root, fetchImpl: downloadFetch });
    // A second download for the same artifact must not touch the network.
    const second = await downloadMacosUpdate({ artifact, version: "0.3.0", stagingRoot: root, fetchImpl: offlineFetch });
    assert.equal(second.zipPath, first.zipPath);
    assert.equal(second.reused, true);
    assert.equal(fetchCalls.length, 0);
    assert.deepEqual(await readFile(second.zipPath), bytes);

    // A tampered staged file forces a fresh download (which needs the network
    // again and here fails), and the bad file does not survive the attempt.
    await writeFile(first.zipPath, Buffer.from("tampered"));
    await assert.rejects(
      downloadMacosUpdate({ artifact, version: "0.3.0", stagingRoot: root, fetchImpl: offlineFetch }),
      /network unavailable/,
    );
    assert.equal(fetchCalls.length, 1);
    // A staged file of a different version never matches either.
    const other = await downloadMacosUpdate({ artifact: artifactFor(bytes, "0.3.1"), version: "0.3.1", stagingRoot: root, fetchImpl: downloadFetch });
    assert.equal(other.reused, undefined);
    assert.deepEqual(await readFile(other.zipPath), bytes);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("macOS apply helper waits for MOSA, verifies the replacement, rolls back, and relaunches", async () => {
  const script = macosUpdateHelperScript();
  assert.match(script, /while kill -0 \"\$TARGET_PID\"/);
  assert.match(script, /\/usr\/bin\/ditto -x -k/);
  assert.match(script, /CFBundleIdentifier/);
  assert.match(script, /CFBundleShortVersionString/);
  // The codesign path is a parameter with the real absolute default so the
  // installation rehearsals can stub it; the strict verification stays.
  assert.match(script, /CODESIGN_BIN="\$\(printenv MOSA_UPDATE_CODESIGN_BIN \|\| true\)"\nif \[ -z "\$CODESIGN_BIN" \]; then CODESIGN_BIN="\/usr\/bin\/codesign"; fi/);
  assert.match(script, /"\$CODESIGN_BIN" --verify --deep --strict/);
  assert.match(script, /OLD_TEAM=.*TeamIdentifier/);
  assert.match(script, /\[ "\$NEW_TEAM" = "\$OLD_TEAM" \]/);
  assert.match(script, /\[ "\$NEW_TEAM" = "\$EXPECTED_TEAM_IDENTIFIER" \]/);
  assert.match(script, /if \[ "\$OLD_TEAM" = "not set" \]/);
  assert.match(script, /flags=.*runtime/);
  assert.match(script, /SPCTL_BIN="\$\(printenv MOSA_UPDATE_SPCTL_BIN \|\| true\)"\nif \[ -z "\$SPCTL_BIN" \]; then SPCTL_BIN="\/usr\/sbin\/spctl"; fi/);
  assert.match(script, /"\$SPCTL_BIN" -a -vv --type execute/);
  assert.match(script, /\[ "\$EXPECTED_DISTRIBUTION" = "production" \]/);
  assert.match(script, /\[ "\$EXPECTED_DISTRIBUTION" = "preview" \]/);
  assert.match(script, /mv \"\$INSTALL_APP\" \"\$BACKUP_APP\"/);
  assert.match(script, /mv \"\$BACKUP_APP\" \"\$INSTALL_APP\"/);
  assert.match(script, /--mosa-update-ready-file=/);
  assert.match(script, /\[ -f \"\$READY_FILE\" \]/);
  assert.match(script, /READY_GIT_SHA=.*gitSha/);
  assert.match(script, /READY_UI_FINGERPRINT=.*uiFingerprint/);
  assert.match(script, /READY_RUNTIME_FINGERPRINT=.*runtimeFingerprint/);
  assert.match(script, /READY_DISTRIBUTION=.*distribution/);
  assert.match(script, /exit 32/);
  assert.match(script, /APP_NAME="\$3"/);
  assert.match(script, /EXPECTED_TEAM_IDENTIFIER="\$4"/);
  assert.match(script, /TRASH_DIR="\$\(printenv MOSA_UPDATE_TRASH_DIR \|\| true\)"\nif \[ -z "\$TRASH_DIR" \]; then TRASH_DIR="\$HOME\/\.Trash"; fi/);

  const root = await mkdtemp(join(tmpdir(), "mosa-mac-helper-"));
  const zipPath = join(root, "MOSA-darwin-arm64-0.3.0.zip");
  let invocation = null;
  try {
    await launchMacosUpdateHelper({
      zipPath,
      installAppPath: "/Applications/MOSA.app",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
      processId: 1234,
      libraryDir: "/tmp/mosa-library",
      createUpdateHandoff: async ({ libraryDir, pid }) => {
        assert.equal(libraryDir, "/tmp/mosa-library");
        assert.equal(pid, 4321);
        return { markerPath: "/tmp/mosa-library/.mosa-desktop-starting.json" };
      },
      spawnImpl: (command, args, options) => {
        invocation = { command, args, options };
        const child = new EventEmitter();
        child.pid = 4321;
        child.kill = () => true;
        child.unref = () => {};
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });
    assert.equal(invocation.command, "/bin/sh");
    assert.equal(invocation.options.detached, true);
    assert.equal(invocation.args.includes("/Applications/MOSA.app"), true);
    assert.equal(invocation.args.includes(EXPECTED_IDENTITY.gitSha), true);
    assert.equal(invocation.args.includes(EXPECTED_IDENTITY.uiFingerprint), true);
    assert.equal(invocation.args.includes(EXPECTED_IDENTITY.runtimeFingerprint), true);
    assert.equal(invocation.args.includes(EXPECTED_IDENTITY.distribution), true);
    assert.equal(invocation.args.includes("/tmp/mosa-library/.mosa-desktop-starting.json"), true);
    assert.equal(invocation.args.includes("MOSA.app"), true);
    assert.equal(invocation.args[invocation.args.length - 1], "");
    assert.match(await readFile(join(root, "apply-update.sh"), "utf8"), /ditto -x -k/);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("macOS apply helper models a cross-name replacement with a guarded target and a Trash handoff", () => {
  const script = macosUpdateHelperScript();
  assert.match(script, /CURRENT_APP_NAME="\$\(basename "\$INSTALL_APP"\)"/);
  assert.match(script, /TARGET_APP="\$PARENT_DIR\/\$APP_NAME"/);
  assert.match(script, /EXEC_NAME="\$\(basename "\$APP_NAME" \.app\)"/);
  assert.match(script, /CROSS_NAME=1/);
  // The refusal runs after the previous app quit and with the trap armed, so
  // it clears the handoff, logs, and reopens the previous app.
  assert.match(script, /trap 'code=\$\?; rollback;[\s\S]*while kill -0 "\$TARGET_PID"[\s\S]*if \[ "\$CROSS_NAME" -eq 1 \] && \[ -e "\$TARGET_APP" \]; then\n  exit 33\nfi/);
  assert.match(script, /elif \[ "\$MOVED_ORIGINAL" -eq 0 \] && \[ -d "\$INSTALL_APP" \] && ! kill -0 "\$TARGET_PID"/);
  assert.match(script, /if \[ -d "\$TARGET_APP" \]; then rm -rf "\$TARGET_APP"; fi/);
  assert.match(script, /PAYLOAD_APP="\$EXTRACT_DIR\/\$APP_NAME"/);
  assert.match(script, /test -x "\$PAYLOAD_APP\/Contents\/MacOS\/\$EXEC_NAME"/);
  assert.match(script, /CFBundleExecutable/);
  assert.match(script, /\[ "\$EXECUTABLE_NAME" = "\$EXEC_NAME" \]/);
  assert.match(script, /mv "\$REPLACEMENT_APP" "\$TARGET_APP"/);
  assert.match(script, /"\$OPEN_BIN" -n "\$TARGET_APP" --args/);
  assert.match(script, /pgrep -f "\$TARGET_APP\/Contents\/MacOS\/\$EXEC_NAME --mosa-update-ready-file="/);
  assert.match(script, /TRASH_NAME="\$TRASH_DIR\/\$CURRENT_APP_NAME"/);
  assert.match(script, /mv "\$BACKUP_APP" "\$TRASH_NAME"/);
});

test("macOS apply helper honors the new app name and pins the production team id", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-mac-helper-"));
  const zipPath = join(root, "GravityPort-darwin-arm64-0.3.0.zip");
  const invocations = [];
  try {
    const spawnImpl = (command, args, options) => {
      invocations.push({ command, args, options });
      const child = new EventEmitter();
      child.pid = 4321;
      child.kill = () => true;
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    };
    await launchMacosUpdateHelper({
      zipPath,
      installAppPath: "/Applications/MOSA.app",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
      processId: 1234,
      libraryDir: "/tmp/mosa-library",
      appName: "GravityPort.app",
      expectedTeamIdentifier: "abcd1234ef",
      createUpdateHandoff: async () => ({}),
      spawnImpl,
    });
    const crossName = invocations.at(-1);
    assert.equal(crossName.args[crossName.args.length - 2], "GravityPort.app");
    assert.equal(crossName.args[crossName.args.length - 1], "ABCD1234EF");
    assert.equal(crossName.args.filter((value) => String(value).endsWith("update-ready.json")).length, 1);

    await launchMacosUpdateHelper({
      zipPath: join(root, "MOSA-darwin-arm64-0.3.0.zip"),
      installAppPath: "/Applications/MOSA.app",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
      processId: 1234,
      libraryDir: "/tmp/mosa-library",
      createUpdateHandoff: async () => ({}),
      spawnImpl,
    });
    const sameName = invocations.at(-1);
    assert.equal(sameName.args[sameName.args.length - 2], "MOSA.app");
    // The readiness file is derived from the updater staging root, so its path
    // is identical no matter which app name the update installs.
    assert.deepEqual(
      sameName.args.filter((value) => String(value).endsWith("update-ready.json")),
      crossName.args.filter((value) => String(value).endsWith("update-ready.json")),
    );

    await assert.rejects(
      launchMacosUpdateHelper({
        zipPath,
        installAppPath: "/Applications/MOSA.app",
        version: "0.3.0",
        expectedIdentity: { ...EXPECTED_IDENTITY, distribution: "production" },
        processId: 1234,
        libraryDir: "/tmp/mosa-library",
        createUpdateHandoff: async () => ({}),
        spawnImpl,
      }),
      /production updates require a release team identifier/,
    );
    await assert.rejects(
      launchMacosUpdateHelper({
        zipPath,
        installAppPath: "/Applications/MOSA.app",
        version: "0.3.0",
        expectedIdentity: EXPECTED_IDENTITY,
        processId: 1234,
        libraryDir: "/tmp/mosa-library",
        appName: "Evil.app",
        createUpdateHandoff: async () => ({}),
        spawnImpl,
      }),
      /Invalid macOS update app name/,
    );
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("macOS apply helper keeps supervisor handoff active until readiness and clears it before rollback relaunch", () => {
  const script = macosUpdateHelperScript();
  assert.match(script, /shift 9\nHANDOFF_FILE="\$1"/);
  assert.match(script, /rollback\(\) \{\n  rm -f "\$HANDOFF_FILE"/);
  // Readiness is verified first; the cross-name Trash handoff (deliberately
  // still under the armed trap so a failure rolls back) runs before the trap
  // is released and the handoff file is cleared for the successful relaunch.
  assert.match(script, /\[ "\$READY_RUNTIME_FINGERPRINT" = "\$EXPECTED_RUNTIME_FINGERPRINT" \]\n    \[ "\$READY_DISTRIBUTION" = "\$EXPECTED_DISTRIBUTION" \]\n    if \[ "\$CROSS_NAME" -eq 1 \]; then/);
  assert.match(script, /trap - HUP INT TERM EXIT\n    rm -f "\$HANDOFF_FILE"/);
});

test("macOS updater resolves only the MOSA.app that contains the running executable", () => {
  assert.equal(
    resolveMacosInstallAppPath("/Applications/MOSA.app/Contents/MacOS/MOSA"),
    "/Applications/MOSA.app",
  );
  // The transition release also updates apps already installed as GravityPort.
  assert.equal(
    resolveMacosInstallAppPath("/Applications/GravityPort.app/Contents/MacOS/GravityPort"),
    "/Applications/GravityPort.app",
  );
  assert.equal(resolveMacosInstallAppPath("/Applications/Other.app/Contents/MacOS/MOSA"), null);
  assert.equal(resolveMacosInstallAppPath("/usr/local/bin/MOSA"), null);
});

test("macOS app name normalization accepts only the two release names", () => {
  assert.equal(normalizeMacosUpdateAppName("MOSA.app"), "MOSA.app");
  assert.equal(normalizeMacosUpdateAppName("GravityPort.app"), "GravityPort.app");
  assert.equal(normalizeMacosUpdateAppName(""), "MOSA.app");
  assert.equal(normalizeMacosUpdateAppName(undefined), "MOSA.app");
  assert.throws(() => normalizeMacosUpdateAppName("MOSA.app/Contents"), /app name/);
  assert.throws(() => normalizeMacosUpdateAppName("Gravityport.app"), /app name/);
});

test("macOS update install location stops safely on translocation and read-only directories", async () => {
  // A normal recognized path inside a writable directory is supported. Use a
  // temporary directory: CI runners (Linux, Windows) have no /Applications.
  const writableRoot = await mkdtemp(join(tmpdir(), "mosa-mac-location-ok-"));
  try {
    for (const appName of ["MOSA.app", "GravityPort.app"]) {
      const executable = appName === "MOSA.app" ? "MOSA" : "GravityPort";
      assert.deepEqual(evaluateMacosInstallLocation(join(writableRoot, appName, "Contents", "MacOS", executable)), {
        supported: true,
        installAppPath: join(writableRoot, appName),
        reason: null,
      });
    }
  } finally {
    await rm(writableRoot, { recursive: true, force: true });
  }
  // Gatekeeper translocation paths are refused before any write attempt.
  assert.deepEqual(
    evaluateMacosInstallLocation(
      "/private/var/folders/xx/AppTranslocation/AB12/d/MOSA.app/Contents/MacOS/MOSA",
    ),
    {
      supported: false,
      installAppPath: "/private/var/folders/xx/AppTranslocation/AB12/d/MOSA.app",
      reason: "app-translocation",
    },
  );

  const root = await mkdtemp(join(tmpdir(), "mosa-mac-location-"));
  try {
    const appDir = join(root, "MOSA.app");
    await mkdir(join(appDir, "Contents", "MacOS"), { recursive: true });
    await chmod(root, 0o555);
    try {
      if (process.getuid && process.getuid() === 0) return;
      assert.deepEqual(evaluateMacosInstallLocation(join(appDir, "Contents", "MacOS", "MOSA")), {
        supported: false,
        installAppPath: appDir,
        reason: "install-dir-not-writable",
      });
    } finally {
      await chmod(root, 0o755);
    }
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("macOS post-update readiness argument is accepted only inside the updater staging root", () => {
  const root = "/Users/example/Library/Application Support/MOSA/updates/macos";
  const ready = `${root}/0.3.0/update-ready.json`;
  assert.equal(resolveMacosUpdateReadyFile([`--mosa-update-ready-file=${ready}`], root), ready);
  assert.equal(resolveMacosUpdateReadyFile(["--mosa-update-ready-file=/tmp/fake-ready.json"], root), null);
});

test("macOS helper tool overrides never leak in from the app environment", () => {
  const base = {
    PATH: "/usr/bin",
    MOSA_UPDATE_CODESIGN_BIN: "/tmp/fake-codesign",
    MOSA_UPDATE_SPCTL_BIN: "/tmp/fake-spctl",
    MOSA_UPDATE_OPEN_BIN: "/tmp/fake-open",
    MOSA_UPDATE_TRASH_DIR: "/tmp/fake-trash",
  };
  assert.deepEqual(macosUpdateHelperEnv(null, base), { PATH: "/usr/bin" });
  assert.deepEqual(
    macosUpdateHelperEnv({ MOSA_UPDATE_TRASH_DIR: "/tmp/rehearsal-trash" }, base),
    { PATH: "/usr/bin", MOSA_UPDATE_TRASH_DIR: "/tmp/rehearsal-trash" },
  );
});

test("macOS apply helper waits 120 seconds and never rolls back a library the new version upgraded", () => {
  const script = macosUpdateHelperScript();
  assert.match(script, /while \[ "\$i" -lt 480 \]; do/, "480 polls of 0.25s = 120s");
  assert.match(script, /SCHEMA_MARKER="\$\(dirname "\$READY_FILE"\)\/schema-upgrade-started\.json"/);
  assert.match(script, /rm -f "\$READY_FILE" "\$SCHEMA_MARKER"/, "a stale marker never survives into a new attempt");
  const rollback = script.slice(script.indexOf("rollback() {"));
  const keep = rollback.indexOf('[ -f "$SCHEMA_MARKER" ]');
  assert.ok(keep > 0 && keep < rollback.indexOf('kill -TERM "$NEW_PID"'), "the marker is checked before the new version is stopped");
  assert.ok(keep < rollback.indexOf('mv "$BACKUP_APP" "$INSTALL_APP"'), "the marker is checked before the previous version is restored");
  assert.match(script, /if \[ "\$KEPT_NEW" -eq 1 \]; then echo "[^"]*kept the new version[^"]*" > "\$LOG_PATH"; exit 34; fi/);
});
