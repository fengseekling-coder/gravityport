import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const C2PA_HELPER_PACK_SCHEMA = "mosa.c2pa-helper-pack/1";
export const C2PA_HELPER_PACK_MANIFEST = "helper-pack.json";
export const MAX_C2PA_HELPER_PACK_BYTES = 128 * 1024 * 1024;

export function c2paHelperTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  // The Intel Mac helper pack uses the same upstream universal c2patool
  // archive as the arm64 pack; only the target directory name differs. No
  // helper pack is published for it until a release prepares one.
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return "";
}

export function c2paHelperPackRoot(userDataDir) {
  const root = String(userDataDir || "").trim();
  if (!root) throw new Error("Desktop userData directory is required for C2PA helper packs.");
  return join(resolve(root), "helper-packs", "c2patool");
}

export function validateC2paHelperPackManifest(input) {
  if (!input || input.schema !== C2PA_HELPER_PACK_SCHEMA) {
    throw helperError("INVALID_SCHEMA", "Unsupported C2PA helper pack schema.");
  }
  const id = cleanIdentifier(input.id, "id");
  if (id !== "c2patool") throw helperError("INVALID_ID", "C2PA helper pack id must be c2patool.");
  const version = cleanVersion(input.version);
  const target = String(input.target || "").trim();
  if (target !== "darwin-arm64" && target !== "darwin-x64" && target !== "win32-x64") {
    throw helperError("INVALID_TARGET", "C2PA helper target must be darwin-arm64, darwin-x64 or win32-x64.");
  }
  const executable = normalizeRelativePath(input.executable);
  const expectedName = target === "win32-x64" ? "c2patool.exe" : "c2patool";
  if (basename(executable).toLowerCase() !== expectedName) {
    throw helperError("INVALID_EXECUTABLE", `C2PA helper executable must be ${expectedName}.`);
  }
  const license = input.license && typeof input.license === "object" ? input.license : {};
  const licenseId = String(license.id || "").trim();
  const licenseSource = String(license.source || "").trim();
  if (!licenseId || !/^https:\/\//iu.test(licenseSource)) {
    throw helperError("LICENSE_INVALID", "C2PA helper license id and HTTPS source are required.");
  }
  if (!Array.isArray(input.files) || input.files.length < 2 || input.files.length > 8) {
    throw helperError("FILES_INVALID", "C2PA helper pack must contain 2-8 files.");
  }
  const seen = new Set();
  const files = input.files.map((entry) => {
    const path = normalizeRelativePath(entry?.path);
    if (seen.has(path)) throw helperError("DUPLICATE_FILE", "C2PA helper pack file paths must be unique.");
    seen.add(path);
    const sha256 = String(entry?.sha256 || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw helperError("INVALID_SHA256", "C2PA helper file SHA-256 is invalid.");
    const bytes = Number(entry?.bytes);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw helperError("INVALID_SIZE", "C2PA helper file size is invalid.");
    const role = String(entry?.role || "").trim();
    if (!role) throw helperError("INVALID_ROLE", "C2PA helper file role is required.");
    return Object.freeze({ path, sha256, bytes, role });
  });
  const binary = files.find((entry) => entry.path === executable && entry.role === "executable");
  if (!binary) throw helperError("EXECUTABLE_MISSING", "C2PA helper manifest does not pin the executable file.");
  if (!files.some((entry) => entry.role === "license" || entry.role === "notice")) {
    throw helperError("LICENSE_FILE_MISSING", "C2PA helper pack must include license or notice material.");
  }
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > MAX_C2PA_HELPER_PACK_BYTES) throw helperError("PACK_TOO_LARGE", "C2PA helper pack exceeds 128 MiB.");
  return Object.freeze({
    schema: C2PA_HELPER_PACK_SCHEMA,
    id,
    version,
    target,
    executable,
    upstream: String(input.upstream || "").trim(),
    license: Object.freeze({ id: licenseId, source: licenseSource }),
    files: Object.freeze(files),
    total_bytes: totalBytes,
  });
}

export async function verifyC2paHelperPack({ packDir, platform = process.platform, arch = process.arch } = {}) {
  const raw = String(packDir || "").trim();
  if (!raw) throw helperError("PACK_DIR_REQUIRED", "C2PA helper pack directory is required.");
  const root = resolve(raw);
  const manifest = validateC2paHelperPackManifest(JSON.parse(await readFile(join(root, C2PA_HELPER_PACK_MANIFEST), "utf8")));
  const hostTarget = c2paHelperTarget(platform, arch);
  if (hostTarget && manifest.target !== hostTarget) {
    throw helperError("HOST_MISMATCH", `C2PA helper targets ${manifest.target}, current host is ${hostTarget}.`);
  }
  const rootReal = await realpath(root);
  const checked = [];
  for (const entry of manifest.files) {
    const absolute = resolve(root, entry.path);
    assertContained(root, absolute, entry.path);
    const linkInfo = await lstat(absolute);
    if (linkInfo.isSymbolicLink()) throw helperError("SYMLINK_REJECTED", `C2PA helper file must not be a symlink: ${entry.path}`);
    if (!linkInfo.isFile()) throw helperError("NOT_A_FILE", `C2PA helper entry is not a regular file: ${entry.path}`);
    const real = await realpath(absolute);
    assertContained(rootReal, real, entry.path);
    const info = await stat(real);
    if (info.size !== entry.bytes) throw helperError("SIZE_MISMATCH", `C2PA helper file size mismatch: ${entry.path}`);
    if (await sha256File(real) !== entry.sha256) throw helperError("HASH_MISMATCH", `C2PA helper SHA-256 mismatch: ${entry.path}`);
    checked.push({ ...entry, absolute_path: real });
  }
  const executable = checked.find((entry) => entry.path === manifest.executable);
  return Object.freeze({
    ok: true,
    ...manifest,
    files: checked,
    executable_path: executable.absolute_path,
    pack_dir: rootReal,
  });
}

// Pack directories are named `<version>-<target>` (e.g. `0.28.0-darwin-arm64`,
// `0.28.0-rc.1-darwin-arm64`). Plain descending locale sort puts `rc` above the
// stable release of the same version, so resolution picks release candidates
// over stable builds. Compare the version part with release>prerelease
// semantics instead; non-conforming names keep the locale order.
const PACK_DIRECTORY_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?-(.+)$/;

function comparePackVersionPart(left, right) {
  const leftMatch = PACK_DIRECTORY_PATTERN.exec(left);
  const rightMatch = PACK_DIRECTORY_PATTERN.exec(right);
  if (!leftMatch || !rightMatch) return left.localeCompare(right, undefined, { numeric: true });
  for (let index = 1; index <= 3; index += 1) {
    if (leftMatch[index] !== rightMatch[index]) return Number(leftMatch[index]) - Number(rightMatch[index]);
  }
  const leftPre = leftMatch[4] ? leftMatch[4].split(".") : [];
  const rightPre = rightMatch[4] ? rightMatch[4].split(".") : [];
  if (!leftPre.length && !rightPre.length) return 0;
  if (!leftPre.length) return 1;
  if (!rightPre.length) return -1;
  for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index += 1) {
    const a = leftPre[index];
    const b = rightPre[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) - Number(b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

export async function discoverC2paHelperPacks({ userDataDir, platform = process.platform, arch = process.arch } = {}) {
  const root = c2paHelperPackRoot(userDataDir);
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const packs = [];
  const invalid = [];
  for (const entry of entries.sort((a, b) => -comparePackVersionPart(a.name, b.name))) {
    if (!entry.isDirectory()) continue;
    const packDir = join(root, entry.name);
    try {
      packs.push(await verifyC2paHelperPack({ packDir, platform, arch }));
    } catch (error) {
      invalid.push({ directory: entry.name, code: String(error?.code || "C2PA_HELPER_INVALID"), message: String(error?.message || error) });
    }
  }
  return { root, packs, invalid };
}

export async function resolveInstalledC2paToolPath(options = {}) {
  const discovery = await discoverC2paHelperPacks(options);
  return discovery.packs[0]?.executable_path || "";
}

function cleanIdentifier(value, field) {
  const candidate = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(candidate)) throw helperError("INVALID_IDENTIFIER", `C2PA helper ${field} is invalid.`);
  return candidate;
}

function cleanVersion(value) {
  const version = String(value || "").trim().replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu.test(version)) throw helperError("INVALID_VERSION", "C2PA helper version is invalid.");
  return version;
}

function normalizeRelativePath(value) {
  const candidate = String(value || "").trim().replaceAll("\\", "/");
  if (!candidate || isAbsolute(candidate) || candidate.startsWith("/") || candidate.includes("\0")) {
    throw helperError("INVALID_PATH", "C2PA helper file path must be relative.");
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw helperError("INVALID_PATH", "C2PA helper file path must not contain traversal or empty segments.");
  }
  return segments.join("/");
}

function assertContained(root, candidate, display) {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw helperError("PATH_ESCAPE", `C2PA helper file escapes the pack directory: ${display}`);
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function helperError(code, message) {
  const error = new Error(message);
  error.code = `C2PA_HELPER_${code}`;
  return error;
}
