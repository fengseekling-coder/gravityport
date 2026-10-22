#!/usr/bin/env node
import "../lib/apply-env-aliases.mjs";

import { constants as fsConstants } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import sharp from "sharp";

import { createAssetStore } from "../lib/asset-store.mjs";
import { verifyVisualModelPack } from "../lib/visual-model-pack.mjs";
import { packagedExecutablePath } from "./desktop-runtime-paths.mjs";
import { signalProcessTree } from "./process-tree.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourcePackDir = resolve(String(process.env.MOSA_VISUAL_SMOKE_PACK || ""));
if (!process.env.MOSA_VISUAL_SMOKE_PACK) {
  throw new Error("MOSA_VISUAL_SMOKE_PACK must point to a verified local visual model pack.");
}

const verified = await verifyVisualModelPack({ packDir: sourcePackDir });
const forgeOutDir = resolve(rootDir, process.env.MOSA_FORGE_OUT_DIR || "out");
const binary = packagedExecutablePath({ rootDir, outDir: forgeOutDir });
const scratchRoot = resolve(forgeOutDir, "tmp");
await mkdir(scratchRoot, { recursive: true });
const temp = await mkdtemp(join(scratchRoot, "packaged-visual-smoke-"));
const libraryDir = join(temp, "library");
const userData = join(temp, "user-data");
const projectRoot = join(temp, "project");
const sourceDir = join(projectRoot, "generated-images");
const packDir = join(userData, "visual-model-packs", verified.id);
let activeLaunch = null;

try {
  await mkdir(sourceDir, { recursive: true });
  await cp(sourcePackDir, packDir, {
    recursive: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
  await writeFile(join(userData, "visual-model-settings.json"), `${JSON.stringify({
    schema: "mosa.visual-model-settings/1",
    enabled: true,
    active_pack_id: verified.id,
    active_revision: verified.revision,
  }, null, 2)}\n`, "utf8");

  const redA = join(sourceDir, "red-a.png");
  const redB = join(sourceDir, "red-b.png");
  const blue = join(sourceDir, "blue.png");
  await Promise.all([
    writeSynthetic(redA, { accent: "#cf2f36", shift: 0 }),
    writeSynthetic(redB, { accent: "#cf2f36", shift: 2 }),
    writeSynthetic(blue, { accent: "#315fba", shift: 0 }),
  ]);

  const store = createAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    libraryDir,
  });
  try {
    await store.createAsset({ assetId: "visual-red-a", imagePath: redA, prompt: "red composition alpha", source: { type: "local-file" } });
    await store.createAsset({ assetId: "visual-red-b", imagePath: redB, prompt: "red composition beta", source: { type: "local-file" } });
    await store.createAsset({ assetId: "visual-blue", imagePath: blue, prompt: "blue composition", source: { type: "local-file" } });
  } finally {
    store.close();
  }

  activeLaunch = await launchPackaged({ libraryDir, userData });
  await waitForHealth(`${activeLaunch.origin}/api/health`, activeLaunch.child);
  const visual = await waitForVisualIndex(activeLaunch.origin, activeLaunch.child, 3);
  if (visual.index?.model_id !== verified.id || visual.index?.model_revision !== verified.revision) {
    throw new Error("Packaged visual runtime loaded a different model identity than the verified pack.");
  }

  const similarResponse = await fetch(`${activeLaunch.origin}/api/visual/assets/visual-red-a/similar?limit=3`);
  if (!similarResponse.ok) throw new Error(`Packaged image similarity failed (${similarResponse.status}).`);
  const similar = await similarResponse.json();
  if (similar.similar?.[0]?.asset_id !== "visual-red-b") {
    throw new Error(`Expected visual-red-b as the nearest packaged image neighbor; got ${similar.similar?.[0]?.asset_id || "none"}.`);
  }
  if (!(Number(similar.similar[0].score) >= 0.985)) {
    throw new Error(`Packaged near-duplicate similarity was too low: ${similar.similar[0].score}.`);
  }

  const query = encodeURIComponent("a red circle on a light background");
  const searchResponse = await fetch(`${activeLaunch.origin}/api/visual/search?q=${query}&limit=3`);
  if (!searchResponse.ok) throw new Error(`Packaged text-to-image search failed (${searchResponse.status}).`);
  const search = await searchResponse.json();
  if (!Array.isArray(search.results) || search.results.length < 1) {
    throw new Error("Packaged text-to-image search returned no indexed assets.");
  }

  console.log(JSON.stringify({
    ok: true,
    model: {
      id: visual.index?.model_id,
      revision: visual.index?.model_revision,
      dimension: visual.index?.dimension,
    },
    indexed: visual.index?.count || 0,
    nearest: similar.similar[0],
    textTop: search.results[0],
  }));
} catch (error) {
  const details = activeLaunch
    ? [activeLaunch.stderr().trim(), activeLaunch.stdout().trim()].filter(Boolean).join("\n")
    : "";
  throw new Error(`${error instanceof Error ? error.message : String(error)}${details ? `\n${details}` : ""}`, { cause: error });
} finally {
  if (activeLaunch) await stopChild(activeLaunch.child);
  await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

async function writeSynthetic(path, { accent, shift }) {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
       <rect width="320" height="320" fill="#e8e4dc"/>
       <circle cx="${160 + shift}" cy="160" r="88" fill="${accent}"/>
     </svg>`,
  );
  await sharp(svg).png().toFile(path);
}

async function launchPackaged({ libraryDir: isolatedLibraryDir, userData: isolatedUserData }) {
  const port = await freePort();
  const child = spawn(binary, [
    ...(process.platform === "win32" ? ["--disable-gpu"] : []),
    `--user-data-dir=${isolatedUserData}`,
  ], {
    env: {
      ...process.env,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_LIBRARY_DIR: isolatedLibraryDir,
      MOSA_DESKTOP_PORT: String(port),
      MOSA_USER_DATA: isolatedUserData,
      MOSA_QA_RUN: "1",
      MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    child,
    origin: `http://127.0.0.1:${port}`,
    stdout: collect(child.stdout),
    stderr: collect(child.stderr),
  };
}

async function waitForHealth(url, childProcess) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (childProcess.exitCode !== null) throw new Error("Packaged app exited before runtime health was ready.");
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await sleep(250);
  }
  throw new Error("Packaged visual smoke health timeout.");
}

async function waitForVisualIndex(origin, childProcess, expectedCount) {
  const end = Date.now() + 120_000;
  let last = null;
  while (Date.now() < end) {
    if (childProcess.exitCode !== null) throw new Error("Packaged app exited while visual indexing was running.");
    try {
      const response = await fetch(`${origin}/api/visual/status`);
      if (response.ok) {
        last = (await response.json()).visual;
        if (last?.available === true && Number(last.index?.count || 0) >= expectedCount) return last;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error(`Packaged visual index timeout; last status: ${JSON.stringify(last)}`);
}

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function stopChild(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode) return;
  const exited = onceExit(childProcess);
  await signalProcessTree(childProcess.pid);
  if (await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])) return;
  if (childProcess.exitCode === null && !childProcess.signalCode) await signalProcessTree(childProcess.pid, { force: true });
  await Promise.race([exited, sleep(5000)]);
}

function onceExit(childProcess) {
  return new Promise((resolveExit) => childProcess.once("exit", resolveExit));
}

function collect(stream) {
  let value = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => { value += chunk; });
  return () => value;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
