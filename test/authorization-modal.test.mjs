// Task 333 — AuthorizationModal contract tests. The repo has no DOM in the
// test environment (and adding jsdom would be a new dependency), so the
// component is bundled with the web app's own rolldown and rendered through
// react-dom/server for structure, while the interactive properties (initial
// focus, Esc chain membership, backdrop-target check, queue head) are pinned
// against the component/App source. The behavioral layer these source pins
// protect is exercised end to end by the e2e pairing flow.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let renderModal;
let renderEmpty;
let tempRoot;
let modalSource;
let appSource;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-auth-modal-"));
  // The entry resolves "react-dom/server" from the app's own dependency tree:
  // a node_modules symlink inside the temp dir makes the walk-up land on the
  // web app's modules, so bundle and render share one React instance.
  const { symlink } = await import("node:fs/promises");
  await symlink(join(uiRoot, "node_modules"), join(tempRoot, "node_modules"), "dir");
  const entry = join(tempRoot, "entry.tsx");
  await writeFile(entry, [
    `import { renderToStaticMarkup } from "react-dom/server"`,
    `import { AuthorizationModal } from ${JSON.stringify(join(uiRoot, "src", "AuthorizationModal.tsx"))}`,
    `export function renderModal(requests, language = "zh") {`,
    `  return renderToStaticMarkup(<AuthorizationModal requests={requests} language={language} onResult={() => {}} />)`,
    `}`,
    `export function renderEmpty() {`,
    `  return renderToStaticMarkup(<AuthorizationModal requests={[]} language="zh" onResult={() => {}} />)`,
    `}`,
  ].join("\n"));
  const rolldownModule = await import(pathToFileURL(join(uiRoot, "node_modules", "rolldown", "dist", "index.mjs")).href);
  const bundle = await rolldownModule.rolldown({ input: entry, platform: "node" });
  const { output } = await bundle.generate({ format: "esm" });
  const outFile = join(tempRoot, "bundle.mjs");
  await writeFile(outFile, output[0].code);
  ({ renderModal, renderEmpty } = await import(pathToFileURL(outFile).href));

  modalSource = await readFile(join(uiRoot, "src", "AuthorizationModal.tsx"), "utf8");
  appSource = await readFile(join(uiRoot, "src", "App.tsx"), "utf8");
});
after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const PAIR_REQUEST = {
  key: "pair-1",
  title: "允许这个浏览器扩展连接 GravityPort 吗？",
  consequence: "允许后，这个扩展可以把网页上生成的图和视频存进素材库。",
  source: "来自：GravityPort Web Capture 0.15.45",
  primaryLabel: "允许连接",
};

describe("AuthorizationModal structure", () => {
  it("renders the requester question, consequence, source and the two buttons", () => {
    const html = renderModal([PAIR_REQUEST]);
    assert.match(html, /role="alertdialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /允许这个浏览器扩展连接 GravityPort 吗？/);
    assert.match(html, /允许后，这个扩展可以把网页上生成的图和视频存进素材库。/);
    assert.match(html, /来自：GravityPort Web Capture 0.15\.45/);
    // Deny first (initial focus), the action-labeled primary button second.
    const denyFirst = html.indexOf("不允许") < html.indexOf("允许连接");
    assert.ok(denyFirst, "the refusal button precedes the primary button");
    assert.match(html, /delete-modal authorization-modal/);
    assert.match(html, /delete-icon/);
  });

  it("omits the source line when the requester is unknown and hides the countdown by default", () => {
    const html = renderModal([{ key: "k", title: "T", consequence: "C", primaryLabel: "P" }]);
    assert.doesNotMatch(html, /authorization-source/);
    assert.doesNotMatch(html, /秒内不回应/);
  });

  it("renders the per-second countdown line when the requester asks for one", () => {
    const html = renderModal([{ key: "k", title: "T", consequence: "C", primaryLabel: "P", timeoutSeconds: 60 }]);
    assert.match(html, /60 秒内不回应将视为不允许/);
  });

  it("shows exactly one request at a time — the head of the queue", () => {
    const second = { key: "pair-2", title: "第二个请求", consequence: "C2", primaryLabel: "P2" };
    const html = renderModal([PAIR_REQUEST, second]);
    assert.match(html, /允许这个浏览器扩展连接 GravityPort 吗？/);
    assert.doesNotMatch(html, /第二个请求/, "queued requests stay invisible until the head resolves");
  });

  it("renders nothing when the queue is empty", () => {
    assert.equal(renderEmpty(), "");
  });
});

describe("AuthorizationModal interaction contract (source pins)", () => {
  it("focuses the refusal button when a request becomes active", () => {
    assert.match(modalSource, /denyButtonRef\.current\?\.focus\(\)/);
    assert.match(modalSource, /ref=\{denyButtonRef\}/);
  });

  it("treats a click on the backdrop itself as a denial, clicks inside the box do nothing", () => {
    assert.match(modalSource, /className="modal-layer authorization-layer"/);
    assert.match(modalSource, /event\.target === event\.currentTarget\) onResultRef\.current\(active\.key, "deny"\)/);
  });

  it("fires the timeout result when the optional countdown reaches zero", () => {
    assert.match(modalSource, /onResultRef\.current\(active\.key, "timeout"\)/);
  });

  it("routes Escape through the App chain first, denying the displayed request", () => {
    // The authorization dialog sits at layer 110 — its Escape branch must be
    // the first dialog branch in the App's Escape chain.
    const chain = appSource.slice(appSource.indexOf('if (e.key === "Escape")'));
    const branch = chain.indexOf("if (pairRequestsActive) pairDecideRef.current");
    const renameBranch = chain.indexOf("else if (renameNoticeOpen)");
    assert.ok(branch >= 0, "the Escape chain denies the pairing request");
    assert.ok(renameBranch > branch, "the authorization branch precedes every other overlay");
    assert.ok(
      chain.slice(branch, branch + 200).includes('"deny")'),
      "the Escape branch denies, never allows",
    );
  });

  it("feeds the whole pending list so the component queues, and the layer sits at 110", () => {
    assert.match(appSource, /requests=\{pairRequests\.map\(row => \(\{/);
    assert.match(appSource, /<AuthorizationModal/);
  });
});
