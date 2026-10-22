import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  GRAVITYPORT_ENV_ALIASES,
  applyGravityPortEnvAliases,
  isTelemetryDisabled,
  readGravityPortEnv,
} from "../lib/env-aliases.mjs";
import { parseDisabledBridges } from "../lib/runtime-bridges.mjs";

const applyModuleUrl = pathToFileURL(resolve(import.meta.dirname, "..", "lib", "apply-env-aliases.mjs")).href;

test("every GravityPort switch maps onto its legacy MOSA_ name", () => {
  for (const [name, legacy] of Object.entries(GRAVITYPORT_ENV_ALIASES)) {
    assert.match(name, /^GRAVITYPORT_/);
    assert.equal(legacy, name.replace(/^GRAVITYPORT_/, "MOSA_"));
  }
});

test("readGravityPortEnv prefers the new name and falls back to the legacy one", () => {
  const name = "GRAVITYPORT_LIBRARY_DIR";
  assert.equal(readGravityPortEnv({}, name), undefined);
  assert.equal(readGravityPortEnv(undefined, name), undefined);
  assert.equal(readGravityPortEnv({ MOSA_LIBRARY_DIR: "/old" }, name), "/old");
  assert.equal(readGravityPortEnv({ GRAVITYPORT_LIBRARY_DIR: "/new" }, name), "/new");
  assert.equal(readGravityPortEnv({ GRAVITYPORT_LIBRARY_DIR: "/new", MOSA_LIBRARY_DIR: "/old" }, name), "/new");
  // A defined new value wins even when empty, so it can clear a legacy value.
  assert.equal(readGravityPortEnv({ GRAVITYPORT_LIBRARY_DIR: "", MOSA_LIBRARY_DIR: "/old" }, name), "");
  assert.throws(() => readGravityPortEnv({}, "GRAVITYPORT_PORT"), /Unknown GravityPort environment switch/);
});

test("applyGravityPortEnvAliases folds new names onto legacy names and drops the new names", () => {
  const env = {
    GRAVITYPORT_DISABLE_TELEMETRY: "1",
    GRAVITYPORT_LIBRARY_DIR: "/new",
    MOSA_LIBRARY_DIR: "/old",
    MOSA_DISABLE_BRIDGES: "codex",
    MOSA_PORT: "43517",
  };
  assert.equal(applyGravityPortEnvAliases(env), env);
  assert.deepEqual(env, {
    MOSA_DISABLE_TELEMETRY: "1",
    MOSA_LIBRARY_DIR: "/new",
    MOSA_DISABLE_BRIDGES: "codex",
    MOSA_PORT: "43517",
  });
  // A child launched with an explicit legacy override now sees only that value.
  assert.equal(readGravityPortEnv({ ...env, MOSA_LIBRARY_DIR: "/isolated" }, "GRAVITYPORT_LIBRARY_DIR"), "/isolated");
});

test("either telemetry name turns the anonymous usage signal off, and the new name wins", () => {
  assert.equal(isTelemetryDisabled({}), false);
  assert.equal(isTelemetryDisabled({ MOSA_DISABLE_TELEMETRY: "1" }), true);
  assert.equal(isTelemetryDisabled({ GRAVITYPORT_DISABLE_TELEMETRY: "1" }), true);
  assert.equal(isTelemetryDisabled({ GRAVITYPORT_DISABLE_TELEMETRY: "1", MOSA_DISABLE_TELEMETRY: "0" }), true);
  assert.equal(isTelemetryDisabled({ GRAVITYPORT_DISABLE_TELEMETRY: "0", MOSA_DISABLE_TELEMETRY: "1" }), false);
  assert.equal(isTelemetryDisabled({ GRAVITYPORT_DISABLE_TELEMETRY: "true" }), false);
});

test("either bridge name disables bridges, and the new name wins", () => {
  assert.deepEqual(parseDisabledBridges({ env: {} }), []);
  assert.deepEqual(parseDisabledBridges({ env: { MOSA_DISABLE_BRIDGES: "codex" } }), ["codex"]);
  assert.deepEqual(parseDisabledBridges({ env: { GRAVITYPORT_DISABLE_BRIDGES: "codex,grok" } }), ["codex", "grok"]);
  assert.deepEqual(
    parseDisabledBridges({ env: { GRAVITYPORT_DISABLE_BRIDGES: "grok", MOSA_DISABLE_BRIDGES: "codex,cowart" } }),
    ["grok"],
  );
  assert.deepEqual(parseDisabledBridges({ env: { GRAVITYPORT_DISABLE_BRIDGES: "", MOSA_DISABLE_BRIDGES: "codex" } }), []);
  assert.throws(() => parseDisabledBridges({ env: { GRAVITYPORT_DISABLE_BRIDGES: "webCapture" } }), /Unknown bridge name/);
  // An explicit array still beats both environment names.
  assert.deepEqual(parseDisabledBridges({ explicit: ["cowart"], env: { GRAVITYPORT_DISABLE_BRIDGES: "codex" } }), ["cowart"]);
});

test("an entry point that imports apply-env-aliases first sees the folded values", () => {
  const script = `import ${JSON.stringify(applyModuleUrl)};
const pick = (prefix) => Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith(prefix)).sort());
console.log(JSON.stringify({ gp: pick("GRAVITYPORT_"), mosa: pick("MOSA_DISABLE_") }));`;
  const env = { ...process.env, GRAVITYPORT_DISABLE_BRIDGES: "grok", MOSA_DISABLE_BRIDGES: "codex", GRAVITYPORT_DISABLE_TELEMETRY: "1" };
  delete env.MOSA_DISABLE_TELEMETRY;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    gp: {},
    mosa: { MOSA_DISABLE_BRIDGES: "grok", MOSA_DISABLE_TELEMETRY: "1" },
  });
});
