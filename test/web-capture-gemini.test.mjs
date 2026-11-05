// Gemini page structure observed in task 336: a generated image inside
// <model-response>, preceded by the matching <user-query>. The expanded
// preview lives in a separate dialog and must not be treated as output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { setImmediate } from "node:timers";

const providerPolicySource = await readFile(new URL("../extensions/chatgpt-web-capture/provider-policy.js", import.meta.url), "utf8");
const providerSource = await readFile(new URL("../extensions/chatgpt-web-capture/provider-sites.js", import.meta.url), "utf8");

const GEMINI_ORIGIN = "https://gemini.google.com";
const GEMINI_PAGE = `${GEMINI_ORIGIN}/app/21c7f187c0eab255`;
const GENERATED_BLOB = `blob:${GEMINI_ORIGIN}/0f0a3758-9eff-4cb6-b5a4-aeef7e509b02`;
const EXPANDED_BLOB = `blob:${GEMINI_ORIGIN}/6a897bbc-d3db-477a-835c-43262b0c3ad8`;
const FOREIGN_BLOB = "blob:https://evil.example/xyz";
const GOOGLE_HOSTED_IMAGE = "https://lh3.googleusercontent.com/gg/AAAA=s1024";
const PROMPT = "画一只坐在窗台上的橘猫，水彩风格";

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
  constructor({ src, naturalWidth = 0, naturalHeight = 0, width = 0, height = 0, complete = true, classes = [] } = {}) {
    super("img", { classes });
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
    innerHeight: 818,
    location: {
      href: GEMINI_PAGE,
      origin: GEMINI_ORIGIN,
      hostname: "gemini.google.com",
      pathname: "/app/21c7f187c0eab255",
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

// Drain debounced scans and any prompt-retry timers after the provider loads.
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

function blobBytes(...urls) {
  return new Map(urls.map((url) => [url, { size: 50_000, type: "image/jpeg" }]));
}

// The image is nested 19 ancestors below <model-response>, matching the
// real Gemini conversation: generated-image > single-image > image-container
// > overlay-container > image-button > img, with message and layout wrappers.
function buildConversation(root, {
  src = GENERATED_BLOB,
  naturalWidth = 1024,
  naturalHeight = 572,
  attachToUserQuery = false,
} = {}) {
  const conversation = root.append(el("div"));
  const userQuery = conversation.append(el("user-query"));
  userQuery.append(new FakeText(PROMPT));
  const modelResponse = conversation.append(el("model-response"));

  let node = attachToUserQuery ? userQuery : modelResponse;
  for (let depth = 0; depth < 9; depth += 1) node = node.append(el("div"));
  node = node.append(el("message-content"));
  node = node.append(el("div", { classes: ["markdown", "markdown-main-panel"] }));
  node = node.append(el("div", { classes: ["attachment-container", "generated-images"] }));
  node = node.append(el("response-element"));
  node = node.append(el("generated-image"));
  node = node.append(el("single-image", { classes: ["generated-image", "large"] }));
  node = node.append(el("div", { classes: ["image-container", "replace-fife-images-at-export"] }));
  node = node.append(el("div", { classes: ["overlay-container"] }));
  node = node.append(el("button", { classes: ["image-button"] }));
  const img = node.append(new FakeImage({
    src, naturalWidth, naturalHeight, width: 708, height: 395,
    classes: ["image", "animate", "loaded"],
  }));
  img.rect = { left: 200, top: 175, right: 908, bottom: 570, width: 708, height: 395 };
  return { img, userQuery, modelResponse };
}

function appendExpandedPreview(root, src = EXPANDED_BLOB) {
  const overlay = root.append(el("div", { classes: ["cdk-overlay-container"] }));
  const dialog = overlay.append(el("mat-dialog-container")).append(el("expansion-dialog"));
  const img = dialog.append(el("div", { classes: ["generated-image-container"] }))
    .append(el("div", { classes: ["doodle-editing-column"] }))
    .append(el("div", { classes: ["image-viewport"] }))
    .append(new FakeImage({
      src, naturalWidth: 1024, naturalHeight: 572, width: 900, height: 503,
      classes: ["image-container", "generated-image"],
    }));
  img.rect = { left: 150, top: 110, right: 1050, bottom: 613, width: 900, height: 503 };
  return img;
}

test("Gemini conversation blob output is captured with its original bytes and visible user prompt", async () => {
  const { context, root } = createHarness({ blobs: blobBytes(GENERATED_BLOB) });
  buildConversation(root);

  await settle();
  await runScan(context);

  const payloads = ingestPayloads(context);
  assert.equal(payloads.length, 1);
  const [payload] = payloads;
  assert.equal(payload.provider, "gemini");
  assert.ok(typeof payload.imageBase64 === "string" && payload.imageBase64.length > 0);
  assert.equal(payload.mimeType, "image/jpeg");
  assert.equal(payload.width, 1024);
  assert.equal(payload.height, 572);
  assert.equal(payload.localMediaIdentity, GENERATED_BLOB);
  assert.equal(Object.hasOwn(payload, "imageUrl"), false);
  assert.equal(payload.prompt, PROMPT);
  assert.equal(payload.promptSource, "gemini-visible-user-prompt");
  assert.deepEqual(context.fetchCalls, [GENERATED_BLOB]);
});

test("Gemini expanded preview outside model-response is not captured or fetched", async () => {
  const { context, root } = createHarness({ blobs: blobBytes(GENERATED_BLOB, EXPANDED_BLOB) });
  buildConversation(root);
  appendExpandedPreview(root);

  await settle();
  await runScan(context);

  const payloads = ingestPayloads(context);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].localMediaIdentity, GENERATED_BLOB);
  assert.deepEqual(context.fetchCalls, [GENERATED_BLOB]);
  assert.equal(context.fetchCalls.includes(EXPANDED_BLOB), false);
});

test("Gemini rejects a blob handle from a foreign origin", async () => {
  const { context, root } = createHarness({ blobs: blobBytes(FOREIGN_BLOB) });
  buildConversation(root, { src: FOREIGN_BLOB });

  await settle();
  await runScan(context);

  assert.equal(ingestPayloads(context).length, 0);
  assert.deepEqual(context.fetchCalls, []);
});

test("Gemini rejects generated images below the 512px natural-edge floor", async () => {
  const { context, root } = createHarness({ blobs: blobBytes(GENERATED_BLOB) });
  buildConversation(root, { naturalWidth: 400, naturalHeight: 300 });

  await settle();
  await runScan(context);

  assert.equal(ingestPayloads(context).length, 0);
  assert.deepEqual(context.fetchCalls, []);
});

test("Gemini does not capture an uploaded image inside user-query", async () => {
  const { context, root } = createHarness({ blobs: blobBytes(GENERATED_BLOB) });
  buildConversation(root, { attachToUserQuery: true });

  await settle();
  await runScan(context);

  assert.equal(ingestPayloads(context).length, 0);
  assert.deepEqual(context.fetchCalls, []);
});

test("Gemini scanning the same generated blob twice ingests exactly once", async () => {
  const { context, root } = createHarness({ blobs: blobBytes(GENERATED_BLOB) });
  buildConversation(root);

  await settle();
  await runScan(context);
  await runScan(context);

  assert.equal(ingestPayloads(context).length, 1);
  assert.deepEqual(context.fetchCalls, [GENERATED_BLOB]);
});

test("Gemini still sends Google-hosted HTTPS images by URL for background download", async () => {
  const { context, root } = createHarness();
  buildConversation(root, { src: GOOGLE_HOSTED_IMAGE });

  await settle();
  await runScan(context);

  const payloads = ingestPayloads(context);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].provider, "gemini");
  assert.equal(payloads[0].imageUrl, GOOGLE_HOSTED_IMAGE);
  assert.equal(Object.hasOwn(payloads[0], "imageBase64"), false);
  assert.deepEqual(context.fetchCalls, []);
});
