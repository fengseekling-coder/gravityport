import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  C2PA_HELPER_PACK_MANIFEST,
  MAX_C2PA_HELPER_PACK_BYTES,
  c2paHelperPackRoot,
  c2paHelperTarget,
  validateC2paHelperPackManifest,
  verifyC2paHelperPack,
} from "../lib/c2pa-helper-pack.mjs";
import { verifyReleaseManifestSignature } from "../lib/release-manifest-signature.mjs";
import { MOSA_UPDATE_FEED_URL } from "./update-service.mjs";

export const MOSA_C2PA_HELPER_DOWNLOAD_BASE_URL = "https://gravityport.azhuilab.com/downloads/helper-packs/c2patool/";

const RELEASE_MANIFEST_MAX_BYTES = 64 * 1024;
const HELPER_MANIFEST_MAX_BYTES = 64 * 1024;
const INSTALL_HEADROOM_BYTES = 16 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function parseC2paHelperReleaseManifest(input, { platform = process.platform, arch = process.arch } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw installerError("RELEASE_INVALID", "Invalid GravityPort release manifest.");
  const target = c2paHelperTarget(platform, arch);
  if (!target) return null;
  const raw = input.helperPacks?.c2patool?.[target];
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw installerError("RELEASE_INVALID", "Invalid C2PA helper release metadata.");
  const version = String(raw.version || "").trim().replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu.test(version)) throw installerError("RELEASE_INVALID", "C2PA helper version is invalid.");
  const manifestSize = Number(raw.manifest?.size);
  const manifestSha256 = String(raw.manifest?.sha256 || "").trim().toLowerCase();
  const totalSize = Number(raw.totalSize);
  const licenseId = String(raw.license?.id || "").trim();
  const licenseSource = String(raw.license?.source || "").trim();
  if (!Number.isSafeInteger(manifestSize) || manifestSize <= 0 || manifestSize > HELPER_MANIFEST_MAX_BYTES) {
    throw installerError("RELEASE_INVALID", "C2PA helper manifest size is invalid.");
  }
  if (!SHA256_PATTERN.test(manifestSha256)) throw installerError("RELEASE_INVALID", "C2PA helper manifest SHA-256 is invalid.");
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0 || totalSize > MAX_C2PA_HELPER_PACK_BYTES) {
    throw installerError("RELEASE_INVALID", "C2PA helper payload size is invalid.");
  }
  if (!licenseId || !/^https:\/\//iu.test(licenseSource)) throw installerError("RELEASE_INVALID", "C2PA helper license metadata is invalid.");
  return Object.freeze({
    id: "c2patool",
    version,
    platform,
    arch,
    target,
    total_size: totalSize,
    manifest: Object.freeze({ size: manifestSize, sha256: manifestSha256 }),
    license: Object.freeze({ id: licenseId, source: licenseSource }),
  });
}

export async function checkForC2paHelperRelease({
  platform = process.platform,
  arch = process.arch,
  releaseManifestTrust,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) {
  const target = c2paHelperTarget(platform, arch);
  if (!target) return { supported: false, release: null };
  // The release manifest lists download sizes and hashes; trusting an
  // unsigned one would let a tampered feed pin arbitrary "verified" files.
  // Verification is therefore mandatory, not an optional hardening step.
  // Accepts one trusted key or a list (primary + backup); the signature's keyId picks the key.
  const trusts = [releaseManifestTrust].flat().filter(Boolean);
  if (!trusts.length) {
    throw installerError("TRUST_REQUIRED", "C2PA helper release check requires signed release manifest trust (from the build identity).");
  }
  if (typeof fetchImpl !== "function") throw installerError("FETCH_UNAVAILABLE", "C2PA helper release fetch is unavailable.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 8_000));
  timeout.unref?.();
  try {
    const response = await fetchImpl(MOSA_UPDATE_FEED_URL, {
      method: "GET",
      headers: { accept: "application/json", "cache-control": "no-cache" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) throw installerError("FETCH_FAILED", `C2PA helper release check returned HTTP ${response?.status || 0}.`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > RELEASE_MANIFEST_MAX_BYTES) throw installerError("RELEASE_INVALID", "GravityPort release manifest is too large.");
    const document = JSON.parse(text);
    verifyReleaseManifestSignature(document, trusts);
    return { supported: true, release: parseC2paHelperReleaseManifest(document, { platform, arch }) };
  } finally {
    clearTimeout(timeout);
  }
}

export function c2paHelperDownloadUrl(release, relativePath = C2PA_HELPER_PACK_MANIFEST) {
  const version = String(release?.version || "").trim().replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu.test(version)) throw installerError("VERSION_INVALID", "C2PA helper version is invalid.");
  const target = String(release?.target || c2paHelperTarget(release?.platform, release?.arch));
  if (target !== "darwin-arm64" && target !== "win32-x64") throw installerError("TARGET_INVALID", "Unsupported C2PA helper target.");
  const safePath = safeRelativePath(relativePath);
  const encodedPath = safePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return new URL(`${encodeURIComponent(version)}/${target}/${encodedPath}`, MOSA_C2PA_HELPER_DOWNLOAD_BASE_URL).toString();
}

export async function installC2paHelperPack({
  userDataDir,
  release,
  fetchImpl = globalThis.fetch,
  signal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  statfsImpl = statfs,
  onProgress = () => {},
} = {}) {
  const baseDir = String(userDataDir || "").trim();
  if (!baseDir) throw installerError("USER_DATA_REQUIRED", "C2PA helper installation requires Electron userData.");
  if (typeof fetchImpl !== "function") throw installerError("FETCH_UNAVAILABLE", "C2PA helper download is unavailable.");
  const safeRelease = parseC2paHelperReleaseManifest({
    helperPacks: { c2patool: { [release?.target || ""]: releaseToManifestValue(release) } },
  }, { platform: release?.platform, arch: release?.arch });
  if (!safeRelease) throw installerError("TARGET_INVALID", "C2PA helper target is unsupported.");

  const root = c2paHelperPackRoot(baseDir);
  const stagingRoot = join(baseDir, "helper-pack-staging", "c2patool");
  const transactionName = `${safeRelease.version}-${safeRelease.target}`;
  const transactionRoot = join(stagingRoot, transactionName);
  const stagingDir = join(transactionRoot, "installing");
  const backupDir = join(transactionRoot, "previous");
  const targetDir = join(root, transactionName);
  await mkdir(root, { recursive: true });
  await mkdir(transactionRoot, { recursive: true });
  await recoverInterruptedSwap({ targetDir, backupDir, platform: safeRelease.platform, arch: safeRelease.arch });
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const expectedTotal = safeRelease.total_size + safeRelease.manifest.size;
  await assertDiskSpace({ baseDir, requiredBytes: expectedTotal + INSTALL_HEADROOM_BYTES, statfsImpl });
  let completedBytes = 0;
  const report = (phase, currentFile = "") => onProgress({
    phase,
    currentFile,
    receivedBytes: completedBytes,
    totalBytes: expectedTotal,
    percent: expectedTotal > 0 ? Math.min(100, Math.floor((completedBytes / expectedTotal) * 100)) : 0,
  });

  try {
    const manifestPath = join(stagingDir, C2PA_HELPER_PACK_MANIFEST);
    report("downloading", C2PA_HELPER_PACK_MANIFEST);
    await downloadPinnedFile({
      url: c2paHelperDownloadUrl(safeRelease),
      destination: manifestPath,
      size: safeRelease.manifest.size,
      sha256: safeRelease.manifest.sha256,
      fetchImpl,
      signal,
      idleTimeoutMs,
      onBytes: (delta) => { completedBytes += delta; report("downloading", C2PA_HELPER_PACK_MANIFEST); },
    });
    const manifest = validateC2paHelperPackManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    if (
      manifest.version !== safeRelease.version
      || manifest.target !== safeRelease.target
      || manifest.total_bytes !== safeRelease.total_size
      || manifest.license.id !== safeRelease.license.id
      || manifest.license.source !== safeRelease.license.source
    ) {
      throw installerError("IDENTITY_MISMATCH", "C2PA helper manifest does not match release metadata.");
    }

    for (const file of manifest.files) {
      const destination = join(stagingDir, ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      report("downloading", file.path);
      await downloadPinnedFile({
        url: c2paHelperDownloadUrl(safeRelease, file.path),
        destination,
        size: file.bytes,
        sha256: file.sha256,
        fetchImpl,
        signal,
        idleTimeoutMs,
        onBytes: (delta) => { completedBytes += delta; report("downloading", file.path); },
      });
    }
    if (safeRelease.platform === "darwin") await chmod(join(stagingDir, manifest.executable), 0o755);
    report("verifying");
    await verifyC2paHelperPack({ packDir: stagingDir, platform: safeRelease.platform, arch: safeRelease.arch });

    report("installing");
    await rm(backupDir, { recursive: true, force: true });
    if (await pathExists(targetDir)) await rename(targetDir, backupDir);
    try {
      await rename(stagingDir, targetDir);
      const installed = await verifyC2paHelperPack({ packDir: targetDir, platform: safeRelease.platform, arch: safeRelease.arch });
      await rm(backupDir, { recursive: true, force: true });
      await rm(transactionRoot, { recursive: true, force: true });
      completedBytes = expectedTotal;
      report("complete");
      return installed;
    } catch (error) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {});
      if (await pathExists(backupDir)) {
        try {
          await rename(backupDir, targetDir);
        } catch (restoreError) {
          // Swallowing the restore failure would leave no installed pack and a
          // stranded backup with no surfaced cause; report both failures and
          // where the backup still lives so it can be recovered by hand.
          throw installerError(
            "RESTORE_FAILED",
            `C2PA helper install failed (${error?.message || error}) and the previous pack could not be restored (${restoreError?.message || restoreError}). The backup is preserved at ${backupDir}.`,
          );
        }
      }
      throw error;
    }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (!(await pathExists(backupDir))) await rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function downloadPinnedFile({ url, destination, size, sha256, fetchImpl, signal, idleTimeoutMs, onBytes }) {
  const controller = new AbortController();
  let source = null;
  let idleTimer = null;
  let timedOut = false;
  const arm = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      const error = installerError("DOWNLOAD_TIMEOUT", "C2PA helper download stalled.");
      controller.abort(error);
      source?.destroy?.(error);
    }, Math.max(1000, Number(idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS));
    idleTimer.unref?.();
  };
  const abortFromCaller = () => {
    const reason = signal?.reason instanceof Error ? signal.reason : installerError("DOWNLOAD_CANCELLED", "C2PA helper download cancelled.");
    controller.abort(reason);
    source?.destroy?.(reason);
  };
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.("abort", abortFromCaller, { once: true });
  arm();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/octet-stream, application/json", "accept-encoding": "identity", "cache-control": "no-cache" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) throw installerError("DOWNLOAD_FAILED", `C2PA helper download returned HTTP ${response?.status || 0}.`);
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (contentLength > 0 && contentLength !== size) throw installerError("SIZE_MISMATCH", "C2PA helper download size does not match the release manifest.");
    source = readableBody(response.body);
    if (!source) throw installerError("DOWNLOAD_FAILED", "C2PA helper response has no readable body.");
    const hash = createHash("sha256");
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        arm();
        received += chunk.length;
        if (received > size) return callback(installerError("SIZE_MISMATCH", "C2PA helper file exceeded its expected size."));
        hash.update(chunk);
        onBytes?.(chunk.length);
        callback(null, chunk);
      },
    });
    await pipeline(source, meter, createWriteStream(destination, { flags: "wx" }));
    if (received !== size) throw installerError("SIZE_MISMATCH", "C2PA helper file download is incomplete.");
    if (hash.digest("hex") !== sha256) throw installerError("HASH_MISMATCH", "C2PA helper SHA-256 verification failed.");
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {});
    if (timedOut && error?.code !== "C2PA_HELPER_INSTALL_DOWNLOAD_TIMEOUT") throw installerError("DOWNLOAD_TIMEOUT", "C2PA helper download stalled.");
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener?.("abort", abortFromCaller);
  }
}

async function recoverInterruptedSwap({ targetDir, backupDir, platform, arch }) {
  if (!(await pathExists(backupDir))) return;
  if (!(await pathExists(targetDir))) {
    await verifyC2paHelperPack({ packDir: backupDir, platform, arch });
    await rename(backupDir, targetDir);
    return;
  }
  let installedError = null;
  try {
    await verifyC2paHelperPack({ packDir: targetDir, platform, arch });
  } catch (error) {
    installedError = error;
  }
  if (!installedError) {
    await rm(backupDir, { recursive: true, force: true });
    return;
  }
  try {
    await verifyC2paHelperPack({ packDir: backupDir, platform, arch });
  } catch (backupError) {
    // Neither directory verifies: the helper is corrupt beyond automatic
    // recovery. Leaving them in place would make every future install abort
    // at this same check; clear both so the next install starts clean.
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    throw installerError(
      "RECOVERY_FAILED",
      `C2PA helper pack is corrupt beyond automatic recovery (installed: ${installedError?.message || installedError}; backup: ${backupError?.message || backupError}). Both copies were removed; run the installer again.`,
    );
  }
  await rm(targetDir, { recursive: true, force: true });
  await rename(backupDir, targetDir);
}

async function assertDiskSpace({ baseDir, requiredBytes, statfsImpl }) {
  if (typeof statfsImpl !== "function") return;
  const info = await statfsImpl(baseDir);
  const available = Number(info?.bavail ?? info?.bfree ?? 0) * Number(info?.bsize ?? 0);
  if (Number.isFinite(available) && available > 0 && available < requiredBytes) {
    const error = installerError("DISK_SPACE", "Not enough free disk space to install the C2PA helper safely.");
    error.required_bytes = requiredBytes;
    error.available_bytes = available;
    throw error;
  }
}

function releaseToManifestValue(release) {
  return {
    version: release?.version,
    totalSize: release?.total_size ?? release?.totalSize,
    manifest: release?.manifest,
    license: release?.license,
  };
}

function readableBody(body) {
  if (!body) return null;
  if (typeof body.getReader === "function") return Readable.fromWeb(body);
  if (typeof body.pipe === "function" || body[Symbol.asyncIterator]) return body;
  return null;
}

function safeRelativePath(value) {
  const path = String(value || "").trim().replaceAll("\\", "/");
  const segments = path.split("/");
  if (!path || path.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw installerError("PATH_INVALID", "C2PA helper download path is invalid.");
  }
  return segments.join("/");
}

async function pathExists(path) {
  return Boolean(await stat(path).catch(() => null));
}

function installerError(code, message) {
  const error = new Error(message);
  error.code = `C2PA_HELPER_INSTALL_${code}`;
  return error;
}
