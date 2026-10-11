import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  discoverVisualModelPacks,
  MAX_VISUAL_MODEL_PACK_BYTES,
  validateVisualModelPackManifest,
  verifyVisualModelPack,
  visualModelPackRoot,
} from "../lib/visual-model-pack.mjs";
import { MOSA_UPDATE_FEED_URL } from "./update-service.mjs";
import { verifyReleaseManifestSignature } from "../lib/release-manifest-signature.mjs";

export const MOSA_VISUAL_PACK_DOWNLOAD_BASE_URL = "https://mosa.azhuilab.com/downloads/visual-packs/";

const RELEASE_MANIFEST_MAX_BYTES = 64 * 1024;
const MODEL_MANIFEST_MAX_BYTES = 256 * 1024;
const INSTALL_HEADROOM_BYTES = 64 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function visualPackTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return "";
}

export function parseVisualPackReleaseManifest(input, { platform = process.platform, arch = process.arch } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw visualPackError("RELEASE_INVALID", "Invalid GravityPort release manifest.");
  const target = visualPackTarget(platform, arch);
  if (!target) return null;
  const raw = input.visualPacks?.[target];
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw visualPackError("RELEASE_INVALID", "Invalid Visual Pack release metadata.");
  const id = cleanIdentifier(raw.id, "id");
  const revision = cleanIdentifier(raw.revision, "revision");
  const manifestSize = Number(raw.manifest?.size);
  const manifestSha256 = String(raw.manifest?.sha256 || "").trim().toLowerCase();
  const totalSize = Number(raw.totalSize);
  const licenseId = String(raw.license?.id || "").trim().slice(0, 80);
  const licenseSource = String(raw.license?.source || "").trim();
  if (!Number.isSafeInteger(manifestSize) || manifestSize <= 0 || manifestSize > MODEL_MANIFEST_MAX_BYTES) {
    throw visualPackError("RELEASE_INVALID", "Visual Pack manifest size is invalid.");
  }
  if (!SHA256_PATTERN.test(manifestSha256)) throw visualPackError("RELEASE_INVALID", "Visual Pack manifest SHA-256 is invalid.");
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0 || totalSize > MAX_VISUAL_MODEL_PACK_BYTES) {
    throw visualPackError("RELEASE_INVALID", "Visual Pack download size is invalid.");
  }
  if (!licenseId || !/^https:\/\//i.test(licenseSource)) {
    throw visualPackError("RELEASE_INVALID", "Visual Pack release license metadata is invalid.");
  }
  return Object.freeze({
    id,
    revision,
    platform,
    arch,
    target,
    total_size: totalSize,
    manifest: Object.freeze({ size: manifestSize, sha256: manifestSha256 }),
    license: Object.freeze({ id: licenseId, source: licenseSource }),
  });
}

export async function checkForVisualPackRelease({
  platform = process.platform,
  arch = process.arch,
  releaseManifestTrust = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) {
  const target = visualPackTarget(platform, arch);
  if (!target) return { supported: false, release: null };
  if (typeof fetchImpl !== "function") throw visualPackError("FETCH_UNAVAILABLE", "Visual Pack update fetch is unavailable.");
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
    if (!response?.ok) throw visualPackError("FETCH_FAILED", `Visual Pack release check returned HTTP ${response?.status || 0}.`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > RELEASE_MANIFEST_MAX_BYTES) throw visualPackError("RELEASE_INVALID", "GravityPort release manifest is too large.");
    const document = JSON.parse(text);
    if (releaseManifestTrust) verifyReleaseManifestSignature(document, releaseManifestTrust);
    return { supported: true, release: parseVisualPackReleaseManifest(document, { platform, arch }) };
  } finally {
    clearTimeout(timeout);
  }
}

export function visualPackDownloadUrl(release, relativePath = "model-pack.json") {
  const id = cleanIdentifier(release?.id, "id");
  const revision = cleanIdentifier(release?.revision, "revision");
  const target = String(release?.target || visualPackTarget(release?.platform, release?.arch));
  if (target !== "darwin-arm64" && target !== "win32-x64") throw visualPackError("TARGET_INVALID", "Unsupported Visual Pack target.");
  const safePath = safeRelativePath(relativePath);
  const encodedPath = safePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return new URL(`${encodeURIComponent(id)}/${encodeURIComponent(revision)}/${target}/${encodedPath}`, MOSA_VISUAL_PACK_DOWNLOAD_BASE_URL).toString();
}

export async function installVisualPack({
  userDataDir,
  release,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  signal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  statfsImpl = statfs,
} = {}) {
  const baseDir = String(userDataDir || "").trim();
  if (!baseDir) throw visualPackError("USER_DATA_REQUIRED", "Visual Pack installation requires Electron userData.");
  if (typeof fetchImpl !== "function") throw visualPackError("FETCH_UNAVAILABLE", "Visual Pack download is unavailable.");
  const safeRelease = parseVisualPackReleaseManifest({ visualPacks: { [release?.target || ""]: releaseToManifestValue(release) } }, {
    platform: release?.platform,
    arch: release?.arch,
  });
  if (!safeRelease) throw visualPackError("TARGET_INVALID", "Visual Pack target is unsupported.");

  const packRoot = visualModelPackRoot(baseDir);
  const stagingRoot = join(baseDir, "visual-pack-staging");
  const transactionName = `${safeRelease.id}-${safeRelease.revision}-${safeRelease.target}`;
  const transactionRoot = join(stagingRoot, transactionName);
  const stagingDir = join(transactionRoot, "installing");
  const backupDir = join(transactionRoot, "previous");
  const targetDir = join(packRoot, transactionName);
  await mkdir(packRoot, { recursive: true });
  await mkdir(transactionRoot, { recursive: true });
  await recoverInterruptedSwap({ targetDir, backupDir });
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const expectedTotal = safeRelease.total_size + safeRelease.manifest.size;
  await assertDiskSpace({ baseDir, requiredBytes: expectedTotal + INSTALL_HEADROOM_BYTES, statfsImpl });
  let completedBytes = 0;
  const report = (phase, currentFile = "") => {
    const percent = expectedTotal > 0 ? Math.min(100, Math.floor((completedBytes / expectedTotal) * 100)) : 0;
    onProgress({ phase, currentFile, receivedBytes: completedBytes, totalBytes: expectedTotal, percent });
  };

  try {
    report("downloading", "model-pack.json");
    const manifestPath = join(stagingDir, "model-pack.json");
    await downloadPinnedFile({
      url: visualPackDownloadUrl(safeRelease, "model-pack.json"),
      destination: manifestPath,
      size: safeRelease.manifest.size,
      sha256: safeRelease.manifest.sha256,
      fetchImpl,
      signal,
      idleTimeoutMs,
      onBytes: (delta) => {
        completedBytes += delta;
        report("downloading", "model-pack.json");
      },
    });
    const manifest = validateVisualModelPackManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    assertManifestMatchesRelease(manifest, safeRelease);

    for (const file of manifest.files) {
      const destination = join(stagingDir, ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      report("downloading", file.path);
      await downloadPinnedFile({
        url: visualPackDownloadUrl(safeRelease, file.path),
        destination,
        size: file.bytes,
        sha256: file.sha256,
        fetchImpl,
        signal,
        idleTimeoutMs,
        onBytes: (delta) => {
          completedBytes += delta;
          report("downloading", file.path);
        },
      });
    }

    report("verifying");
    const verifiedStaging = await verifyVisualModelPack({ packDir: stagingDir });
    if (verifiedStaging.id !== safeRelease.id || verifiedStaging.revision !== safeRelease.revision) {
      throw visualPackError("IDENTITY_MISMATCH", "Downloaded Visual Pack identity changed during verification.");
    }

    report("installing");
    await rm(backupDir, { recursive: true, force: true });
    if (await pathExists(targetDir)) await rename(targetDir, backupDir);
    try {
      await rename(stagingDir, targetDir);
      const installed = await verifyVisualModelPack({ packDir: targetDir });
      await rm(backupDir, { recursive: true, force: true });
      await rm(transactionRoot, { recursive: true, force: true });
      completedBytes = expectedTotal;
      report("complete");
      return installed;
    } catch (error) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {});
      if (await pathExists(backupDir)) await rename(backupDir, targetDir).catch(() => {});
      throw error;
    }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (!(await pathExists(backupDir))) await rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function cleanupVisualPackStaging({ userDataDir } = {}) {
  const baseDir = String(userDataDir || "").trim();
  if (!baseDir) throw visualPackError("USER_DATA_REQUIRED", "Visual Pack staging cleanup requires Electron userData.");
  const packRoot = visualModelPackRoot(baseDir);
  const stagingRoot = join(baseDir, "visual-pack-staging");
  const entries = await readdir(stagingRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  let recovered = 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const transactionRoot = join(stagingRoot, entry.name);
    const targetDir = join(packRoot, entry.name);
    const backupDir = join(transactionRoot, "previous");
    const stagingDir = join(transactionRoot, "installing");
    if (await pathExists(backupDir)) {
      await recoverInterruptedSwap({ targetDir, backupDir });
      recovered += 1;
    }
    await rm(stagingDir, { recursive: true, force: true });
    await rm(transactionRoot, { recursive: true, force: true });
    removed += 1;
  }
  return { recovered, removed };
}

export async function removeVisualPack({ userDataDir, id } = {}) {
  const baseDir = String(userDataDir || "").trim();
  if (!baseDir) throw visualPackError("USER_DATA_REQUIRED", "Visual Pack removal requires Electron userData.");
  const safeId = cleanIdentifier(id, "id");
  const discovery = await discoverVisualModelPacks({ userDataDir: baseDir });
  const matching = discovery.packs.filter((pack) => pack.id === safeId);
  for (const pack of matching) await rm(pack.pack_dir, { recursive: true, force: true });
  return { ok: true, id: safeId, removed: matching.length };
}

async function downloadPinnedFile({ url, destination, size, sha256, fetchImpl, signal, idleTimeoutMs, onBytes }) {
  const controller = new AbortController();
  let source = null;
  let idleTimer = null;
  let timedOut = false;
  const timeoutMs = Math.max(1000, Number(idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS);
  const timeoutError = () => visualPackError("DOWNLOAD_TIMEOUT", "Visual Pack download stalled.");
  const armIdleTimeout = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      const error = timeoutError();
      controller.abort(error);
      source?.destroy?.(error);
    }, timeoutMs);
    idleTimer.unref?.();
  };
  const abortFromCaller = () => {
    const reason = signal?.reason instanceof Error ? signal.reason : visualPackError("DOWNLOAD_CANCELLED", "Visual Pack download cancelled.");
    controller.abort(reason);
    source?.destroy?.(reason);
  };
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.("abort", abortFromCaller, { once: true });
  armIdleTimeout();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      // Static model assets must arrive byte-for-byte as published so declared
      // Content-Length and SHA-256 values remain meaningful.
      headers: { accept: "application/octet-stream, application/json", "accept-encoding": "identity", "cache-control": "no-cache" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) throw visualPackError("DOWNLOAD_FAILED", `Visual Pack download returned HTTP ${response?.status || 0}.`);
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== size) {
      throw visualPackError("SIZE_MISMATCH", "Visual Pack download size does not match the release manifest.");
    }
    source = readableBody(response.body);
    if (!source) throw visualPackError("DOWNLOAD_FAILED", "Visual Pack response has no readable body.");
    const hash = createHash("sha256");
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        armIdleTimeout();
        received += chunk.length;
        if (received > size) return callback(visualPackError("SIZE_MISMATCH", "Visual Pack file exceeded its expected size."));
        hash.update(chunk);
        onBytes?.(chunk.length);
        callback(null, chunk);
      },
    });
    await pipeline(source, meter, createWriteStream(destination, { flags: "wx" }));
    if (received !== size) throw visualPackError("SIZE_MISMATCH", "Visual Pack file download is incomplete.");
    if (hash.digest("hex") !== sha256) throw visualPackError("HASH_MISMATCH", "Visual Pack SHA-256 verification failed.");
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {});
    if (timedOut && error?.code !== "VISUAL_PACK_DOWNLOAD_TIMEOUT") throw timeoutError();
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener?.("abort", abortFromCaller);
  }
}

function assertManifestMatchesRelease(manifest, release) {
  if (manifest.id !== release.id || manifest.revision !== release.revision) {
    throw visualPackError("IDENTITY_MISMATCH", "Visual Pack manifest identity does not match the release metadata.");
  }
  if (manifest.total_bytes !== release.total_size) {
    throw visualPackError("SIZE_MISMATCH", "Visual Pack total size does not match the release metadata.");
  }
  if (!manifest.runtime || manifest.runtime.platform !== release.platform || manifest.runtime.arch !== release.arch) {
    throw visualPackError("TARGET_MISMATCH", "Visual Pack runtime does not match this platform.");
  }
}

async function assertDiskSpace({ baseDir, requiredBytes, statfsImpl }) {
  if (typeof statfsImpl !== "function") return;
  const info = await statfsImpl(baseDir);
  const available = Number(info?.bavail ?? info?.bfree ?? 0) * Number(info?.bsize ?? 0);
  if (Number.isFinite(available) && available > 0 && available < requiredBytes) {
    const error = visualPackError("DISK_SPACE", "Not enough free disk space to install the Visual Pack safely.");
    error.required_bytes = requiredBytes;
    error.available_bytes = available;
    throw error;
  }
}

async function recoverInterruptedSwap({ targetDir, backupDir }) {
  const hasTarget = await pathExists(targetDir);
  const hasBackup = await pathExists(backupDir);
  if (!hasBackup) return;
  if (!hasTarget) {
    await verifyVisualModelPack({ packDir: backupDir });
    await rename(backupDir, targetDir);
    return;
  }
  try {
    await verifyVisualModelPack({ packDir: targetDir });
    await rm(backupDir, { recursive: true, force: true });
  } catch {
    try {
      await verifyVisualModelPack({ packDir: backupDir });
      await rm(targetDir, { recursive: true, force: true });
      await rename(backupDir, targetDir);
    } catch (backupError) {
      throw visualPackError("RECOVERY_FAILED", `Visual Pack recovery failed: ${backupError?.message || backupError}`);
    }
  }
}

function releaseToManifestValue(release) {
  return {
    id: release?.id,
    revision: release?.revision,
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
    throw visualPackError("PATH_INVALID", "Visual Pack download path is invalid.");
  }
  return segments.join("/");
}

function cleanIdentifier(value, field) {
  const candidate = String(value || "").trim();
  if (!IDENTIFIER_PATTERN.test(candidate)) throw visualPackError("IDENTITY_INVALID", `Visual Pack ${field} is invalid.`);
  return candidate;
}

async function pathExists(path) {
  return Boolean(await stat(path).catch(() => null));
}

function visualPackError(code, message) {
  const error = new Error(message);
  error.code = `VISUAL_PACK_${code}`;
  return error;
}
