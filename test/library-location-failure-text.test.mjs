// 任务 359（任务单第二节 3）：changeLibraryLocation 的 reason→文案映射。
// 取消（用户在选文件夹框点了取消）不出提示；其余原因各给一句带原因的整句。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import test, { after, before } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
let lifecycle;

before(async () => {
  const outDir = await mkdtemp(join(tmpdir(), "mosa-gp-locfail-"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(repositoryRoot, "web", "gravityport", "src", "app-lifecycle.ts"),
    "--outDir", outDir, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  lifecycle = await import(join(outDir, "app-lifecycle.js"));
});

after(async () => {
  // temp dirs cleaned by the OS tmp cleaner; nothing to hold onto
});

const fill = (text, values) => Object.entries(values).reduce(
  (acc, [key, value]) => acc.split(`{${key}}`).join(String(value)), text);

test("cancelled returns null (no toast)", () => {
  assert.equal(lifecycle.libraryLocationFailureText("cancelled", fill), null);
});

test("managed / attached / unavailable / copy-failed each produce the sentence with the reason", () => {
  for (const reason of ["managed", "attached", "unavailable", "copy-failed", "same-library"]) {
    const text = lifecycle.libraryLocationFailureText(reason, fill);
    assert.equal(text, `无法更改存储位置（${reason}）。`);
  }
});

test("a missing or unknown reason falls back to (unknown)", () => {
  assert.equal(lifecycle.libraryLocationFailureText(undefined, fill), "无法更改存储位置（unknown）。");
  assert.equal(lifecycle.libraryLocationFailureText("", fill), "无法更改存储位置（unknown）。");
});
