#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveReleaseProductNames } from "./release-product.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

function normalizeThumbprint(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

export function assertWindowsReleaseSignature(result, expectedThumbprint) {
  const expected = normalizeThumbprint(expectedThumbprint);
  if (!/^[0-9A-F]{40,64}$/.test(expected)) throw new Error("Windows release signer thumbprint is invalid.");
  if (!result || typeof result !== "object") throw new Error("Windows Authenticode result is missing.");
  if (String(result.status || "") !== "Valid") {
    throw new Error(`Windows release Authenticode status is ${result.status || "(missing)"}, expected Valid.`);
  }
  const actual = normalizeThumbprint(result.thumbprint);
  if (actual !== expected) {
    throw new Error(`Windows release signer thumbprint ${actual || "(missing)"} does not match ${expected}.`);
  }
  if (!String(result.subject || "").trim()) throw new Error("Windows release signer subject is missing.");
  return true;
}

export function runPowerShell(command, { spawnImpl = spawn } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => { stdout += chunk; });
    child.stderr?.on?.("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`PowerShell Authenticode verification failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

export async function verifyWindowsReleasePackage({
  packageDir,
  expectedThumbprint = process.env.MOSA_WINDOWS_SIGNER_THUMBPRINT,
  powershell = runPowerShell,
} = {}) {
  if (!packageDir) throw new Error("Windows release package directory is required.");
  const resolvedPackage = resolve(packageDir);
  await access(resolvedPackage);
  const escaped = resolvedPackage.replaceAll("'", "''");
  const output = await powershell(
    `$files = @(Get-ChildItem -LiteralPath '${escaped}' -Recurse -File | Where-Object { $_.Extension -in @('.exe', '.dll', '.node') }); `
    + `if ($files.Count -eq 0) { throw 'No signable Windows release payload found.' }; `
    + `$results = @($files | ForEach-Object { $signature = Get-AuthenticodeSignature -LiteralPath $_.FullName; `
    + `[pscustomobject]@{path=$_.FullName; status=[string]$signature.Status; thumbprint=$signature.SignerCertificate.Thumbprint; subject=$signature.SignerCertificate.Subject} }); `
    + `$results | ConvertTo-Json -Compress`,
  );
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Windows package Authenticode verifier returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const results = Array.isArray(parsed) ? parsed : [parsed];
  if (!results.length) throw new Error("Windows release package contains no signable payload.");
  for (const result of results) assertWindowsReleaseSignature(result, expectedThumbprint);
  return { packageDir: resolvedPackage, files: results.length, results };
}

// One file, such as the installer, must carry the release signature too.
export async function verifyWindowsReleaseFile({
  file,
  expectedThumbprint = process.env.MOSA_WINDOWS_SIGNER_THUMBPRINT,
  powershell = runPowerShell,
} = {}) {
  if (!file) throw new Error("Windows release file is required.");
  const resolvedFile = resolve(file);
  await access(resolvedFile);
  const escaped = resolvedFile.replaceAll("'", "''");
  const output = await powershell(
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'; `
    + `[pscustomobject]@{path='${escaped}'; status=[string]$signature.Status; thumbprint=$signature.SignerCertificate.Thumbprint; subject=$signature.SignerCertificate.Subject} | ConvertTo-Json -Compress`,
  );
  let result;
  try {
    result = JSON.parse(output);
  } catch (error) {
    throw new Error(`Windows file Authenticode verifier returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertWindowsReleaseSignature(result, expectedThumbprint);
  return result;
}

async function main() {
  if (process.platform !== "win32") throw new Error("Windows release verification must run on Windows.");
  const names = resolveReleaseProductNames();
  const packageDir = resolve(rootDir, process.env.MOSA_FORGE_OUT_DIR || "out", names.windowsPackageDirName);
  const result = await verifyWindowsReleasePackage({ packageDir });
  console.log(`[MOSA] Windows release signatures verified: ${result.files} executable/native files.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[MOSA] Windows release verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
