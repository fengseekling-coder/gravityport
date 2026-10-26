import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import sharp from "sharp";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";
import { generationSessionKey } from "../lib/generation-session.mjs";
import { sourceSearchDisplayName } from "../lib/asset-search-scope.mjs";

const extensionRoot = new URL("../extensions/chatgpt-web-capture/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionRoot), "utf8"));
const backgroundSource = await readFile(new URL("background.js", extensionRoot), "utf8");
const providerPolicySource = await readFile(new URL("provider-policy.js", extensionRoot), "utf8");
const providerJimengSource = await readFile(new URL("provider-jimeng.js", extensionRoot), "utf8");
const providerMidjourneySource = await readFile(new URL("provider-midjourney.js", extensionRoot), "utf8");
const jimengHookSource = await readFile(new URL("jimeng-page-hook.js", extensionRoot), "utf8");

// Everything below runs on synthetic fixtures: no real account, token, or
// signature values are embedded; URL query strings carry fake placeholders.

function createProviderSandbox(source, filename) {
  const sandbox = {
    URL,
    atob: (value) => Buffer.from(String(value), "base64").toString("binary"),
    btoa: (value) => Buffer.from(String(value), "binary").toString("base64"),
  };
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  vm.runInNewContext(source, sandbox, { filename });
  return sandbox;
}

const jimeng = createProviderSandbox(providerJimengSource, "provider-jimeng.js").MosaJimengCapture;
const midjourney = createProviderSandbox(providerMidjourneySource, "provider-midjourney.js").MosaMidjourneyCapture;

function jimengPollFixture(nowMs) {
  const hqVideoUrl = "https://v3-dreamnia.jimeng.com/fake/video-src-key.mp4?fake=1";
  return {
    ret: 0,
    data: {
      "7468000000000000001": {
        status: 50,
        create_time: Math.floor(nowMs / 1000),
        prompt: "海边小镇的黄昏，胶片感",
        model_name: "图片 2.1",
        item_list: [
          {
            item_id: "7468000000000000011",
            image: {
              large_images: [
                {
                  image_url: "https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/key-AAAA~tplv-fake-aigc_resize:360:360.webp?lk3s=fake&x-expires=1&x-signature=fake",
                  width: 360,
                  height: 360,
                },
                {
                  image_url: "https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/key-AAAA~tplv-fake-aigc_resize:2400:2400.webp?lk3s=fake&x-expires=1&x-signature=fake",
                  width: 816,
                  height: 1456,
                },
              ],
            },
          },
          {
            item_id: "7468000000000000012",
            video: {
              video_model: JSON.stringify({
                video_list: {
                  video_1: { main_url: Buffer.from("https://v3-dreamnia.jimeng.com/fake/low.mp4?fake").toString("base64") },
                  video_2: { main_url: Buffer.from(hqVideoUrl).toString("base64") },
                },
              }),
              transcoded_video: { origin: { video_url: "https://v3-dreamnia.jimeng.com/fake/watermarked.mp4?fake" } },
            },
          },
        ],
      },
      "7467000000000000001": {
        status: 50,
        create_time: Math.floor(nowMs / 1000) - 86_400,
        prompt: "上周生成的旧图",
        item_list: [
          {
            item_id: "7467000000000000011",
            image: {
              large_images: [
                {
                  image_url: "https://p9-dreamina-sign.byteimg.com/tos-cn-i-fake/key-BBBB~tplv-fake-aigc_resize:360:360.webp?lk3s=fake&x-expires=1&x-signature=fake",
                  width: 360,
                  height: 360,
                },
              ],
            },
          },
        ],
      },
    },
  };
}

test("provider policy recognizes Jimeng and Midjourney pages and videos", () => {
  const sandbox = { URL };
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  const policy = sandbox.MosaProviderPolicy;
  assert.equal(policy.providerForPageUrl("https://jimeng.jianying.com/ai-tool/generate?type=image"), "jimeng");
  assert.equal(policy.providerForPageUrl("https://jimeng.jianying.com/ai-tool/asset"), "jimeng");
  assert.equal(policy.providerForPageUrl("https://www.midjourney.com/imagine"), "midjourney");
  assert.equal(policy.providerForPageUrl("https://www.midjourney.com/jobs/abc123"), "midjourney");
  assert.equal(policy.providerForPageUrl("https://evil.example/?next=https://jimeng.jianying.com/"), "");
  assert.equal(policy.providerForPageUrl("https://jianying.com/"), "");
  assert.equal(policy.providerForPageUrl("https://midjourney.com/imagine"), "");
  assert.equal(policy.supportsVideo("jimeng"), true);
  assert.equal(policy.supportsVideo("midjourney"), true);
  assert.equal(policy.supportsVideo("chatgpt"), false);
});

test("manifest declares the two new sites, their CDNs, and 0.15.42", () => {
  assert.equal(manifest.version, "0.15.42");
  for (const host of [
    "https://jimeng.jianying.com/*",
    "https://*.byteimg.com/*",
    "https://*.jimeng.com/*",
    "https://*.vlabvod.com/*",
    "https://www.midjourney.com/*",
    "https://cdn.midjourney.com/*",
  ]) assert.ok(manifest.host_permissions.includes(host), `missing ${host}`);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);

  const jimengHook = manifest.content_scripts.find((entry) => entry.js?.includes("jimeng-page-hook.js"));
  assert.deepEqual(jimengHook?.matches, ["https://jimeng.jianying.com/*"]);
  assert.equal(jimengHook?.world, "MAIN");
  assert.equal(jimengHook?.run_at, "document_start");
  const jimengProvider = manifest.content_scripts.find((entry) => entry.js?.includes("provider-jimeng.js"));
  assert.deepEqual(jimengProvider?.js, ["provider-policy.js", "provider-jimeng.js"]);
  assert.equal(jimengProvider?.run_at, "document_idle");
  const mjProvider = manifest.content_scripts.find((entry) => entry.js?.includes("provider-midjourney.js"));
  assert.deepEqual(mjProvider?.js, ["provider-policy.js", "provider-midjourney.js"]);
  assert.deepEqual(mjProvider?.matches, ["https://www.midjourney.com/*"]);
  assert.equal(mjProvider?.world, undefined, "Midjourney adapter must stay in the isolated world");
});

test("jimeng extractor picks the largest image variant and the watermark-free video", () => {
  const nowMs = Date.parse("2026-10-23T10:00:00Z");
  const { records } = jimeng.extractJimengResponse(JSON.stringify(jimengPollFixture(nowMs)));
  assert.equal(records.length, 3);

  const image = records.find((record) => record.identity === "7468000000000000011");
  assert.ok(image, "fresh image item extracted");
  assert.equal(image.image.kind, "image");
  assert.match(image.image.url, /aigc_resize:2400:2400\.webp/, "the 360 thumbnail must lose to the 2400 variant");
  assert.equal(image.prompt, "海边小镇的黄昏，胶片感");
  assert.equal(image.model, "图片 2.1");
  assert.equal(image.historyId, "7468000000000000001");
  assert.equal(image.generationStatus, "completed");
  assert.equal(jimeng.isFreshGeneration(image.capturedAtMs, nowMs), true);

  const video = records.find((record) => record.identity === "7468000000000000012");
  assert.ok(video, "fresh video item extracted");
  assert.equal(video.video.kind, "video");
  assert.equal(video.video.url, "https://v3-dreamnia.jimeng.com/fake/video-src-key.mp4?fake=1",
    "the highest-bitrate base64 main_url wins over the watermarked origin URL");

  const old = records.find((record) => record.identity === "7467000000000000011");
  assert.ok(old, "history item is still extracted (baseline bookkeeping)");
  assert.equal(jimeng.isFreshGeneration(old.capturedAtMs, nowMs), false,
    "records created before the content script started are never auto-captured");
  assert.equal(jimeng.isFreshGeneration(null, nowMs), false,
    "records without a parseable timestamp fail closed to baseline");
});

test("jimeng extractor reads the live get_asset_list shape (created_time, common_attr.prompt, nested model_config)", () => {
  // Key layout observed on jimeng.jianying.com /mweb/v1/get_asset_list on
  // 2026-10-23; every value here is made up.
  const nowMs = Date.parse("2026-10-23T10:00:00Z");
  const sign = "?lk3s=fake&x-expires=1&x-signature=fake";
  const response = {
    ret: "0",
    data: {
      has_more: false,
      asset_list: [{
        id: "a1",
        type: 1,
        image: {
          history_record_id: "8100000000000000001",
          created_time: Math.floor(nowMs / 1000) + 30,
          item_list: [{
            common_attr: {
              id: "8100000000000000011",
              prompt: "红色背景上的金属数字 77",
              create_time: Math.floor(nowMs / 1000) + 30,
              cover_url: `https://p26-dreamina-sign.byteimg.com/tos-cn-i-fake/abc~tplv-fake-aigc_resize:640:640.jpeg${sign}`,
            },
            image: {
              format: "png",
              large_images: [{
                image_url: `https://p26-dreamina-sign.byteimg.com/tos-cn-i-fake/abc~tplv-fake-aigc_resize:2400:2400.webp${sign}`,
                width: 816,
                height: 1456,
              }],
            },
            aigc_image_params: {
              text2image_params: { model_config: { model_name: "图片 4.0" } },
            },
          }],
        },
      }],
    },
  };
  const { records } = jimeng.extractJimengResponse(JSON.stringify(response));
  assert.equal(records.length, 1);
  const [record] = records;
  assert.match(record.image.url, /aigc_resize:2400:2400/);
  assert.equal(record.prompt, "红色背景上的金属数字 77");
  assert.equal(record.model, "图片 4.0");
  assert.equal(record.historyId, "8100000000000000001");
  assert.ok(record.capturedAtMs, "created_time feeds the freshness gate");
  assert.equal(jimeng.isFreshGeneration(record.capturedAtMs, nowMs), true, "a record created after the script started is captured");
});

test("jimeng original images (aigc_resize:0:0.png) take their size from the response and win", () => {
  // get_history_by_ids on 2026-10-23 answered a fresh 9:16 generation with a
  // single large image at aigc_resize:0:0.png and width 1440 / height 2560.
  const nowMs = Date.parse("2026-10-23T18:24:00Z");
  const sign = "?lk3s=fake&x-expires=1&x-signature=fake";
  const response = {
    ret: "0",
    data: {
      "ce68fe50-0000-4000-8000-000000000000": {
        history_record_id: "8200000000000000001",
        created_time: Math.floor(nowMs / 1000) + 5,
        status: 50,
        item_list: [{
          common_attr: {
            id: "8200000000000000011",
            prompt: "一只橘猫趴在窗台上晒太阳",
            create_time: Math.floor(nowMs / 1000) + 5,
            cover_url: `https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/cat~tplv-fake-aigc_resize:640:640.jpeg${sign}`,
          },
          image: {
            large_images: [{
              image_url: `https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/cat~tplv-fake-aigc_resize:0:0.png${sign}`,
              width: 1440,
              height: 2560,
            }],
          },
        }],
      },
    },
  };
  const { records } = jimeng.extractJimengResponse(JSON.stringify(response));
  assert.equal(records.length, 1);
  const [record] = records;
  assert.match(record.image.url, /aigc_resize:0:0\.png/, "the full-size original is chosen");
  assert.equal(record.image.width, 1440);
  assert.equal(record.image.height, 2560);
  assert.equal(record.historyId, "8200000000000000001");
  assert.equal(jimeng.isFreshGeneration(record.capturedAtMs, nowMs), true);
});

test("jimeng media URL gate accepts only the ByteDance media hosts", () => {
  const info = jimeng.mediaUrlInfo("https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/key-CCCC~tplv-fake-aigc_resize:720:1280.webp?x-signature=fake");
  assert.equal(info.kind, "image");
  assert.equal(info.width, 720);
  assert.equal(info.height, 1280);
  assert.equal(info.resourceId, "key-CCCC");
  const bare = jimeng.mediaUrlInfo("https://p9-static-sign.byteimg.com/tos-cn-i-fake/key.webp");
  assert.equal(bare.kind, "image");
  assert.equal(bare.resourceId, "", "URLs without a ~tplv resource id carry no dedup identity");
  assert.equal(jimeng.mediaUrlInfo("https://evil.example/tos-cn-i-fake/key-DDDD~tplv-fake-aigc_resize:360:360.webp"), null);
  assert.equal(jimeng.mediaUrlInfo("http://p3-dreamina-sign.byteimg.com/key~tplv.webp"), null, "http is refused");
  const video = jimeng.mediaUrlInfo("https://v26-web.jimeng.com/fake/video.mp4?fake");
  assert.equal(video.kind, "video");
  const vlab = jimeng.mediaUrlInfo("https://v3-default.vlabvod.com/fake/abc.mp4");
  assert.equal(vlab.kind, "video");
});

test("jimeng page hook observes /mweb/v1/ responses read-only through a one-shot port", async () => {
  const hookMessages = [];
  const seenFetchCalls = [];
  const originalFetch = async (input, init) => {
    seenFetchCalls.push({ input, init });
    return {
      url: String(typeof input === "string" ? input : input?.url || ""),
      clone() {
        return {
          text: async () => JSON.stringify({ ret: 0, data: { ok: 1 } }),
        };
      },
    };
  };
  const portMessages = [];
  const sandbox = {
    URL,
    location: { origin: "https://jimeng.jianying.com", href: "https://jimeng.jianying.com/ai-tool/generate?type=image" },
    fetch: originalFetch,
    XMLHttpRequest: function FakeXHR() {
      this.open = () => {};
      this.send = () => {};
      this.addEventListener = () => {};
    },
    MessageChannel: function FakeChannel() {
      this.port1 = {
        postMessage: (message) => portMessages.push(message),
        addEventListener: () => {},
        start: () => {},
      };
      this.port2 = {};
    },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.postMessage = (message, origin, transfer) => {
    hookMessages.push({ message, origin, transfer });
  };
  vm.runInNewContext(jimengHookSource, sandbox, { filename: "jimeng-page-hook.js" });

  const requestInit = { method: "POST", credentials: "include" };
  await sandbox.window.fetch("https://jimeng.jianying.com/mweb/v1/get_history_by_ids", requestInit);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seenFetchCalls.length, 1);
  assert.equal(seenFetchCalls[0].init, requestInit, "the hook must not modify or re-issue the page request");
  assert.equal(portMessages.length, 1);
  assert.equal(portMessages[0].type, "jimeng-api-response");
  assert.equal(portMessages[0].url, "https://jimeng.jianying.com/mweb/v1/get_history_by_ids");

  portMessages.length = 0;
  await sandbox.window.fetch("https://jimeng.jianying.com/mweb/v2/other", requestInit);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(portMessages.length, 0, "non-/mweb/v1 responses are not observed");

  // The port was offered exactly once via a transient window message.
  assert.equal(hookMessages.length, 1);
  assert.equal(hookMessages[0].message.source, "mosa-jimeng-hook");
  assert.equal(hookMessages[0].origin, "https://jimeng.jianying.com");
  assert.equal(Array.isArray(hookMessages[0].transfer) && hookMessages[0].transfer.length, 1);

  assert.match(jimengHookSource, /XMLHttpRequest\.prototype\.open/);
  assert.match(jimengHookSource, /responseType === "json"/);
  assert.doesNotMatch(jimengHookSource, /setRequestHeader/, "the hook never rewrites requests");
});

test("midjourney URL parser derives the full-size original and job identity", () => {
  const preview = midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/2c0ab4d1e5f64789abcd1234ef567890/0_2_640_960.webp?method=shortest");
  assert.equal(preview.kind, "image");
  assert.equal(preview.jobId, "2c0ab4d1e5f64789abcd1234ef567890");
  assert.equal(preview.index, 2);
  assert.equal(preview.isPreview, true);
  assert.equal(preview.originalUrl, "https://cdn.midjourney.com/2c0ab4d1e5f64789abcd1234ef567890/0_2.png");
  assert.equal(midjourney.midjourneyAssetIdentity(preview), "2c0ab4d1e5f64789abcd1234ef567890:2");

  const upscale = midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/2c0ab4d1e5f64789abcd1234ef567890/0_1.png");
  assert.equal(upscale.isPreview, false);
  assert.equal(upscale.originalUrl, "https://cdn.midjourney.com/2c0ab4d1e5f64789abcd1234ef567890/0_1.png");

  const video = midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/2c0ab4d1e5f64789abcd1234ef567890/0_0.mp4");
  assert.equal(video.kind, "video");
  assert.equal(midjourney.midjourneyAssetIdentity(video), "2c0ab4d1e5f64789abcd1234ef567890:0");

  assert.equal(midjourney.parseMidjourneyMediaUrl("https://evil.example/2c0ab4d1e5f64789abcd1234ef567890/0_0_640_640.webp"), null);
  assert.equal(midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/not-a-job/0_0_640_640.webp"), null);
  assert.equal(midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/2c0ab4d1e5f64789abcd1234ef567890/logo.svg"), null);
});

test("midjourney URL parser accepts the live-site format (UUID job ids, 0_<n>_640_N previews)", () => {
  // Shape observed on www.midjourney.com/imagine on 2026-10-23 (job id is a
  // made-up UUID; only the format matters).
  const live = midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/0_3_640_N.webp?method=shortest");
  assert.ok(live, "a live preview URL parses");
  assert.equal(live.jobId, "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d");
  assert.equal(live.index, 3);
  assert.equal(live.isPreview, true);
  assert.equal(live.originalUrl, "https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/0_3.png");
  assert.equal(midjourney.midjourneyAssetIdentity(live), "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d:3");
  const original = midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/0_3.png");
  assert.equal(original.isPreview, false);
  assert.equal(midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/1b2c3d4e-5f60/0_0_640_N.webp"), null, "a truncated id is rejected");
});

test("background re-derives the original from a live-format preview URL", () => {
  const match = /function fetchMidjourneyOriginal[\s\S]*?const originalUrl/.exec(backgroundSource);
  assert.ok(match, "fetchMidjourneyOriginal is present");
  const body = match[0];
  const idPattern = new RegExp(/test\(segments\[0\]\)/.source);
  assert.match(body, idPattern);
  const idRegex = /!(\/\^\[0-9a-f\][^\n]*?\/i)\.test\(segments\[0\]\)/.exec(body);
  const fileRegex = /const previewMatch = (\/\^0_[^\n]*?\/i)\.exec/.exec(body);
  assert.ok(idRegex && fileRegex, "both URL rules are literal regexes");
  const toRegExp = (literal) => new RegExp(literal.slice(1, literal.lastIndexOf("/")), "i");
  assert.ok(toRegExp(idRegex[1]).test("1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d"));
  assert.ok(toRegExp(fileRegex[1]).test("0_3_640_N.webp"));
  assert.ok(toRegExp(fileRegex[1]).test("0_3.png"));
});

test("midjourney baseline rules separate lazy history from fresh generations", () => {
  const now = 1_000_000;
  assert.equal(midjourney.isScrollBaselineInsertion(now, now - 500), true, "insertion right after a scroll is history");
  assert.equal(midjourney.isScrollBaselineInsertion(now, now - 5_000), false, "a card appearing well after scrolling is fresh");
  assert.equal(midjourney.isScrollBaselineInsertion(now, -Infinity), false);
  assert.equal(midjourney.isBatchBaselineInsertion(1), false, "one new job card is a fresh generation");
  assert.equal(midjourney.isBatchBaselineInsertion(2), false, "an upscale pair is still a fresh generation");
  assert.equal(midjourney.isBatchBaselineInsertion(4), true, "a page of lazy-loaded history is baseline");
  assert.match(providerMidjourneySource, /firstScanDone/, "the first scan baselines whatever the page already shows");
});

test("background gates the new providers and downloads Midjourney originals with cookies", () => {
  assert.match(backgroundSource, /WEB_IMAGE_PROVIDERS = new Set\(\["chatgpt", "gemini", "flow", "google-ai-studio", "jimeng", "midjourney"\]\)/);
  assert.match(backgroundSource, /WEB_VIDEO_PROVIDERS = new Set\(\["flow", "google-ai-studio", "jimeng", "midjourney"\]\)/);
  assert.match(backgroundSource, /"cdn\.midjourney\.com",/);
  assert.match(backgroundSource, /host\.endsWith\("\.byteimg\.com"\)/);
  assert.match(backgroundSource, /host\.endsWith\("\.jimeng\.com"\)/);
  assert.match(backgroundSource, /host\.endsWith\("\.vlabvod\.com"\)/);
  assert.match(backgroundSource, /async function fetchMidjourneyOriginal\(previewUrl\)/);
  assert.match(backgroundSource, /hostname\.toLowerCase\(\) !== "cdn\.midjourney\.com"/);
  assert.match(backgroundSource, /\/0_\$\{previewMatch\[1\]\}\.png/);
  assert.match(backgroundSource, /\{ credentials: "include", cache: "no-cache" \}/);
  assert.match(backgroundSource, /message\.type === "mosa\.fetchMidjourneyOriginal"\) return context\.provider === "midjourney";/);
  assert.match(backgroundSource, /context\.provider === "jimeng"/);
  assert.match(backgroundSource, /context\.provider === "midjourney"/);
  assert.match(backgroundSource, /media_variant: String\(payload\.mediaVariant \|\| payload\.media_variant \|\| ""\)/);
  for (const pattern of ["https://jimeng.jianying.com/*", "https://www.midjourney.com/*"]) {
    assert.ok(backgroundSource.includes(pattern), `context menus must cover ${pattern}`);
  }
  assert.match(backgroundSource, /id: "mosa-save-video"/);
});

async function noiseImage(seed, width = 640, height = 900) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * (31 + seed) + (i % 249)) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

test("app ingest accepts jimeng and midjourney images with sourceType and media variant", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-jm-mj-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const created = [];
  const store = {
    createAsset: async (input) => {
      const asset = { id: input.assetId, project_id: "default", ...input, source: { ...input.source } };
      created.push(asset);
      return asset;
    },
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
  };

  const jimengResult = await ingestWebCapture({
    store,
    tempRoot: join(root, "jimeng"),
    input: {
      provider: "jimeng",
      imageBytes: await noiseImage(7),
      mimeType: "image/jpeg",
      prompt: "海边小镇的黄昏，胶片感",
      prompt_status: "provider-visible-prompt",
      prompt_source: "jimeng-visible-prompt",
      conversationId: "7468000000000000001",
      providerAssetId: "7468000000000000011",
      model: "图片 2.1",
      pageUrl: "https://jimeng.jianying.com/ai-tool/generate?type=image",
    },
  });
  assert.equal(jimengResult.status, "imported");
  assert.equal(jimengResult.asset.sourceType, "web-jimeng");
  assert.equal(jimengResult.asset.source.provider, "jimeng");
  assert.equal(jimengResult.asset.prompt, "海边小镇的黄昏，胶片感");
  assert.equal(jimengResult.asset.source.prompt_status, "provider-visible-prompt");
  assert.equal(jimengResult.asset.source.model, "图片 2.1");
  assert.match(jimengResult.asset.assetId, /^web-jimeng-[a-f0-9]{12}$/);
  assert.deepEqual(jimengResult.asset.tags, ["jimeng", "web-capture", "auto-archived"]);

  const mjResult = await ingestWebCapture({
    store,
    tempRoot: join(root, "midjourney"),
    input: {
      provider: "midjourney",
      imageBytes: await noiseImage(13),
      mimeType: "image/jpeg",
      prompt: "a lighthouse in a storm --ar 2:3 --v 7",
      prompt_status: "provider-visible-prompt",
      prompt_source: "midjourney-visible-prompt",
      conversationId: "2c0ab4d1e5f64789abcd1234ef567890",
      providerAssetId: "2c0ab4d1e5f64789abcd1234ef567890:2",
      mediaVariant: "preview",
    },
  });
  assert.equal(mjResult.status, "imported");
  assert.equal(mjResult.asset.sourceType, "web-midjourney");
  assert.equal(mjResult.asset.source.media_variant, "preview", "a preview-only Midjourney capture is marked in the source record");
  assert.equal(jimengResult.asset.source.media_variant, "", "an unset variant stays empty");

  // An untrusted provider-visible prompt for a legacy provider is still dropped.
  const droppedPrompt = await ingestWebCapture({
    store,
    tempRoot: join(root, "jimeng-untrusted"),
    input: {
      provider: "jimeng",
      imageBytes: await noiseImage(21),
      mimeType: "image/jpeg",
      prompt: "should not be trusted",
      prompt_status: "user-message",
    },
  });
  assert.equal(droppedPrompt.asset.prompt, "");
});

test("app ingest accepts jimeng and midjourney videos", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-jm-mj-video-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sampleMp4 = (() => {
    const bytes = Buffer.alloc(96 * 1024, 0);
    bytes.writeUInt32BE(24, 0);
    bytes.write("ftyp", 4, "ascii");
    bytes.write("isom", 8, "ascii");
    return bytes;
  })();
  const created = [];
  const store = {
    createAsset: async (input) => {
      const asset = { id: input.assetId, project_id: "default", ...input, source: { ...input.source } };
      created.push(asset);
      return asset;
    },
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
  };
  const result = await ingestWebCapture({
    store,
    tempRoot: join(root, "jimeng"),
    input: {
      provider: "jimeng",
      mediaKind: "video",
      mediaBytes: sampleMp4,
      mimeType: "video/mp4",
      durationSeconds: 5.4,
      width: 1080,
      height: 1920,
      conversationId: "7468000000000000001",
      providerAssetId: "7468000000000000012",
    },
  });
  assert.equal(result.status, "imported");
  assert.equal(result.asset.sourceType, "web-jimeng");
  assert.equal(result.asset.source.media_kind, "video");
  assert.equal(result.asset.business_fields.duration_seconds, 5.4);
  assert.match(result.asset.assetId, /^web-jimeng-video-[a-f0-9]{12}$/);

  const mjVideo = await ingestWebCapture({
    store,
    tempRoot: join(root, "midjourney"),
    input: {
      provider: "midjourney",
      mediaKind: "video",
      mediaBytes: sampleMp4,
      mimeType: "video/mp4",
      conversationId: "2c0ab4d1e5f64789abcd1234ef567890",
      providerAssetId: "2c0ab4d1e5f64789abcd1234ef567890:0",
      mediaVariant: "original",
    },
  });
  assert.equal(mjVideo.status, "imported");
  assert.equal(mjVideo.asset.sourceType, "web-midjourney");
  assert.equal(mjVideo.asset.source.media_variant, "original");
});

test("generation sessions group by jimeng record and midjourney job id", () => {
  assert.equal(
    generationSessionKey({ source: { type: "web-jimeng", conversation_id: "7468000000000000001" } }),
    "web-jimeng:7468000000000000001",
  );
  assert.equal(
    generationSessionKey({ source: { type: "web-midjourney", conversation_id: "2c0ab4d1e5f64789abcd1234ef567890" } }),
    "web-midjourney:2c0ab4d1e5f64789abcd1234ef567890",
  );
  assert.equal(generationSessionKey({ source: { type: "web-midjourney" } }), "");
  assert.equal(sourceSearchDisplayName("web-jimeng"), "即梦");
  assert.equal(sourceSearchDisplayName("web-midjourney"), "Midjourney");
});
