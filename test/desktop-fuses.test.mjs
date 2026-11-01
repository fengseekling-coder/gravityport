import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { createForgeConfig, DESKTOP_FUSES } from "../desktop/forge.config.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("DESKTOP_FUSES carries exactly the six audited entries", () => {
  const keys = Object.keys(DESKTOP_FUSES).map(Number).sort((a, b) => a - b);
  assert.deepEqual(keys, [
    FuseV1Options.RunAsNode,
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseV1Options.EnableNodeCliInspectArguments,
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    FuseV1Options.OnlyLoadAppFromAsar,
  ]);
  assert.equal(DESKTOP_FUSES[FuseV1Options.RunAsNode], true, "MCP runs the packaged app via ELECTRON_RUN_AS_NODE");
  assert.equal(DESKTOP_FUSES[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
  assert.equal(DESKTOP_FUSES[FuseV1Options.EnableNodeCliInspectArguments], false);
  assert.equal(DESKTOP_FUSES[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
  assert.equal(DESKTOP_FUSES[FuseV1Options.OnlyLoadAppFromAsar], true);
});

test("createForgeConfig wires DESKTOP_FUSES into the FusesPlugin with the ad-hoc darwin reset", () => {
  const config = createForgeConfig();
  const fusePlugin = config.plugins.find((plugin) => plugin instanceof FusesPlugin);
  assert.ok(fusePlugin, "the fuses plugin must be part of the forge plugins");
  assert.equal(fusePlugin.fusesConfig.version, FuseVersion.V1);
  // darwin arm64: flipping invalidates the ad-hoc signature, so it is reset
  // after the flip (a no-op on Windows, where the path is not a .app bundle).
  assert.equal(fusePlugin.fusesConfig.resetAdHocDarwinSignature, true);
  for (const [fuseOption, value] of Object.entries(DESKTOP_FUSES)) {
    assert.equal(fusePlugin.fusesConfig[fuseOption], value, `fuse ${fuseOption} must come from DESKTOP_FUSES`);
  }
  // Nothing outside DESKTOP_FUSES may be flipped: unlisted fuses stay INHERIT
  // (stock Electron defaults, e.g. the file:// startup shell must keep working).
  const flippedKeys = Object.keys(fusePlugin.fusesConfig)
    .filter((key) => key !== "version" && key !== "resetAdHocDarwinSignature")
    .map(Number);
  assert.deepEqual(flippedKeys.sort((a, b) => a - b), Object.keys(DESKTOP_FUSES).map(Number).sort((a, b) => a - b));
});

test("fuses are only ever flipped on the packaged output, never on dev node_modules/electron", async () => {
  const forgeSource = await readFile(resolve(root, "desktop", "forge.config.mjs"), "utf8");
  assert.doesNotMatch(forgeSource, /node_modules[\\/]electron/, "the dev Electron binary must not be a fuse target");
  assert.doesNotMatch(forgeSource, /flipFuses\(/, "flipping goes through the forge plugin hook only");
  // The verifier reads (never writes) the packaged fuse wire.
  const verifierSource = await readFile(resolve(root, "scripts", "verify-packaged-runtime.mjs"), "utf8");
  assert.match(verifierSource, /getCurrentFuseWire/);
  assert.doesNotMatch(verifierSource, /flipFuses\(/);
});
