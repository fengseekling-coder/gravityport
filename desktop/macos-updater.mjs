import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createMosaMacosUpdateHelperHandoff,
  mosaDesktopStartupHandoffPath,
} from "../lib/runtime-handoff.mjs";
import { normalizeDesktopDistribution } from "../lib/release-distribution.mjs";
import { MACOS_TEAM_IDENTIFIER_PATTERN, MACOS_UPDATE_APP_NAMES } from "./update-service.mjs";

export { MACOS_UPDATE_APP_NAMES };

export const MOSA_MACOS_DOWNLOAD_BASE_URL = "https://gravityport.azhuilab.com/downloads/";
const MAX_MACOS_UPDATE_BYTES = 1_500_000_000;
const DEFAULT_MACOS_UPDATE_IDLE_TIMEOUT_MS = 30_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function safeVersion(value) {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid macOS update version.");
  return version;
}

export function normalizeMacosUpdateAppName(value) {
  const appName = value == null || String(value).trim() === "" ? "MOSA.app" : String(value).trim();
  if (!MACOS_UPDATE_APP_NAMES.includes(appName)) throw new Error("Invalid macOS update app name.");
  return appName;
}

function safeBuildIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("macOS update build identity is missing.");
  const gitSha = String(value.gitSha || "").trim().toLowerCase();
  const uiFingerprint = String(value.uiFingerprint || "").trim().toLowerCase();
  const runtimeFingerprint = String(value.runtimeFingerprint || "").trim().toLowerCase();
  const distribution = normalizeDesktopDistribution(value.distribution, { defaultValue: "preview", releaseOnly: true });
  if (!GIT_SHA_PATTERN.test(gitSha) || !SHA256_PATTERN.test(uiFingerprint) || !SHA256_PATTERN.test(runtimeFingerprint)) {
    throw new Error("macOS update build identity is invalid.");
  }
  return { gitSha, uiFingerprint, runtimeFingerprint, distribution };
}

export function validateMacosUpdateArtifact(input, version) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("macOS update artifact is missing.");
  const normalizedVersion = safeVersion(version);
  const appName = normalizeMacosUpdateAppName(input.appName);
  const expectedFile = `${appName.slice(0, -4)}-darwin-arm64-${normalizedVersion}.zip`;
  const file = String(input.file || "").trim();
  const size = Number(input.size);
  const sha256 = String(input.sha256 || "").trim().toLowerCase();
  if (String(input.platform || "").trim() !== "macOS") throw new Error("macOS update artifact has an unexpected platform.");
  if (String(input.arch || "").trim() !== "arm64") throw new Error("macOS update artifact has an unexpected architecture.");
  if (file !== expectedFile) throw new Error("macOS update artifact filename does not match the release version.");
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_MACOS_UPDATE_BYTES) throw new Error("macOS update artifact has an invalid size.");
  if (!SHA256_PATTERN.test(sha256)) throw new Error("macOS update artifact has an invalid SHA-256 digest.");
  const teamIdentifier = String(input.teamIdentifier || "").trim().toUpperCase();
  if (teamIdentifier && !MACOS_TEAM_IDENTIFIER_PATTERN.test(teamIdentifier)) {
    throw new Error("macOS update artifact has an invalid team identifier.");
  }
  return {
    platform: "macOS",
    arch: "arm64",
    appName,
    file,
    size,
    sha256,
    ...(teamIdentifier ? { teamIdentifier } : {}),
  };
}

export function macosUpdateDownloadUrl(artifact) {
  const file = String(artifact?.file || "").trim();
  if (!/^(?:MOSA|GravityPort)-darwin-arm64-[0-9A-Za-z.-]+\.zip$/.test(file)) throw new Error("Unsafe macOS update filename.");
  return new URL(encodeURIComponent(file), MOSA_MACOS_DOWNLOAD_BASE_URL).toString();
}

export function resolveMacosInstallAppPath(execPath = process.execPath) {
  const executable = resolve(String(execPath || ""));
  const marker = "/Contents/MacOS/";
  const index = executable.lastIndexOf(marker);
  if (index <= 0) return null;
  const appPath = executable.slice(0, index);
  return appPath.endsWith("/MOSA.app") || appPath.endsWith("/GravityPort.app") ? appPath : null;
}

// A packaged app that runs from a Gatekeeper translocation path, or sits in a
// directory it cannot write to (read-only volume, lack of permission), must not
// attempt an in-place replacement: the updater stops safely and the UI asks
// the user to move the app into Applications first.
export function evaluateMacosInstallLocation(execPath = process.execPath) {
  const installAppPath = resolveMacosInstallAppPath(execPath);
  if (!installAppPath) return { supported: false, installAppPath: null, reason: "app-bundle-unrecognized" };
  if (installAppPath.includes("/AppTranslocation/")) {
    return { supported: false, installAppPath, reason: "app-translocation" };
  }
  try {
    accessSync(dirname(installAppPath), fsConstants.W_OK);
  } catch {
    return { supported: false, installAppPath, reason: "install-dir-not-writable" };
  }
  return { supported: true, installAppPath, reason: null };
}

export async function downloadMacosUpdate({
  artifact,
  version,
  stagingRoot,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  signal,
  idleTimeoutMs = DEFAULT_MACOS_UPDATE_IDLE_TIMEOUT_MS,
} = {}) {
  const safeArtifact = validateMacosUpdateArtifact(artifact, version);
  if (typeof fetchImpl !== "function") throw new Error("macOS update download is unavailable.");
  const normalizedVersion = safeVersion(version);
  const stagingDir = join(stagingRoot, normalizedVersion);
  const partialPath = join(stagingDir, `${safeArtifact.file}.partial`);
  const zipPath = join(stagingDir, safeArtifact.file);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const controller = new AbortController();
  let activeSource = null;
  let idleTimer = null;
  let timedOut = false;
  const timeoutMs = Math.max(1000, Number(idleTimeoutMs) || DEFAULT_MACOS_UPDATE_IDLE_TIMEOUT_MS);
  const timeoutError = () => Object.assign(new Error("macOS update download stalled."), { code: "MACOS_UPDATE_DOWNLOAD_TIMEOUT" });
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
    const reason = signal?.reason instanceof Error ? signal.reason : new Error("macOS update download cancelled.");
    controller.abort(reason);
    activeSource?.destroy?.(reason);
  };
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.("abort", abortFromCaller, { once: true });
  armIdleTimeout();

  try {
    const response = await fetchImpl(macosUpdateDownloadUrl(safeArtifact), {
      method: "GET",
      headers: {
        accept: "application/zip, application/octet-stream",
        "accept-encoding": "identity",
        "cache-control": "no-cache",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`macOS update download returned HTTP ${response?.status || 0}.`);
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== safeArtifact.size) {
      throw new Error("macOS update download size does not match the release manifest.");
    }
    activeSource = readableBody(response.body);
    if (!activeSource) throw new Error("macOS update response has no readable body.");
    armIdleTimeout();

    const hash = createHash("sha256");
    let receivedBytes = 0;
    let lastReportedPercent = -1;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        armIdleTimeout();
        receivedBytes += chunk.length;
        if (receivedBytes > safeArtifact.size) return callback(new Error("macOS update download exceeded the expected size."));
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
    if (receivedBytes !== safeArtifact.size) throw new Error("macOS update download is incomplete.");
    if (hash.digest("hex") !== safeArtifact.sha256) throw new Error("macOS update SHA-256 verification failed.");
    await rename(partialPath, zipPath);
    onProgress({ receivedBytes, totalBytes: safeArtifact.size, percent: 100 });
    return { stagingDir, zipPath, artifact: safeArtifact };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (timedOut && error?.code !== "MACOS_UPDATE_DOWNLOAD_TIMEOUT") throw timeoutError();
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener?.("abort", abortFromCaller);
  }
}

export function resolveMacosUpdateReadyFile(argv = process.argv, stagingRoot = "") {
  const prefix = "--mosa-update-ready-file=";
  const raw = (Array.isArray(argv) ? argv : []).find((value) => String(value).startsWith(prefix));
  if (!raw || !stagingRoot) return null;
  const candidate = resolve(String(raw).slice(prefix.length));
  const root = resolve(stagingRoot);
  return candidate === root || candidate.startsWith(`${root}/`) ? candidate : null;
}

export function macosUpdateHelperScript() {
  return String.raw`#!/bin/sh
set -eu

TARGET_PID="$1"
ZIP_PATH="$2"
INSTALL_APP="$3"
EXPECTED_VERSION="$4"
EXPECTED_GIT_SHA="$5"
EXPECTED_UI_FINGERPRINT="$6"
EXPECTED_RUNTIME_FINGERPRINT="$7"
LOG_PATH="$8"
READY_FILE="$9"
shift 9
HANDOFF_FILE="$1"
EXPECTED_DISTRIBUTION="$2"
APP_NAME="$3"
EXPECTED_TEAM_IDENTIFIER="$4"

# Installation-rehearsal tests override these to run against stub tools in a
# temporary directory. The defaults are the real absolute paths a packaged
# update uses; nothing else may customize them. printenv keeps the lookups
# safe under "set -u" in a packaged run, where none of them is set.
OPEN_BIN="$(printenv MOSA_UPDATE_OPEN_BIN || true)"
if [ -z "$OPEN_BIN" ]; then OPEN_BIN="/usr/bin/open"; fi
CODESIGN_BIN="$(printenv MOSA_UPDATE_CODESIGN_BIN || true)"
if [ -z "$CODESIGN_BIN" ]; then CODESIGN_BIN="/usr/bin/codesign"; fi
SPCTL_BIN="$(printenv MOSA_UPDATE_SPCTL_BIN || true)"
if [ -z "$SPCTL_BIN" ]; then SPCTL_BIN="/usr/sbin/spctl"; fi
TRASH_DIR="$(printenv MOSA_UPDATE_TRASH_DIR || true)"
if [ -z "$TRASH_DIR" ]; then TRASH_DIR="$HOME/.Trash"; fi

PARENT_DIR="$(dirname "$INSTALL_APP")"
CURRENT_APP_NAME="$(basename "$INSTALL_APP")"
TARGET_APP="$PARENT_DIR/$APP_NAME"
EXEC_NAME="$(basename "$APP_NAME" .app)"
TRANSACTION_ROOT="$PARENT_DIR/.MOSA-update-$(date +%s)-$$"
EXTRACT_DIR="$TRANSACTION_ROOT/extracted"
REPLACEMENT_APP="$TRANSACTION_ROOT/replacement.app"
BACKUP_APP="$TRANSACTION_ROOT/previous.app"
FAILED_APP="$TRANSACTION_ROOT/failed.app"
CROSS_NAME=0
MOVED_ORIGINAL=0
NEW_PID=""
# The new version writes this before it upgrades the library schema. From then
# on the previous version cannot open the library, so never roll back to it.
SCHEMA_MARKER="$(dirname "$READY_FILE")/schema-upgrade-started.json"
KEPT_NEW=0

if [ "$CURRENT_APP_NAME" != "$APP_NAME" ]; then CROSS_NAME=1; fi

rollback() {
  rm -f "$HANDOFF_FILE" 2>/dev/null || true
  if [ "$MOVED_ORIGINAL" -eq 1 ] && [ -f "$SCHEMA_MARKER" ]; then
    KEPT_NEW=1
    if [ -z "$NEW_PID" ] || ! kill -0 "$NEW_PID" 2>/dev/null; then
      "$OPEN_BIN" -n "$TARGET_APP" >/dev/null 2>&1 || true
    fi
    return
  fi
  if [ -n "$NEW_PID" ] && kill -0 "$NEW_PID" 2>/dev/null; then
    kill -TERM "$NEW_PID" 2>/dev/null || true
    i=0
    while kill -0 "$NEW_PID" 2>/dev/null && [ "$i" -lt 40 ]; do sleep 0.25; i=$((i + 1)); done
  fi
  if [ "$MOVED_ORIGINAL" -eq 1 ] && [ -d "$BACKUP_APP" ]; then
    if [ "$CROSS_NAME" -eq 1 ]; then
      if [ -d "$TARGET_APP" ]; then rm -rf "$TARGET_APP"; fi
    elif [ -e "$INSTALL_APP" ]; then
      mv "$INSTALL_APP" "$FAILED_APP" 2>/dev/null || rm -rf "$INSTALL_APP"
    fi
    mv "$BACKUP_APP" "$INSTALL_APP"
    "$OPEN_BIN" -n "$INSTALL_APP" >/dev/null 2>&1 || true
  elif [ "$MOVED_ORIGINAL" -eq 0 ] && [ -d "$INSTALL_APP" ] && ! kill -0 "$TARGET_PID" 2>/dev/null; then
    # Failed before anything moved (refused target, bad payload): the
    # previous app already quit for the update, so bring it back untouched.
    "$OPEN_BIN" -n "$INSTALL_APP" >/dev/null 2>&1 || true
  fi
}

trap 'code=$?; rollback; if [ "$KEPT_NEW" -eq 1 ]; then echo "macOS update helper kept the new version because it already upgraded the library (exit $code)" > "$LOG_PATH"; exit 34; fi; echo "macOS update helper failed (exit $code)" > "$LOG_PATH"; exit $code' HUP INT TERM EXIT

while kill -0 "$TARGET_PID" 2>/dev/null; do sleep 0.25; done

# Cross-name update (e.g. MOSA.app -> GravityPort.app): the target location
# may already hold an app the user installed themselves. Refuse before
# touching anything; the trap clears the handoff, logs, and reopens the
# previous app.
if [ "$CROSS_NAME" -eq 1 ] && [ -e "$TARGET_APP" ]; then
  exit 33
fi

mkdir -p "$EXTRACT_DIR"
/usr/bin/ditto -x -k "$ZIP_PATH" "$EXTRACT_DIR"
PAYLOAD_APP="$EXTRACT_DIR/$APP_NAME"
test -x "$PAYLOAD_APP/Contents/MacOS/$EXEC_NAME"

BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PAYLOAD_APP/Contents/Info.plist")
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PAYLOAD_APP/Contents/Info.plist")
EXECUTABLE_NAME=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PAYLOAD_APP/Contents/Info.plist")
[ "$BUNDLE_ID" = "com.azhuilab.mosa" ]
[ "$VERSION" = "$EXPECTED_VERSION" ]
[ "$EXECUTABLE_NAME" = "$EXEC_NAME" ]
"$CODESIGN_BIN" --verify --deep --strict "$PAYLOAD_APP"
PAYLOAD_CODESIGN=$("$CODESIGN_BIN" -dv --verbose=4 "$PAYLOAD_APP" 2>&1)
if [ "$EXPECTED_DISTRIBUTION" = "production" ]; then
  OLD_TEAM=$("$CODESIGN_BIN" -dv --verbose=4 "$INSTALL_APP" 2>&1 | /usr/bin/sed -n 's/^TeamIdentifier=//p' | /usr/bin/head -n 1)
  if [ "$OLD_TEAM" = "not set" ]; then OLD_TEAM=""; fi
  NEW_TEAM=$(printf '%s\n' "$PAYLOAD_CODESIGN" | /usr/bin/sed -n 's/^TeamIdentifier=//p' | /usr/bin/head -n 1)
  [ -n "$EXPECTED_TEAM_IDENTIFIER" ]
  [ "$NEW_TEAM" = "$EXPECTED_TEAM_IDENTIFIER" ]
  if [ -n "$OLD_TEAM" ]; then
    [ "$NEW_TEAM" = "$OLD_TEAM" ]
  fi
  printf '%s\n' "$PAYLOAD_CODESIGN" | /usr/bin/grep -q 'flags=.*runtime'
  "$SPCTL_BIN" -a -vv --type execute "$PAYLOAD_APP"
else
  [ "$EXPECTED_DISTRIBUTION" = "preview" ]
fi

/usr/bin/ditto "$PAYLOAD_APP" "$REPLACEMENT_APP"
mv "$INSTALL_APP" "$BACKUP_APP"
MOVED_ORIGINAL=1
if [ "$CROSS_NAME" -eq 1 ]; then
  mv "$REPLACEMENT_APP" "$TARGET_APP"
else
  mv "$REPLACEMENT_APP" "$INSTALL_APP"
fi
rm -f "$READY_FILE" "$SCHEMA_MARKER"

"$OPEN_BIN" -n "$TARGET_APP" --args "--mosa-update-ready-file=$READY_FILE"
i=0
while [ "$i" -lt 480 ]; do
  if [ -f "$READY_FILE" ]; then
    READY_VERSION=$(/usr/bin/plutil -extract version raw -o - "$READY_FILE")
    READY_GIT_SHA=$(/usr/bin/plutil -extract gitSha raw -o - "$READY_FILE")
    READY_UI_FINGERPRINT=$(/usr/bin/plutil -extract uiFingerprint raw -o - "$READY_FILE")
    READY_RUNTIME_FINGERPRINT=$(/usr/bin/plutil -extract runtimeFingerprint raw -o - "$READY_FILE")
    READY_DISTRIBUTION=$(/usr/bin/plutil -extract distribution raw -o - "$READY_FILE")
    [ "$READY_VERSION" = "$EXPECTED_VERSION" ]
    [ "$READY_GIT_SHA" = "$EXPECTED_GIT_SHA" ]
    [ "$READY_UI_FINGERPRINT" = "$EXPECTED_UI_FINGERPRINT" ]
    [ "$READY_RUNTIME_FINGERPRINT" = "$EXPECTED_RUNTIME_FINGERPRINT" ]
    [ "$READY_DISTRIBUTION" = "$EXPECTED_DISTRIBUTION" ]
    if [ "$CROSS_NAME" -eq 1 ]; then
      # Only after the replacement reported ready does the previous app go to
      # the Trash (never rm -rf). A Trash failure rolls the whole update back
      # while the trap is still armed, so the previous app is never lost.
      TRASH_BASE="$(basename "$CURRENT_APP_NAME" .app)"
      TRASH_NAME="$TRASH_DIR/$CURRENT_APP_NAME"
      if [ -e "$TRASH_NAME" ]; then
        n=2
        while [ -e "$TRASH_DIR/$TRASH_BASE $n.app" ]; do n=$((n + 1)); done
        TRASH_NAME="$TRASH_DIR/$TRASH_BASE $n.app"
      fi
      mkdir -p "$TRASH_DIR" 2>/dev/null || true
      mv "$BACKUP_APP" "$TRASH_NAME"
    fi
    trap - HUP INT TERM EXIT
    rm -f "$HANDOFF_FILE" 2>/dev/null || true
    rm -rf "$TRANSACTION_ROOT"
    exit 0
  fi
  if [ -z "$NEW_PID" ]; then
    NEW_PID=$(/usr/bin/pgrep -f "$TARGET_APP/Contents/MacOS/$EXEC_NAME --mosa-update-ready-file=" | /usr/bin/head -n 1 || true)
  elif ! kill -0 "$NEW_PID" 2>/dev/null; then
    exit 31
  fi
  sleep 0.25
  i=$((i + 1))
done
exit 32
`;
}

const HELPER_TOOL_OVERRIDE_KEYS = Object.freeze([
  "MOSA_UPDATE_OPEN_BIN",
  "MOSA_UPDATE_CODESIGN_BIN",
  "MOSA_UPDATE_SPCTL_BIN",
  "MOSA_UPDATE_TRASH_DIR",
]);

// The helper's tool overrides exist only for installation-rehearsal tests,
// which pass them explicitly. Never let them leak in from the app's own
// environment, or a stray variable could swap out signature verification.
export function macosUpdateHelperEnv(helperEnv = null, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of HELPER_TOOL_OVERRIDE_KEYS) delete env[key];
  return helperEnv ? { ...env, ...helperEnv } : env;
}

export async function launchMacosUpdateHelper({
  zipPath,
  installAppPath,
  version,
  expectedIdentity,
  processId,
  libraryDir,
  appName = "MOSA.app",
  expectedTeamIdentifier = "",
  helperEnv = null,
  spawnImpl = spawn,
  createUpdateHandoff = createMosaMacosUpdateHelperHandoff,
} = {}) {
  const identity = safeBuildIdentity(expectedIdentity);
  if (!zipPath || !installAppPath || !safeVersion(version) || !Number.isSafeInteger(processId) || processId <= 0 || !libraryDir) {
    throw new Error("Invalid macOS update helper arguments.");
  }
  const safeAppName = normalizeMacosUpdateAppName(appName);
  const safeTeamIdentifier = String(expectedTeamIdentifier || "").trim().toUpperCase();
  if (safeTeamIdentifier && !MACOS_TEAM_IDENTIFIER_PATTERN.test(safeTeamIdentifier)) {
    throw new Error("Invalid macOS release team identifier.");
  }
  if (identity.distribution === "production" && !safeTeamIdentifier) {
    throw new Error("macOS production updates require a release team identifier.");
  }
  const stagingDir = dirname(zipPath);
  const scriptPath = join(stagingDir, "apply-update.sh");
  const logPath = join(stagingDir, "apply-update-error.log");
  // The readiness file lives in the updater staging root under Electron
  // userData, so its path never depends on the installed app's name.
  const readyFile = join(stagingDir, "update-ready.json");
  const handoffFile = mosaDesktopStartupHandoffPath(libraryDir);
  await writeFile(scriptPath, macosUpdateHelperScript(), { encoding: "utf8", mode: 0o700 });
  const child = spawnImpl("/bin/sh", [
    scriptPath,
    String(processId),
    zipPath,
    installAppPath,
    safeVersion(version),
    identity.gitSha,
    identity.uiFingerprint,
    identity.runtimeFingerprint,
    logPath,
    readyFile,
    handoffFile,
    identity.distribution,
    safeAppName,
    safeTeamIdentifier,
  ], {
    detached: true,
    stdio: "ignore",
    env: macosUpdateHelperEnv(helperEnv),
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    child.kill?.("SIGTERM");
    throw new Error("macOS update helper did not expose a valid process id.");
  }
  try {
    await createUpdateHandoff({ libraryDir, pid: child.pid });
  } catch (error) {
    child.kill?.("SIGTERM");
    throw error;
  }
  child.unref?.();
  return { scriptPath, logPath, readyFile, handoffFile, helperPid: child.pid };
}

function readableBody(body) {
  if (!body) return null;
  if (typeof body.getReader === "function") return Readable.fromWeb(body);
  if (typeof body.pipe === "function" || body[Symbol.asyncIterator]) return body;
  return null;
}
