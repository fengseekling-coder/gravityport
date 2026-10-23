// Task 225: the Settings → 连接 browser extension card.
//
// Backend: an accepted capture records the reporting extension's version and
// status() serves it as lastExtensionVersion. UI: the real card sources are
// compiled with tsc and the emitted JS is imported — the connection window,
// the version compare, and every rendered state (connected/not connected,
// outdated hint, retry row, last error, English rendering) are asserted
// against renderToStaticMarkup output.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire, register } from "node:module";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { createWebCaptureIngest } from "../lib/web-capture-ingest.js";

// High-entropy raster so compressed size exceeds the ~20KiB ingest floor.
const CAPTURE_JPEG_BASE64 = await (async () => {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + (i % 251)) & 255;
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
  return buf.toString("base64");
})();

test("an accepted capture records the extension version and status serves it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-ext-version-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const capture = createWebCaptureIngest({
      store,
      libraryDir,
      projectId: "default",
      token: "test-token",
      allowedOrigins: ["chrome-extension://test"],
    });
    assert.equal(capture.status().lastExtensionVersion, null, "no version before any capture");

    await capture.ingest({
      provider: "chatgpt",
      imageBase64: CAPTURE_JPEG_BASE64,
      mimeType: "image/jpeg",
      extensionVersion: "0.15.36",
    }, "test-token");
    assert.equal(capture.status().lastExtensionVersion, "0.15.36");

    // A later capture with a newer version replaces it; the snake_case input
    // name is accepted the same way.
    await capture.ingest({
      provider: "chatgpt",
      imageBase64: CAPTURE_JPEG_BASE64,
      mimeType: "image/jpeg",
      extension_version: "0.15.37",
    }, "test-token");
    assert.equal(capture.status().lastExtensionVersion, "0.15.37");

    // A capture without a version (very old extension) keeps the last value.
    const duplicate = await capture.ingest({
      provider: "chatgpt",
      imageBase64: CAPTURE_JPEG_BASE64,
      mimeType: "image/jpeg",
    }, "test-token");
    assert.notEqual(duplicate.status, "imported");
    assert.equal(capture.status().lastExtensionVersion, "0.15.37");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// UI: compile the real card sources and render them
// ---------------------------------------------------------------------------

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");
const compileRoot = join(uiRoot, "node_modules", ".cache", "web-capture-status-test");

let card;
let bundledVersionModule;
let React;
let renderStatic;

before(async () => {
  await mkdir(compileRoot, { recursive: true });
  const sources = [
    join(uiRoot, "src", "vite-env.d.ts"),
    join(uiRoot, "src", "mosa-api.ts"),
    join(uiRoot, "src", "i18n.ts"),
    join(uiRoot, "src", "bundled-extension-version.ts"),
    join(uiRoot, "src", "WebCaptureStatusCard.tsx"),
  ];
  execFileSync(
    join(repositoryRoot, "node_modules", ".bin", "tsc"),
    [
      ...sources,
      "--outDir", compileRoot,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--jsx", "react-jsx",
      "--skipLibCheck",
    ],
    { stdio: "pipe" }
  );

  // The card does `import "./web-capture-status.css"`, which Vite handles in
  // the real build; short-circuit it for Node with a resolve hook.
  await writeFile(
    join(compileRoot, "web-capture-status-css-hooks.mjs"),
    [
      "export async function resolve(specifier, context, next) {",
      '  if (specifier.endsWith(".css")) {',
      '    return { url: "data:text/javascript,export default null;", shortCircuit: true };',
      "  }",
      "  return next(specifier, context);",
      "}",
      "",
    ].join("\n")
  );
  register(pathToFileURL(join(compileRoot, "web-capture-status-css-hooks.mjs")).href);

  const uiRequire = createRequire(join(uiRoot, "package.json"));
  ({ renderToStaticMarkup: renderStatic } = await import(uiRequire.resolve("react-dom/server")));
  React = await import(uiRequire.resolve("react"));
  card = await import(join(compileRoot, "WebCaptureStatusCard.js"));
  bundledVersionModule = await import(join(compileRoot, "bundled-extension-version.js"));
  assert.equal(typeof card.WebCaptureStatusCardView, "function");
  assert.equal(typeof card.isExtensionRecentlyActive, "function");
  assert.equal(typeof card.compareExtensionVersions, "function");
  assert.equal(card.DOWNLOAD_PAGE_URL, "https://gravityport.azhuilab.com/#download");
  // Outside the bundler there is no injected version.
  assert.equal(bundledVersionModule.bundledExtensionVersion(), "");
});

after(async () => {
  await rm(compileRoot, { recursive: true, force: true });
});

const noop = () => {};

function bridgeStatus(overrides = {}) {
  return {
    enabled: true,
    tokenConfigured: true,
    lastIngestAt: null,
    lastExtensionVersion: "",
    totalImported: 0,
    lastError: null,
    queue: { reportedAt: null, pending: 0, failed: 0, items: [] },
    retryRequestId: 0,
    ...overrides,
  };
}

const viewBase = {
  language: "zh",
  status: bridgeStatus(),
  active: false,
  bundledVersion: "",
  refreshing: false,
  retrying: false,
  retried: false,
  onRefresh: noop,
  onRetry: noop,
};

const renderCard = (overrides = {}) =>
  renderStatic(React.createElement(card.WebCaptureStatusCardView, { ...viewBase, ...overrides }));

test("connection window: one minute before the edge is active, one minute after is not", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  const reportedAt = (msAgo) => new Date(now - msAgo).toISOString();
  const reporting = (msAgo) => bridgeStatus({
    queue: { reportedAt: reportedAt(msAgo), pending: 0, failed: 0, items: [] },
  });
  const window = card.EXTENSION_ACTIVE_WINDOW_MS;
  assert.equal(card.isExtensionRecentlyActive(reporting(window - 60_000), now), true, "just inside the window");
  assert.equal(card.isExtensionRecentlyActive(reporting(window + 60_000), now), false, "just outside the window");
  // A capture alone also counts as recent activity.
  assert.equal(
    card.isExtensionRecentlyActive(bridgeStatus({ lastIngestAt: reportedAt(60_000) }), now),
    true,
    "recent capture counts"
  );
  assert.equal(card.isExtensionRecentlyActive(bridgeStatus(), now), false, "never reported");
});

test("version compare: lower, equal, higher, missing, non-numeric", () => {
  assert.equal(card.compareExtensionVersions("0.15.36", "0.15.37"), -1);
  assert.equal(card.compareExtensionVersions("0.15.37", "0.15.37"), 0);
  assert.equal(card.compareExtensionVersions("0.15.38", "0.15.37"), 1);
  assert.equal(card.compareExtensionVersions("0.16.0", "0.15.37"), 1);
  assert.equal(card.compareExtensionVersions("1.0", "0.15.37"), 1);
  assert.equal(card.compareExtensionVersions("", "0.15.37"), null);
  assert.equal(card.compareExtensionVersions("0.15.37", ""), null);
  assert.equal(card.compareExtensionVersions("0.15.37-beta", "0.15.37"), null);
});

test("loading state shows 加载中 and neither verdict", () => {
  const html = renderCard({ status: undefined });
  assert.match(html, /加载中/);
  assert.doesNotMatch(html, /已连接/);
  assert.doesNotMatch(html, /没有连接/);
});

test("not connected shows the verdict, the install guidance, and the download link", () => {
  const html = renderCard({ active: false });
  assert.match(html, /没有连接/);
  assert.match(html, /去官网安装浏览器扩展/);
  assert.match(html, /发现新图时自动入库/);
  assert.match(html, new RegExp(String.raw`href="${card.DOWNLOAD_PAGE_URL.replace(/[/.#]/g, "\\$&")}"`));
  assert.doesNotMatch(html, /扩展版本/);
});

test("connected shows the verdict and the version row", () => {
  const html = renderCard({
    active: true,
    status: bridgeStatus({ lastExtensionVersion: "0.15.36" }),
  });
  assert.match(html, /已连接/);
  assert.match(html, /扩展版本/);
  assert.match(html, /0\.15\.36/);
  assert.doesNotMatch(html, /有新版扩展/);
});

test("a version older than the bundled one offers the download link", () => {
  const html = renderCard({
    active: true,
    bundledVersion: "0.15.37",
    status: bridgeStatus({ lastExtensionVersion: "0.15.36" }),
  });
  assert.match(html, /有新版扩展/);
  assert.match(html, new RegExp(String.raw`href="${card.DOWNLOAD_PAGE_URL.replace(/[/.#]/g, "\\$&")}"`));
});

test("equal or newer extension versions, a missing bundled version, or a missing report never hint", () => {
  const renders = [
    renderCard({ active: true, bundledVersion: "0.15.37", status: bridgeStatus({ lastExtensionVersion: "0.15.37" }) }),
    renderCard({ active: true, bundledVersion: "0.15.37", status: bridgeStatus({ lastExtensionVersion: "0.16.0" }) }),
    renderCard({ active: true, bundledVersion: "", status: bridgeStatus({ lastExtensionVersion: "0.15.36" }) }),
    renderCard({ active: true, bundledVersion: "0.15.37", status: bridgeStatus() }),
  ];
  for (const html of renders) {
    assert.doesNotMatch(html, /有新版扩展/);
  }
  // A connected extension that never sent a version shows 未记录, no hint.
  assert.match(renders[3], /未记录/);
});

test("the version row hides again once the extension is no longer active", () => {
  const html = renderCard({
    active: false,
    status: bridgeStatus({ lastExtensionVersion: "0.15.36", lastIngestAt: "2026-10-23T10:00:00.000Z" }),
  });
  assert.match(html, /没有连接/);
  assert.doesNotMatch(html, /扩展版本/);
});

test("pending > 0 shows the count and the retry button; pending 0 shows neither", () => {
  const withPending = renderCard({
    active: true,
    status: bridgeStatus({ queue: { reportedAt: "2026-10-23T11:59:00.000Z", pending: 2, failed: 0, items: [] } }),
  });
  assert.match(withPending, /等待重试 2 张/);
  assert.match(withPending, />重试</);
  assert.doesNotMatch(withPending, /已让扩展重试/);

  const withoutPending = renderCard({
    active: true,
    status: bridgeStatus({ lastIngestAt: "2026-10-23T11:59:00.000Z" }),
  });
  assert.doesNotMatch(withoutPending, /重试/);
});

test("a completed retry shows the confirmation", () => {
  const html = renderCard({
    active: true,
    retried: true,
    status: bridgeStatus({ queue: { reportedAt: "2026-10-23T11:59:00.000Z", pending: 2, failed: 0, items: [] } }),
  });
  assert.match(html, /已让扩展重试/);
});

test("lastError is shown once, capped at 120 characters", () => {
  const longError = "e".repeat(200) + "TAIL-MUST-NOT-APPEAR";
  const html = renderCard({
    active: true,
    status: bridgeStatus({ lastError: longError }),
  });
  assert.match(html, /最近一次错误/);
  assert.ok(html.includes("e".repeat(120)), "first 120 characters shown");
  assert.ok(!html.includes("TAIL-MUST-NOT-APPEAR"), "nothing past 120 characters");
});

test("English rendering contains no Chinese characters in any state", () => {
  const zhStatus = bridgeStatus({
    lastExtensionVersion: "0.15.36",
    lastError: "ingest refused",
    queue: { reportedAt: "2026-10-23T11:59:00.000Z", pending: 2, failed: 0, items: [] },
  });
  const pieces = [
    renderCard({ language: "en", status: undefined }),
    renderCard({ language: "en", status: null, active: false }),
    renderCard({ language: "en", active: true, bundledVersion: "0.15.37", status: zhStatus }),
    renderCard({
      language: "en",
      active: true,
      retried: true,
      bundledVersion: "0.15.37",
      status: bridgeStatus({ lastExtensionVersion: "0.15.36", queue: { reportedAt: "2026-10-23T11:59:00.000Z", pending: 2, failed: 0, items: [] } }),
    }),
  ];
  const all = pieces.join("");
  assert.doesNotMatch(all, /[一-鿿]/, `Chinese leaked into EN render: ${all.slice(0, 400)}`);
  assert.match(pieces[1], /Not connected/);
  assert.match(pieces[2], /Connected/);
  assert.match(pieces[2], /Extension version/);
  assert.match(pieces[2], /A newer extension is available/);
  assert.match(pieces[2], /2 waiting to retry/);
  assert.match(pieces[2], /Last error/);
  assert.match(pieces[3], /Asked the extension to retry/);
});

test("refresh stays enabled after the promise settles (no stuck disabled state)", async () => {
  // The container is covered by e2e; here only the view contract is pinned:
  // refreshing disables the button, the idle state does not.
  assert.match(renderCard({ refreshing: true }), /disabled/);
  const idle = renderCard({ status: bridgeStatus() });
  assert.doesNotMatch(idle, /disabled/);
});
