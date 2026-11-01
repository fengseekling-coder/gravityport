/**
 * 审查 3-6 甲（任务 318）:target gate for the write-clipboard-image channel.
 *
 * The old handler checked existsSync(target) BEFORE the library containment
 * check, so a renderer could distinguish "missing" from "not-allowed" for any
 * absolute path and probe which files exist on this machine. The order is now
 * reversed: the containment decision is made on the literal path alone — no
 * filesystem access to the requested path happens before it — so every
 * out-of-library request gets the same not-allowed answer whether or not the
 * file exists.
 *
 * fsImpl is injectable for tests; production passes node:fs. Only the library
 * root itself may be probed during the literal check (its realpath handles a
 * symlinked library directory); the requested path is never touched before the
 * containment verdict.
 */

import nodeFs from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isUrlLikePath } from "../lib/path-safety.mjs";
import { resolveAllowedFolderPath } from "../lib/server-security.js";

function containsPath(rootPath, candidatePath) {
  const pathFromRoot = relative(rootPath, candidatePath);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

export function clipboardImageTarget(requestedPath, libraryDir, fsImpl = nodeFs) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) {
    return { ok: false, reason: "invalid" };
  }
  const target = requestedPath.trim();
  if (!isAbsolute(target) || (isUrlLikePath(target) && /^[a-z][a-z0-9+.-]*:/i.test(target))) {
    return { ok: false, reason: "invalid" };
  }
  if (typeof libraryDir !== "string" || !libraryDir.trim()) {
    return { ok: false, reason: "not-allowed" };
  }

  // Literal containment first: the requested path must sit under the library
  // as written, or under the library's realpath (the renderer may hold paths
  // expressed through either spelling when the library dir is a symlink).
  const libraryRoots = [resolve(libraryDir)];
  if (typeof fsImpl.realpathSync === "function") {
    try {
      libraryRoots.push(fsImpl.realpathSync(libraryDir));
    } catch {
      // Unreadable library root: fall back to the literal spelling only, which
      // is the more restrictive direction.
    }
  }
  const candidate = resolve(target);
  const literalInside = libraryRoots.some((root) => containsPath(root, candidate));
  if (!literalInside) {
    return { ok: false, reason: "not-allowed" };
  }

  // Inside the library spelling: the canonical check realpaths the target, so
  // a symlink pointing out of the library is refused here.
  const allowedTarget = resolveAllowedFolderPath(target, [libraryDir]);
  if (allowedTarget) {
    return { ok: true, path: allowedTarget };
  }
  try {
    fsImpl.lstatSync(target);
    // The path exists but resolved outside the library (e.g. an in-library
    // symlink to an outside file).
    return { ok: false, reason: "not-allowed" };
  } catch {
    // Same answer the old handler gave for a missing file; only reachable for
    // paths that already passed the library containment check, so it leaks
    // nothing about the rest of the disk.
    return { ok: false, reason: "missing" };
  }
}
