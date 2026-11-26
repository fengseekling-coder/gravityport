// Gatekeeper for the test-suite isolation of AI-tool source directories: a
// runtime started under `npm test` that forgets its temporary source
// directories must fail before it can scan the developer's real ~/.codex or
// ~/.grok. Covers the preload that arms the guard, the guard itself, and the
// runtime wiring (including the Codex thread-history location).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { assertNoHostSourcesUnderTest, TEST_HOST_SOURCE_ROOTS_ENV } from "../lib/test-host-source-guard.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { isolatedSourceOptions } from "./helpers/isolated-sources.mjs";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);

async function makeRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  return root;
}

function baseRuntimeOptions(root) {
  const libraryDir = join(root, "library");
  return {
    port: 0,
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(root, "generated-images"),
  };
}

// If the guard ever stops firing, the runtime really starts: stop it at once
// (so the file fails instead of hanging on an open server) and fail loudly.
async function expectHostSourceRejection(starting, matches) {
  let runtime;
  try {
    runtime = await starting;
  } catch (error) {
    assert.equal(error.code, "ERR_TEST_HOST_SOURCE", error.stack);
    assert.ok(matches(error), error.message);
    return;
  }
  await runtime.stop();
  assert.fail("startMosaRuntime started against host source directories instead of rejecting");
}

test("the npm test preload records the real host source roots and drops shell overrides", () => {
  const roots = String(process.env[TEST_HOST_SOURCE_ROOTS_ENV] || "").split(delimiter);
  assert.ok(roots.includes(join(homedir(), ".codex")), "the real ~/.codex must be a recorded host root");
  assert.ok(roots.includes(join(homedir(), ".grok")), "the real ~/.grok must be a recorded host root");
  for (const name of ["CODEX_HOME", "CODEX_SESSIONS_DIR", "CODEX_GENERATED_IMAGES_DIR", "CODEX_THREAD_HISTORY_DIR", "GROK_SESSIONS_DIR", "COWART_MOSA_CANVAS_DIR", "MOSA_COWART_REGISTRY_PATH"]) {
    assert.equal(process.env[name], undefined, `${name} from the developer's shell must not reach tests`);
  }
});

test("the guard rejects a source at or inside a host root and accepts a temporary one", () => {
  const host = join(tmpdir(), "fake-host-home", ".codex");
  const env = { [TEST_HOST_SOURCE_ROOTS_ENV]: host };
  const reject = (sources) => assert.throws(
    () => assertNoHostSourcesUnderTest({ sources, env, processEnv: {}, platform: "linux" }),
    (error) => error.code === "ERR_TEST_HOST_SOURCE" && error.field === Object.keys(sources)[0],
  );
  reject({ codexThreadHistoryDir: host });
  reject({ codexSessionsDir: join(host, "sessions") });
  reject({ cowartRegistryPath: join(host, "mosa", "cowart-projects.json") });
  assert.doesNotThrow(() => assertNoHostSourcesUnderTest({
    sources: { codexSessionsDir: join(tmpdir(), "fake-host-home", ".codex-sibling", "sessions") },
    env,
    processEnv: {},
    platform: "linux",
  }));
  // macOS/Windows volumes are case-insensitive: a differently-cased path is the same folder.
  assert.throws(
    () => assertNoHostSourcesUnderTest({ sources: { grokSessionsDir: host.toUpperCase() }, env, processEnv: {}, platform: "darwin" }),
    { code: "ERR_TEST_HOST_SOURCE" },
  );
});

test("the guard is inert without the test-suite marker, so production defaults are unchanged", () => {
  assert.doesNotThrow(() => assertNoHostSourcesUnderTest({
    sources: { codexSessionsDir: join(homedir(), ".codex", "sessions") },
    env: {},
    processEnv: {},
  }));
});

test("a runtime under test that omits its source directories fails before touching the library", async () => {
  const root = await makeRoot("gp-host-source-guard-missing-");
  const options = baseRuntimeOptions(root);
  await expectHostSourceRejection(startMosaRuntime(options), (error) => /TEST_HOST_SOURCE_REJECTED/.test(error.message));
  assert.equal(existsSync(options.libraryDir), false, "the guard must reject before the library lock or store is created");
});

test("a runtime under test that omits only the Codex thread history is still rejected", async () => {
  const root = await makeRoot("gp-host-source-guard-thread-");
  const { codexThreadHistoryDir: _omitted, ...sources } = isolatedSourceOptions(root);
  await expectHostSourceRejection(
    startMosaRuntime({ ...baseRuntimeOptions(root), ...sources }),
    (error) => error.field === "codexThreadHistoryDir",
  );
});

test("a runtime under test with every source directory isolated starts and reports them", async (t) => {
  const root = await makeRoot("gp-host-source-guard-ok-");
  const sources = isolatedSourceOptions(root);
  const runtime = await startMosaRuntime({ ...baseRuntimeOptions(root), ...sources });
  t.after(() => runtime.stop());
  const bridges = await (await fetch(`${runtime.url}/api/bridges`, {
    headers: { "x-mosa-client-token": runtime.clientToken },
  })).json();
  assert.equal(bridges.codex.sessionsDir, sources.codexSessionsDir);
  assert.equal(bridges.codex.threadHistoryPath, sources.codexThreadHistoryDir);
});
