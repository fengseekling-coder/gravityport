import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const extensionRoot = new URL("../extensions/chatgpt-web-capture/", import.meta.url);
const providerPolicySource = await readFile(new URL("provider-policy.js", extensionRoot), "utf8");
const providerJimengSource = await readFile(new URL("provider-jimeng.js", extensionRoot), "utf8");

// Fixtures mirror the live /mweb/v1/ record shape observed on 2026-10-25:
// reference images live in the record's own `resources` array (type "image")
// and video generations also carry first/last frame images under `task`.
// Every id, URL path and signature here is made up.

const FAKE_SIGN = "?lk3s=fake&x-expires=1792940032&x-signature=fakesig";
const REF_A = "a".repeat(32);
const REF_B = "b".repeat(32);
const REF_C = "c".repeat(32);
const REF_D = "d".repeat(32);
const REF_F = "f".repeat(32);

function referenceImageUrl(hex) {
  return `https://p26-dreamina-sign.byteimg.com/tos-cn-i-fake/${hex}~tplv-tb4s082cfz-resize:0:0.image${FAKE_SIGN}`;
}

function jimengResource(hex) {
  return {
    type: "image",
    key: `tos-cn-i-fake/${hex}`,
    name: "",
    platform: 1,
    image_info: {
      image_uri: `tos-cn-i-fake/${hex}`,
      image_url: referenceImageUrl(hex),
      width: 941,
      height: 1672,
      format: "png",
    },
  };
}

// 「全能参考」video generation: two reference images in `resources`.
function videoRecordFixture(nowMs) {
  const seconds = Math.floor(nowMs / 1000) + 2;
  return {
    ret: 0,
    data: {
      "48938517727244": {
        history_record_id: "48938517727244",
        generate_type: 10,
        created_time: seconds,
        status: 50,
        item_list: [{
          item_id: "48938517727251",
          common_attr: {
            id: "48938517727251",
            prompt: "全能参考：两只猫在草地上奔跑",
            create_time: seconds,
            width: 1080,
            height: 1920,
          },
          video: {
            transcoded_video: { origin: { video_url: `https://v26-dreamina-sign.vlabvod.com/fake/video-key.mp4${FAKE_SIGN}` } },
          },
        }],
        resources: [jimengResource(REF_A), jimengResource(REF_B)],
      },
    },
  };
}

// Image-to-image generation (generate_type 12): one reference in `resources`,
// and the same image again inside task.aigc_image_params.blend_params.
function imageRecordFixture(nowMs) {
  const seconds = Math.floor(nowMs / 1000) + 2;
  return {
    ret: 0,
    data: {
      "820000000000000102": {
        history_record_id: "820000000000000102",
        generate_type: 12,
        created_time: seconds,
        status: 50,
        item_list: [{
          item_id: "820000000000000112",
          common_attr: { id: "820000000000000112", prompt: "把这张图改成赛博朋克夜景", create_time: seconds },
          image: {
            large_images: [{
              image_url: `https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/output0000~tplv-fake-aigc_resize:0:0.png${FAKE_SIGN}`,
              width: 1440,
              height: 2560,
            }],
          },
        }],
        resources: [jimengResource(REF_C)],
        task: {
          aigc_image_params: {
            blend_params: {
              ability_list: [
                { large_image_list: [{ image_uri: `tos-cn-i-fake/${REF_C}`, image_url: referenceImageUrl(REF_C), width: 941, height: 1672 }] },
              ],
            },
          },
        },
      },
    },
  };
}

// Text-to-image generation (generate_type 1): no references at all.
function textToImageRecordFixture(nowMs) {
  const seconds = Math.floor(nowMs / 1000) + 2;
  return {
    ret: 0,
    data: {
      "820000000000000201": {
        history_record_id: "820000000000000201",
        generate_type: 1,
        created_time: seconds,
        status: 50,
        item_list: [{
          item_id: "820000000000000211",
          common_attr: { id: "820000000000000211", prompt: "一只橘猫趴在窗台上", create_time: seconds },
          image: {
            large_images: [{
              image_url: `https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/t2i00000~tplv-fake-aigc_resize:0:0.png${FAKE_SIGN}`,
              width: 1024,
              height: 1024,
            }],
          },
        }],
      },
    },
  };
}

// Video generation whose only reference is the first frame under `task`.
function frameOnlyRecordFixture(nowMs) {
  const seconds = Math.floor(nowMs / 1000) + 2;
  return {
    ret: 0,
    data: {
      "48938517727999": {
        history_record_id: "48938517727999",
        generate_type: 10,
        created_time: seconds,
        status: 50,
        item_list: [{
          item_id: "48938517727998",
          common_attr: { id: "48938517727998", create_time: seconds, width: 1280, height: 720 },
          video: {
            transcoded_video: { origin: { video_url: `https://v26-dreamina-sign.vlabvod.com/fake/frame-video.mp4${FAKE_SIGN}` } },
          },
        }],
        task: {
          first_frame_image: {
            image_uri: `tos-cn-i-fake/${REF_D}`,
            image_url: referenceImageUrl(REF_D),
            width: 1280,
            height: 720,
          },
        },
      },
    },
  };
}

// Non-image `resources` entries are skipped; an image entry without
// image_url falls back to the largest cover_url_map tier.
function mixedResourcesRecordFixture(nowMs) {
  const seconds = Math.floor(nowMs / 1000) + 2;
  const cover4096 = `https://p26-dreamina-sign.byteimg.com/tos-cn-i-fake/${REF_F}~tplv-tb4s082cfz-resize:2312:4096.webp${FAKE_SIGN}`;
  return {
    ret: 0,
    data: {
      "820000000000000301": {
        history_record_id: "820000000000000301",
        generate_type: 12,
        created_time: seconds,
        status: 50,
        item_list: [{
          item_id: "820000000000000311",
          common_attr: { id: "820000000000000311", create_time: seconds },
          image: {
            large_images: [{
              image_url: `https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/mixed000~tplv-fake-aigc_resize:0:0.png${FAKE_SIGN}`,
              width: 2048,
              height: 2048,
            }],
          },
        }],
        resources: [
          { type: "video", key: "tos-cn-i-fake/videotag", image_info: { image_url: referenceImageUrl("e".repeat(32)) } },
          {
            type: "image",
            key: `tos-cn-i-fake/${REF_F}`,
            image_info: {
              image_uri: `tos-cn-i-fake/${REF_F}`,
              width: 941,
              height: 1672,
              format: "webp",
              cover_url_map: {
                "360": `https://p26-dreamina-sign.byteimg.com/tos-cn-i-fake/${REF_F}~tplv-tb4s082cfz-resize:203:360.webp${FAKE_SIGN}`,
                "1080": `https://p26-dreamina-sign.byteimg.com/tos-cn-i-fake/${REF_F}~tplv-tb4s082cfz-resize:610:1080.webp${FAKE_SIGN}`,
                "4096": cover4096,
              },
            },
          },
        ],
      },
    },
  };
}

function createExtractionSandbox() {
  const sandbox = {
    URL,
    atob: (value) => Buffer.from(String(value), "base64").toString("binary"),
    btoa: (value) => Buffer.from(String(value), "binary").toString("base64"),
  };
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  vm.runInNewContext(providerJimengSource, sandbox, { filename: "provider-jimeng.js" });
  return sandbox.MosaJimengCapture;
}

const jimeng = createExtractionSandbox();

test("video record: the two resources images become referenceUrls in order", () => {
  const { records } = jimeng.extractJimengResponse(JSON.stringify(videoRecordFixture(Date.now())));
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.historyId, "48938517727244");
  assert.deepEqual([...record.referenceUrls], [referenceImageUrl(REF_A), referenceImageUrl(REF_B)]);
});

test("image-to-image record: the blend_params copy of the same reference does not duplicate", () => {
  const { records } = jimeng.extractJimengResponse(JSON.stringify(imageRecordFixture(Date.now())));
  assert.equal(records.length, 1);
  const [record] = records;
  assert.deepEqual([...record.referenceUrls], [referenceImageUrl(REF_C)]);
});

test("text-to-image record without resources has no referenceUrls", () => {
  const { records } = jimeng.extractJimengResponse(JSON.stringify(textToImageRecordFixture(Date.now())));
  assert.equal(records.length, 1);
  const [record] = records;
  assert.deepEqual([...record.referenceUrls], []);
});

test("video record with only task.first_frame_image picks up the frame as reference", () => {
  const { records } = jimeng.extractJimengResponse(JSON.stringify(frameOnlyRecordFixture(Date.now())));
  assert.equal(records.length, 1);
  const [record] = records;
  assert.deepEqual([...record.referenceUrls], [referenceImageUrl(REF_D)]);
});

test("non-image resources entries are skipped and cover_url_map falls back to the largest tier", () => {
  const { records } = jimeng.extractJimengResponse(JSON.stringify(mixedResourcesRecordFixture(Date.now())));
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.referenceUrls.length, 1);
  assert.match(record.referenceUrls[0], /resize:2312:4096\.webp/, "the 4096 tier wins over 360 and 1080");
});

// The capture-path tests below run the real content script inside a sandbox
// with a fake chrome.runtime; each mosa.ingest send resolves after a small
// delay so the test can tell "sent after every reference finished" apart
// from "sent in parallel with them".

function createCaptureSandbox({ delayMs = 15 } = {}) {
  const ingested = [];
  const windowMessageListeners = [];
  const sandbox = {
    URL,
    console: { info() {} },
    setTimeout, clearTimeout, setImmediate,
    // The content script's 5s watchdog would keep the event loop alive; the
    // tests drive captures through the 300ms scan instead.
    setInterval: () => 0,
    clearInterval: () => {},
    atob: (value) => Buffer.from(String(value), "base64").toString("binary"),
    btoa: (value) => Buffer.from(String(value), "binary").toString("base64"),
    location: { origin: "https://jimeng.jianying.com", href: "https://jimeng.jianying.com/ai-tool/image" },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, appendChild() {} }),
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { appendChild() {} },
    },
    chrome: {
      runtime: {
        id: "test-extension-id",
        sendMessage: async (message) => {
          if (message?.type === "mosa.getSettings") return { ok: true, settings: { autoCapture: true } };
          if (message?.type !== "mosa.ingest") return { ok: true };
          const entry = { payload: message.payload, calledAt: Date.now(), resolvedAt: 0 };
          ingested.push(entry);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          entry.resolvedAt = Date.now();
          return { ok: true };
        },
        onMessage: { addListener: () => {} },
      },
      storage: {
        local: { get: async () => ({ autoCapture: true }) },
        onChanged: { addListener: () => {} },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, listener) => {
    if (type === "message") windowMessageListeners.push(listener);
  };
  sandbox.postMessage = () => {};
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  vm.runInNewContext(providerJimengSource, sandbox, { filename: "provider-jimeng.js" });
  return { sandbox, ingested, windowMessageListeners };
}

function deliverHookResponse({ sandbox, windowMessageListeners }, text) {
  const portListeners = [];
  const port = {
    addEventListener: (type, listener) => {
      if (type === "message") portListeners.push(listener);
    },
    start() {},
    close() {},
  };
  const [listener] = windowMessageListeners;
  listener({ origin: sandbox.location.origin, data: { source: "mosa-jimeng-hook", type: "hook-port" }, ports: [port] });
  portListeners[0]({ data: { type: "jimeng-api-response", text } });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

test("automatic video capture ingests both references before the video, and a replayed record sends nothing", async () => {
  const capture = createCaptureSandbox();
  await new Promise((resolve) => setImmediate(resolve));
  const text = JSON.stringify(videoRecordFixture(Date.now()));
  deliverHookResponse(capture, text);

  const refs = () => capture.ingested.filter((entry) => entry.payload.isReference);
  const product = () => capture.ingested.find((entry) => entry.payload.mediaKind === "video" && !entry.payload.isReference);
  assert.ok(
    await waitFor(() => refs().length >= 2 && product() && product().resolvedAt > 0),
    "two references and the finished video should be ingested",
  );

  assert.deepEqual(refs().map((entry) => entry.payload.imageUrl), [referenceImageUrl(REF_A), referenceImageUrl(REF_B)]);
  assert.deepEqual(refs().map((entry) => entry.payload.providerAssetId), [`ref:${REF_A}`, `ref:${REF_B}`]);
  for (const ref of refs()) {
    assert.equal(ref.payload.generationContextId, "48938517727244", "references carry the record's generation context id");
  }
  assert.equal(product().payload.generationContextId, "48938517727244");
  assert.equal(product().payload.providerAssetId, "48938517727251");
  assert.ok(
    product().calledAt >= Math.max(...refs().map((ref) => ref.resolvedAt)),
    "the video may only be sent after every reference of the record finished",
  );

  const count = capture.ingested.length;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(capture.ingested.length, count, "the quiet period after capture adds nothing");

  // The poll answers with the same record again: neither the references nor
  // the video may be sent a second time.
  deliverHookResponse(capture, text);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(capture.ingested.length, count, "a replayed record must not re-ingest references or media");
});

test("automatic image capture also ingests its reference before the image", async () => {
  const capture = createCaptureSandbox();
  await new Promise((resolve) => setImmediate(resolve));
  deliverHookResponse(capture, JSON.stringify(imageRecordFixture(Date.now())));

  const refs = () => capture.ingested.filter((entry) => entry.payload.isReference);
  const product = () => capture.ingested.find((entry) => entry.payload.mediaKind === "image" && !entry.payload.isReference);
  assert.ok(
    await waitFor(() => refs().length >= 1 && product() && product().resolvedAt > 0),
    "the reference and the finished image should be ingested",
  );

  assert.deepEqual(refs().map((entry) => entry.payload.imageUrl), [referenceImageUrl(REF_C)]);
  assert.equal(product().payload.generationContextId, "820000000000000102");
  assert.equal(product().payload.providerAssetId, "820000000000000112");
  assert.ok(
    product().calledAt >= Math.max(...refs().map((ref) => ref.resolvedAt)),
    "the image may only be sent after its reference finished",
  );
});
