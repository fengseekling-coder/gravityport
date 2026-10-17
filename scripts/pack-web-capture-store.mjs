import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionDir = resolve(root, "extensions/chatgpt-web-capture");
const manifestPath = resolve(extensionDir, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const version = String(manifest.version || "").trim();
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
  throw new Error(`Invalid extension version: ${version || "<empty>"}`);
}
const outputDir = resolve(root, "out/store");
const outputZip = resolve(outputDir, `GravityPort-Web-Capture-${version}-Chrome-Web-Store.zip`);
await mkdir(outputDir, { recursive: true });

const staging = await mkdtemp(resolve(tmpdir(), "mosa-web-capture-store-"));
const localTestStaging = await mkdtemp(resolve(tmpdir(), "mosa-web-capture-local-test-"));
const localTestZip = resolve(outputDir, `GravityPort-Web-Capture-${version}-Local-Test.zip`);
const runtimeFiles = [
  "background.js",
  "content.css",
  "content.js",
  "generation-registry.js",
  "options.html",
  "options.js",
  "page-hook.js",
  "provider-policy.js",
  "provider-sites.js",
];

async function zipStaging(sourceDir, target) {
  await rm(target, { force: true });
  if (process.platform === "win32") {
    const escapedTarget = target.replace(/'/g, "''");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -Path * -DestinationPath '${escapedTarget}' -Force`,
    ], { cwd: sourceDir });
  } else {
    await execFileAsync("zip", ["-qr", "-X", target, "."], { cwd: sourceDir });
  }
}

try {
  const storeManifest = { ...manifest };
  delete storeManifest.key;
  await writeFile(resolve(staging, "manifest.json"), `${JSON.stringify(storeManifest, null, 2)}\n`, "utf8");
  await writeFile(resolve(localTestStaging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  for (const relative of runtimeFiles) {
    await copyFile(resolve(extensionDir, relative), resolve(staging, relative));
    await copyFile(resolve(extensionDir, relative), resolve(localTestStaging, relative));
  }

  await zipStaging(staging, outputZip);
  await zipStaging(localTestStaging, localTestZip);

  const packagedManifest = JSON.parse(await readFile(resolve(staging, "manifest.json"), "utf8"));
  if (Object.hasOwn(packagedManifest, "key")) {
    throw new Error("Store package manifest unexpectedly contains key");
  }
  const localTestManifest = JSON.parse(await readFile(resolve(localTestStaging, "manifest.json"), "utf8"));
  if (!Object.hasOwn(localTestManifest, "key")) {
    throw new Error("Local test package manifest unexpectedly lost key");
  }

  const info = await stat(outputZip);
  console.log(`Chrome Web Store package: ${outputZip}`);
  console.log(`Version: ${version}`);
  console.log(`Size: ${info.size} bytes`);
  console.log(`Manifest key removed: yes`);
  console.log(`ZIP root: manifest.json + ${runtimeFiles.length} runtime files`);
  // The keyless store zip cannot be load-tested unpacked: Chrome derives a
  // path-dependent extension ID that MOSA's pairing allowlist rejects by
  // design. The local-test twin keeps the pinned key (fixed development ID)
  // so other machines can verify the exact same runtime before publishing.
  const localInfo = await stat(localTestZip);
  console.log(`Local test package (keeps pinned key/dev ID): ${localTestZip}`);
  console.log(`Local test size: ${localInfo.size} bytes`);
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(localTestStaging, { recursive: true, force: true });
}
