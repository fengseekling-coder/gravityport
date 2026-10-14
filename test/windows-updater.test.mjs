import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import {
  downloadWindowsUpdate,
  launchWindowsUpdateHelper,
  resolveWindowsUpdateReadyFile,
  validateWindowsUpdateArtifact,
  windowsUpdateDetachedLauncherCommand,
  windowsUpdateDownloadUrl,
  windowsUpdateHelperScript,
  windowsInstalledExeName,
  windowsInstallProcessDrainScript,
  windowsMoveDirectoryRetryScript,
  windowsUpdateTransactionParentDir,
} from "../desktop/windows-updater.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

const execFileAsync = promisify(execFile);

function encodePowerShellCommand(command) {
  return Buffer.from(String(command || ""), "utf16le").toString("base64");
}

function powershellLiteral(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function artifactFor(bytes, version = "0.3.0", { payloadExeName = "MOSA.exe", signerThumbprint = "" } = {}) {
  return {
    platform: "Windows",
    arch: "x64",
    payloadExeName,
    file: `${payloadExeName.slice(0, -4)}-win32-x64-${version}.zip`,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(signerThumbprint ? { signerThumbprint } : {}),
  };
}

const EXPECTED_IDENTITY = Object.freeze({
  gitSha: "a".repeat(40),
  uiFingerprint: "b".repeat(64),
  runtimeFingerprint: "c".repeat(64),
  distribution: "preview",
});

test("Windows update artifacts are pinned to the official filename and HTTPS download origin", () => {
  const artifact = artifactFor(Buffer.from("zip"));
  assert.deepEqual(validateWindowsUpdateArtifact(artifact, "0.3.0"), artifact);
  const gravity = artifactFor(Buffer.from("zip"), "0.3.0", { payloadExeName: "GravityPort.exe" });
  assert.deepEqual(validateWindowsUpdateArtifact(gravity, "0.3.0"), gravity);
  assert.equal(
    windowsUpdateDownloadUrl(artifact),
    "https://mosa.azhuilab.com/downloads/MOSA-win32-x64-0.3.0.zip",
  );
  assert.equal(
    windowsUpdateDownloadUrl(gravity),
    "https://mosa.azhuilab.com/downloads/GravityPort-win32-x64-0.3.0.zip",
  );
  assert.throws(() => validateWindowsUpdateArtifact({ ...artifact, file: "other.zip" }, "0.3.0"), /filename/);
  assert.throws(() => validateWindowsUpdateArtifact({ ...artifact, sha256: "bad" }, "0.3.0"), /SHA-256/);
  // The payload exe name is whitelisted, rejects path separators and unknown
  // values, and is bound to the package filename prefix.
  assert.throws(() => validateWindowsUpdateArtifact({ ...artifact, payloadExeName: "Evil.exe" }, "0.3.0"), /payload executable/);
  assert.throws(() => validateWindowsUpdateArtifact({ ...artifact, payloadExeName: "sub/MOSA.exe" }, "0.3.0"), /payload executable/);
  assert.throws(() => validateWindowsUpdateArtifact({ ...artifact, payloadExeName: "sub\\MOSA.exe" }, "0.3.0"), /payload executable/);
  assert.throws(() => validateWindowsUpdateArtifact({ ...artifact, payloadExeName: "GravityPort.exe" }, "0.3.0"), /filename/);
  assert.equal(validateWindowsUpdateArtifact({ ...artifact, payloadExeName: " " }, "0.3.0").payloadExeName, "MOSA.exe");
  // A signer thumbprint must be 40 hex digits; the manifest's casing is
  // normalized so the helper compares consistently.
  assert.equal(validateWindowsUpdateArtifact({ ...artifact, signerThumbprint: "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34" }, "0.3.0").signerThumbprint, "AB12CD34AB12CD34AB12CD34AB12CD34AB12CD34");
  assert.throws(() => validateWindowsUpdateArtifact({ ...artifact, signerThumbprint: "nothex" }, "0.3.0"), /thumbprint/);
  assert.throws(() => windowsUpdateDownloadUrl({ file: "Evil-win32-x64-0.3.0.zip" }), /Unsafe/);
});

test("the installed exe name is whitelisted and anything else stops the update", () => {
  assert.equal(windowsInstalledExeName("C:\\Users\\Example\\MOSA-win32-x64\\MOSA.exe"), "MOSA.exe");
  assert.equal(windowsInstalledExeName("C:\\Users\\Example\\GravityPort\\GravityPort.exe"), "GravityPort.exe");
  assert.equal(windowsInstalledExeName("C:\\Users\\Example\\MOSA-win32-x64\\Other.exe"), null);
  assert.equal(windowsInstalledExeName("C:\\Users\\Example\\MOSA"), null);
  assert.equal(windowsInstalledExeName(""), null);
  assert.equal(windowsInstalledExeName("MOSA.exe"), "MOSA.exe");
});

test("Windows updater downloads to userData staging and verifies exact size plus SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-update-"));
  const bytes = Buffer.from("fake-zip-payload");
  const artifact = artifactFor(bytes);
  const progress = [];
  try {
    const result = await downloadWindowsUpdate({
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

    await assert.rejects(downloadWindowsUpdate({
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

test("Windows apply helper waits for MOSA, replaces the whole portable directory, rolls back, and relaunches", async () => {
  const script = windowsUpdateHelperScript();
  assert.match(script, /Wait-Process -Id \$TargetPid/);
  assert.match(script, /Wait-MosaInstallProcessesExit -InstallDir \$InstallDir/);
  assert.match(script, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(script, /ExecutablePath/);
  assert.match(script, /\$transactionRoot = Join-Path \$parentDir/);
  // The current exe name and the payload exe name are modeled separately so a
  // cross-name update can rename the payload while every relaunch path keeps
  // the installed name.
  assert.match(script, /\$oldExe = Join-Path \$InstallDir \$CurrentExeName/);
  assert.match(script, /\$flatPayloadExe = Join-Path \$extractDir \$PayloadExeName/);
  assert.match(script, /foreach \(\$nestedDirName in @\("MOSA-win32-x64", "GravityPort-win32-x64"\)\)/);
  assert.match(script, /\$candidateExe = Join-Path \$candidateDir \$PayloadExeName/);
  assert.match(script, /if \(Test-Path -LiteralPath \$flatPayloadExe -PathType Leaf\)/);
  assert.match(script, /elseif \(\(\$null -ne \$nestedPayloadExe\) -and \(Test-Path -LiteralPath \$nestedPayloadExe -PathType Leaf\)\)/);
  assert.match(script, /if \(\$PayloadExeName -ne \$CurrentExeName\) \{/);
  assert.match(script, /Rename-Item -LiteralPath \$payloadExe -NewName \$CurrentExeName -ErrorAction Stop/);
  // Production trust is anchored to the manifest thumbprint; the installed
  // signature only pins the publisher subject so renewed certificates keep
  // updating, and an unsigned preview install may cross into production.
  assert.match(script, /Production Windows updates require the release signer thumbprint\./);
  assert.match(script, /function Get-MosaSignatureInfo \{/);
  assert.match(script, /if \(\$SignatureProbe\) \{/);
  assert.match(script, /& \$SignatureProbe \$LiteralPath/);
  assert.match(script, /Get-AuthenticodeSignature -LiteralPath \$LiteralPath/);
  assert.match(script, /Get-MosaSignatureInfo -LiteralPath \$oldExe/);
  assert.match(script, /\$oldSignerSubject = \[string\]\$oldSignature\.Subject/);
  assert.match(script, /if \(\$ExpectedDistribution -eq 'production'\)/);
  assert.match(script, /\$signableFiles = @\(Get-ChildItem -LiteralPath \$payloadDir -Recurse -File/);
  assert.match(script, /foreach \(\$file in \$signableFiles\)/);
  assert.match(script, /Get-MosaSignatureInfo -LiteralPath \$file\.FullName/);
  assert.match(script, /signed by a different publisher/);
  assert.match(script, /publisher changed between releases/);
  assert.match(script, /Move-MosaDirectoryWithRetry -LiteralPath \$InstallDir -Destination \$backupDir/);
  assert.match(script, /Move-MosaDirectoryWithRetry -LiteralPath \$payloadDir -Destination \$InstallDir/);
  assert.match(script, /Move-MosaDirectoryWithRetry -LiteralPath \$backupDir -Destination \$InstallDir/);
  assert.match(script, /\[int\]\$MaxAttempts = 10/);
  assert.match(script, /\$retryDelaysMs = @\(250, 500, 1000, 2000, 3000, 4000, 5000, 5000, 5000\)/);
  assert.match(script, /\$exception -is \[System\.IO\.IOException\]/);
  assert.match(script, /\$exception -is \[System\.UnauthorizedAccessException\]/);
  assert.match(script, /hresult=\$hresultHex/);
  assert.match(script, /nativeCode=\$nativeCode/);
  assert.match(script, /errorId=\$errorId/);
  assert.match(script, /--mosa-update-ready-file=/);
  assert.match(script, /\$newExe = Join-Path \$InstallDir \$CurrentExeName/);
  assert.match(script, /Start-Process -FilePath \$newExe -WorkingDirectory \$InstallDir -ArgumentList @\(\$readyArgument\) -PassThru/);
  assert.doesNotMatch(script, /Start-Process -FilePath \$newExe[^\n]*-WindowStyle Hidden/);
  assert.doesNotMatch(script, /Start-Process -FilePath \$oldExe[^\n]*-WindowStyle Hidden/);
  assert.match(script, /Test-Path -LiteralPath \$ReadyFile/);
  assert.match(script, /did not report readiness before the rollback deadline/);
  assert.match(script, /readiness identity does not match the release manifest/);
  assert.match(script, /distribution does not match the release manifest/);
  // The destructive rollback removal must be explicitly scoped to runs where
  // the original directory is verifiably parked in the backup location.
  assert.match(script, /\$movedOriginal = \$true/);
  assert.match(script, /if \(\$movedOriginal -and \(Test-Path -LiteralPath \$backupDir -PathType Container\)\)/);
  // Recovery data survives a successful apply until the updated app's own
  // boot sweep reclaims it; only the redundant extracted payload is dropped.
  assert.doesNotMatch(script, /Remove-Item -LiteralPath \$backupDir/);
  assert.doesNotMatch(script, /Remove-Item -LiteralPath \$transactionRoot/);
  assert.match(script, /Remove-Item -LiteralPath \$extractDir -Recurse -Force/);
  // The success path must explicitly exit 0 to ensure the helper terminates
  // cleanly and does not keep the updated MOSA process waiting.
  assert.match(script, /Remove-Item -LiteralPath \$extractDir[^\n]*\n\s*exit 0/);
  // The rollback path exits 1 to signal failure.
  assert.match(script, /exit 1/);

  const root = await mkdtemp(join(tmpdir(), "mosa-win-helper-"));
  const zipPath = join(root, "MOSA-win32-x64-0.3.0.zip");
  let invocation = null;
  try {
    await launchWindowsUpdateHelper({
      zipPath,
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      currentExeName: "MOSA.exe",
      payloadExeName: "MOSA.exe",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
      processId: 1234,
      spawnImpl: (command, args, options) => {
        invocation = { command, args, options };
        const child = new EventEmitter();
        child.unref = () => {};
        child.kill = () => {};
        queueMicrotask(() => child.emit("spawn"));
        queueMicrotask(() => writeFile(join(root, "helper-started.txt"), "4321\n"));
        return child;
      },
    });
    assert.equal(invocation.command, "powershell.exe");
    assert.equal(invocation.options.detached, undefined);
    assert.equal(invocation.args.includes("-ExecutionPolicy"), true);
    assert.equal(invocation.args.includes("Bypass"), true);
    assert.equal(invocation.args.includes("-EncodedCommand"), true);
    assert.match(await readFile(join(root, "apply-update.ps1"), "utf8"), /Expand-Archive/);
    assert.match(await readFile(join(root, "apply-update.ps1"), "utf8"), /Set-Content -LiteralPath \$StartedFile/);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("Windows updater drains residual install-directory processes before replacement", () => {
  const script = windowsInstallProcessDrainScript();
  assert.match(script, /\[int\]\$MaxAttempts = 60/);
  assert.match(script, /StartsWith\(\$prefix, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(script, /Start-Sleep -Milliseconds 250/);
  assert.match(script, /processes still hold the install directory/i);
});

test("Windows directory move retries a transient exclusive file lock", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-move-retry-"));
  const sourceDir = join(root, "source");
  const destinationDir = join(root, "destination");
  const lockedFile = join(sourceDir, "payload.bin");
  const markerFile = join(root, "lock-held.txt");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(lockedFile, "locked payload", "utf8");

  const lockerCommand = [
    `$stream = [System.IO.File]::Open(${powershellLiteral(lockedFile)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)`,
    "try {",
    `  'locked' | Set-Content -LiteralPath ${powershellLiteral(markerFile)} -Encoding ASCII`,
    "  Start-Sleep -Milliseconds 6500",
    "} finally {",
    "  $stream.Dispose()",
    "}",
  ].join("\n");
  const locker = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encodePowerShellCommand(lockerCommand),
  ], { stdio: "ignore", windowsHide: true });
  const lockerExit = new Promise((resolveExit) => locker.once("exit", resolveExit));

  try {
    let locked = false;
    // powershell.exe cold start on a contended CI runner can exceed two
    // seconds; the marker wait must outlive it (the holder keeps the lock for
    // 6.5s after writing, so the move below still runs under contention).
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (await readFile(markerFile, "utf8").then(() => true).catch(() => false)) {
        locked = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert.equal(locked, true, "exclusive lock holder must report readiness");

    const moveCommand = [
      windowsMoveDirectoryRetryScript(),
      `Move-MosaDirectoryWithRetry -LiteralPath ${powershellLiteral(sourceDir)} -Destination ${powershellLiteral(destinationDir)}`,
    ].join("\n");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", encodePowerShellCommand(moveCommand),
    ], { windowsHide: true, timeout: 35_000 });

    assert.equal(await readFile(join(destinationDir, "payload.bin"), "utf8"), "locked payload");
    await lockerExit;
  } finally {
    if (locker.exitCode === null) locker.kill();
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("Windows update transaction cleanup targets the helper transaction parent", () => {
  assert.equal(
    windowsUpdateTransactionParentDir("C:\\Users\\Example\\Downloads\\MOSA-win32-x64-0.2.1-rc.30\\MOSA-win32-x64\\MOSA.exe"),
    "C:\\Users\\Example\\Downloads\\MOSA-win32-x64-0.2.1-rc.30",
  );
});

test("desktop stale transaction cleanup scans the updater transaction parent", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /windowsUpdateTransactionParentDir\(process\.execPath\)/);
  assert.match(main, /resolveMacosInstallAppPath\(process\.execPath\)/);
  assert.doesNotMatch(main, /const parentDir = dirname\(process\.execPath\);/);
  // The sweep deletes directories, so it must stay limited to packaged builds
  // and to the exact prefix both update helpers create; a renamed helper
  // prefix would otherwise silently stop the cleanup.
  assert.match(main, /function cleanupStaleUpdateTransactions\(\) \{\n  if \(!app\.isPackaged\) return;/);
  assert.match(main, /const UPDATE_TRANSACTION_PREFIX = "\.MOSA-update-";/);
  const macosUpdater = await readFile(new URL("../desktop/macos-updater.mjs", import.meta.url), "utf8");
  assert.match(macosUpdater, /TRANSACTION_ROOT="\$PARENT_DIR\/\.MOSA-update-/);
  const windowsUpdater = await readFile(new URL("../desktop/windows-updater.mjs", import.meta.url), "utf8");
  assert.match(windowsUpdater, /Join-Path \$parentDir \("\.MOSA-update-"/);
});

test("Windows update helper rejects when PowerShell cannot spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-helper-spawn-error-"));
  try {
    await assert.rejects(launchWindowsUpdateHelper({
      zipPath: join(root, "MOSA-win32-x64-0.3.0.zip"),
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      currentExeName: "MOSA.exe",
      payloadExeName: "MOSA.exe",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
      processId: 1234,
      spawnImpl: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" })));
        return child;
      },
    }), /ENOENT/);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("Windows update helper handoff fails closed when PowerShell spawns but the script never starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-helper-no-handoff-"));
  let killed = false;
  try {
    await assert.rejects(launchWindowsUpdateHelper({
      zipPath: join(root, "MOSA-win32-x64-0.3.0.zip"),
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      currentExeName: "MOSA.exe",
      payloadExeName: "MOSA.exe",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
      processId: 1234,
      helperStartTimeoutMs: 100,
      spawnImpl: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        child.kill = () => { killed = true; };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    }), /did not start before the handoff deadline/);
    assert.equal(killed, true);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("Windows detached launcher creates the real updater through Win32_Process", () => {
  const command = windowsUpdateDetachedLauncherCommand({
    scriptPath: "C:\\Users\\Example\\AppData\\Roaming\\mosa\\updates\\windows\\0.3.0\\apply-update.ps1",
    processId: 1234,
    zipPath: "C:\\Users\\Example\\AppData\\Roaming\\mosa\\updates\\windows\\0.3.0\\MOSA-win32-x64-0.3.0.zip",
    installDir: "C:\\Users\\Example\\MOSA-win32-x64",
    currentExeName: "MOSA.exe",
    payloadExeName: "MOSA.exe",
    version: "0.3.0",
    expectedIdentity: EXPECTED_IDENTITY,
    logPath: "C:\\Users\\Example\\AppData\\Roaming\\mosa\\updates\\windows\\0.3.0\\apply-update-error.log",
    startedFile: "C:\\Users\\Example\\AppData\\Roaming\\mosa\\updates\\windows\\0.3.0\\helper-started.txt",
    readyFile: "C:\\Users\\Example\\AppData\\Roaming\\mosa\\updates\\windows\\0.3.0\\update-ready.json",
    launcherLogPath: "C:\\Users\\Example\\AppData\\Roaming\\mosa\\updates\\windows\\0.3.0\\helper-launch-error.log",
  });
  assert.match(command, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(command, /Win32_Process\.Create failed with return value/);
  assert.match(command, /helper-launch-error\.log/);
  assert.match(command, /powershell\.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand/);
  // The startup info must be passed at creation: a -ClientOnly instance
  // rejects later property assignment (the rc.33/rc.34 launcher failed there).
  // WMI rejects the undocumented CREATE_NO_WINDOW flag with return value 21.
  assert.match(command, /New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @\{ ShowWindow = \[uint16\]0 \}/);
  assert.doesNotMatch(command, /CreateFlags/);
  assert.doesNotMatch(command, /\$startup\.ShowWindow =/);
  assert.match(command, /ProcessStartupInformation = \$startup/);
  assert.doesNotMatch(command, /Start-Process/);
});

test("the detached launcher passes the current and payload exe names plus the signer thumbprint", () => {
  const command = windowsUpdateDetachedLauncherCommand({
    scriptPath: "C:\\staging\\apply-update.ps1",
    processId: 1234,
    zipPath: "C:\\staging\\GravityPort-win32-x64-0.3.0.zip",
    installDir: "C:\\Users\\Example\\MOSA-win32-x64",
    currentExeName: "MOSA.exe",
    payloadExeName: "GravityPort.exe",
    signerThumbprint: "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34",
    signatureProbe: "C:\\test\\probe.ps1",
    version: "0.3.0",
    expectedIdentity: EXPECTED_IDENTITY,
    logPath: "C:\\staging\\apply-update-error.log",
    startedFile: "C:\\staging\\helper-started.txt",
    readyFile: "C:\\staging\\update-ready.json",
    launcherLogPath: "C:\\staging\\helper-launch-error.log",
  });
  // The helper arguments ride inside the -EncodedCommand payload, so decode
  // before matching.
  const encoded = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1];
  const helperCommand = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(helperCommand, /-CurrentExeName 'MOSA\.exe'/);
  assert.match(helperCommand, /-PayloadExeName 'GravityPort\.exe'/);
  assert.match(helperCommand, /-ExpectedSignerThumbprint 'AB12CD34AB12CD34AB12CD34AB12CD34AB12CD34'/);
  assert.match(helperCommand, /-SignatureProbe 'C:\\test\\probe\.ps1'/);
  // Packaged updates omit the option entirely instead of passing an empty one.
  const packaged = windowsUpdateDetachedLauncherCommand({
    scriptPath: "C:\\staging\\apply-update.ps1",
    processId: 1234,
    zipPath: "C:\\staging\\MOSA-win32-x64-0.3.0.zip",
    installDir: "C:\\Users\\Example\\MOSA-win32-x64",
    currentExeName: "MOSA.exe",
    payloadExeName: "MOSA.exe",
    version: "0.3.0",
    expectedIdentity: EXPECTED_IDENTITY,
    logPath: "C:\\staging\\apply-update-error.log",
    startedFile: "C:\\staging\\helper-started.txt",
    readyFile: "C:\\staging\\update-ready.json",
    launcherLogPath: "C:\\staging\\helper-launch-error.log",
  });
  const packagedEncoded = packaged.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1];
  assert.doesNotMatch(Buffer.from(packagedEncoded, "base64").toString("utf16le"), /-SignatureProbe/);
  assert.throws(() => windowsUpdateDetachedLauncherCommand({
    scriptPath: "C:\\staging\\apply-update.ps1",
    processId: 1234,
    zipPath: "C:\\staging\\MOSA-win32-x64-0.3.0.zip",
    installDir: "C:\\Users\\Example\\MOSA-win32-x64",
    currentExeName: "Evil.exe",
    payloadExeName: "MOSA.exe",
    version: "0.3.0",
    expectedIdentity: EXPECTED_IDENTITY,
    logPath: "C:\\staging\\apply-update-error.log",
    startedFile: "C:\\staging\\helper-started.txt",
    readyFile: "C:\\staging\\update-ready.json",
    launcherLogPath: "C:\\staging\\helper-launch-error.log",
  }), /current executable name/);
});

test("production updates require the manifest signer thumbprint before anything starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-helper-prod-"));
  try {
    await assert.rejects(launchWindowsUpdateHelper({
      zipPath: join(root, "MOSA-win32-x64-0.3.0.zip"),
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      currentExeName: "MOSA.exe",
      payloadExeName: "MOSA.exe",
      version: "0.3.0",
      expectedIdentity: { ...EXPECTED_IDENTITY, distribution: "production" },
      processId: 1234,
      spawnImpl: () => {
        throw new Error("the helper must be rejected before any PowerShell spawn");
      },
    }), /require a release signer thumbprint/);
    await assert.rejects(launchWindowsUpdateHelper({
      zipPath: join(root, "MOSA-win32-x64-0.3.0.zip"),
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      currentExeName: "MOSA.exe",
      payloadExeName: "MOSA.exe",
      signerThumbprint: "nothex",
      version: "0.3.0",
      expectedIdentity: { ...EXPECTED_IDENTITY, distribution: "production" },
      processId: 1234,
      spawnImpl: () => {
        throw new Error("the helper must be rejected before any PowerShell spawn");
      },
    }), /thumbprint/);
    // Preview updates keep working without a thumbprint.
    await launchWindowsUpdateHelper({
      zipPath: join(root, "MOSA-win32-x64-0.3.0.zip"),
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      currentExeName: "MOSA.exe",
      payloadExeName: "MOSA.exe",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
      processId: 1234,
      spawnImpl: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        child.kill = () => {};
        queueMicrotask(() => child.emit("spawn"));
        queueMicrotask(() => writeFile(join(root, "helper-started.txt"), "1\n"));
        return child;
      },
    });
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("the readiness file path never depends on the installed exe name", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-helper-ready-"));
  const launches = [];
  try {
    for (const currentExeName of ["MOSA.exe", "GravityPort.exe"]) {
      launches.push(await launchWindowsUpdateHelper({
        zipPath: join(root, "MOSA-win32-x64-0.3.0.zip"),
        installDir: "C:\\Users\\Example\\MOSA-win32-x64",
        currentExeName,
        payloadExeName: "GravityPort.exe",
        version: "0.3.0",
        expectedIdentity: EXPECTED_IDENTITY,
        processId: 1234,
        spawnImpl: () => {
          const child = new EventEmitter();
          child.unref = () => {};
          child.kill = () => {};
          queueMicrotask(() => child.emit("spawn"));
          queueMicrotask(() => writeFile(join(root, "helper-started.txt"), "1\n"));
          return child;
        },
      }));
    }
    assert.equal(launches[0].readyFile, launches[1].readyFile);
    assert.equal(launches[0].readyFile, join(root, "update-ready.json"));
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("the packaged app never passes the signature-probe option", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /signatureProbe/);
  assert.doesNotMatch(main, /MOSA_UPDATE_SIGNATURE_PROBE/);
});

test("the apply script receives the probe as a parameter and never reads environment variables", () => {
  const script = windowsUpdateHelperScript();
  // The probe must arrive as a script parameter: the helper is started through
  // Win32_Process.Create, which builds the environment from the registry, so
  // an environment variable would both miss in tests and leak in from a
  // user's machine settings.
  assert.match(script, /\[AllowEmptyString\(\)\]\[string\]\$SignatureProbe = ''/);
  assert.doesNotMatch(script, /MOSA_UPDATE_SIGNATURE_PROBE/);
  assert.doesNotMatch(script, /\$env:/);
});

test("Windows helper handoff tolerates bootstrap exit zero while waiting for detached helper marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-helper-bootstrap-exit-"));
  try {
    await launchWindowsUpdateHelper({
      zipPath: join(root, "MOSA-win32-x64-0.3.0.zip"),
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      currentExeName: "MOSA.exe",
      payloadExeName: "MOSA.exe",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
      processId: 1234,
      helperStartTimeoutMs: 500,
      spawnImpl: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        child.kill = () => {};
        queueMicrotask(() => child.emit("spawn"));
        setTimeout(() => child.emit("exit", 0, null), 5);
        setTimeout(() => writeFile(join(root, "helper-started.txt"), "9876\n"), 30);
        return child;
      },
    });
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("post-update readiness argument is accepted only inside the updater staging root", () => {
  const root = "C:\\Users\\Example\\AppData\\Roaming\\MOSA\\updates\\windows";
  const ready = `${root}\\0.3.0\\update-ready.json`;
  assert.equal(resolveWindowsUpdateReadyFile([`--mosa-update-ready-file=${ready}`], root), ready);
  assert.equal(resolveWindowsUpdateReadyFile(["--mosa-update-ready-file=C:\\Temp\\fake-ready.json"], root), null);
});
