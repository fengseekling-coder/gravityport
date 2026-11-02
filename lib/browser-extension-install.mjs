import { createHash, randomUUID as defaultRandomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

const MARKER = "gravityport-managed.json";
const SAFE_REMOVABLE_EXTENSIONS = new Set([".js", ".css", ".html", ".json", ".png"]);
const WINDOWS_LOCK_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function managedExtensionPaths(userDataDir) {
  const userData = String(userDataDir || "").trim();
  if (!userData) throw new Error("Desktop userData directory is required for the managed browser extension");
  const root = join(resolve(userData), "browser-extension");
  return { root, target: join(root, "chrome") };
}

// Mirrors the card's numeric, dotted-segment comparison; invalid versions
// compare as null and can never trigger an extension reload or a downgrade.
export function compareManagedExtensionVersions(left, right) {
  const parse = (value) => {
    const parts = String(value || "").trim().split(".");
    return parts.length && parts.every((part) => /^\d+$/.test(part)) ? parts.map(Number) : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function readJson(path, fs) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function markerAt(target, fs) {
  const marker = await readJson(join(target, MARKER), fs);
  return marker && typeof marker === "object" && !Array.isArray(marker) ? marker : null;
}

async function readInstallation(target, fs) {
  const [manifest, marker] = await Promise.all([
    readJson(join(target, "manifest.json"), fs),
    markerAt(target, fs),
  ]);
  if (!manifest || !marker || marker.schema !== 1 ||
      typeof marker.installId !== "string" || !marker.installId.trim() ||
      typeof marker.installedAt !== "string" || !Number.isFinite(Date.parse(marker.installedAt)) ||
      typeof manifest.version !== "string" ||
      compareManagedExtensionVersions(manifest.version, manifest.version) === null ||
      marker.version !== manifest.version) return null;
  return { version: manifest.version, installId: marker.installId, path: target };
}

export async function readManagedExtension(targetDir) {
  try {
    return await readInstallation(targetDir, nodeFs);
  } catch {
    return null;
  }
}

async function pathExists(path, fs) {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function filesWithin(dir, fs, prefix = "") {
  const names = await fs.readdir(join(dir, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of names) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesWithin(dir, fs, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unsafe browser extension file type: ${path}`);
  }
  return files.sort();
}

async function filesMatch(sourceDir, targetDir, fs) {
  const files = await filesWithin(sourceDir, fs);
  for (const file of files) {
    const [left, right] = await Promise.all([
      fs.readFile(join(sourceDir, file)),
      fs.readFile(join(targetDir, file)).catch(() => null),
    ]);
    if (!right || createHash("sha256").update(left).digest("hex") !== createHash("sha256").update(right).digest("hex")) {
      return false;
    }
  }
  return true;
}

async function writeInPlace(staging, target, fs, randomUUID) {
  const files = (await filesWithin(staging, fs)).filter((file) => file !== MARKER);
  const expected = new Set([...files, MARKER]);
  for (const file of files) {
    const destination = join(target, file);
    await fs.mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await fs.copyFile(join(staging, file), temporary);
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  // Never touch unknown files (including notes.txt) inside the user's
  // unpacked extension directory. Remove only stale extension-owned types.
  for (const file of await filesWithin(target, fs)) {
    if (!expected.has(file) && SAFE_REMOVABLE_EXTENSIONS.has(extname(file).toLowerCase())) {
      await fs.rm(join(target, file), { force: true });
    }
  }
  // A reader cannot observe the new managed version until all other files
  // are in place. The marker is always replaced last.
  const markerTemp = join(target, `${MARKER}.tmp-${randomUUID()}`);
  try {
    await fs.copyFile(join(staging, MARKER), markerTemp);
    await fs.rename(markerTemp, join(target, MARKER));
  } finally {
    await fs.rm(markerTemp, { force: true }).catch(() => {});
  }
}

export async function installManagedExtension({
  sourceDir,
  userDataDir,
  randomUUID = defaultRandomUUID,
  now = () => new Date(),
  fs = nodeFs,
  copySource = (source, destination) => fs.cp(source, destination, { recursive: true }),
}) {
  const { root, target } = managedExtensionPaths(userDataDir);
  const staging = `${target}.staging`;
  const previous = `${target}.previous`;
  const source = resolve(sourceDir);
  const manifest = await readJson(join(source, "manifest.json"), fs);
  if (typeof manifest?.version !== "string" ||
      compareManagedExtensionVersions(manifest.version, manifest.version) === null ||
      typeof manifest.key !== "string" || !manifest.key.trim()) {
    throw new Error("Managed extension source requires a valid version and pinned manifest key");
  }
  await fs.mkdir(root, { recursive: true });
  if (!(await pathExists(target, fs)) && await pathExists(previous, fs)) {
    await fs.rename(previous, target);
  }
  // Never follow a replaced/symlink target into an unrelated directory.
  if (await pathExists(target, fs) && !(await fs.lstat(target)).isDirectory()) {
    throw new Error("Managed browser extension target is not a directory");
  }
  const currentManifest = await readJson(join(target, "manifest.json"), fs);
  const oldMarker = await markerAt(target, fs);
  const currentVersion = typeof currentManifest?.version === "string" ? currentManifest.version : "";
  const comparison = compareManagedExtensionVersions(currentVersion, manifest.version);
  const installId = typeof oldMarker?.installId === "string" && oldMarker.installId.trim()
    ? oldMarker.installId : randomUUID();
  if (comparison !== null && comparison > 0) {
    return { action: "skipped-newer", version: currentVersion, installId };
  }
  const current = await readInstallation(target, fs);
  if (comparison === 0 && current && await filesMatch(source, target, fs)) {
    return { action: "unchanged", version: currentVersion, installId: current.installId };
  }

  await fs.rm(staging, { recursive: true, force: true });
  try {
    await copySource(source, staging);
    const marker = { schema: 1, installId, version: manifest.version, installedAt: now().toISOString() };
    await fs.writeFile(join(staging, MARKER), `${JSON.stringify(marker)}\n`, "utf8");
    const stagedManifest = await readJson(join(staging, "manifest.json"), fs);
    const staged = await readInstallation(staging, fs);
    if (stagedManifest?.key !== manifest.key || !staged ||
        staged.version !== manifest.version || staged.installId !== installId ||
        !(await filesMatch(source, staging, fs))) {
      throw new Error("Managed extension staging validation failed");
    }

    // Keep the stable target pathname continuously recoverable: if the
    // second rename fails, restore the previous directory in place.
    await fs.rm(previous, { recursive: true, force: true });
    let movedOld = false;
    if (await pathExists(target, fs)) {
      try {
        await fs.rename(target, previous);
        movedOld = true;
      } catch (error) {
        if (!WINDOWS_LOCK_CODES.has(error?.code)) throw error;
        await writeInPlace(staging, target, fs, randomUUID);
        if (!(await filesMatch(source, target, fs)) || !(await readInstallation(target, fs))) {
          throw new Error("Managed extension in-place validation failed");
        }
        return { action: "updated", version: manifest.version, installId };
      }
    }
    try {
      await fs.rename(staging, target);
    } catch (error) {
      if (movedOld) {
        try {
          await fs.rename(previous, target);
        } catch (restoreError) {
          throw new Error(`Managed extension swap failed (${error?.message || error}); recovery directory preserved at ${previous}: ${restoreError?.message || restoreError}`, { cause: error });
        }
      }
      throw error;
    }
    if (movedOld) await fs.rm(previous, { recursive: true, force: true });
    return { action: currentVersion ? "updated" : "installed", version: manifest.version, installId };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
