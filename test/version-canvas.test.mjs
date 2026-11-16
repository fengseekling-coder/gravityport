import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");
const compileRoot = join(uiRoot, "node_modules", ".cache", "version-canvas-ui-test");
const tscOut = join(compileRoot, "tsc");
const offDir = join(compileRoot, "off");
const onDir = join(compileRoot, "on");

let React;
let renderStatic;
let offModel;
let onModel;
let offSection;
let onSection;
let canvasMod;
let exportMod;
let i18nMod;
let roundsMod;

async function rewriteViteEnv(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteViteEnv(full);
    } else if (entry.name.endsWith(".js")) {
      const source = await readFile(full, "utf8");
      const rewritten = source
        .replaceAll("import.meta.env.DEV", "false")
        .replaceAll("import.meta.env.PROD", "true");
      if (rewritten !== source) {
        await writeFile(full, rewritten, "utf8");
      }
    }
  }
}

function makeAsset(id, name, overrides = {}) {
  return {
    id,
    name,
    width: 1024,
    height: 1024,
    size_bytes: 120000,
    mime_type: "image/png",
    media_type: "image",
    imported_at: "2026-11-14T10:00:00.000Z",
    favorite: false,
    tags: [],
    group: "未分组",
    image_url: `/api/assets/default/${id}/image`,
    preview_url: `/api/assets/default/${id}/preview`,
    medium_url: `/api/assets/default/${id}/medium`,
    thumbnail_url: `/api/assets/default/${id}/thumb`,
    ...overrides,
  };
}

function makeHistory() {
  const a1 = makeAsset("a1", "hero-v1.png", { imported_at: "2026-11-14T10:00:00.000Z" });
  const a2 = makeAsset("a2", "hero-v2.png", { imported_at: "2026-11-14T10:02:00.000Z" });
  const a3 = makeAsset("a3", "hero-v3.png", { imported_at: "2026-11-14T10:05:00.000Z" });
  return {
    asset_id: "a1",
    generation_ids: ["evt1"],
    output_assets: [a1, a2, a3],
    events: [
      {
        id: "evt1",
        provider: "chatgpt",
        conversation_id: "conv-421",
        message_id: "msg-1",
        output_asset_id: "a1",
        user_prompt: "sunset bottle on stone",
        effective_prompt: "sunset bottle on stone",
        created_at: "2026-11-14T10:00:00.000Z",
        verification_level: "observed",
      },
      {
        id: "evt2",
        provider: "chatgpt",
        conversation_id: "conv-421",
        message_id: "msg-2",
        output_asset_id: "a2",
        user_prompt: "warmer golden rim light",
        effective_prompt: "warmer golden rim light",
        created_at: "2026-11-14T10:02:00.000Z",
        verification_level: "observed",
      },
      {
        id: "evt3",
        provider: "chatgpt",
        conversation_id: "conv-421",
        message_id: "msg-3",
        output_asset_id: "a3",
        user_prompt: "minimal shadow background",
        effective_prompt: "minimal shadow background",
        created_at: "2026-11-14T10:05:00.000Z",
        verification_level: "observed",
      },
    ],
    context_events: [],
    relations: [
      {
        id: "rel-1",
        parent_generation_id: "evt1",
        child_generation_id: "evt2",
        relation_type: "variant_of",
        verification_level: "user_confirmed",
        evidence: { user_selected_parent: true },
        created_at: "2026-11-14T10:02:30.000Z",
      },
      {
        id: "rel-ignored",
        parent_generation_id: "evt1",
        child_generation_id: "evt3",
        relation_type: "derived_from",
        verification_level: "observed",
        created_at: "2026-11-14T10:05:10.000Z",
      },
    ],
    relation_candidates: [
      {
        id: "cand-low",
        parent_generation_id: "evt1",
        child_generation_id: "evt3",
        suggested_relation_type: "derived_from",
        status: "suggested",
        confidence: 0.41,
        evidence: { turn_distance: 2 },
        created_at: "2026-11-14T10:05:05.000Z",
      },
      {
        id: "cand-best",
        parent_generation_id: "evt2",
        child_generation_id: "evt3",
        suggested_relation_type: "edited_from",
        status: "suggested",
        confidence: 0.91,
        evidence: { explicit_ref: true },
        created_at: "2026-11-14T10:05:06.000Z",
      },
      {
        id: "cand-dismissed",
        parent_generation_id: "evt1",
        child_generation_id: "evt3",
        suggested_relation_type: "based_on",
        status: "dismissed",
        confidence: 0.99,
        created_at: "2026-11-14T10:05:07.000Z",
      },
    ],
  };
}

function findElements(node, predicate, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  if (node.props && node.props.children !== undefined) {
    findElements(node.props.children, predicate, acc);
  }
  return acc;
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node.props && node.props.children !== undefined) return textOf(node.props.children);
  return "";
}

function makeSectionProps(history, overrides = {}) {
  const current = history.output_assets[0];
  const tr = (text) => i18nMod.translate(text, "zh");
  return {
    asset: current,
    selected: current.id,
    project: "default",
    language: "zh",
    tr,
    fillNamed: (text, values) => text.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? "")),
    versions: [],
    generationHistory: history,
    versionRounds: roundsMod.computeConversationRounds(history, current.id),
    inspectorFetchError: { versions: false, history: false, recipes: false },
    relationBusy: false,
    relationDrafts: {},
    newRelation: null,
    showAllRelationChoices: false,
    versionTreeOpen: false,
    setVersionTreeOpen: () => {},
    setNewRelation: () => {},
    setRelationDrafts: () => {},
    setShowAllRelationChoices: () => {},
    timeLabel: (value) => value || "",
    relationPairLine: () => "hero-v1 -> hero-v2",
    roundText: (n) => `第 ${n} 轮`,
    selectHistoryAsset: () => {},
    mutateRelation: async (action) => { await action(); },
    providerDisplayLabel: (provider) => provider,
    onOpenCanvas: () => {},
    ...overrides,
  };
}

before(async () => {
  await rm(compileRoot, { recursive: true, force: true });
  await mkdir(tscOut, { recursive: true });
  execFileSync(
    join(repositoryRoot, "node_modules", ".bin", "tsc"),
    [
      join(uiRoot, "src", "vite-env.d.ts"),
      join(uiRoot, "src", "VersionSection.tsx"),
      join(uiRoot, "src", "VersionCanvas.tsx"),
      "--outDir", tscOut,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--jsx", "react-jsx",
      "--skipLibCheck",
    ],
    { stdio: "pipe" },
  );
  await rewriteViteEnv(tscOut);
  await cp(tscOut, offDir, { recursive: true });
  await cp(tscOut, onDir, { recursive: true });

  await writeFile(
    join(compileRoot, "hooks.mjs"),
    [
      'import { existsSync } from "node:fs";',
      'import { dirname, resolve as resolvePath } from "node:path";',
      'import { fileURLToPath, pathToFileURL } from "node:url";',
      "export async function resolve(specifier, context, nextResolve) {",
      '  if (specifier.endsWith(".css")) return { url: "data:text/javascript,export default null;", shortCircuit: true };',
      '  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {',
      "    const parentDir = dirname(fileURLToPath(context.parentURL));",
      '    if (!existsSync(resolvePath(parentDir, specifier)) && existsSync(resolvePath(parentDir, specifier + ".js"))) {',
      '      return { url: pathToFileURL(resolvePath(parentDir, specifier + ".js")).href, shortCircuit: true };',
      "    }",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  register(pathToFileURL(join(compileRoot, "hooks.mjs")).href);

  const uiRequire = createRequire(join(uiRoot, "package.json"));
  React = await import(uiRequire.resolve("react"));
  ({ renderToStaticMarkup: renderStatic } = await import(uiRequire.resolve("react-dom/server")));

  const previousStorage = globalThis.localStorage;
  try {
    delete globalThis.localStorage;
    offModel = await import(pathToFileURL(join(offDir, "version-canvas-model.js")).href);
    offSection = await import(pathToFileURL(join(offDir, "VersionSection.js")).href);
    canvasMod = await import(pathToFileURL(join(offDir, "VersionCanvas.js")).href);
    exportMod = await import(pathToFileURL(join(offDir, "version-canvas-export.js")).href);
    i18nMod = await import(pathToFileURL(join(offDir, "i18n.js")).href);
    roundsMod = await import(pathToFileURL(join(offDir, "conversation-rounds.js")).href);

    globalThis.localStorage = {
      getItem: (key) => (key === "gravityport.dev.version-canvas" ? "1" : null),
    };
    onModel = await import(pathToFileURL(join(onDir, "version-canvas-model.js")).href);
    onSection = await import(pathToFileURL(join(onDir, "VersionSection.js")).href);
  } finally {
    if (previousStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previousStorage;
    }
  }
});

after(async () => {
  await rm(compileRoot, { recursive: true, force: true });
});

describe("VersionCanvas entry gate & model (task 421)", () => {
  it("gates VERSION_CANVAS_ENTRY off by default in built mode and enables it via localStorage", () => {
    assert.equal(offModel.VERSION_CANVAS_ENTRY, false, "default built build must keep switch OFF");
    assert.equal(onModel.VERSION_CANVAS_ENTRY, true, "localStorage flag must turn switch ON");
  });

  it("preserves legacy toggle behavior when switch is OFF", () => {
    const history = makeHistory();
    let toggleCalls = [];
    let openCalls = 0;
    let tree = null;
    function Capture() {
      tree = offSection.VersionSection(
        makeSectionProps(history, {
          setVersionTreeOpen: (next) => toggleCalls.push(next),
          onOpenCanvas: () => { openCalls += 1; },
        }),
      );
      return tree;
    }
    const html = renderStatic(React.createElement(Capture));
    assert.match(html, />查看</);
    const buttons = findElements(tree, (el) => el.type === "button" && el.props?.className === "section-action");
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].props["aria-expanded"], false);
    buttons[0].props.onClick();
    assert.deepEqual(toggleCalls, [true]);
    assert.equal(openCalls, 0);
  });

  it("routes the existing expand button directly into VersionCanvas when switch is ON", () => {
    const history = makeHistory();
    let toggleCalls = 0;
    let openCalls = 0;
    let tree = null;
    function Capture() {
      tree = onSection.VersionSection(
        makeSectionProps(history, {
          versionTreeOpen: true,
          setVersionTreeOpen: () => { toggleCalls += 1; },
          onOpenCanvas: () => { openCalls += 1; },
        }),
      );
      return tree;
    }
    const html = renderStatic(React.createElement(Capture));
    assert.match(html, /class="settings-badge"/, "existing badge count remains intact");
    assert.match(html, />查看</, "button copy stays 查看 without introducing a new button");
    const buttons = findElements(tree, (el) => el.type === "button" && el.props?.className === "section-action");
    assert.equal(buttons.length, 1);
    assert.equal(textOf(buttons[0]), "查看");
    assert.equal(buttons[0].props["aria-expanded"], false);
    buttons[0].props.onClick();
    assert.equal(openCalls, 1);
    assert.equal(toggleCalls, 0);
  });

  it("maps real generationHistory into nodes, confirmed edges, highest-confidence suggested edge, and final path", () => {
    const history = makeHistory();
    const doc = offModel.canvasFromHistory(history, history.output_assets[0], (v) => v || "");
    assert.deepEqual(doc.nodes.map((n) => n.id), ["a1", "a2", "a3"]);
    assert.deepEqual(doc.nodes.map((n) => n.column), [0, 1, 2]);
    assert.equal(doc.edges.length, 2);

    const confirmed = doc.edges.find((e) => e.id === "a1:a2");
    assert.ok(confirmed);
    assert.equal(confirmed.suggested, false);
    assert.equal(confirmed.type, "variant_of");
    assert.equal(confirmed.parentGenerationId, "evt1");
    assert.equal(confirmed.childGenerationId, "evt2");

    const suggested = doc.edges.find((e) => e.id === "a2:a3");
    assert.ok(suggested, "highest-confidence suggested candidate wins over weaker and dismissed candidates");
    assert.equal(suggested.suggested, true);
    assert.equal(suggested.type, "edited_from");
    assert.equal(suggested.confidence, 0.91);

    const nodesFinal2 = doc.nodes.map((n) => (n.id === "a2" ? { ...n, final: true } : n));
    assert.deepEqual([...offModel.finalPathIds(nodesFinal2, doc.edges)].sort(), ["a1", "a2"]);
    const nodesFinal3 = doc.nodes.map((n) => (n.id === "a3" ? { ...n, final: true } : n));
    assert.deepEqual([...offModel.finalPathIds(nodesFinal3, doc.edges)], ["a3"], "final path only traces confirmed edges");

    const detour = offModel.edgeCurve(doc.nodes[0], doc.nodes[2]);
    assert.match(detour, /Q /, "multi-column skip routes below cards");

    const fallback = offModel.canvasFromHistory(null, makeAsset("solo", "solo.png"));
    assert.equal(fallback.nodes.length, 1);
    assert.equal(fallback.nodes[0].id, "solo");
    assert.equal(fallback.edges.length, 0);
  });

  it("fits each card to its image inside the fixed slot so tall and wide images get no bars", () => {
    const { nodeBox, NODE_WIDTH, NODE_HEIGHT, edgeCurve } = onModel;
    const slot = { x: 100, y: 50 };
    assert.deepEqual(nodeBox({ ...slot, width: 1080, height: 1920 }), { x: 100 + Math.round((NODE_WIDTH - 153) / 2), y: 50, width: 153, height: NODE_HEIGHT });
    assert.deepEqual(nodeBox({ ...slot, width: 1920, height: 1080 }), { x: 100, y: 50 + Math.round((NODE_HEIGHT - 115) / 2), width: NODE_WIDTH, height: 115 });
    assert.deepEqual(nodeBox({ ...slot, width: 0, height: 0 }), { x: 100, y: 50, width: NODE_WIDTH, height: NODE_HEIGHT });
    const tall = { ...slot, width: 1080, height: 1920, column: 0 };
    const next = { x: 100 + 286, y: 50, width: 1080, height: 1920, column: 1 };
    const box = nodeBox(tall);
    assert.ok(edgeCurve(tall, next).startsWith(`M ${box.x + box.width} ${50 + NODE_HEIGHT / 2} `), "edges start at the card's real right edge");
  });

  it("wires confirm and dismiss actions to generation-relation APIs", async () => {
    const requests = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), method: init?.method || "GET", body: init?.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const edge = {
        childGenerationId: "evt3",
        parentGenerationId: "evt2",
        type: "edited_from",
        evidence: { explicit_ref: true },
      };
      await offModel.submitCanvasCandidateAction("default", edge, true);
      await offModel.submitCanvasCandidateAction("default", edge, false);
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "POST");
    assert.match(requests[0].url, /\/api\/generation-relations$/);
    assert.deepEqual(requests[0].body, {
      projectId: "default",
      childGenerationId: "evt3",
      parentGenerationId: "evt2",
      relationType: "edited_from",
      verificationLevel: "user_confirmed",
      evidence: {
        explicit_ref: true,
        source: "gravityport-inspector",
        user_confirmed_relation: true,
      },
    });
    assert.equal(requests[1].method, "PATCH");
    assert.match(requests[1].url, /\/api\/generation-relation-candidates$/);
    assert.deepEqual(requests[1].body, {
      projectId: "default",
      childGenerationId: "evt3",
      parentGenerationId: "evt2",
      status: "dismissed",
    });
  });

  it("plans drag-to-link from the side dots and posts a user-confirmed relation", async () => {
    const nodes = [
      { id: "a1", assetId: "a1" },
      { id: "a2", assetId: "a2" },
      { id: "a3", assetId: "a3" },
      { id: "a4", assetId: "a4" },
    ];
    const gen = { a1: "evt1", a2: "evt2", a3: "evt3" };
    const lookup = (assetId) => gen[assetId] || "";
    const edges = [
      { id: "e1", from: "a1", to: "a2", parentGenerationId: "evt1", childGenerationId: "evt2", type: "variant_of", suggested: false },
      { id: "e2", from: "a2", to: "a3", parentGenerationId: "evt2", childGenerationId: "evt3", type: "derived_from", suggested: true, evidence: { explicit_ref: true } },
    ];
    const plan = (from, to, side) => offModel.planCanvasLink(nodes, edges, from, to, side, lookup);

    assert.deepEqual(plan("a1", "a1", "out"), { kind: "self" });
    assert.deepEqual(plan("a1", "a2", "out"), { kind: "exists" });
    assert.deepEqual(plan("a2", "a1", "out"), { kind: "exists" }, "a confirmed edge blocks the reverse direction too");
    assert.deepEqual(plan("a2", "a3", "out"), { kind: "confirm", edge: edges[1] });
    assert.deepEqual(plan("a3", "a2", "in"), { kind: "confirm", edge: edges[1] }, "left dot drags back to the parent");
    assert.deepEqual(plan("a1", "a4", "out"), { kind: "missing" });
    assert.deepEqual(plan("a1", "a3", "out"), {
      kind: "create", parentId: "a1", childId: "a3", parentGenerationId: "evt1", childGenerationId: "evt3",
    });
    assert.deepEqual(plan("a1", "a3", "in"), {
      kind: "create", parentId: "a3", childId: "a1", parentGenerationId: "evt3", childGenerationId: "evt1",
    });

    const requests = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), method: init?.method || "GET", body: init?.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await offModel.submitCanvasLink("default", plan("a1", "a3", "out"));
      await offModel.submitCanvasLink("default", plan("a2", "a3", "out"));
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "POST");
    assert.match(requests[0].url, /\/api\/generation-relations$/);
    assert.deepEqual(requests[0].body, {
      projectId: "default",
      childGenerationId: "evt3",
      parentGenerationId: "evt1",
      relationType: "edited_from",
      verificationLevel: "user_confirmed",
      evidence: { canvas_link: true, source: "gravityport-inspector", user_confirmed_relation: true },
    });
    assert.equal(requests[1].body.relationType, "derived_from", "confirming a suggestion keeps its suggested type");
    assert.deepEqual(requests[1].body.evidence, { explicit_ref: true, source: "gravityport-inspector", user_confirmed_relation: true });
  });

  it("renders VersionCanvas with moved inspector features and zero sample artifacts", () => {
    const history = makeHistory();
    const html = renderStatic(
      React.createElement(canvasMod.default, {
        ...makeSectionProps(history),
        versions: [
          { id: "a1", name: "hero-v1.png", is_current: true, created_at: "2026-11-14T10:00:00.000Z" },
          { id: "a2", name: "hero-v2.png", is_current: false, created_at: "2026-11-14T10:02:00.000Z" },
        ],
        onClose: () => {},
        onOpenAsset: () => {},
        onSelectVersion: () => {},
      }),
    );
    for (const required of [
      "本页暂存",
      "返回素材库",
      "生成关系",
      "版本对比",
      "版本历史",
      "保存关系",
      "删除关系",
      "导出版本树",
    ]) {
      assert.ok(html.includes(required), `VersionCanvas output missing "${required}"`);
    }
    for (const forbidden of ["exampleCanvas", "示例", "coffee"]) {
      assert.ok(!html.includes(forbidden), `VersionCanvas must omit "${forbidden}"`);
    }
    assert.match(html, /<g class="suggested">/, "suggested relations still draw as dashed lines");
    assert.ok(!html.includes("添加生成关系"), "the canvas adds relations by dragging between card dots, not a form");
    assert.ok(!html.includes("可能改自"), "suggested lines carry no label on the board");
  });

  it("keeps canvas sources free of sample leftovers and adheres to export/i18n norms", async () => {
    const files = [
      join(uiRoot, "src", "VersionCanvas.tsx"),
      join(uiRoot, "src", "version-canvas-model.ts"),
      join(uiRoot, "src", "version-canvas-export.ts"),
      join(uiRoot, "src", "version-canvas.css"),
    ];
    const contents = await Promise.all(files.map((p) => readFile(p, "utf8")));
    const joined = contents.join("\n");
    for (const forbidden of [
      "exampleCanvas",
      "/version-canvas/",
      "coffee-",
      "vc-example-label",
      "canvas-inspector-entry",
      "window.confirm(",
    ]) {
      assert.ok(!joined.includes(forbidden), `Canvas source must not contain "${forbidden}"`);
    }

    assert.match(
      contents[0],
      /useState\(\{\s*prompts:\s*false,\s*sources:\s*false,\s*notes:\s*true/s,
      "Export options must default prompts & sources to OFF",
    );

    const canvasObj = {
      width: 100,
      height: 100,
      toDataURL: () => "data:image/jpeg;base64," + Buffer.from("ff", "hex").toString("base64"),
    };
    const pdf = await exportMod.canvasPdf(canvasObj);
    const pdfText = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
    assert.ok(pdfText.startsWith("%PDF-1.4"));
    assert.ok(pdfText.includes("%%EOF"));

    const drawnTexts = [];
    const origImage = globalThis.Image;
    const origDocument = globalThis.document;
    const origPath2D = globalThis.Path2D;
    globalThis.Path2D = class FakePath2D {};
    globalThis.Image = class FakeImage {
      set src(_v) {
        queueMicrotask(() => this.onload && this.onload());
      }
    };
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          scale() {},
          fillRect() {},
          fillText(text) { drawnTexts.push(String(text)); },
          translate() {},
          beginPath() {},
          roundRect() {},
          fill() {},
          drawImage() {},
          ellipse() {},
          stroke() {},
          setLineDash() {},
          measureText(t) { return { width: t.length * 6 }; },
        }),
      }),
    };
    try {
      const doc = offModel.canvasFromHistory(makeHistory(), makeAsset("a1", "hero-v1.png"));
      await exportMod.renderCanvasExport(doc.title, doc.nodes, doc.edges, { prompts: false, sources: false, notes: true }, "zh");
      assert.ok(!drawnTexts.some((t) => t.includes("sunset bottle on stone")), "prompts stay excluded by default");
      assert.ok(!drawnTexts.some((t) => t.includes("chatgpt")), "sources stay excluded by default");
    } finally {
      if (origImage === undefined) delete globalThis.Image; else globalThis.Image = origImage;
      if (origDocument === undefined) delete globalThis.document; else globalThis.document = origDocument;
      if (origPath2D === undefined) delete globalThis.Path2D; else globalThis.Path2D = origPath2D;
    }

    const canvasSource = contents[0] + "\n" + contents[2];
    const literals = [...canvasSource.matchAll(/(?:\btr|fillNamed)\(\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(literals.length > 30, "extracted VersionCanvas translation strings");
    for (const zh of literals) {
      if (!/[\u4e00-\u9fff]/.test(zh)) continue;
      assert.doesNotMatch(zh, /[你]|我们/, `ZH copy must not address user with 你/我们: ${zh}`);
      const en = i18nMod.translate(zh, "en");
      assert.notEqual(en, zh, `Missing EN translation for "${zh}"`);
      assert.doesNotMatch(en, /\b(you|your|yourself)\b/i, `EN copy must not address user with you/your/yourself: ${en}`);
    }
  });
});
