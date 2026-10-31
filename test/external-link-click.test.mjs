import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

// 审查 3-6 甲（任务 318）:the settings-card links go through the controlled
// open-external-link channel in the desktop app, and keep their plain-anchor
// behavior in the browser. The module is compiled from the real TypeScript
// source (external-link.ts + desktop.ts) like the other UI unit tests.
const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = resolve(repositoryRoot, "web", "gravityport");
const tscBin = join(repositoryRoot, "node_modules", ".bin", "tsc");

async function compileModule(t) {
  const tempRoot = await mkdtemp(join(tmpdir(), "mosa-external-link-click-"));
  deferTestPathRemoval(tempRoot, { recursive: true, force: true });
  t.after(async () => { await rm(tempRoot, { recursive: true, force: true }); });
  execFileSync(tscBin, [
    join(uiRoot, "src", "external-link.ts"),
    "--outDir", tempRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  return import(join(tempRoot, "external-link.js"));
}

test("with the desktop API the anchor is intercepted and the channel is called", async (t) => {
  const { handleExternalLinkClick } = await compileModule(t);
  const calls = [];
  globalThis.window = {
    electronAPI: {
      openExternalLink: (url) => { calls.push(["openExternalLink", url]); return Promise.resolve({ ok: true }); },
    },
  };
  t.after(() => { delete globalThis.window; });

  const preventDefaultCalls = [];
  const event = { preventDefault: () => { preventDefaultCalls.push(true); } };
  handleExternalLinkClick(event, "https://gravityport.azhuilab.com/#download");

  assert.deepEqual(preventDefaultCalls, [true], "the default new-window navigation must be cancelled");
  assert.deepEqual(calls, [["openExternalLink", "https://gravityport.azhuilab.com/#download"]]);
});

test("without openExternalLink nothing is intercepted (plain browser behavior)", async (t) => {
  const { handleExternalLinkClick } = await compileModule(t);
  globalThis.window = { electronAPI: {} };
  t.after(() => { delete globalThis.window; });

  const event = { preventDefault: () => { throw new Error("preventDefault must not run"); } };
  handleExternalLinkClick(event, "https://example.com/");
});

test("without any desktop API the anchor is left alone", async (t) => {
  const { handleExternalLinkClick } = await compileModule(t);
  delete globalThis.window;
  const event = { preventDefault: () => { throw new Error("preventDefault must not run"); } };
  handleExternalLinkClick(event, "https://example.com/");
});
