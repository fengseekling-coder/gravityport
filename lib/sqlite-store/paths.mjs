// Path validation and file link/copy helpers for SQLite store (task 394). Pure moves; no behavior changes.
import { constants as fsConstants } from "node:fs";
import { copyFile, link, lstat, realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { assetStoreError } from "../asset-version-history.mjs";
import { assertMediaSignature } from "../media-signature.mjs";
import {
  MEDIA_EXTENSIONS,
  isSafeChildPath,
  resolveRequiredPath,
  statForImport,
} from "./util.mjs";

// excludeProjectRoot drops the caller's working/project directory from the
// trusted roots. MCP passes it so an assistant started from, say, the user's
// home directory can never read arbitrary files just by pointing imagePath
// there (task 334); HTTP imports and the bridges keep the old behavior.
export async function resolveReadableImagePath(store, value, trustedSourceRoots = [], options = {}) {
  const requestedPath = resolveRequiredPath(value, "imagePath");
  if (!MEDIA_EXTENSIONS.has(extname(requestedPath).toLowerCase())) throw assetStoreError("IMAGE_PATH_UNSUPPORTED_TYPE", `Unsupported media type: ${requestedPath}`);
  // Messages match the JSON store; only the machine-readable code is new, so the
  // import form can attribute each rejection to the path field.
  const requestedStat = await statForImport(requestedPath);
  if (requestedStat.isSymbolicLink()) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `Refusing to import symbolic links: ${requestedPath}`);
  if (!requestedStat.isFile()) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `imagePath is not a file: ${requestedPath}`);
  const readablePath = await realpath(requestedPath);
  await assertWithinReadableProject(store, readablePath, trustedSourceRoots, options);
  // Task 366: the extension only promised a media type; the bytes must keep
  // that promise, so plain text saved as fake.png never becomes a card. The
  // legacy-library migration passes skipMediaSignature: it moves data that
  // predates this gate, and one odd legacy file must not stop the whole run.
  if (options.skipMediaSignature !== true) {
    await assertMediaSignature(readablePath, extname(requestedPath).toLowerCase());
  }
  return { sourcePath: requestedPath, readablePath };
}

async function assertWithinReadableProject(store, filePath, trustedSourceRoots = [], options = {}) {
  const allowedRoots = [
    options.excludeProjectRoot === true ? null : store.projectRoot,
    store.generatedImagesDir,
    store.codexImagesDir,
    store.assetsRoot,
    store.cowartPageAssetsDir,
    store.legacyAssetsRoot,
    ...(Array.isArray(trustedSourceRoots) ? trustedSourceRoots : []),
  ].filter((root) => typeof root === "string" && root);
  const roots = (await Promise.all(allowedRoots.map(async (root) => {
    try { return await realpath(root); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }))).filter(Boolean);
  if (!roots.some((root) => filePath === root || isSafeChildPath(root, filePath))) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `Refusing to import outside the project roots: ${filePath}`);
}

export async function assertStoredPath(root, filePath) {
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(filePath)]);
  const fileStat = await lstat(realFile);
  if (fileStat.isSymbolicLink() || !fileStat.isFile() || !isSafeChildPath(realRoot, realFile)) throw new Error("Unsafe asset path.");
}

export async function codexSourceMetadata(store, filePath) {
  const configuredRoot = resolve(store.codexImagesDir);
  let root;
  try { root = await realpath(configuredRoot); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!isSafeChildPath(root, filePath)) return null;
  const relativePath = relative(root, filePath).split(sep).join("/");
  const [taskId] = relativePath.split("/");
  return { codex_generated_images_root: configuredRoot, codex_task_id: taskId || null, codex_relative_path: relativePath };
}

export async function hardLinkOrCopy(sourcePath, targetPath) {
  try { await link(sourcePath, targetPath); return "hard-link"; }
  catch (error) {
    if (!["EXDEV", "EPERM", "EOPNOTSUPP", "ENOTSUP", "EMLINK"].includes(error?.code)) throw error;
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
    return "copy";
  }
}
