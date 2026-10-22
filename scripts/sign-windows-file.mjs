#!/usr/bin/env node

// Signs one Windows executable with the release signing configuration Forge
// uses for the app itself (scripts/windows-signing.mjs). The installer build
// (scripts/windows-installer.nsi) runs it on the uninstaller and then on the
// installer, and only for production builds.

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { windowsSignOptionsFromEnvironment } from "./windows-signing.mjs";

export async function signWindowsFile(file, { env = process.env, signImpl = null } = {}) {
  const target = resolve(String(file || ""));
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new Error(`Nothing to sign at ${target}.`);
  const options = windowsSignOptionsFromEnvironment(env);
  if (!options) throw new Error("Windows files are signed for production builds only (MOSA_RELEASE_DISTRIBUTION=production).");
  const sign = signImpl || (await import("@electron/windows-sign")).sign;
  await sign({ ...options, files: [target] });
  return target;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  signWindowsFile(process.argv[2]).catch((error) => {
    console.error(`[MOSA] Windows signing failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
