// 任务 359（任务单第二节 3）+ 返工 1（HC-06）：changeLibraryLocation 的
// reason→文案映射。取消（用户在选文件夹框点了取消）不出提示；六个已知原因
// 各断言中文整句（函数返回值）和英文整句（真 i18n.ts 的 translate 查表）；
// 未知原因回退到带原始代号的兜底句。两个模块都用 tsc 编译真文件后 import，
// 不抄实现。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import test, { after, before } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
let lifecycle;
let translate;

before(async () => {
  const outDir = await mkdtemp(join(tmpdir(), "mosa-gp-locfail-"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(repositoryRoot, "web", "gravityport", "src", "app-lifecycle.ts"),
    join(repositoryRoot, "web", "gravityport", "src", "i18n.ts"),
    "--outDir", outDir, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  lifecycle = await import(join(outDir, "app-lifecycle.js"));
  ({ translate } = await import(join(outDir, "i18n.js")));
  after(async () => {
    await rm(outDir, { recursive: true, force: true });
  });
});

const fill = (text, values) => Object.entries(values).reduce(
  (acc, [key, value]) => acc.split(`{${key}}`).join(String(value)), text);

// 返工 1 表格（与 desktop/main.mjs change-library-location 和
// lib/library-relocation.mjs validateRelocationTarget 的返回值逐行对应）。
const REASON_SENTENCES = [
  ["not-empty", "无法更改存储位置。请选择一个空文件夹。", "Couldn’t change storage location. Choose an empty folder."],
  ["invalid", "无法更改存储位置。新位置不能位于当前素材库内，也不能包含当前素材库。", "Couldn’t change storage location. The new location can’t be inside the current library or contain it."],
  ["unavailable", "无法更改存储位置。无法访问所选文件夹。", "Couldn’t change storage location. The selected folder can’t be accessed."],
  ["copy-failed", "无法更改存储位置。复制素材库时出错，原素材库未改动。", "Couldn’t change storage location. Copying the library failed. The original library was not changed."],
  ["attached", "无法更改存储位置。请退出其他正在运行的 GravityPort 后重试。", "Couldn’t change storage location. Quit any other running GravityPort and try again."],
  ["managed", "无法更改存储位置。素材库位置由启动设置指定。", "Couldn’t change storage location. The location is set by a launch setting."],
];

test("cancelled returns null (no toast)", () => {
  assert.equal(lifecycle.libraryLocationFailureText("cancelled", fill), null);
});

test("each known reason has its own zh sentence, and i18n.ts translates it to the en sentence", () => {
  for (const [reason, zh, en] of REASON_SENTENCES) {
    assert.equal(lifecycle.libraryLocationFailureText(reason, fill), zh, `${reason} zh sentence`);
    assert.equal(translate(zh, "en"), en, `${reason} en sentence`);
  }
});

test("an unknown reason falls back to the sentence carrying the raw code", () => {
  assert.equal(lifecycle.libraryLocationFailureText("weird", fill), "无法更改存储位置（weird）。");
});

// 任务 367：兜底句在英文界面下也翻——调用方（App.tsx）传 fillNamed（先 tr
// 再填），i18n.ts 里「无法更改存储位置（{reason}）。」有英文整句。
test("an unknown reason translates before filling, so the en UI shows the English fallback", () => {
  const fillNamedEn = (text, values) => fill(translate(text, "en"), values);
  assert.equal(
    lifecycle.libraryLocationFailureText("weird", fillNamedEn),
    "Couldn’t change storage location (weird).",
  );
  assert.equal(
    lifecycle.libraryLocationFailureText(undefined, fillNamedEn),
    "Couldn’t change storage location (unknown).",
  );
});

test("a missing or empty reason falls back to (unknown)", () => {
  assert.equal(lifecycle.libraryLocationFailureText(undefined, fill), "无法更改存储位置（unknown）。");
  assert.equal(lifecycle.libraryLocationFailureText("", fill), "无法更改存储位置（unknown）。");
});
