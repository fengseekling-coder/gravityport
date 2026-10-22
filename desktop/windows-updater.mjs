import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizeDesktopDistribution } from "../lib/release-distribution.mjs";
import {
  WINDOWS_SIGNER_THUMBPRINT_PATTERN,
  WINDOWS_UPDATE_EXE_NAMES,
  normalizeWindowsUpdatePayloadExeName,
  windowsUpdateFileNameForPayloadExeName,
} from "./update-service.mjs";

export { WINDOWS_UPDATE_EXE_NAMES };

export const MOSA_WINDOWS_DOWNLOAD_BASE_URL = "https://gravityport.azhuilab.com/downloads/";
const MAX_WINDOWS_UPDATE_BYTES = 1_500_000_000;
const DEFAULT_WINDOWS_UPDATE_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_WINDOWS_HELPER_START_TIMEOUT_MS = 5_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function safeVersion(value) {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Invalid Windows update version.");
  }
  return version;
}

function safeSignerThumbprint(value) {
  const thumbprint = String(value || "").trim().toUpperCase();
  if (!thumbprint) return "";
  if (!WINDOWS_SIGNER_THUMBPRINT_PATTERN.test(thumbprint)) {
    throw new Error("Invalid Windows release signer thumbprint.");
  }
  return thumbprint;
}

function safeBuildIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows update build identity is missing.");
  const gitSha = String(value.gitSha || "").trim().toLowerCase();
  const uiFingerprint = String(value.uiFingerprint || "").trim().toLowerCase();
  const runtimeFingerprint = String(value.runtimeFingerprint || "").trim().toLowerCase();
  const distribution = normalizeDesktopDistribution(value.distribution, { defaultValue: "preview", releaseOnly: true });
  if (!GIT_SHA_PATTERN.test(gitSha) || !SHA256_PATTERN.test(uiFingerprint) || !SHA256_PATTERN.test(runtimeFingerprint)) {
    throw new Error("Windows update build identity is invalid.");
  }
  return { gitSha, uiFingerprint, runtimeFingerprint, distribution };
}

export function validateWindowsUpdateArtifact(input, version) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Windows update artifact is missing.");
  }
  const normalizedVersion = safeVersion(version);
  const payloadExeName = normalizeWindowsUpdatePayloadExeName(input.payloadExeName);
  const expectedFile = windowsUpdateFileNameForPayloadExeName(payloadExeName, normalizedVersion);
  const file = String(input.file || "").trim();
  const size = Number(input.size);
  const sha256 = String(input.sha256 || "").trim().toLowerCase();
  const signerThumbprint = safeSignerThumbprint(input.signerThumbprint);
  if (String(input.platform || "").trim() !== "Windows") {
    throw new Error("Windows update artifact has an unexpected platform.");
  }
  if (String(input.arch || "").trim() !== "x64") {
    throw new Error("Windows update artifact has an unexpected architecture.");
  }
  if (file !== expectedFile) {
    throw new Error("Windows update artifact filename does not match the release version.");
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_WINDOWS_UPDATE_BYTES) {
    throw new Error("Windows update artifact has an invalid size.");
  }
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error("Windows update artifact has an invalid SHA-256 digest.");
  }
  return {
    platform: "Windows",
    arch: "x64",
    payloadExeName,
    file,
    size,
    sha256,
    ...(signerThumbprint ? { signerThumbprint } : {}),
  };
}

export function windowsUpdateDownloadUrl(artifact) {
  const file = String(artifact?.file || "").trim();
  if (!/^(?:MOSA|GravityPort)-win32-x64-[0-9A-Za-z.-]+\.zip$/.test(file)) {
    throw new Error("Unsafe Windows update filename.");
  }
  return new URL(encodeURIComponent(file), MOSA_WINDOWS_DOWNLOAD_BASE_URL).toString();
}

// The portable install keeps its on-disk exe name across updates (old users
// stay on MOSA.exe, new installs on GravityPort.exe), so the updater installs
// under whichever name is currently running. An unrecognized executable name
// must stop the update instead of guessing.
export function windowsInstalledExeName(execPath = process.execPath) {
  const exeName = win32.basename(String(execPath || ""));
  return WINDOWS_UPDATE_EXE_NAMES.includes(exeName) ? exeName : null;
}

function readableBody(body) {
  if (!body) return null;
  if (typeof body.getReader === "function") return Readable.fromWeb(body);
  if (typeof body.pipe === "function" || body[Symbol.asyncIterator]) return body;
  return null;
}

export async function downloadWindowsUpdate({
  artifact,
  version,
  stagingRoot,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  signal,
  idleTimeoutMs = DEFAULT_WINDOWS_UPDATE_IDLE_TIMEOUT_MS,
} = {}) {
  const safeArtifact = validateWindowsUpdateArtifact(artifact, version);
  if (typeof fetchImpl !== "function") throw new Error("Windows update download is unavailable.");
  const normalizedVersion = safeVersion(version);
  const stagingDir = join(stagingRoot, normalizedVersion);
  const partialPath = join(stagingDir, `${safeArtifact.file}.partial`);
  const zipPath = join(stagingDir, safeArtifact.file);
  // Only one downloaded release is ever useful. Removing the updater-owned
  // root prevents 150MB-class ZIPs from accumulating across versions.
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const controller = new AbortController();
  let activeSource = null;
  let idleTimer = null;
  let timedOut = false;
  const timeoutMs = Math.max(1000, Number(idleTimeoutMs) || DEFAULT_WINDOWS_UPDATE_IDLE_TIMEOUT_MS);
  const timeoutError = () => Object.assign(new Error("Windows update download stalled."), { code: "WINDOWS_UPDATE_DOWNLOAD_TIMEOUT" });
  const armIdleTimeout = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      const error = timeoutError();
      controller.abort(error);
      activeSource?.destroy?.(error);
    }, timeoutMs);
    idleTimer.unref?.();
  };
  const abortFromCaller = () => {
    const reason = signal?.reason instanceof Error ? signal.reason : new Error("Windows update download cancelled.");
    controller.abort(reason);
    activeSource?.destroy?.(reason);
  };
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.("abort", abortFromCaller, { once: true });
  armIdleTimeout();

  try {
    const response = await fetchImpl(windowsUpdateDownloadUrl(safeArtifact), {
      method: "GET",
      headers: {
        accept: "application/zip, application/octet-stream",
        "cache-control": "no-cache",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`Windows update download returned HTTP ${response?.status || 0}.`);
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== safeArtifact.size) {
      throw new Error("Windows update download size does not match the release manifest.");
    }
    activeSource = readableBody(response.body);
    if (!activeSource) throw new Error("Windows update response has no readable body.");
    armIdleTimeout();

    const hash = createHash("sha256");
    let receivedBytes = 0;
    let lastReportedPercent = -1;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        armIdleTimeout();
        receivedBytes += chunk.length;
        if (receivedBytes > safeArtifact.size) {
          callback(new Error("Windows update download exceeded the expected size."));
          return;
        }
        hash.update(chunk);
        const percent = Math.min(100, Math.floor((receivedBytes / safeArtifact.size) * 100));
        if (percent !== lastReportedPercent) {
          lastReportedPercent = percent;
          onProgress({ receivedBytes, totalBytes: safeArtifact.size, percent });
        }
        callback(null, chunk);
      },
    });
    await pipeline(activeSource, meter, createWriteStream(partialPath, { flags: "wx" }));
    if (receivedBytes !== safeArtifact.size) {
      throw new Error("Windows update download is incomplete.");
    }
    const digest = hash.digest("hex");
    if (digest !== safeArtifact.sha256) {
      throw new Error("Windows update SHA-256 verification failed.");
    }
    await rename(partialPath, zipPath);
    onProgress({ receivedBytes, totalBytes: safeArtifact.size, percent: 100 });
    return { stagingDir, zipPath, artifact: safeArtifact };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (timedOut && error?.code !== "WINDOWS_UPDATE_DOWNLOAD_TIMEOUT") throw timeoutError();
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener?.("abort", abortFromCaller);
  }
}

export function resolveWindowsUpdateReadyFile(argv = process.argv, stagingRoot = "") {
  const prefix = "--mosa-update-ready-file=";
  const raw = (Array.isArray(argv) ? argv : []).find((value) => String(value).startsWith(prefix));
  if (!raw || !stagingRoot) return null;
  const rawCandidate = String(raw).slice(prefix.length);
  const windowsStyle = /^[a-z]:[\\/]/i.test(rawCandidate) || /^[a-z]:[\\/]/i.test(String(stagingRoot));
  const pathApi = windowsStyle ? win32 : { resolve, relative: (from, to) => relative(from, to), isAbsolute };
  const candidate = pathApi.resolve(rawCandidate);
  const root = pathApi.resolve(stagingRoot);
  const suffix = pathApi.relative(root, candidate);
  if (suffix === "") return candidate;
  if (suffix === ".." || suffix.startsWith(`..${windowsStyle ? "\\" : "/"}`) || pathApi.isAbsolute(suffix)) return null;
  return candidate;
}

export function windowsUpdateTransactionParentDir(execPath) {
  const value = String(execPath || "").trim();
  if (!value) return "";
  return win32.dirname(win32.dirname(value));
}

export function windowsMoveDirectoryRetryScript() {
  return String.raw`function Move-MosaDirectoryWithRetry {
  param(
    [Parameter(Mandatory=$true)][string]$LiteralPath,
    [Parameter(Mandatory=$true)][string]$Destination,
    [int]$MaxAttempts = 10
  )

  # Windows antivirus/indexing filters can retain handles to a freshly
  # extracted portable app for several seconds. Keep the update bounded, but
  # tolerate a materially longer transient-contention window before rollback.
  $retryDelaysMs = @(250, 500, 1000, 2000, 3000, 4000, 5000, 5000, 5000)
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction Stop
      return
    } catch {
      $errorRecord = $_
      $exception = $errorRecord.Exception
      $retryable = ($exception -is [System.IO.IOException]) -or ($exception -is [System.UnauthorizedAccessException])
      if (-not $retryable -or $attempt -ge $MaxAttempts) {
        $exceptionType = if ($exception) { $exception.GetType().FullName } else { "unknown" }
        $hresultHex = if ($exception) { "0x" + $exception.HResult.ToString("X8") } else { "unknown" }
        $nativeCode = if ($exception) { $exception.HResult -band 0xffff } else { "unknown" }
        $errorId = [string]$errorRecord.FullyQualifiedErrorId
        $moveDiagnostic = "MOSA directory move failed: source=$LiteralPath; destination=$Destination; attempt=$attempt/$MaxAttempts; exceptionType=$exceptionType; hresult=$hresultHex; nativeCode=$nativeCode; errorId=$errorId"
        if ($script:MosaLastMoveDiagnostic) {
          $script:MosaLastMoveDiagnostic += [Environment]::NewLine + $moveDiagnostic
        } else {
          $script:MosaLastMoveDiagnostic = $moveDiagnostic
        }
        throw
      }
      $delayIndex = [Math]::Min($attempt - 1, $retryDelaysMs.Count - 1)
      Start-Sleep -Milliseconds $retryDelaysMs[$delayIndex]
    }
  }
}`;
}

export function windowsInstallProcessDrainScript() {
  return String.raw`function Wait-MosaInstallProcessesExit {
  param(
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [int]$MaxAttempts = 60
  )

  $trimmed = $InstallDir.TrimEnd([char]92, [char]47)
  if ($trimmed -notmatch '[\\/]') {
    # A drive-root install (e.g. C:\) would make the prefix below match every
    # process on that drive and abort valid updates; MOSA ships as a
    # subdirectory layout, so fail closed with guidance instead.
    throw "MOSA update requires a subdirectory install, not a drive root: $InstallDir"
  }
  $prefix = $trimmed + [IO.Path]::DirectorySeparatorChar
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $remaining = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $exe = [string]$_.ExecutablePath
      $exe -and $exe.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($remaining.Count -eq 0) { return }
    if ($attempt -ge $MaxAttempts) {
      $ids = ($remaining | ForEach-Object { [string]$_.ProcessId }) -join ','
      throw "MOSA processes still hold the install directory after shutdown: $ids"
    }
    Start-Sleep -Milliseconds 250
  }
}`;
}

export function windowsUpdateHelperScript() {
  return String.raw`param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$ZipPath,
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][string]$CurrentExeName,
  [Parameter(Mandatory=$true)][string]$PayloadExeName,
  [Parameter(Mandatory=$true)][AllowEmptyString()][string]$ExpectedSignerThumbprint,
  [Parameter(Mandatory=$true)][string]$ExpectedVersion,
  [Parameter(Mandatory=$true)][string]$ExpectedGitSha,
  [Parameter(Mandatory=$true)][string]$ExpectedUiFingerprint,
  [Parameter(Mandatory=$true)][string]$ExpectedRuntimeFingerprint,
  [Parameter(Mandatory=$true)][ValidateSet('preview','production')][string]$ExpectedDistribution,
  [AllowEmptyString()][string]$SignatureProbe = '',
  [Parameter(Mandatory=$true)][string]$LogPath,
  [Parameter(Mandatory=$true)][string]$StartedFile,
  [Parameter(Mandatory=$true)][string]$ReadyFile
)

${windowsMoveDirectoryRetryScript()}
${windowsInstallProcessDrainScript()}

$ErrorActionPreference = "Stop"
$script:MosaLastMoveDiagnostic = $null
$parentDir = Split-Path -Parent $InstallDir
$transactionRoot = Join-Path $parentDir (".MOSA-update-" + [Guid]::NewGuid().ToString("N"))
$extractDir = Join-Path $transactionRoot "extracted"
$payloadDir = $null
$backupDir = Join-Path $transactionRoot "previous"
$oldExe = Join-Path $InstallDir $CurrentExeName
$newProcess = $null
$movedOriginal = $false
# The new version writes this before it upgrades the library schema. From then
# on the previous version cannot open the library, so never roll back to it.
$schemaUpgradeMarker = Join-Path (Split-Path -Parent $ReadyFile) "schema-upgrade-started.json"

# Installation-rehearsal tests pass this probe as a script parameter to run
# signature verification against a stub that answers Status/Thumbprint/Subject
# lines. The default is the real cmdlet; nothing else may customize it. It is
# deliberately NOT read from the environment: this helper is started through
# Win32_Process.Create, which builds the environment from the registry rather
# than inheriting the caller's, so an environment variable would both fail to
# reach the script in tests and leak in from a user's machine settings.
function Get-MosaSignatureInfo {
  param([Parameter(Mandatory=$true)][string]$LiteralPath)
  if ($SignatureProbe) {
    $raw = (& $SignatureProbe $LiteralPath) -join [Environment]::NewLine
    $values = @{}
    foreach ($line in ($raw -split '\r?\n')) {
      $trimmed = $line.Trim()
      $separator = $trimmed.IndexOf('=')
      if ($trimmed -and $separator -gt 0) {
        $values[$trimmed.Substring(0, $separator)] = $trimmed.Substring($separator + 1)
      }
    }
    return [pscustomobject]@{
      Status = [string]$values['Status']
      Thumbprint = [string]$values['Thumbprint']
      Subject = [string]$values['Subject']
    }
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $LiteralPath
  $thumbprint = ''
  $subject = ''
  if ($signature -and $signature.SignerCertificate) {
    $thumbprint = [string]$signature.SignerCertificate.Thumbprint
    $subject = [string]$signature.SignerCertificate.Subject
  }
  return [pscustomobject]@{
    Status = [string]$signature.Status
    Thumbprint = $thumbprint
    Subject = $subject
  }
}

try {
  [string]$PID | Set-Content -LiteralPath $StartedFile -Encoding ASCII
  if ($ExpectedDistribution -eq 'production' -and -not $ExpectedSignerThumbprint) {
    throw "Production Windows updates require the release signer thumbprint."
  }
  # Production trust is anchored to the signed manifest's thumbprint, never to
  # the previous install alone. An installed exe that already carries a valid
  # signature pins the payload's publisher subject: certificate renewals
  # rotate thumbprints, so comparing subjects (not thumbprints) is what keeps
  # a renewed certificate updating. An unsigned (preview) install crosses
  # into production exactly once, checked only against the manifest below.
  $oldSignerSubject = ''
  if ($ExpectedDistribution -eq 'production') {
    $oldSignature = Get-MosaSignatureInfo -LiteralPath $oldExe
    if ($oldSignature.Status -eq 'Valid' -and $oldSignature.Thumbprint) {
      $oldSignerSubject = [string]$oldSignature.Subject
    }
  }
  Wait-Process -Id $TargetPid -ErrorAction SilentlyContinue
  Wait-MosaInstallProcessesExit -InstallDir $InstallDir
  New-Item -ItemType Directory -Path $transactionRoot -Force | Out-Null
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $extractDir -Force
  $flatPayloadExe = Join-Path $extractDir $PayloadExeName
  $nestedPayloadDir = $null
  $nestedPayloadExe = $null
  foreach ($nestedDirName in @("MOSA-win32-x64", "GravityPort-win32-x64")) {
    $candidateDir = Join-Path $extractDir $nestedDirName
    $candidateExe = Join-Path $candidateDir $PayloadExeName
    if (Test-Path -LiteralPath $candidateExe -PathType Leaf) {
      $nestedPayloadDir = $candidateDir
      $nestedPayloadExe = $candidateExe
      break
    }
  }
  if (Test-Path -LiteralPath $flatPayloadExe -PathType Leaf) {
    $payloadDir = $extractDir
    $payloadExe = $flatPayloadExe
  } elseif (($null -ne $nestedPayloadExe) -and (Test-Path -LiteralPath $nestedPayloadExe -PathType Leaf)) {
    $payloadDir = $nestedPayloadDir
    $payloadExe = $nestedPayloadExe
  } else {
    throw "Downloaded MOSA package does not contain the expected executable."
  }
  if ($ExpectedDistribution -eq 'production') {
    $signableFiles = @(Get-ChildItem -LiteralPath $payloadDir -Recurse -File | Where-Object { $_.Extension -in @('.exe', '.dll', '.node') })
    if ($signableFiles.Count -eq 0) {
      throw "Downloaded MOSA package contains no signable executable payload."
    }
    foreach ($file in $signableFiles) {
      $payloadSignature = Get-MosaSignatureInfo -LiteralPath $file.FullName
      if ($payloadSignature.Status -ne 'Valid' -or -not $payloadSignature.Thumbprint) {
        throw "Downloaded MOSA payload contains an invalid Authenticode signature: $($file.FullName)"
      }
      if ($payloadSignature.Thumbprint -ne $ExpectedSignerThumbprint) {
        throw "Downloaded MOSA payload is signed by a different publisher: $($file.FullName)"
      }
      if ($oldSignerSubject -and ([string]$payloadSignature.Subject -ne $oldSignerSubject)) {
        throw "Downloaded MOSA payload publisher changed between releases: $($file.FullName)"
      }
    }
  }
  # A cross-name update (the payload ships the other whitelisted exe name)
  # keeps the installed file name: rename the payload executable before
  # anything moves, so the portable directory and every relaunch path stay on
  # the current name. A failed rename throws while the original install is
  # still untouched, so the rollback below only has to relaunch it.
  if ($PayloadExeName -ne $CurrentExeName) {
    Rename-Item -LiteralPath $payloadExe -NewName $CurrentExeName -ErrorAction Stop
  }

  Move-MosaDirectoryWithRetry -LiteralPath $InstallDir -Destination $backupDir
  $movedOriginal = $true
  try {
    Move-MosaDirectoryWithRetry -LiteralPath $payloadDir -Destination $InstallDir
    $newExe = Join-Path $InstallDir $CurrentExeName
    if (-not (Test-Path -LiteralPath $newExe -PathType Leaf)) {
      throw "Updated MOSA executable is missing after replacement."
    }
    Remove-Item -LiteralPath $ReadyFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $schemaUpgradeMarker -Force -ErrorAction SilentlyContinue
    $readyArgument = '--mosa-update-ready-file="' + $ReadyFile + '"'
    # The PowerShell helper itself is created with CREATE_NO_WINDOW. Do not
    # propagate hidden-window semantics to MOSA.exe: it is a GUI application
    # and must relaunch with its normal visible-window lifecycle.
    $newProcess = Start-Process -FilePath $newExe -WorkingDirectory $InstallDir -ArgumentList @($readyArgument) -PassThru
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(120)
    while ([DateTime]::UtcNow -lt $readyDeadline) {
      if (Test-Path -LiteralPath $ReadyFile -PathType Leaf) { break }
      if ($newProcess.HasExited) {
        # It may have written the ready file just before exiting.
        if (Test-Path -LiteralPath $ReadyFile -PathType Leaf) { break }
        throw "Updated MOSA exited before reporting readiness."
      }
      Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $ReadyFile -PathType Leaf)) {
      throw "Updated MOSA did not report readiness before the rollback deadline."
    }
    $ready = Get-Content -LiteralPath $ReadyFile -Raw | ConvertFrom-Json
    if ([string]$ready.version -ne $ExpectedVersion -or
        [string]$ready.gitSha -ne $ExpectedGitSha -or
        [string]$ready.uiFingerprint -ne $ExpectedUiFingerprint -or
        [string]$ready.runtimeFingerprint -ne $ExpectedRuntimeFingerprint) {
      throw "Updated MOSA readiness identity does not match the release manifest."
    }
    if ([string]$ready.distribution -ne $ExpectedDistribution) {
      throw "Updated MOSA distribution does not match the release manifest."
    }
    # Keep $backupDir parked inside $transactionRoot. The updated app sweeps
    # stale .MOSA-update-* directories on a later boot, so a crash shortly
    # after this point remains recoverable from the parked previous copy.
    Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
  } catch {
    if ($movedOriginal -and (Test-Path -LiteralPath $schemaUpgradeMarker -PathType Leaf)) {
      # Keep the new version and the parked previous copy; only the new
      # version can open the upgraded library.
      if ((-not $newProcess) -or $newProcess.HasExited) {
        $keptExe = Join-Path $InstallDir $CurrentExeName
        if (Test-Path -LiteralPath $keptExe -PathType Leaf) {
          Start-Process -FilePath $keptExe -WorkingDirectory $InstallDir -ErrorAction SilentlyContinue
        }
      }
      ("Kept the new version because it already upgraded the library." + [Environment]::NewLine + ($_ | Out-String)) | Set-Content -LiteralPath $LogPath -Encoding UTF8
      exit 34
    }
    if ($newProcess -and -not $newProcess.HasExited) {
      Stop-Process -Id $newProcess.Id -Force -ErrorAction SilentlyContinue
      Wait-Process -Id $newProcess.Id -ErrorAction SilentlyContinue
    }
    # The destructive removal is explicitly scoped: it only runs once the
    # original directory is verifiably parked in $backupDir, so whatever sits
    # at $InstallDir at this point is replacement payload this helper moved
    # in — never files that predate the update.
    if ($movedOriginal -and (Test-Path -LiteralPath $backupDir -PathType Container)) {
      if (Test-Path -LiteralPath $InstallDir) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
      }
      Move-MosaDirectoryWithRetry -LiteralPath $backupDir -Destination $InstallDir
    }
    throw
  }
} catch {
  if (Test-Path -LiteralPath $oldExe -PathType Leaf) {
    Start-Process -FilePath $oldExe -WorkingDirectory $InstallDir -ErrorAction SilentlyContinue
  }
  $errorText = ($_ | Out-String)
  if ($script:MosaLastMoveDiagnostic) {
    $errorText += [Environment]::NewLine + $script:MosaLastMoveDiagnostic + [Environment]::NewLine
  }
  $errorText | Set-Content -LiteralPath $LogPath -Encoding UTF8
  exit 1
}
`;
}

async function waitForWindowsUpdateHelperStarted({
  child,
  startedFile,
  timeoutMs = DEFAULT_WINDOWS_HELPER_START_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + Math.max(250, Number(timeoutMs) || DEFAULT_WINDOWS_HELPER_START_TIMEOUT_MS);
  let childExit = null;
  const onExit = (code, signal) => {
    childExit = { code, signal };
  };
  child.once?.("exit", onExit);
  try {
    while (Date.now() < deadline) {
      const marker = await readFile(startedFile, "utf8").catch((error) => {
        // Windows reports the marker as busy or locked while the helper is
        // still writing it; that is "not yet", not a failed handoff.
        if (["ENOENT", "EBUSY", "EPERM", "EACCES"].includes(error?.code)) return "";
        throw error;
      });
      if (String(marker || "").trim()) return true;
      if (childExit && (childExit.signal || childExit.code !== 0)) {
        throw new Error(
          `Windows update helper exited before startup handoff (code=${childExit.code ?? "null"}, signal=${childExit.signal ?? "none"}).`,
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    throw new Error("Windows update helper did not start before the handoff deadline.");
  } finally {
    child.off?.("exit", onExit);
  }
}

function powershellLiteral(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function encodePowerShellCommand(command) {
  return Buffer.from(String(command || ""), "utf16le").toString("base64");
}

export function windowsUpdateDetachedLauncherCommand({
  scriptPath,
  processId,
  zipPath,
  installDir,
  currentExeName,
  payloadExeName,
  signerThumbprint = "",
  signatureProbe = "",
  version,
  expectedIdentity,
  logPath,
  startedFile,
  readyFile,
  launcherLogPath,
} = {}) {
  const identity = safeBuildIdentity(expectedIdentity);
  const normalizedVersion = safeVersion(version);
  const safeCurrentExeName = String(currentExeName || "");
  if (!WINDOWS_UPDATE_EXE_NAMES.includes(safeCurrentExeName)) {
    throw new Error("Invalid Windows update current executable name.");
  }
  const safePayloadExeName = normalizeWindowsUpdatePayloadExeName(payloadExeName);
  const safeSignerThumbprintValue = safeSignerThumbprint(signerThumbprint);
  const helperCommand = [
    `& ${powershellLiteral(scriptPath)}`,
    `-TargetPid ${Number(processId)}`,
    `-ZipPath ${powershellLiteral(zipPath)}`,
    `-InstallDir ${powershellLiteral(installDir)}`,
    `-CurrentExeName ${powershellLiteral(safeCurrentExeName)}`,
    `-PayloadExeName ${powershellLiteral(safePayloadExeName)}`,
    `-ExpectedSignerThumbprint ${powershellLiteral(safeSignerThumbprintValue)}`,
    ...(String(signatureProbe || "") ? [`-SignatureProbe ${powershellLiteral(signatureProbe)}`] : []),
    `-ExpectedVersion ${powershellLiteral(normalizedVersion)}`,
    `-ExpectedGitSha ${powershellLiteral(identity.gitSha)}`,
    `-ExpectedUiFingerprint ${powershellLiteral(identity.uiFingerprint)}`,
    `-ExpectedRuntimeFingerprint ${powershellLiteral(identity.runtimeFingerprint)}`,
    `-ExpectedDistribution ${powershellLiteral(identity.distribution)}`,
    `-LogPath ${powershellLiteral(logPath)}`,
    `-StartedFile ${powershellLiteral(startedFile)}`,
    `-ReadyFile ${powershellLiteral(readyFile)}`,
  ].join(" ");
  const helperEncoded = encodePowerShellCommand(helperCommand);
  const detachedCommandLine = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${helperEncoded}`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $commandLine = ${powershellLiteral(detachedCommandLine)}`,
    // A -ClientOnly CIM instance only carries the properties it is created
    // with; assigning them afterwards throws "property cannot be found"
    // (shipped broken in rc.33/rc.34), so set them up front. CreateFlags is
    // left out: WMI accepts only its documented flags and rejects
    // CREATE_NO_WINDOW with return value 21. SW_HIDE plus the helper's own
    // -WindowStyle Hidden keep the console out of sight.
    "  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 } -ErrorAction Stop",
    "  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; ProcessStartupInformation = $startup } -ErrorAction Stop",
    "  if (-not $result -or [int]$result.ReturnValue -ne 0) {",
    "    throw ('Win32_Process.Create failed with return value ' + [string]$result.ReturnValue)",
    "  }",
    "} catch {",
    `  ($_ | Out-String) | Set-Content -LiteralPath ${powershellLiteral(launcherLogPath)} -Encoding UTF8`,
    "  exit 1",
    "}",
  ].join("; ");
}

export async function launchWindowsUpdateHelper({
  zipPath,
  installDir,
  currentExeName,
  payloadExeName,
  signerThumbprint = "",
  signatureProbe = "",
  version,
  expectedIdentity,
  processId,
  spawnImpl = spawn,
  helperStartTimeoutMs = DEFAULT_WINDOWS_HELPER_START_TIMEOUT_MS,
} = {}) {
  const identity = safeBuildIdentity(expectedIdentity);
  const normalizedVersion = safeVersion(version);
  const safeCurrentExeName = windowsInstalledExeName(currentExeName);
  const safePayloadExeName = normalizeWindowsUpdatePayloadExeName(payloadExeName);
  const expectedSignerThumbprint = safeSignerThumbprint(signerThumbprint);
  if (!zipPath || !installDir || !safeCurrentExeName || !Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error("Invalid Windows update helper arguments.");
  }
  if (identity.distribution === "production" && !expectedSignerThumbprint) {
    throw new Error("Windows production updates require a release signer thumbprint.");
  }
  const stagingDir = dirname(zipPath);
  const scriptPath = join(stagingDir, "apply-update.ps1");
  const logPath = join(stagingDir, "apply-update-error.log");
  const launcherLogPath = join(stagingDir, "helper-launch-error.log");
  const startedFile = join(stagingDir, "helper-started.txt");
  // The readiness file lives in the updater staging root under Electron
  // userData, so its path never depends on the installed exe's name.
  const readyFile = join(stagingDir, "update-ready.json");
  await Promise.all([
    rm(startedFile, { force: true }),
    rm(launcherLogPath, { force: true }),
  ]);
  await writeFile(scriptPath, windowsUpdateHelperScript(), "utf8");
  const launcherCommand = windowsUpdateDetachedLauncherCommand({
    scriptPath,
    processId,
    zipPath,
    installDir,
    currentExeName: safeCurrentExeName,
    payloadExeName: safePayloadExeName,
    signerThumbprint: expectedSignerThumbprint,
    signatureProbe,
    version: normalizedVersion,
    expectedIdentity: identity,
    logPath,
    startedFile,
    readyFile,
    launcherLogPath,
  });
  const child = spawnImpl("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encodePowerShellCommand(launcherCommand),
  ], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  try {
    await waitForWindowsUpdateHelperStarted({
      child,
      startedFile,
      timeoutMs: helperStartTimeoutMs,
    });
  } catch (error) {
    child.kill?.();
    throw error;
  }
  child.unref?.();
  return { scriptPath, logPath, launcherLogPath, startedFile, readyFile };
}
