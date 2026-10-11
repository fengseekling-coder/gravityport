#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { desktopDistributionFromEnvironment, normalizeDesktopDistribution, requiresPlatformSigning } from "../lib/release-distribution.mjs";
import { resolveReleaseProductNames } from "./release-product.mjs";

export const MOSA_RELEASE_BUNDLE_ID = "com.azhuilab.mosa";

function nonEmpty(value) {
  return String(value || "").trim();
}

export function parseCodesignDetails(output) {
  const fields = {};
  const authorities = [];
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("CodeDirectory ")) {
      fields.CodeDirectory = line;
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === "Authority") authorities.push(value);
    else fields[key] = value;
  }
  return { ...fields, authorities };
}

export function assertMacosReleaseSignature(details, { teamId, identity } = {}) {
  const expectedTeamId = nonEmpty(teamId);
  const expectedIdentity = nonEmpty(identity);
  if (!expectedTeamId || !expectedIdentity) {
    throw new Error("macOS release verification requires APPLE_TEAM_ID and MOSA_MACOS_SIGN_IDENTITY.");
  }
  if (!details || typeof details !== "object") throw new Error("macOS release signature details are missing.");
  if (String(details.Signature || "").toLowerCase() === "adhoc") {
    throw new Error("macOS release app is ad-hoc signed; Developer ID signing is required.");
  }
  if (details.TeamIdentifier !== expectedTeamId) {
    throw new Error(`macOS release TeamIdentifier ${details.TeamIdentifier || "(missing)"} does not match ${expectedTeamId}.`);
  }
  const authorities = Array.isArray(details.authorities) ? details.authorities : [];
  if (authorities[0] !== expectedIdentity) {
    throw new Error(`macOS release signing identity ${authorities[0] || "(missing)"} does not match ${expectedIdentity}.`);
  }
  const flags = String(details.CodeDirectory || "");
  if (!/\bruntime\b/i.test(flags)) {
    throw new Error("macOS release app is not signed with Hardened Runtime.");
  }
  if (details.Identifier !== MOSA_RELEASE_BUNDLE_ID) {
    throw new Error(`macOS release bundle identifier ${details.Identifier || "(missing)"} does not match ${MOSA_RELEASE_BUNDLE_ID}.`);
  }
  return true;
}

export function assertMacosPreviewSignature(details) {
  if (!details || typeof details !== "object") throw new Error("macOS preview signature details are missing.");
  if (details.Identifier !== MOSA_RELEASE_BUNDLE_ID) {
    throw new Error(`macOS preview bundle identifier ${details.Identifier || "(missing)"} does not match ${MOSA_RELEASE_BUNDLE_ID}.`);
  }
  return true;
}

export function runCommand(command, args, { cwd = process.cwd() } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) return resolvePromise({ stdout, stderr });
      const detail = stderr.trim() || stdout.trim() || `exit ${code ?? "?"}${signal ? ` (${signal})` : ""}`;
      rejectPromise(new Error(`${command} failed: ${detail}`));
    });
  });
}

export async function verifyMacosReleaseApp({
  appPath,
  env = process.env,
  runner = runCommand,
  staple = false,
  distribution = desktopDistributionFromEnvironment(env, { defaultValue: "production", releaseOnly: true }),
} = {}) {
  const resolvedAppPath = resolve(String(appPath || ""));
  if (!appPath) throw new Error("macOS release app path is required.");
  await access(resolvedAppPath);
  const normalizedDistribution = normalizeDesktopDistribution(distribution, { releaseOnly: true });

  await runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", resolvedAppPath]);
  const detailsResult = await runner("/usr/bin/codesign", ["-dv", "--verbose=4", resolvedAppPath]);
  const details = parseCodesignDetails(`${detailsResult.stdout || ""}\n${detailsResult.stderr || ""}`);
  if (!requiresPlatformSigning(normalizedDistribution)) {
    assertMacosPreviewSignature(details);
    return { appPath: resolvedAppPath, distribution: normalizedDistribution, bundleId: details.Identifier };
  }

  const teamId = nonEmpty(env.APPLE_TEAM_ID);
  const identity = nonEmpty(env.MOSA_MACOS_SIGN_IDENTITY);
  if (!teamId || !identity) {
    throw new Error("macOS production verification requires APPLE_TEAM_ID and MOSA_MACOS_SIGN_IDENTITY.");
  }
  assertMacosReleaseSignature(details, { teamId, identity });

  if (staple) await runner("/usr/bin/xcrun", ["stapler", "staple", resolvedAppPath]);
  await runner("/usr/bin/xcrun", ["stapler", "validate", resolvedAppPath]);
  await runner("/usr/sbin/spctl", ["-a", "-vv", "--type", "execute", resolvedAppPath]);
  return { appPath: resolvedAppPath, distribution: normalizedDistribution, teamId, identity, bundleId: details.Identifier };
}

function cliOption(argv, name) {
  const prefix = `--${name}=`;
  const exact = `--${name}`;
  const index = argv.indexOf(exact);
  if (index >= 0) return argv[index + 1] || "";
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

async function main() {
  if (process.platform !== "darwin") throw new Error("macOS release verification must run on macOS.");
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const names = resolveReleaseProductNames();
  const appPath = cliOption(process.argv.slice(2), "app") || resolve(root, process.env.MOSA_FORGE_OUT_DIR || "out", names.macosPackageDirName, names.macAppBundleName);
  const result = await verifyMacosReleaseApp({ appPath, staple: process.argv.includes("--staple") });
  console.log(`[MOSA] macOS ${result.distribution} app verified: ${result.bundleId}${result.teamId ? `; team ${result.teamId}` : ""}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[MOSA] macOS release verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
