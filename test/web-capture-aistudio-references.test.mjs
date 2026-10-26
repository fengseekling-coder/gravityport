// Tests for the AI Studio generation-block reference capture in
// extensions/chatgpt-web-capture/provider-sites.js. The real provider source
// runs inside a vm sandbox against a fake DOM shaped like the real page:
// ms-chat-turn#turn-<UUID> > div.chat-turn-container.<user|model> with
// ms-prompt-chunk > ms-image-chunk > img blob: elements, collapsible empty
// shells, and a rendered text turn for the existing prompt association.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { setImmediate } from "node:timers";

const providerPolicySource = await readFile(new URL("../extensions/chatgpt-web-capture/provider-policy.js", import.meta.url), "utf8");
const providerSource = await readFile(new URL("../extensions/chatgpt-web-capture/provider-sites.js", import.meta.url), "utf8");

const UUID = {
  ref1: "0A0A0A0A-1111-2222-3333-000000000001",
  ref2: "0A0A0A0A-1111-2222-3333-000000000002",
  text: "0A0A0A0A-1111-2222-3333-000000000003",
  thought: "0A0A0A0A-1111-2222-3333-000000000004",
  shell1: "0A0A0A0A-1111-2222-3333-000000000005",
  shell2: "0A0A0A0A-1111-2222-3333-000000000006",
  output: "0A0A0A0A-1111-2222-3333-000000000007",
  refA: "0A0A0A0A-1111-2222-3333-00000000000A",
  textA: "0A0A0A0A-1111-2222-3333-00000000000B",
  outA: "0A0A0A0A-1111-2222-3333-00000000000C",
  refB: "0A0A0A0A-1111-2222-3333-00000000000D",
  textB: "0A0A0A0A-1111-2222-3333-00000000000E",
  outB: "0A0A0A0A-1111-2222-3333-00000000000F",
};
const REF1_BLOB = "blob:https://aistudio.google.com/11111111-2222-3333-4444-555555555555";
const REF2_BLOB = "blob:https://aistudio.google.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OUTPUT_BLOB = "blob:https://aistudio.google.com/99999999-8888-7777-6666-555555555555";
const THOUGHT_BLOB = "blob:https://aistudio.google.com/77777777-6666-5555-4444-333333333333";
const BLOCK_A_REF = "blob:https://aistudio.google.com/a0000000-0000-0000-0000-00000000000a";
const BLOCK_A_OUT = "blob:https://aistudio.google.com/a0000000-0000-0000-0000-00000000000b";
const BLOCK_B_REF = "blob:https://aistudio.google.com/b0000000-0000-0000-0000-00000000000a";
const BLOCK_B_OUT = "blob:https://aistudio.google.com/b0000000-0000-0000-0000-00000000000b";
const EDITOR_BLOB = "blob:https://aistudio.google.com/e0000000-0000-0000-0000-00000000000e";
const BLOCK1_ID = `ai-studio-turn:${UUID.ref1}`;
const BLOCK_A_ID = `ai-studio-turn:${UUID.refA}`;
const BLOCK_B_ID = `ai-studio-turn:${UUID.refB}`;
const LONG_PROMPT = "把这张参考图里的角色画成黄昏光线的插画，保持服装细节和配色不变，背景改成雨后的街道。".repeat(30);

class FakeElement {
  constructor(tagName, { attributes = {}, classes = [] } = {}) {
    this.nodeType = 1;
    this.tagName = tagName;
    this.attributes = { ...attributes };
    const classSet = new Set(classes);
    this.classList = { contains: (name) => classSet.has(name) };
    this.children = [];
    this.parent = null;
    this.rect = { left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480 };
  }

  get id() { return this.attributes.id || ""; }
  get parentElement() { return this.parent; }
  get childNodes() { return this.children; }
  get previousElementSibling() {
    const siblings = (this.parent?.children || []).filter((child) => child.nodeType === 1);
    return siblings[siblings.indexOf(this) - 1] || null;
  }

  append(child) { child.parent = this; this.children.push(child); return child; }

  remove() {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  getAttribute(name) { return this.attributes[name] ?? null; }
  getBoundingClientRect() { return this.rect; }
}

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
  }
}

class FakeImage extends FakeElement {
  constructor({ src, naturalWidth = 0, naturalHeight = 0, width = 0, height = 0, complete = true } = {}) {
    super("img");
    this.src = src;
    this.currentSrc = src;
    this.complete = complete;
    this.naturalWidth = naturalWidth;
    this.naturalHeight = naturalHeight;
    this.width = width;
    this.height = height;
  }
}

class FakeVideo extends FakeElement {
  constructor({ src = "", videoWidth = 0, videoHeight = 0, duration = 0, readyState = 2 } = {}) {
    super("video");
    this.src = src;
    this.currentSrc = src;
    this.videoWidth = videoWidth;
    this.videoHeight = videoHeight;
    this.duration = duration;
    this.readyState = readyState;
  }
}

function collect(root, predicate) {
  const found = [];
  const walk = (node) => {
    if (node.nodeType !== 1) return;
    for (const child of node.children) {
      if (predicate(child)) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function createHarness({
  blobs = new Map(),
  fetchFailures = new Set(),
  rejectIngest = null,
  holdReferenceIngest = false,
} = {}) {
  const heldReferenceIngests = [];
  const root = new FakeElement("html");
  const context = {
    URL,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    innerWidth: 1200,
    innerHeight: 1200,
    location: {
      href: "https://aistudio.google.com/prompts/abc",
      origin: "https://aistudio.google.com",
      hostname: "aistudio.google.com",
      pathname: "/prompts/abc",
    },
    document: {
      documentElement: root,
      body: root,
      get images() { return collect(root, (node) => node instanceof FakeImage); },
      querySelectorAll: (selector) => (String(selector) === "video" ? collect(root, (node) => node instanceof FakeVideo) : []),
      addEventListener: () => {},
      getElementById: () => null,
      createElement: () => ({ style: {}, setAttribute: () => {}, replaceChildren: () => {}, appendChild: () => {} }),
    },
    HTMLImageElement: FakeImage,
    HTMLVideoElement: FakeVideo,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    MutationObserver: class {
      constructor(callback) { context.mutationCallback = callback; }
      observe() {}
      disconnect() {}
    },
    messages: [],
    fetchCalls: [],
    blobBytes: blobs,
    fetchFailures,
    rejectIngest,
    heldReferenceIngests,
    __pendingTimers: [],
    setTimeout: (fn) => { context.__pendingTimers.push(fn); return context.__pendingTimers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async (url) => {
      const key = String(url);
      context.fetchCalls.push(key);
      const entry = blobs.get(key);
      if (fetchFailures.has(key) || !entry) return { ok: false, status: 404 };
      return {
        ok: true,
        status: 200,
        blob: async () => ({
          size: entry.size,
          type: entry.type,
          arrayBuffer: async () => new Uint8Array(entry.size).fill(7).buffer,
          slice: (start, end) => ({
            arrayBuffer: async () => new Uint8Array(Math.max(0, end - start)).fill(7).buffer,
          }),
        }),
      };
    },
    chrome: {
      runtime: {
        id: "test-extension",
        sendMessage: async (message) => {
          context.messages.push(message);
          if (message.type === "mosa.getSettings") return { ok: true, settings: { autoCapture: true } };
          if (message.type === "mosa.ingest" && rejectIngest?.(message.payload)) {
            return { ok: false, error: "rejected by test" };
          }
          if (holdReferenceIngest && message.type === "mosa.ingest" && message.payload?.isReference) {
            return new Promise((resolve) => heldReferenceIngests.push(() => resolve({ ok: true })));
          }
          return { ok: true };
        },
        onMessage: { addListener: () => {} },
      },
      storage: {
        local: { get: async (defaults) => ({ ...defaults }) },
        onChanged: { addListener: () => {} },
      },
    },
  };
  vm.runInNewContext(`${providerPolicySource}\n${providerSource}`, context, { filename: "provider-sites.js" });
  return { context, root };
}

async function settle(rounds = 30) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Runs one scan: the pending timers hold the provider's debounced scan callback
// plus any prompt-retry timers, so drain the queue after every mutation and let
// each spawned async chain (reference fetch + ingest, output capture, replay)
// run to completion.
async function runScan(context) {
  context.mutationCallback();
  await settle();
  while (context.__pendingTimers.length) {
    context.__pendingTimers.shift()();
    await settle();
  }
}

function ingestPayloads(context) {
  return context.messages.filter((message) => message.type === "mosa.ingest").map((message) => message.payload);
}

function el(tagName, { attributes = {}, classes = [] } = {}) {
  return new FakeElement(tagName, { attributes, classes });
}

// The real page structure from a Nano Banana Pro conversation: two user turns
// with uploaded reference images, one user text turn, a model thought turn
// with a small sketch, two collapsed model shells, and the model output turn.
function buildStandardConversation(root, {
  includeOutput = true,
  refNaturalWidth = 2250,
} = {}) {
  const session = root.append(el("div", { classes: ["chat-session-content"] }));
  const appendUserImageTurn = (uuid, blobUrl) => {
    const turn = session.append(el("ms-chat-turn", { attributes: { id: `turn-${uuid}` } }));
    const container = turn.append(el("div", { classes: ["chat-turn-container", "render", "user"] }));
    const chunk = container.append(el("ms-prompt-chunk"));
    const imageChunk = chunk.append(el("ms-image-chunk"));
    const img = imageChunk.append(new FakeImage({
      src: blobUrl, naturalWidth: refNaturalWidth, naturalHeight: 4872, width: 115, height: 248,
    }));
    img.rect = { left: 0, top: 0, right: 115, bottom: 248, width: 115, height: 248 };
    return { turn, container, img };
  };
  const appendUserTextTurn = (uuid, promptText) => {
    const turn = session.append(el("ms-chat-turn", { attributes: { id: `turn-${uuid}` } }));
    const container = turn.append(el("div", { classes: ["chat-turn-container", "render", "user"] }));
    const chunk = container.append(el("ms-prompt-chunk"));
    const promptContainer = chunk.append(el("div", { classes: ["user-prompt-container"] }));
    const textChunk = promptContainer.append(el("ms-text-chunk"));
    textChunk.append(el("ms-cmark-node")).append(new FakeText(promptText));
    return { turn, container };
  };
  const appendThoughtTurn = (uuid) => {
    const turn = session.append(el("ms-chat-turn", { attributes: { id: `turn-${uuid}` } }));
    const container = turn.append(el("div", { classes: ["chat-turn-container", "render", "model"] }));
    const chunk = container.append(el("ms-prompt-chunk"));
    const thought = chunk.append(el("ms-thought-chunk"));
    const panel = thought.append(el("mat-accordion")).append(el("mat-expansion-panel"));
    const imageChunk = panel.append(el("ms-image-chunk"));
    imageChunk.append(new FakeImage({ src: THOUGHT_BLOB, naturalWidth: 300, naturalHeight: 300, width: 100, height: 100 }));
    return { turn, container };
  };
  const appendShellTurn = (uuid, role) => {
    const turn = session.append(el("ms-chat-turn", { attributes: { id: `turn-${uuid}` } }));
    turn.append(el("div", { classes: ["chat-turn-container", role] }));
    turn.append(el("ms-chat-turn-options"));
    return { turn };
  };
  const appendOutputTurn = (uuid, blobUrl) => {
    const turn = session.append(el("ms-chat-turn", { attributes: { id: `turn-${uuid}` } }));
    const container = turn.append(el("div", { classes: ["chat-turn-container", "render", "model"] }));
    const chunk = container.append(el("ms-prompt-chunk"));
    const imageChunk = chunk.append(el("ms-image-chunk"));
    const img = imageChunk.append(new FakeImage({
      src: blobUrl, naturalWidth: 704, naturalHeight: 1520, width: 680, height: 740,
    }));
    img.rect = { left: 0, top: 0, right: 680, bottom: 740, width: 680, height: 740 };
    return { turn, container, img };
  };

  const ref1 = appendUserImageTurn(UUID.ref1, REF1_BLOB);
  const ref2 = appendUserImageTurn(UUID.ref2, REF2_BLOB);
  const text = appendUserTextTurn(UUID.text, LONG_PROMPT);
  const thought = appendThoughtTurn(UUID.thought);
  appendShellTurn(UUID.shell1, "model");
  appendShellTurn(UUID.shell2, "model");
  const output = includeOutput ? appendOutputTurn(UUID.output, OUTPUT_BLOB) : null;
  return { session, ref1, ref2, text, thought, output };
}

function standardBlobs() {
  return new Map([
    [REF1_BLOB, { size: 515548, type: "image/jpeg" }],
    [REF2_BLOB, { size: 275145, type: "image/jpeg" }],
    [OUTPUT_BLOB, { size: 704 * 1520, type: "image/png" }],
    [THOUGHT_BLOB, { size: 4096, type: "image/jpeg" }],
  ]);
}

test("one generation block sends both uploaded references with isReference before the finished image", async () => {
  const blobs = standardBlobs();
  const { context } = createHarness({ blobs });
  buildStandardConversation(context.document.documentElement);

  await settle();
  await runScan(context);

  const payloads = ingestPayloads(context);
  assert.equal(payloads.length, 3, `expected reference, reference, output, got ${JSON.stringify(payloads.map((p) => p.localMediaIdentity))}`);
  const [ref1, ref2, output] = payloads;

  assert.equal(ref1.isReference, true);
  assert.equal(ref1.generationContextId, BLOCK1_ID);
  assert.equal(ref1.provider, "google-ai-studio");
  assert.equal(ref1.mediaKind, "image");
  assert.equal(ref1.mimeType, "image/jpeg");
  assert.equal(ref1.width, 2250);
  assert.equal(ref1.height, 4872);
  assert.equal(ref1.localMediaIdentity, REF1_BLOB);
  assert.ok(ref1.imageBase64.length > 0);
  assert.equal(ref1.promptStatus, "not-available");
  assert.equal(ref1.captureMode, "automatic");
  assert.equal(ref1.pageUrl, "https://aistudio.google.com/prompts/abc");

  assert.equal(ref2.isReference, true);
  assert.equal(ref2.generationContextId, BLOCK1_ID);
  assert.equal(ref2.localMediaIdentity, REF2_BLOB);
  assert.ok(ref2.imageBase64.length > 0);

  assert.equal(output.isReference, undefined);
  assert.equal(output.generationContextId, BLOCK1_ID);
  assert.equal(output.prompt, LONG_PROMPT);
  assert.equal(output.promptStatus, "provider-visible-prompt");
  assert.equal(output.promptSource, "google-ai-studio-visible-user-prompt");
  assert.equal(output.width, 704);
  assert.equal(output.height, 1520);
  assert.ok(output.imageBase64.length > 0);

  assert.deepEqual(context.fetchCalls, [REF1_BLOB, REF2_BLOB, OUTPUT_BLOB]);
  assert.equal(context.fetchCalls.filter((url) => url === REF1_BLOB).length, 1, "each reference is fetched once");
});

test("references recorded while rendered are still sent from memory after their turns collapse", async () => {
  const blobs = standardBlobs();
  const { context, root } = createHarness({ blobs });
  const built = buildStandardConversation(root, { includeOutput: false });

  await settle();
  await runScan(context);
  assert.equal(ingestPayloads(context).length, 0, "no output means nothing is sent yet");

  // Collapse both reference turns to empty shells and only then let the
  // finished image appear; the blob: URLs must still be readable.
  built.ref1.img.remove();
  built.ref2.img.remove();
  const session = root.children[0];
  const outputTurn = session.append(el("ms-chat-turn", { attributes: { id: `turn-${UUID.output}` } }));
  const outputImg = outputTurn.append(el("div", { classes: ["chat-turn-container", "render", "model"] }))
    .append(el("ms-prompt-chunk")).append(el("ms-image-chunk"))
    .append(new FakeImage({ src: OUTPUT_BLOB, naturalWidth: 704, naturalHeight: 1520, width: 680, height: 740 }));
  outputImg.rect = { left: 0, top: 0, right: 680, bottom: 740, width: 680, height: 740 };

  await runScan(context);

  const payloads = ingestPayloads(context);
  assert.equal(payloads.length, 3);
  const [ref1, ref2, output] = payloads;
  assert.equal(ref1.isReference, true);
  assert.equal(ref1.localMediaIdentity, REF1_BLOB);
  assert.equal(ref2.isReference, true);
  assert.equal(ref2.localMediaIdentity, REF2_BLOB);
  assert.equal(output.generationContextId, BLOCK1_ID);
  assert.equal(output.isReference, undefined);
  assert.deepEqual(context.fetchCalls, [REF1_BLOB, REF2_BLOB, OUTPUT_BLOB], "reference bytes come from the remembered blob: URLs");
});

test("uploaded images without a generated output are never sent", async () => {
  const blobs = standardBlobs();
  const { context } = createHarness({ blobs });
  buildStandardConversation(context.document.documentElement, { includeOutput: false });

  await settle();
  await runScan(context);
  await runScan(context);
  await runScan(context);

  assert.equal(ingestPayloads(context).length, 0);
  assert.deepEqual(context.fetchCalls, []);
});

test("two blocks keep their references and outputs paired by their own block ids", async () => {
  const blobs = new Map([
    [BLOCK_A_REF, { size: 400000, type: "image/jpeg" }],
    [BLOCK_B_REF, { size: 300000, type: "image/jpeg" }],
    [BLOCK_A_OUT, { size: 704 * 1520, type: "image/png" }],
    [BLOCK_B_OUT, { size: 704 * 1520, type: "image/png" }],
  ]);
  const { context, root } = createHarness({ blobs });
  const session = root.append(el("div", { classes: ["chat-session-content"] }));
  const buildBlock = (refUuid, textUuid, outUuid, refBlob, outBlob) => {
    const refTurn = session.append(el("ms-chat-turn", { attributes: { id: `turn-${refUuid}` } }));
    const refImg = refTurn.append(el("div", { classes: ["chat-turn-container", "render", "user"] }))
      .append(el("ms-prompt-chunk")).append(el("ms-image-chunk"))
      .append(new FakeImage({ src: refBlob, naturalWidth: 2250, naturalHeight: 4872, width: 115, height: 248 }));
    refImg.rect = { left: 0, top: 0, right: 115, bottom: 248, width: 115, height: 248 };
    const textTurn = session.append(el("ms-chat-turn", { attributes: { id: `turn-${textUuid}` } }));
    textTurn.append(el("div", { classes: ["chat-turn-container", "render", "user"] }))
      .append(el("ms-prompt-chunk")).append(el("div", { classes: ["user-prompt-container"] }))
      .append(el("ms-text-chunk")).append(el("ms-cmark-node"))
      .append(new FakeText(`块 ${outBlob} 的提示词`));
    const outTurn = session.append(el("ms-chat-turn", { attributes: { id: `turn-${outUuid}` } }));
    const outImg = outTurn.append(el("div", { classes: ["chat-turn-container", "render", "model"] }))
      .append(el("ms-prompt-chunk")).append(el("ms-image-chunk"))
      .append(new FakeImage({ src: outBlob, naturalWidth: 704, naturalHeight: 1520, width: 680, height: 740 }));
    outImg.rect = { left: 0, top: 0, right: 680, bottom: 740, width: 680, height: 740 };
  };
  buildBlock(UUID.refA, UUID.textA, UUID.outA, BLOCK_A_REF, BLOCK_A_OUT);
  buildBlock(UUID.refB, UUID.textB, UUID.outB, BLOCK_B_REF, BLOCK_B_OUT);

  await settle();
  await runScan(context);

  const payloads = ingestPayloads(context);
  assert.equal(payloads.length, 4, `expected 4 payloads, got ${JSON.stringify(payloads.map((p) => [p.localMediaIdentity, p.generationContextId]))}`);
  const refAPayloads = payloads.filter((p) => p.localMediaIdentity === BLOCK_A_REF);
  const refBPayloads = payloads.filter((p) => p.localMediaIdentity === BLOCK_B_REF);
  const outAPayloads = payloads.filter((p) => p.localMediaIdentity === BLOCK_A_OUT);
  const outBPayloads = payloads.filter((p) => p.localMediaIdentity === BLOCK_B_OUT);
  assert.equal(refAPayloads.length, 1, "reference A is sent exactly once");
  assert.equal(refBPayloads.length, 1);
  assert.equal(outAPayloads.length, 1);
  assert.equal(outBPayloads.length, 1);
  assert.equal(refAPayloads[0].isReference, true);
  assert.equal(refAPayloads[0].generationContextId, BLOCK_A_ID);
  assert.equal(outAPayloads[0].generationContextId, BLOCK_A_ID);
  assert.equal(outAPayloads[0].isReference, undefined);
  assert.equal(refBPayloads[0].isReference, true);
  assert.equal(refBPayloads[0].generationContextId, BLOCK_B_ID);
  assert.equal(outBPayloads[0].generationContextId, BLOCK_B_ID);
  assert.ok(payloads.indexOf(refAPayloads[0]) < payloads.indexOf(outAPayloads[0]), "block A reference lands before block A output");
  assert.ok(payloads.indexOf(refBPayloads[0]) < payloads.indexOf(outBPayloads[0]), "block B reference lands before block B output");
  assert.notEqual(outAPayloads[0].generationContextId, outBPayloads[0].generationContextId);
});

test("a reference that renders after the output was sent re-associates by replaying the output once", async () => {
  const blobs = new Map([
    [REF1_BLOB, { size: 515548, type: "image/jpeg" }],
    [OUTPUT_BLOB, { size: 704 * 1520, type: "image/png" }],
  ]);
  const { context, root } = createHarness({ blobs });
  const session = root.append(el("div", { classes: ["chat-session-content"] }));
  // The reference turn starts as a collapsed shell, so the first scan only
  // sees the text turn and the finished image.
  const shellTurn = session.append(el("ms-chat-turn", { attributes: { id: `turn-${UUID.ref1}` } }));
  const shellContainer = shellTurn.append(el("div", { classes: ["chat-turn-container", "user"] }));
  const textTurn = session.append(el("ms-chat-turn", { attributes: { id: `turn-${UUID.text}` } }));
  textTurn.append(el("div", { classes: ["chat-turn-container", "render", "user"] }))
    .append(el("ms-prompt-chunk")).append(el("div", { classes: ["user-prompt-container"] }))
    .append(el("ms-text-chunk")).append(el("ms-cmark-node"))
    .append(new FakeText(LONG_PROMPT));
  const outTurn = session.append(el("ms-chat-turn", { attributes: { id: `turn-${UUID.output}` } }));
  const outImg = outTurn.append(el("div", { classes: ["chat-turn-container", "render", "model"] }))
    .append(el("ms-prompt-chunk")).append(el("ms-image-chunk"))
    .append(new FakeImage({ src: OUTPUT_BLOB, naturalWidth: 704, naturalHeight: 1520, width: 680, height: 740 }));
  outImg.rect = { left: 0, top: 0, right: 680, bottom: 740, width: 680, height: 740 };

  await settle();
  await runScan(context);

  let payloads = ingestPayloads(context);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].generationContextId, BLOCK1_ID);
  assert.equal(payloads[0].prompt, LONG_PROMPT);

  // The user scrolls up and the reference turn renders its image.
  const refImg = shellContainer.append(el("ms-prompt-chunk")).append(el("ms-image-chunk"))
    .append(new FakeImage({ src: REF1_BLOB, naturalWidth: 2250, naturalHeight: 4872, width: 115, height: 248 }));
  refImg.rect = { left: 0, top: 0, right: 115, bottom: 248, width: 115, height: 248 };

  await runScan(context);

  payloads = ingestPayloads(context);
  assert.equal(payloads.length, 3, `expected reference + replayed output, got ${JSON.stringify(payloads.map((p) => p.localMediaIdentity))}`);
  const [firstOutput, reference, replay] = payloads;
  assert.equal(firstOutput.localMediaIdentity, OUTPUT_BLOB);
  assert.equal(reference.isReference, true);
  assert.equal(reference.generationContextId, BLOCK1_ID);
  assert.equal(reference.localMediaIdentity, REF1_BLOB);
  assert.equal(replay.isReference, undefined);
  assert.equal(replay.generationContextId, BLOCK1_ID);
  assert.equal(replay.localMediaIdentity, OUTPUT_BLOB);
  assert.equal(replay.prompt, LONG_PROMPT);
  assert.equal(replay.width, 704);
  assert.equal(replay.height, 1520);
  assert.ok(replay.imageBase64.length > 0);
  assert.equal(context.fetchCalls.filter((url) => url === OUTPUT_BLOB).length, 2, "the output bytes are fetched once for the capture and once for the replay");

  await runScan(context);
  await runScan(context);
  assert.equal(ingestPayloads(context).length, 3, "further scans never re-send the replay");
});

test("a failing reference fetch or a rejected reference ingest does not block the finished image", async () => {
  const blobs = standardBlobs();
  const { context } = createHarness({
    blobs,
    fetchFailures: new Set([REF1_BLOB]),
    rejectIngest: (payload) => payload.isReference && payload.localMediaIdentity === REF2_BLOB,
  });
  buildStandardConversation(context.document.documentElement);

  await settle();
  await runScan(context);

  const payloads = ingestPayloads(context);
  assert.ok(context.fetchCalls.includes(REF1_BLOB), "the failing reference fetch was attempted");
  const ref2Attempts = payloads.filter((p) => p.isReference && p.localMediaIdentity === REF2_BLOB);
  assert.equal(ref2Attempts.length, 1, "the rejected reference ingest was attempted once");
  const output = payloads.filter((p) => !p.isReference);
  assert.equal(output.length, 1, "the finished image is still sent");
  assert.equal(output[0].generationContextId, BLOCK1_ID);
  assert.equal(output[0].localMediaIdentity, OUTPUT_BLOB);
});

test("the finished image waits until every reference ingest has completed", async () => {
  const blobs = standardBlobs();
  const { context } = createHarness({ blobs, holdReferenceIngest: true });
  buildStandardConversation(context.document.documentElement);

  await settle();
  await runScan(context);

  const whileHeld = ingestPayloads(context);
  assert.equal(whileHeld.filter((p) => p.isReference).length, 2, "both references were sent");
  assert.equal(whileHeld.filter((p) => !p.isReference).length, 0, "the output must not go out while a reference ingest is still pending");

  context.heldReferenceIngests.shift()();
  await settle();
  assert.equal(ingestPayloads(context).filter((p) => !p.isReference).length, 0, "one reference is still pending");

  context.heldReferenceIngests.shift()();
  await settle();
  const output = ingestPayloads(context).filter((p) => !p.isReference);
  assert.equal(output.length, 1);
  assert.equal(output[0].generationContextId, BLOCK1_ID);
});

test("an image outside the chat session (the editor draft) is not a reference", async () => {
  const blobs = standardBlobs();
  blobs.set(EDITOR_BLOB, { size: 515548, type: "image/jpeg" });
  const { context, root } = createHarness({ blobs });
  buildStandardConversation(context.document.documentElement);
  const editor = root.append(el("div", { classes: ["input-area"] }));
  const editorImg = editor.append(new FakeImage({
    src: EDITOR_BLOB, naturalWidth: 2250, naturalHeight: 4872, width: 115, height: 248,
  }));
  editorImg.rect = { left: 0, top: 1000, right: 115, bottom: 1248, width: 115, height: 248 };

  await settle();
  await runScan(context);

  const payloads = ingestPayloads(context);
  assert.equal(payloads.length, 3);
  assert.ok(payloads.every((payload) => payload.localMediaIdentity !== EDITOR_BLOB));
  assert.ok(!context.fetchCalls.includes(EDITOR_BLOB));
  assert.equal(payloads.filter((payload) => payload.isReference).length, 2);
});

test("user-turn images never go out as generated outputs", async () => {
  const blobs = standardBlobs();
  const { context } = createHarness({ blobs });
  buildStandardConversation(context.document.documentElement, { refNaturalWidth: 1024 });

  await settle();
  await runScan(context);

  const payloads = ingestPayloads(context);
  const nonReference = payloads.filter((payload) => !payload.isReference);
  assert.equal(nonReference.length, 1, "exactly one generated output is sent");
  assert.equal(nonReference[0].localMediaIdentity, OUTPUT_BLOB);
  for (const payload of payloads) {
    if (payload.isReference) {
      assert.ok(payload.localMediaIdentity === REF1_BLOB || payload.localMediaIdentity === REF2_BLOB);
      assert.equal(payload.generationContextId, BLOCK1_ID);
    }
  }
  const outputsClaimingReferences = payloads.filter((payload) => !payload.isReference
    && (payload.localMediaIdentity === REF1_BLOB || payload.localMediaIdentity === REF2_BLOB));
  assert.equal(outputsClaimingReferences.length, 0);
});
