// Desktop shell contract tests (task 127): the startup splash must never
// declare a window drag region, and the React tree must never render
// simulated window controls. Both guard the same macOS failure mode from
// opposite ends.
//
// Why: a document that declares `-webkit-app-region: drag` (startup.html used
// to declare it on <body>, i.e. the whole window) poisons the window server's
// draggable region for the lifetime of the BrowserWindow. Navigating from that
// document to a page without drag regions does NOT clear the region
// (Electron 43.2.0 + macOS 27); from then on every real mouse press and wheel
// tick is swallowed by the window server before it reaches Chromium — the page
// still renders, CDP Input.dispatchMouseEvent and element.click() still work,
// and the native traffic lights still work, so only a human with a real mouse
// can see the breakage. An in-page `no-drag` cannot repair it either (verified
// experimentally). The only safe contract: the navigated-away-from document
// declares no app-region at all.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("desktop shell contract", () => {
  it("startup splash declares no window drag region", async () => {
    const source = await readFile(join(repositoryRoot, "desktop", "startup.html"), "utf8");
    // The splash is navigated away from once the local service is up. Any
    // app-region here risks outliving the document and eating real mouse
    // input for every page shown afterwards in the same window.
    assert.doesNotMatch(source, /app-region/i);
  });

  it("GravityPort stylesheet declares no window drag region", async () => {
    const source = await readFile(join(repositoryRoot, "web", "gravityport", "src", "index.css"), "utf8");
    // The React app renders in a hiddenInset window whose native titlebar
    // strip already drags. If a CSS drag region is ever reintroduced here it
    // must come with a documented region-recompute story; until then, none.
    assert.doesNotMatch(source, /app-region/i);
  });

  it("GravityPort renders no simulated window control buttons", async () => {
    const source = await readFile(join(repositoryRoot, "web", "gravityport", "src", "App.tsx"), "utf8");
    // macOS draws the real traffic lights (hiddenInset) and Windows keeps its
    // native titlebar, so a React-drawn red/yellow/green triple can only ever
    // be a second, dead set of controls.
    assert.doesNotMatch(source, /\btraffic\b/);
  });
});
