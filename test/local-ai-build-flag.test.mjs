import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localAiBuildFromEnv } from "../web/gravityport/local-build-flags.mjs";

// Released builds must keep the AI line behind its localStorage switch; only a
// local preview package built with GRAVITYPORT_LOCAL_AI=1 shows it.
test("GRAVITYPORT_LOCAL_AI turns the local AI build on only for the exact string 1", () => {
  assert.equal(localAiBuildFromEnv({ GRAVITYPORT_LOCAL_AI: "1" }), true);
  for (const value of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
    assert.equal(localAiBuildFromEnv({ GRAVITYPORT_LOCAL_AI: value }), false, JSON.stringify(value));
  }
  assert.equal(localAiBuildFromEnv({}), false);
  assert.equal(localAiBuildFromEnv(undefined), false);
});

test("release workflows never set GRAVITYPORT_LOCAL_AI", async () => {
  const { readdir } = await import("node:fs/promises");
  const dir = new URL("../.github/workflows/", import.meta.url);
  for (const file of await readdir(dir)) {
    const text = await readFile(new URL(file, dir), "utf8");
    assert.doesNotMatch(text, /GRAVITYPORT_LOCAL_AI/, `${file} must not build the local AI preview`);
  }
});

test("both AI entry points honour the local AI build", async () => {
  for (const file of ["ai-entry.ts", "learning-library-entry.ts"]) {
    const text = await readFile(new URL(`../web/gravityport/src/${file}`, import.meta.url), "utf8");
    assert.match(text, /import\.meta\.env\.DEV \|\| localAiBuild\(\)/, file);
  }
  const config = await readFile(new URL("../web/gravityport/vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /__GRAVITYPORT_LOCAL_AI_BUILD__: JSON\.stringify\(localAiBuildFromEnv\(env\)\)/);
});
