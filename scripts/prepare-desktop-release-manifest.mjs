#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseUpdateManifest, macosUpdateFileNameForAppName, windowsUpdateFileNameForPayloadExeName, MACOS_TEAM_IDENTIFIER_PATTERN, MACOS_UPDATE_APP_NAMES, WINDOWS_UPDATE_EXE_NAMES, WINDOWS_SIGNER_THUMBPRINT_PATTERN } from "../desktop/update-service.mjs";
import { normalizeDesktopDistribution } from "../lib/release-distribution.mjs";
import { formatManifestNotes, notesForVersion, readReleaseNotes } from "../lib/release-notes.mjs";
import { releaseProductNames } from "./release-product.mjs";
import {
  normalizeReleaseManifestTrust,
  releaseManifestPrivateKeyFromEnvironment,
  signReleaseManifest,
  verifyReleaseManifestSignature,
} from "../lib/release-manifest-signature.mjs";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export async function prepareDesktopReleaseManifest({
  version,
  macArtifactPath = "",
  macAppName = "MOSA.app",
  macTeamIdentifier = "",
  windowsArtifactPath = "",
  windowsInstallerPath = "",
  windowsPayloadExeName = "MOSA.exe",
  windowsSignerThumbprint = "",
  buildIdentity = null,
  signingPrivateKey = null,
  previousManifest = null,
  publishedAt = new Date().toISOString(),
  notes = null,
} = {}) {
  const cleanVersion = String(version || "").trim();
  if (!VERSION_PATTERN.test(cleanVersion)) throw new Error("Invalid MOSA release version.");
  const normalizedBuildIdentity = normalizeBuildIdentity(buildIdentity, cleanVersion);

  const cleanMacAppName = String(macAppName || "").trim();
  if (!MACOS_UPDATE_APP_NAMES.includes(cleanMacAppName)) throw new Error("Invalid macOS release app name.");
  const cleanMacTeamIdentifier = String(macTeamIdentifier || "").trim().toUpperCase();
  if (cleanMacTeamIdentifier && !MACOS_TEAM_IDENTIFIER_PATTERN.test(cleanMacTeamIdentifier)) {
    throw new Error("Release macOS teamIdentifier is invalid.");
  }
  const cleanWindowsPayloadExeName = String(windowsPayloadExeName || "").trim();
  if (!WINDOWS_UPDATE_EXE_NAMES.includes(cleanWindowsPayloadExeName)) {
    throw new Error("Invalid Windows release payload executable name.");
  }
  const cleanWindowsSignerThumbprint = String(windowsSignerThumbprint || "").trim().toUpperCase();
  if (cleanWindowsSignerThumbprint && !WINDOWS_SIGNER_THUMBPRINT_PATTERN.test(cleanWindowsSignerThumbprint)) {
    throw new Error("Release Windows signerThumbprint is invalid.");
  }

  const macos = macArtifactPath
    ? await artifactMetadata({
        path: macArtifactPath,
        expectedFile: macosUpdateFileNameForAppName(cleanMacAppName, cleanVersion),
        platform: "macOS",
        arch: "arm64",
        appName: cleanMacAppName,
        ...(cleanMacTeamIdentifier ? { teamIdentifier: cleanMacTeamIdentifier } : {}),
      })
    : null;
  // The Desktop reader enforces the same rule; fail here with the publishing
  // context so a production release can never leave without its pinned team.
  if (normalizedBuildIdentity.distribution === "production" && macos && !macos.teamIdentifier) {
    throw new Error("Production macOS releases require a platforms.macos teamIdentifier.");
  }
  const windows = windowsArtifactPath
    ? await artifactMetadata({
        path: windowsArtifactPath,
        expectedFile: windowsUpdateFileNameForPayloadExeName(cleanWindowsPayloadExeName, cleanVersion),
        platform: "Windows",
        arch: "x64",
        payloadExeName: cleanWindowsPayloadExeName,
        ...(cleanWindowsSignerThumbprint ? { signerThumbprint: cleanWindowsSignerThumbprint } : {}),
      })
    : null;
  // The Desktop reader enforces the same rule; fail here with the publishing
  // context so a production Windows release can never leave unpinned.
  if (normalizedBuildIdentity.distribution === "production" && windows && !windows.signerThumbprint) {
    throw new Error("Production Windows releases require a platforms.windows signerThumbprint.");
  }
  // The installer is what the website offers for a first install. Desktop
  // clients ignore it: in-app updates keep using the update ZIP, so an
  // installer never ships without one.
  if (windowsInstallerPath) {
    if (!windows) throw new Error("A Windows installer ships with its update ZIP: pass the Windows ZIP as well.");
    const installer = await artifactMetadata({
      path: windowsInstallerPath,
      expectedFile: releaseProductNames(cleanWindowsPayloadExeName.slice(0, -4)).windowsInstallerName(cleanVersion),
      platform: "Windows",
      arch: "x64",
    });
    windows.installer = { file: installer.file, size: installer.size, sha256: installer.sha256 };
  }

  const previous = previousManifest && typeof previousManifest === "object" && !Array.isArray(previousManifest)
    ? previousManifest
    : {};
  const normalizedNotes = normalizeRequiredNotes(notes);
  const unsignedManifest = {
    version: cleanVersion,
    build: normalizedBuildIdentity,
    publishedAt: normalizePublishedAt(publishedAt),
    notes: normalizedNotes,
    platforms: {
      ...(macos ? { macos } : {}),
      ...(windows ? { windows } : {}),
    },
  };

  const trust = normalizeReleaseManifestTrust(buildIdentity?.releaseManifestTrust);
  if (!signingPrivateKey) throw new Error("Release manifest signing private key is required.");
  const manifest = signReleaseManifest(unsignedManifest, {
    privateKey: signingPrivateKey,
    expectedTrust: trust,
  });

  // The release writer and Desktop reader share the exact same parser. This
  // deliberately fails the publishing step if schema/filename/version rules
  // ever drift apart again.
  verifyReleaseManifestSignature(manifest, trust);
  parseUpdateManifest(manifest);
  return manifest;
}

export async function artifactMetadata({ path, expectedFile, platform, arch, ...extraFields }) {
  const absolute = resolve(String(path || ""));
  if (basename(absolute) !== expectedFile) {
    throw new Error(`Release artifact filename must be ${expectedFile}.`);
  }
  const info = await stat(absolute);
  if (!info.isFile() || info.size <= 0) throw new Error(`Release artifact is missing or empty: ${absolute}`);
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(absolute);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", resolveHash);
  });
  return {
    platform,
    arch,
    ...extraFields,
    file: expectedFile,
    size: info.size,
    sha256: hash.digest("hex"),
  };
}

function normalizePublishedAt(value) {
  const raw = String(value || "").trim();
  const parsed = Date.parse(raw);
  if (!raw || !Number.isFinite(parsed)) throw new Error("Invalid release publishedAt timestamp.");
  return new Date(parsed).toISOString();
}

function normalizeRequiredNotes(value) {
  const zh = typeof value?.zh === "string" ? value.zh.trim().slice(0, 3000) : "";
  const en = typeof value?.en === "string" ? value.en.trim().slice(0, 3000) : "";
  if (!zh || !en) {
    throw new Error("Release notes are required: notes.zh and notes.en must both be non-empty.");
  }
  return { zh, en };
}

/**
 * Notes for the manifest: explicit --notes-* values win (the website release
 * script keeps passing them); any language they leave empty is filled from
 * release-notes.json, the single source of release notes. A version without
 * an entry there fails the run so a release never ships without its notes.
 */
export function resolveManifestNotes({ notesZh = "", notesEn = "", version, releaseNotesPath = "" } = {}) {
  const zh = String(notesZh || "").trim();
  const en = String(notesEn || "").trim();
  if (zh && en) return { zh, en };
  const data = readReleaseNotes(releaseNotesPath ? resolve(String(releaseNotesPath)) : undefined);
  const entry = notesForVersion(data, version);
  if (!entry) throw new Error(`release-notes.json 缺少 ${version} 的更新说明`);
  return {
    zh: zh || formatManifestNotes(entry.zh, "zh"),
    en: en || formatManifestNotes(entry.en, "en"),
  };
}

function normalizeBuildIdentity(value, version) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release build identity is required.");
  }
  const productVersion = String(value.productVersion || "").trim();
  const gitSha = String(value.gitSha || "").trim().toLowerCase();
  const uiFingerprint = String(value.uiFingerprint || "").trim().toLowerCase();
  const runtimeFingerprint = String(value.runtimeFingerprint || "").trim().toLowerCase();
  const distribution = normalizeDesktopDistribution(value.distribution, { releaseOnly: true });
  if (productVersion !== version) {
    throw new Error(`Release build identity version ${productVersion || "(missing)"} does not match ${version}.`);
  }
  if (!/^[0-9a-f]{40}$/.test(gitSha)) throw new Error("Release build identity gitSha is invalid.");
  if (!/^[0-9a-f]{64}$/.test(uiFingerprint)) throw new Error("Release build identity uiFingerprint is invalid.");
  if (!/^[0-9a-f]{64}$/.test(runtimeFingerprint)) throw new Error("Release build identity runtimeFingerprint is invalid.");
  return { gitSha, uiFingerprint, runtimeFingerprint, distribution };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    args[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version || !args.output) {
    throw new Error("Usage: prepare-desktop-release-manifest.mjs --version <version> --output <latest.json> [--previous <latest.json>] [--mac <zip>] [--mac-app-name <MOSA.app|GravityPort.app>] [--mac-team-identifier <10-char id>] [--windows <zip>] [--windows-installer <exe>] [--windows-payload-exe-name <MOSA.exe|GravityPort.exe>] [--windows-signer-thumbprint <40-char id>] [--published-at <ISO>] [--notes-zh <text>] [--notes-en <text>] [--release-notes <release-notes.json>]");
  }
  const previousManifest = args.previous ? JSON.parse(await readFile(resolve(args.previous), "utf8")) : null;
  const projectRoot = new URL("..", import.meta.url);
  const buildIdentity = JSON.parse(await readFile(resolve(fileURLToPath(projectRoot), "web", "gravityport", "dist", "build-identity.json"), "utf8"));
  const signingPrivateKey = releaseManifestPrivateKeyFromEnvironment(process.env);
  const manifest = await prepareDesktopReleaseManifest({
    version: args.version,
    macArtifactPath: args.mac || "",
    macAppName: args["mac-app-name"] || "MOSA.app",
    macTeamIdentifier: args["mac-team-identifier"] || "",
    windowsArtifactPath: args.windows || "",
    windowsInstallerPath: args["windows-installer"] || "",
    windowsPayloadExeName: args["windows-payload-exe-name"] || "MOSA.exe",
    windowsSignerThumbprint: args["windows-signer-thumbprint"] || "",
    buildIdentity,
    signingPrivateKey,
    previousManifest,
    publishedAt: args["published-at"] || new Date().toISOString(),
    notes: resolveManifestNotes({
      notesZh: args["notes-zh"] || "",
      notesEn: args["notes-en"] || "",
      version: args.version,
      releaseNotesPath: args["release-notes"] || "",
    }),
  });
  const output = resolve(args.output);
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, output, manifest }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[MOSA] release manifest preparation failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
