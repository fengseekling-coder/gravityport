import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createIsolatedCliEnv, runMosaCli } from "./helpers/cli-runner.mjs";

test("running mosa without a command prints usage and exits 1", async () => {
  const { env } = await createIsolatedCliEnv("mosa-cli-no-command-");
  const result = runMosaCli([], { env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /GravityPort local library commands/);
  assert.match(result.stdout, /gravityport migrate \[--library <path>\]/);
  assert.match(result.stdout, /The mosa command still works as an alias of gravityport\./);
  assert.equal(result.stderr, "");
});

test("help and --help print usage and exit 0", async () => {
  const { env } = await createIsolatedCliEnv("mosa-cli-help-");
  for (const command of ["help", "--help"]) {
    const result = runMosaCli([command], { env });
    assert.equal(result.status, 0, `${command} must exit 0`);
    assert.match(result.stdout, /GravityPort local library commands/);
    assert.match(result.stdout, /gravityport thumbnails <rebuild\|repair>/);
    assert.match(result.stdout, /The mosa command still works as an alias of gravityport\./);
    assert.equal(result.stderr, "");
  }
});

test("package.json keeps the mosa package name and points both bins at the same file", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "mosa");
  assert.equal(manifest.productName, undefined);
  assert.deepEqual(manifest.bin, {
    gravityport: "bin/mosa.mjs",
    mosa: "bin/mosa.mjs",
  });
});

test("unknown subcommands are rejected on stderr with exit 1", async () => {
  const { env } = await createIsolatedCliEnv("mosa-cli-unknown-");
  const result = runMosaCli(["transmogrify"], { env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown GravityPort command: transmogrify/);
  assert.match(result.stdout, /GravityPort local library commands/);
});

test("unknown options fail with exit 1 before any report is printed", async () => {
  const { env } = await createIsolatedCliEnv("mosa-cli-unknown-option-");
  const result = runMosaCli(["verify", "--nope", "--library", env.MOSA_LIBRARY_DIR], { env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --nope/);
  assert.equal(result.stdout, "");
});

test("options missing their value fail with exit 1", async () => {
  const { env } = await createIsolatedCliEnv("mosa-cli-missing-value-");
  const dangling = runMosaCli(["verify", "--library"], { env });
  assert.equal(dangling.status, 1);
  assert.match(dangling.stderr, /--library needs a path\./);

  const followedByFlag = runMosaCli(["verify", "--library", "--resume"], { env });
  assert.equal(followedByFlag.status, 1);
  assert.match(followedByFlag.stderr, /--library needs a path\./);
});

test("thumbnails requires rebuild or repair as its sub-action", async () => {
  const { env } = await createIsolatedCliEnv("mosa-cli-thumbnails-usage-");
  for (const args of [["thumbnails"], ["thumbnails", "compress"]]) {
    const result = runMosaCli([...args, "--library", env.MOSA_LIBRARY_DIR], { env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: gravityport thumbnails <rebuild\|repair>/);
    assert.equal(result.stdout, "");
  }
});
