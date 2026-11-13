/**
 * Behavior tests for the Google provider adapters and the options page
 * (task 397, review 4-1 丁).
 *
 * Every test boots the REAL extensions/chatgpt-web-capture sources through
 * test/helpers/provider-sites-harness.mjs — provider-policy.js +
 * provider-sites.js in manifest order, or options.js — and drives the same
 * surfaces the pages do: fake DOM images/videos, chrome.runtime messages,
 * storage changes, media events, a controllable clock. These tests replace
 * the former providerSource/providerPolicySource/optionsSource source-text
 * assertions in chatgpt-web-capture-hook.test.mjs; nothing here matches on
 * source text or slices functions out of the sources.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import {
  createOptionsHarness,
  createProviderPolicyHarness,
  createProviderSitesHarness,
  FakeProviderImage,
  FakeProviderVideo,
  identityProof,
  textNode,
} from "./helpers/provider-sites-harness.mjs";

const visibleRect = (width = 800, height = 600) => ({
  x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height,
});
const GEMINI = { host: "gemini.google.com", pathname: "/app" };
const FLOW = { host: "flow.google.com", pathname: "/project/p1" };
const AI_STUDIO_VIDEO = { host: "aistudio.google.com", pathname: "/generate-video" };
const flowRedirectUrl = (name) => `https://flow.google.com/api/trpc/media.getMediaUrlRedirect?name=${name}`;
const messagesOf = (harness, type) => harness.sentMessages.filter((entry) => entry.message?.type === type);

/** Build (but do not mount) a visible Gemini generated image element. */
const geminiImage = (overrides = {}) => new FakeProviderImage({
  src: "https://lh3.googleusercontent.com/generated-1",
  rect: visibleRect(),
  ...overrides,
});

/** Mount an image inside a model-response ancestor and register it with the page. */
function mountModelResponseImage(harness, img) {
  const modelResponse = harness.document.createElement("model-response");
  modelResponse.appendChild(img);
  harness.document.body.appendChild(modelResponse);
  harness.document.images.push(img);
  return img;
}

const mountGeminiGeneratedImage = (harness, overrides = {}) =>
  mountModelResponseImage(harness, geminiImage(overrides));

/** Mount a Flow generation row: media plus a nearby Prompt card. */
function mountFlowRow(harness, media, cardChildren) {
  const card = harness.document.createElement("div");
  for (const child of cardChildren) card.appendChild(child);
  const row = harness.document.createElement("div");
  row.appendChild(media);
  row.appendChild(card);
  harness.document.body.appendChild(row);
  if (media instanceof FakeProviderVideo) harness.document.videos.push(media);
  else harness.document.images.push(media);
  return row;
}

const reusePromptButton = (harness) => {
  const button = harness.document.createElement("button");
  button.setAttribute("aria-label", "Reuse prompt");
  return button;
};

const runScan = async (harness) => {
  harness.runScheduledScan();
  await harness.flush();
};

test("provider policy classifies only supported top-level product URLs", () => {
  const policy = createProviderPolicyHarness();
  assert.equal(policy.providerForPageUrl("https://chatgpt.com/c/abc"), "chatgpt");
  assert.equal(policy.providerForPageUrl("https://gemini.google.com/app/abc"), "gemini");
  assert.equal(policy.providerForPageUrl("https://aistudio.google.com/generate-video"), "google-ai-studio");
  assert.equal(policy.providerForPageUrl("https://labs.google/fx/en/tools/flow/project/abc"), "flow");
  assert.equal(policy.providerForPageUrl("https://flow.google.com/project/abc"), "flow");
  assert.equal(policy.providerForPageUrl("https://labs.google/search"), "");
  // Similar-looking hosts must not classify.
  assert.equal(policy.providerForPageUrl("https://gemini.google.com.evil.test/app"), "");
  assert.equal(policy.providerForPageUrl("https://notlabs.google/fx/tools/flow/project/x"), "");
  assert.equal(policy.providerForPageUrl("https://flow.google.com.evil.test/project"), "");
  assert.equal(policy.providerForPageUrl("https://aistudio.google.com.evil.test/generate-video"), "");
  assert.equal(policy.providerForPageUrl("http://gemini.google.com/app/abc"), "");
  assert.equal(policy.providerForPageUrl("https://evil.example/?next=https://gemini.google.com"), "");
  // The Flow media redirect endpoint is host- and path-gated.
  assert.equal(policy.isFlowMediaRedirectUrl("https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=abc"), true);
  assert.equal(policy.isFlowMediaRedirectUrl("https://flow.google.com/api/trpc/media.getMediaUrlRedirect?name=abc"), true);
  assert.equal(policy.isFlowMediaRedirectUrl("https://flow.google.com/fx/api/trpc/media.getMediaUrlRedirect?name=abc"), true);
  assert.equal(policy.isFlowMediaRedirectUrl("https://flow.google.com/api/trpc/media.getMediaUrlRedirect"), false);
  assert.equal(policy.isFlowMediaRedirectUrl("https://evil.example/api/trpc/media.getMediaUrlRedirect?name=abc"), false);
  assert.equal(policy.isFlowMediaRedirectUrl("https://flow.google.com/api/trpc/media.getSomethingElse?name=abc"), false);
  assert.equal(policy.isFlowMediaRedirectUrl("https://notlabs.google/fx/api/trpc/media.getMediaUrlRedirect?name=abc"), false);
  assert.equal(policy.supportsVideo("flow"), true);
  assert.equal(policy.supportsVideo("google-ai-studio"), true);
  assert.equal(policy.supportsVideo("gemini"), false);
});

test("provider capture stays off until enabled and follows the stored switch", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: false, ...GEMINI });
  mountGeminiGeneratedImage(harness);
  await harness.flush();
  await runScan(harness);
  assert.equal(messagesOf(harness, "mosa.ingest").length, 0, "no capture while automatic capture is off");

  harness.storage.fireChanged({ autoCapture: { newValue: true } }, "local");
  await harness.flush();
  assert.equal(harness.state.autoCapture, true, "the stored switch enables capture without a reload");
  await runScan(harness);
  assert.equal(messagesOf(harness, "mosa.ingest").length, 1, "the enabled scan captures the generated image");

  const timeoutsBefore = harness.timers.timeouts.length;
  harness.storage.fireChanged({ unrelatedKey: { newValue: 1 } }, "local");
  await harness.flush();
  assert.equal(harness.timers.timeouts.length, timeoutsBefore, "an unrelated storage key schedules no scan");

  harness.state.seen.add("https://keep.example/rotated.png");
  harness.storage.fireChanged({ mosaToken: { newValue: "rotated" } }, "local");
  await harness.flush();
  assert.equal(harness.state.seen.size, 0, "a corrected Token frees the seen keys for a rescan");

  const observer = harness.observers[0];
  harness.storage.fireChanged({ autoCapture: { newValue: false } }, "local");
  await harness.flush();
  assert.equal(harness.state.autoCapture, false);
  assert.ok(observer.disconnectCount >= 1, "switching capture off disconnects the observer");
  await runScan(harness);
  assert.equal(messagesOf(harness, "mosa.ingest").length, 1, "a switched-off scan captures nothing new");
});

test("Gemini generated images are captured only when visible and large enough", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...GEMINI });
  const img = mountGeminiGeneratedImage(harness);
  await harness.flush();
  await runScan(harness);
  const ingest = messagesOf(harness, "mosa.ingest")[0];
  assert.ok(ingest, "a visible generated image is captured");
  assert.equal(ingest.message.payload.provider, "gemini");
  assert.equal(ingest.message.payload.imageUrl, img.src, "remote provider URLs stay remote (no page bytes read)");
  assert.equal(ingest.message.payload.imageBase64, undefined);
  assert.equal(ingest.message.payload.width, 1024);
  assert.equal(ingest.message.payload.promptStatus, "not-available");

  const small = mountGeminiGeneratedImage(harness, {
    src: "https://lh3.googleusercontent.com/small",
    naturalWidth: 511, naturalHeight: 511, rect: visibleRect(511, 511),
  });
  const invisible = mountGeminiGeneratedImage(harness, {
    src: "https://lh3.googleusercontent.com/zero",
    rect: { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 },
  });
  const foreignHost = mountGeminiGeneratedImage(harness, { src: "https://example.com/photo/generated.png" });
  await runScan(harness);
  assert.equal(messagesOf(harness, "mosa.ingest").length, 1, "too-small, invisible, and non-provider-host images are never captured");
  assert.equal(harness.state.seen.has(img.src), true);
  assert.equal(harness.state.seen.has(small.src), false);
  assert.equal(harness.state.seen.has(invisible.src), false);
  assert.equal(harness.state.seen.has(foreignHost.src), false);
});

test("Gemini prompt association reads the visible user query beside the model response", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...GEMINI });
  const img = geminiImage();
  const userQuery = harness.document.createElement("user-query");
  userQuery.appendChild(textNode("A sailing ship at sunset"));
  const modelResponse = harness.document.createElement("model-response");
  modelResponse.appendChild(img);
  harness.document.body.appendChild(userQuery);
  harness.document.body.appendChild(modelResponse);
  harness.document.images.push(img);
  await harness.flush();
  await runScan(harness);
  const payload = messagesOf(harness, "mosa.ingest")[0]?.message?.payload;
  assert.equal(payload.prompt, "A sailing ship at sunset");
  assert.equal(payload.promptStatus, "provider-visible-prompt");
  assert.equal(payload.promptSource, "gemini-visible-user-prompt");
});

test("Gemini prompt association stops at eight turns and the character floor", async () => {
  const cases = [
    ["a user query more than eight turns away", async () => {
      const harness = await createProviderSitesHarness({ autoCapture: true, ...GEMINI });
      const userQuery = harness.document.createElement("user-query");
      userQuery.appendChild(textNode("A distant question"));
      harness.document.body.appendChild(userQuery);
      for (let index = 0; index < 9; index += 1) {
        harness.document.body.appendChild(harness.document.createElement("div"));
      }
      mountGeminiGeneratedImage(harness);
      return harness;
    }],
    ["a user query longer than 24k characters", async () => {
      const harness = await createProviderSitesHarness({ autoCapture: true, ...GEMINI });
      const userQuery = harness.document.createElement("user-query");
      userQuery.appendChild(textNode("word ".repeat(4_801)));
      harness.document.body.appendChild(userQuery);
      mountGeminiGeneratedImage(harness);
      return harness;
    }],
  ];
  for (const [label, build] of cases) {
    const harness = await build();
    await harness.flush();
    await runScan(harness);
    const payload = messagesOf(harness, "mosa.ingest")[0]?.message?.payload;
    assert.ok(payload, `${label}: the image itself is still captured`);
    assert.equal(payload.promptStatus, "not-available", `${label}: no prompt is attached`);
    assert.equal(payload.prompt, undefined, `${label}: the prompt stays empty instead of guessing`);
    assert.equal(payload.promptSource, "provider-visible-image");
  }
});

test("Flow media thumbnails probe and capture without waiting for Prompt text", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const tile = new FakeProviderImage({
    src: flowRedirectUrl("media-1"),
    naturalWidth: 200,
    naturalHeight: 200,
    rect: visibleRect(200, 200),
  });
  harness.document.body.appendChild(tile);
  harness.document.images.push(tile);
  await harness.flush();
  await runScan(harness);

  const probe = messagesOf(harness, "mosa.probeFlowMedia")[0];
  assert.ok(probe, "the media id is probed even though no Prompt card is rendered");
  assert.equal(probe.message.url, flowRedirectUrl("media-1"));

  const ingest = messagesOf(harness, "mosa.ingest")[0];
  assert.ok(ingest, "the probe answer archives the thumbnail");
  assert.equal(ingest.message.payload.provider, "flow");
  assert.equal(ingest.message.payload.imageUrl, flowRedirectUrl("media-1"));
  assert.equal(ingest.message.payload.localMediaIdentity, flowRedirectUrl("media-1"));
  assert.equal(ingest.message.payload.promptStatus, "not-available", "no Prompt card means no Prompt, never an empty string");

  await runScan(harness);
  assert.equal(messagesOf(harness, "mosa.probeFlowMedia").length, 1, "the archived media id is not probed again");

  const plain = new FakeProviderImage({
    src: "https://lh3.googleusercontent.com/flow-generic.png",
    naturalWidth: 300,
    naturalHeight: 300,
    rect: visibleRect(300, 300),
  });
  harness.document.body.appendChild(plain);
  harness.document.images.push(plain);
  await harness.flush();
  await runScan(harness);
  assert.equal(messagesOf(harness, "mosa.ingest").length, 1, "a generic Flow image below the 512px floor without a Prompt card is not captured");
});

test("failed Flow media probes back off 15s/60s/300s and a success clears the failure", async () => {
  const harness = await createProviderSitesHarness({
    autoCapture: true,
    ...FLOW,
    respond: async (message) => (message?.type === "mosa.probeFlowMedia" ? { ok: true, result: null } : undefined),
  });
  const tile = new FakeProviderImage({
    src: flowRedirectUrl("media-1"),
    naturalWidth: 200,
    naturalHeight: 200,
    rect: visibleRect(200, 200),
  });
  harness.document.body.appendChild(tile);
  harness.document.images.push(tile);
  await harness.flush();

  const probes = () => messagesOf(harness, "mosa.probeFlowMedia").length;
  const failureKey = "flow-media:media-1";
  await runScan(harness);
  assert.equal(probes(), 1);
  assert.equal(harness.state.flowProbeFailures.has(failureKey), true, "the failed probe is remembered");

  await runScan(harness);
  assert.equal(probes(), 1, "a failed probe does not re-fire on the next scan");

  const tiers = [15_000, 60_000, 300_000];
  let elapsed = 0;
  for (const [index, tier] of tiers.entries()) {
    harness.advanceClock(tier - 1_000);
    elapsed += tier - 1_000;
    await runScan(harness);
    assert.equal(probes(), index + 1, `the ${tier}ms backoff tier must not fire one second early`);
    harness.advanceClock(1_000);
    elapsed += 1_000;
    await runScan(harness);
    assert.equal(probes(), index + 2, `after ${elapsed}ms of failures the probe fires again (attempt ${index + 2})`);
    assert.equal(harness.state.flowProbeFailures.get(failureKey)?.count, index + 2);
  }

  // A successful probe archives the media and clears the failure record.
  const succeeding = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const goodTile = new FakeProviderImage({
    src: flowRedirectUrl("media-2"),
    naturalWidth: 200,
    naturalHeight: 200,
    rect: visibleRect(200, 200),
  });
  succeeding.document.body.appendChild(goodTile);
  succeeding.document.images.push(goodTile);
  await succeeding.flush();
  await runScan(succeeding);
  assert.equal(messagesOf(succeeding, "mosa.ingest").length, 1, "the image answer archives the thumbnail");
  assert.equal(succeeding.state.flowProbeFailures.size, 0, "a successful probe clears the failure record");
  assert.deepEqual([...succeeding.state.seen], ["flow-media:media-2"]);
});

test("Flow prompt association uses the nearby card and fails closed between two cards", async () => {
  const capture = async (harness) => {
    await harness.flush();
    await runScan(harness);
    return messagesOf(harness, "mosa.ingest")[0]?.message?.payload;
  };

  // (a) The card holding the media's Reuse Prompt control wins over a plain caption.
  const anchored = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const anchoredImage = new FakeProviderImage({ src: "https://lh3.googleusercontent.com/flow-a.png", rect: visibleRect() });
  const anchoredRow = anchored.document.createElement("div");
  anchoredRow.appendChild(anchoredImage);
  const plainCard = anchored.document.createElement("div");
  plainCard.appendChild(textNode("Plain caption A"));
  anchoredRow.appendChild(plainCard);
  const anchoredCard = anchored.document.createElement("div");
  anchoredCard.appendChild(textNode("Caption B"));
  anchoredCard.appendChild(reusePromptButton(anchored));
  anchoredRow.appendChild(anchoredCard);
  anchored.document.body.appendChild(anchoredRow);
  anchored.document.images.push(anchoredImage);
  const anchoredPayload = await capture(anchored);
  assert.equal(anchoredPayload.prompt, "Caption B", "the anchored card is associated, not the plain caption");
  assert.equal(anchoredPayload.promptStatus, "provider-visible-prompt");
  assert.equal(anchoredPayload.promptSource, "flow-visible-prompt");

  // (b) A single viable text card is associated even without the English anchor.
  const single = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const singleImage = new FakeProviderImage({ src: "https://lh3.googleusercontent.com/flow-b.png", rect: visibleRect() });
  mountFlowRow(single, singleImage, [textNode("A cabin in the woods")]);
  const singlePayload = await capture(single);
  assert.equal(singlePayload.prompt, "A cabin in the woods", "one text card is a structural association");

  // (c) Two text cards without an anchor fail closed: nothing is captured.
  const ambiguous = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const ambiguousImage = new FakeProviderImage({ src: "https://lh3.googleusercontent.com/flow-c.png", rect: visibleRect() });
  const ambiguousRow = mountFlowRow(ambiguous, ambiguousImage, [textNode("First caption")]);
  const otherCard = ambiguous.document.createElement("div");
  otherCard.appendChild(textNode("Second caption"));
  ambiguousRow.appendChild(otherCard);
  const ambiguousPayload = await capture(ambiguous);
  assert.equal(ambiguousPayload, undefined, "two cards without an anchor are never guessed between");

  // (d) Controls, glyphs, and hidden notes never leak into the Prompt.
  const filtered = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const filteredImage = new FakeProviderImage({ src: "https://lh3.googleusercontent.com/flow-d.png", rect: visibleRect() });
  const glyph = filtered.document.createElement("span");
  glyph.className = "material-symbol";
  glyph.appendChild(textNode("close"));
  const hidden = filtered.document.createElement("span");
  hidden.setAttribute("aria-hidden", "true");
  hidden.appendChild(textNode("hidden note"));
  const textarea = filtered.document.createElement("textarea");
  textarea.appendChild(textNode("ignore me"));
  mountFlowRow(filtered, filteredImage, [
    textNode("A red fox in the snow"),
    reusePromptButton(filtered),
    glyph,
    textarea,
    hidden,
  ]);
  const filteredPayload = await capture(filtered);
  assert.equal(filteredPayload.prompt, "A red fox in the snow", "only the visible prose becomes the Prompt");

  // (e) A card longer than 20k characters is not a Prompt source.
  const huge = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const hugeImage = new FakeProviderImage({ src: "https://lh3.googleusercontent.com/flow-e.png", rect: visibleRect() });
  mountFlowRow(huge, hugeImage, [textNode("x".repeat(20_001)), reusePromptButton(huge)]);
  const hugePayload = await capture(huge);
  assert.equal(hugePayload, undefined, "an oversized card is rejected instead of truncating");
});

test("generated videos on the AI Studio video surface are captured from media events", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...AI_STUDIO_VIDEO });
  await harness.flush();
  harness.advance(300); // consume the boot scan before media exists
  const video = new FakeProviderVideo({
    src: "blob:https://aistudio.google.com/vid-1",
    readyState: 0,
    videoWidth: 720,
    videoHeight: 1280,
    attrs: { "data-generated": "true" },
    rect: visibleRect(640, 360),
  });
  harness.document.videos.push(video);
  await harness.flush();
  await runScan(harness);
  assert.equal(messagesOf(harness, "mosa.beginVideoTransfer").length, 0, "a video without metadata is not captured");

  harness.fireDocumentEvent("loadedmetadata", { target: video });
  video.readyState = 1;
  await harness.flush();
  await runScan(harness);

  const begin = messagesOf(harness, "mosa.beginVideoTransfer")[0];
  assert.ok(begin, "the media event leads to the scan that captures the video");
  assert.equal(begin.message.payload.provider, "google-ai-studio");
  assert.equal(begin.message.payload.mediaKind, "video");
  assert.equal(begin.message.payload.width, 720, "dimensions come from videoWidth, not the element width");
  assert.equal(begin.message.payload.height, 1280, "dimensions come from videoHeight, not the element height");
  assert.equal(begin.message.payload.promptStatus, "not-available");
  assert.equal(begin.message.payload.promptSource, "provider-visible-video");
  assert.equal(begin.message.payload.localMediaIdentity, video.src);
  assert.ok(messagesOf(harness, "mosa.videoTransferChunk").length >= 1, "the page-local video is transferred in chunks");
  assert.equal(messagesOf(harness, "mosa.commitVideoTransfer").length, 1);
  assert.equal(harness.fetchCalls[0]?.init?.credentials, "same-origin", "page bytes are read with same-origin credentials");
  assert.equal(harness.fetchCalls[0]?.init?.cache, "no-cache");

  const markerless = new FakeProviderVideo({
    src: "blob:https://aistudio.google.com/vid-2",
    readyState: 1,
    rect: visibleRect(640, 360),
  });
  harness.document.videos.push(markerless);
  await harness.flush();
  await runScan(harness);
  assert.equal(messagesOf(harness, "mosa.beginVideoTransfer").length, 1, "a video on the Veo surface without any generated marker is not captured");
});

test("video scans stay off while automatic capture is off", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: false, ...AI_STUDIO_VIDEO });
  const video = new FakeProviderVideo({
    src: "blob:https://aistudio.google.com/vid-off",
    readyState: 1,
    attrs: { "data-generated": "true" },
    rect: visibleRect(640, 360),
  });
  harness.document.videos.push(video);
  await harness.flush();
  for (const type of ["loadedmetadata", "loadeddata", "canplay"]) harness.fireDocumentEvent(type, { target: video });
  await harness.flush();
  await runScan(harness);
  assert.equal(harness.state.autoCapture, false);
  assert.equal(messagesOf(harness, "mosa.beginVideoTransfer").length, 0, "no video transfer while capture is off");
  assert.equal(messagesOf(harness, "mosa.ingest").length, 0);
});

test("Flow generated videos are captured with their visible Prompt card", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const video = new FakeProviderVideo({
    src: "blob:https://flow.google.com/vid-1",
    readyState: 1,
    videoWidth: 640,
    videoHeight: 640,
    rect: visibleRect(640, 640),
  });
  mountFlowRow(harness, video, [textNode("A red fox in the snow"), reusePromptButton(harness)]);
  await harness.flush();
  await runScan(harness);
  const begin = messagesOf(harness, "mosa.beginVideoTransfer")[0];
  assert.ok(begin, "the Flow video is captured");
  assert.equal(begin.message.payload.mediaKind, "video");
  assert.equal(begin.message.payload.prompt, "A red fox in the snow");
  assert.equal(begin.message.payload.promptStatus, "provider-visible-prompt");
  assert.equal(begin.message.payload.promptSource, "flow-visible-prompt");
  assert.equal(begin.message.payload.width, 640);
});

test("loadedmetadata, loadeddata, and canplay each wake the video scan", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...AI_STUDIO_VIDEO });
  await harness.flush();
  harness.advance(300);
  const wake = async (eventName) => {
    const video = new FakeProviderVideo({
      src: `blob:https://aistudio.google.com/vid-${eventName}`,
      readyState: 0,
      attrs: { "data-generated": "true" },
      rect: visibleRect(640, 360),
    });
    harness.document.videos.push(video);
    await harness.flush();
    harness.fireDocumentEvent(eventName, { target: video });
    video.readyState = 1;
    await harness.flush();
    await runScan(harness);
  };
  await wake("loadedmetadata");
  await wake("loadeddata");
  await wake("canplay");
  assert.equal(messagesOf(harness, "mosa.beginVideoTransfer").length, 3, "each media event leads to exactly one capture");
});

test("manual save requests capture the selected image or video and explain rejections", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: false, ...GEMINI });
  const img = mountGeminiGeneratedImage(harness);
  await harness.flush();
  const imageResponse = await harness.dispatchRuntimeMessage({
    type: "mosa.capture.saveImageWithPrompt",
    imageUrl: img.src,
  });
  assert.equal(imageResponse?.ok, true, "a manual image save on a generated image succeeds");
  const ingest = messagesOf(harness, "mosa.ingest")[0];
  assert.equal(ingest.message.payload.captureMode, "manual");
  assert.equal(ingest.message.payload.provider, "gemini");

  const rejected = await harness.dispatchRuntimeMessage({
    type: "mosa.capture.saveImage",
    imageUrl: "https://lh3.googleusercontent.com/not-in-page.png",
  });
  assert.equal(rejected?.ok, false, "media that is not a visible generated image is rejected");
  const toast = harness.document.getElementById("mosa-provider-capture-toast");
  assert.ok(toast, "the rejection is explained on the page");
  assert.equal(toast.textContent, "无法保存：请在支持的网站上选择生成的图片");
  assert.equal(toast.getAttribute("role"), "alert");

  const flow = await createProviderSitesHarness({ autoCapture: false, ...FLOW });
  const video = new FakeProviderVideo({
    src: "blob:https://flow.google.com/vid-manual",
    readyState: 1,
    rect: visibleRect(640, 360),
  });
  mountFlowRow(flow, video, [textNode("A cabin in the woods"), reusePromptButton(flow)]);
  await flow.flush();
  const videoResponse = await flow.dispatchRuntimeMessage({
    type: "mosa.capture.saveVideoWithPrompt",
    videoUrl: video.src,
  });
  assert.equal(videoResponse?.ok, true, "a manual video save on a generated video succeeds");
  const begin = messagesOf(flow, "mosa.beginVideoTransfer")[0];
  assert.equal(begin.message.payload.mediaKind, "video");
  assert.equal(begin.message.payload.captureMode, "manual");
  assert.equal(begin.message.payload.prompt, "A cabin in the woods");
});

test("retryable hand-offs free the dedupe key twice, 60 seconds apart", async () => {
  const imageUrl = "https://lh3.googleusercontent.com/retryable.png";
  const harness = await createProviderSitesHarness({
    autoCapture: true,
    ...GEMINI,
    respond: async (message) => (message?.type === "mosa.ingest" ? { ok: false, retryable: true } : undefined),
  });
  mountGeminiGeneratedImage(harness, { src: imageUrl });
  await harness.flush();
  const ingests = () => messagesOf(harness, "mosa.ingest").length;

  await runScan(harness);
  assert.equal(ingests(), 1);
  assert.equal(harness.state.seen.has(imageUrl), true, "a retryable answer frees the key only later");

  harness.advance(30_000);
  await runScan(harness);
  assert.equal(ingests(), 1, "the key stays held within the 60 second gap");

  harness.advance(30_000);
  await runScan(harness);
  assert.equal(ingests(), 2, "after 60 seconds the first retry re-captures");

  harness.advance(30_000);
  await runScan(harness);
  assert.equal(ingests(), 2);

  harness.advance(30_000);
  await runScan(harness);
  assert.equal(ingests(), 3, "the second retry re-captures once more");

  harness.advance(60_000);
  await runScan(harness);
  assert.equal(ingests(), 3, "after the second retry the key stays locked");
});

test("prompt retries walk their ladder and give up after the last tier", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...GEMINI });
  mountGeminiGeneratedImage(harness);
  await harness.flush();
  await runScan(harness);
  assert.equal(messagesOf(harness, "mosa.ingest").length, 1);
  const state = [...harness.state.promptRetryStates.values()][0];
  assert.ok(state, "a prompt retry is scheduled after a capture without a Prompt");
  assert.equal(state.attempt, 1, "the first tier is armed immediately");

  const tiers = [900, 2_700, 7_200, 15_000, 30_000];
  for (const [index, tier] of tiers.entries()) {
    harness.advanceClock(tier - 1);
    harness.timers.fireTimeouts({ dueBefore: 0 });
    assert.equal(state.attempt, index + 1, `tier ${index + 1} (${tier}ms) must not fire one millisecond early`);
    harness.advanceClock(1);
    harness.timers.fireTimeouts({ dueBefore: 0 });
    await harness.flush();
    assert.equal(messagesOf(harness, "mosa.upgradeMetadata").length, 0, "no upgrade is sent while no Prompt is visible");
    if (index < tiers.length - 1) {
      assert.equal(state.attempt, index + 2, `tier ${index + 2} is armed by tier ${index + 1}`);
    }
  }
  assert.equal(harness.state.promptRetryStates.size, 0, "the ladder gives up after the last tier");
  assert.equal(messagesOf(harness, "mosa.ingest").length, 1, "the archived capture is not resent");
});

test("a late Prompt upgrades the archived capture exactly once", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...GEMINI });
  const img = geminiImage();
  const userQuery = harness.document.createElement("user-query");
  const modelResponse = harness.document.createElement("model-response");
  modelResponse.appendChild(img);
  harness.document.body.appendChild(userQuery);
  harness.document.body.appendChild(modelResponse);
  harness.document.images.push(img);
  await harness.flush();
  await runScan(harness);
  assert.equal(messagesOf(harness, "mosa.ingest").length, 1);
  assert.equal(messagesOf(harness, "mosa.upgradeMetadata").length, 0);

  userQuery.textContent = "A late-rendered question";
  await harness.flush();
  harness.advanceClock(900);
  harness.timers.fireTimeouts({ dueBefore: 0 });
  await harness.flush();
  const upgrades = messagesOf(harness, "mosa.upgradeMetadata");
  assert.equal(upgrades.length, 1, "the first retry after the Prompt renders upgrades the capture");
  assert.equal(upgrades[0].message.payload.provider, "gemini");
  assert.equal(upgrades[0].message.payload.sourceMediaUrl, img.src);
  assert.equal(upgrades[0].message.payload.prompt, "A late-rendered question");
  assert.equal(upgrades[0].message.payload.promptStatus, "provider-visible-prompt");
  assert.equal(upgrades[0].message.payload.promptSource, "gemini-visible-user-prompt");

  harness.advanceClock(7_200 + 15_000 + 30_000);
  harness.timers.fireTimeouts({ dueBefore: 0 });
  await harness.flush();
  assert.equal(messagesOf(harness, "mosa.upgradeMetadata").length, 1, "the upgrade happens exactly once");
  assert.equal(harness.state.promptRetryStates.size, 0);
});

test("captures without a visible Prompt report promptStatus not-available", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...GEMINI });
  mountGeminiGeneratedImage(harness);
  await harness.flush();
  await runScan(harness);
  const payload = messagesOf(harness, "mosa.ingest")[0]?.message?.payload;
  assert.equal(payload.promptStatus, "not-available", "no Prompt must say so, not pretend one exists");
  assert.equal(payload.prompt, undefined, "an empty string must never masquerade as a Prompt");
  assert.equal(payload.promptSource, "provider-visible-image");

  const videoHarness = await createProviderSitesHarness({ autoCapture: true, ...AI_STUDIO_VIDEO });
  await videoHarness.flush();
  videoHarness.advance(300);
  const video = new FakeProviderVideo({
    src: "blob:https://aistudio.google.com/vid-no-prompt",
    readyState: 1,
    attrs: { "data-generated": "true" },
    rect: visibleRect(640, 360),
  });
  videoHarness.document.videos.push(video);
  await videoHarness.flush();
  await runScan(videoHarness);
  const videoPayload = messagesOf(videoHarness, "mosa.beginVideoTransfer")[0]?.message?.payload;
  assert.equal(videoPayload.promptStatus, "not-available");
  assert.equal(videoPayload.promptSource, "provider-visible-video");
});

test("the provider observer scans on DOM mutations and its config stays bounded", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...GEMINI });
  const observer = harness.observers[0];
  assert.ok(observer, "an observer is started while capture is on");
  assert.equal(observer.observed[0].target, harness.document.documentElement);
  assert.deepEqual(
    JSON.parse(JSON.stringify(observer.observed[0].options)),
    {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: false,
      attributeFilter: ["src", "srcset", "class", "aria-hidden", "hidden"],
    },
  );

  await harness.flush();
  harness.advance(300); // consume the boot scan before the image exists
  mountGeminiGeneratedImage(harness);
  observer.trigger();
  await harness.flush();
  harness.timers.fireTimeouts({ ms: 300 });
  await harness.flush();
  assert.equal(messagesOf(harness, "mosa.ingest").length, 1, "a DOM mutation leads to the scan that captures");
});

test("page-local blob media is read only same-origin and carries the page bytes", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...GEMINI });
  const crossOrigin = mountGeminiGeneratedImage(harness, { src: "blob:https://evil.test/stolen" });
  const sameOriginHttps = mountGeminiGeneratedImage(harness, { src: "https://gemini.google.com/local.png" });
  await harness.flush();
  await runScan(harness);
  assert.equal(messagesOf(harness, "mosa.ingest").length, 0, "a cross-origin blob handle and a plain same-origin URL are both refused");

  const local = mountGeminiGeneratedImage(harness, { src: "blob:https://gemini.google.com/good" });
  await harness.flush();
  await runScan(harness);
  const ingest = messagesOf(harness, "mosa.ingest")[0];
  assert.ok(ingest, "a supported same-origin blob image is captured");
  assert.equal(ingest.message.payload.localMediaIdentity, local.src);
  assert.ok((ingest.message.payload.imageBase64 || "").length > 0, "the page bytes are sent as base64");
  assert.equal(ingest.message.payload.imageUrl, undefined);
  assert.equal(harness.fetchCalls[0]?.url, local.src);
  assert.equal(harness.fetchCalls[0]?.init?.credentials, "same-origin");
  assert.equal(harness.state.seen.has(crossOrigin.src), false);
  assert.equal(harness.state.seen.has(sameOriginHttps.src), false);
});

test("provider capture work is limited to two concurrent tasks", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...GEMINI });
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const tasks = Array.from({ length: 5 }, (_, index) => harness.state.withCaptureSlot(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolveTask) => releases.push(resolveTask));
    active -= 1;
    return index;
  }));

  await setImmediate();
  assert.equal(active, 2);
  assert.equal(maxActive, 2);
  while (releases.length || active) {
    releases.shift()?.();
    await setImmediate();
  }
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
  assert.equal(maxActive, 2, "no more than two captures ever run at once");
});

test("a Flow thumbnail that probes as video is captured as a remote video", async () => {
  const videoUrl = "https://flow-content.google/generated/rendered.mp4";
  const harness = await createProviderSitesHarness({
    autoCapture: true,
    ...FLOW,
    probeFlowMedia: { ok: true, result: { mediaKind: "video", mediaUrl: videoUrl } },
  });
  const tile = new FakeProviderImage({
    src: flowRedirectUrl("media-video"),
    naturalWidth: 200,
    naturalHeight: 200,
    rect: visibleRect(200, 200),
  });
  harness.document.body.appendChild(tile);
  harness.document.images.push(tile);
  await harness.flush();
  await runScan(harness);

  const ingest = messagesOf(harness, "mosa.ingest")[0];
  assert.ok(ingest, "the probed video is captured");
  assert.equal(ingest.message.payload.provider, "flow");
  assert.equal(ingest.message.payload.mediaKind, "video");
  assert.equal(ingest.message.payload.mediaUrl, videoUrl, "the remote video URL is handed to the background");
  assert.equal(ingest.message.payload.imageBase64, undefined, "no page bytes are read for a remote video");
  assert.equal(harness.fetchCalls.length, 0, "the thumbnail URL is never fetched for page bytes");
  assert.equal(messagesOf(harness, "mosa.probeFlowMedia").length, 1, "the archived media id is not probed again");
});

test("AI Studio prompt association reads the user prompt block beside the model turn", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, host: "aistudio.google.com", pathname: "/prompts/abc" });
  const img = new FakeProviderImage({ src: "https://lh3.googleusercontent.com/aistudio-1.png", rect: visibleRect() });
  const userTurn = harness.document.createElement("ms-chat-turn");
  userTurn.setAttribute("id", "turn-abc");
  const userContainer = harness.document.createElement("div");
  userContainer.className = "chat-turn-container user";
  const promptBlock = harness.document.createElement("div");
  promptBlock.className = "user-prompt-container";
  promptBlock.appendChild(textNode("A lighthouse in a storm"));
  userContainer.appendChild(promptBlock);
  userTurn.appendChild(userContainer);
  const modelTurn = harness.document.createElement("ms-chat-turn");
  const modelContainer = harness.document.createElement("div");
  modelContainer.className = "chat-turn-container model";
  modelContainer.appendChild(img);
  modelTurn.appendChild(modelContainer);
  const sessionContent = harness.document.createElement("div");
  sessionContent.className = "chat-session-content";
  sessionContent.appendChild(userTurn);
  sessionContent.appendChild(modelTurn);
  harness.document.body.appendChild(sessionContent);
  harness.document.images.push(img);
  await harness.flush();
  await runScan(harness);

  const payload = messagesOf(harness, "mosa.ingest")[0]?.message?.payload;
  assert.ok(payload, "the model-turn image is captured");
  assert.equal(payload.provider, "google-ai-studio");
  assert.equal(payload.prompt, "A lighthouse in a storm");
  assert.equal(payload.promptStatus, "provider-visible-prompt");
  assert.equal(payload.promptSource, "google-ai-studio-visible-user-prompt");
  assert.equal(payload.generationContextId, "ai-studio-turn:abc", "the block id anchors on the first user turn");
});

test("the image load event wakes the scan", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...GEMINI });
  await harness.flush();
  harness.advance(300);
  mountGeminiGeneratedImage(harness);
  await harness.flush();
  harness.fireDocumentEvent("load", {});
  await harness.flush();
  harness.timers.fireTimeouts({ ms: 300 });
  await harness.flush();
  assert.equal(messagesOf(harness, "mosa.ingest").length, 1, "the load event leads to the scan that captures");
});

test("options page loads settings and defaults auto-capture off", async () => {
  const harness = await createOptionsHarness({
    settings: { mosaBaseUrl: "http://127.0.0.1:9", mosaToken: "saved-token", autoCapture: false },
  });
  assert.equal(harness.elements.mosaBaseUrl.value, "http://127.0.0.1:9");
  assert.equal(harness.elements.mosaToken.value, "saved-token");
  assert.equal(harness.elements.autoCapture.checked, false, "the stored off switch stays off in the checkbox");

  const fallback = await createOptionsHarness({
    runtimeError: true,
    storageLocal: [["mosaBaseUrl", "http://localhost:8080"], ["autoCapture", true]],
  });
  assert.equal(fallback.elements.mosaBaseUrl.value, "http://localhost:8080", "with the background gone the page reads chrome.storage.local");
  assert.equal(fallback.elements.autoCapture.checked, true, "a stored on switch is restored");
  assert.ok(fallback.elements.status.textContent.includes("无法读取设置"), "the read failure is explained");
  assert.ok(fallback.storage.localReads.length >= 1, "the fallback went through chrome.storage.local");
});

test("options save normalizes the local address and persists through chrome.storage.local", async () => {
  const harness = await createOptionsHarness({
    settings: { mosaBaseUrl: "http://127.0.0.1:9", mosaToken: "", autoCapture: false },
  });
  harness.elements.mosaBaseUrl.value = "http://127.0.0.1:43517/";
  harness.elements.mosaToken.value = "tok-1";
  harness.elements.autoCapture.checked = true;
  await harness.click("save");
  await harness.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(harness.storage.localWrites[0])), {
    mosaBaseUrl: "http://127.0.0.1:43517",
    mosaToken: "tok-1",
    autoCapture: true,
  });
  assert.equal(harness.elements.status.textContent, "已保存。刷新已打开的支持网站后生效。");
  assert.equal(harness.storage.local.get("mosaToken"), "tok-1", "the write landed in chrome.storage.local");

  for (const [label, badUrl] of [
    ["a non-local host", "https://example.com:1"],
    ["a non-http protocol", "https://127.0.0.1:43517"],
    ["embedded credentials", "http://user:pass@127.0.0.1:43517"],
  ]) {
    const rejecting = await createOptionsHarness({
      settings: { mosaBaseUrl: "http://127.0.0.1:9", mosaToken: "", autoCapture: false },
    });
    rejecting.elements.mosaBaseUrl.value = badUrl;
    await rejecting.click("save");
    await rejecting.flush();
    assert.equal(rejecting.storage.localWrites.length, 0, `${label} must not be written`);
    assert.ok(rejecting.elements.status.textContent.includes("地址必须") || rejecting.elements.status.textContent.includes("地址无效"), `${label} is explained`);
  }

  const legacy = await createOptionsHarness({
    settings: { mosaBaseUrl: "http://127.0.0.1:9", mosaToken: "", autoCapture: false },
  });
  legacy.elements.mosaBaseUrl.value = "http://127.0.0.1:43517";
  legacy.elements.mosaToken.value = "mosa-web-capture-dev";
  await legacy.click("save");
  await legacy.flush();
  assert.equal(legacy.storage.localWrites.length, 0, "the legacy development token is rejected");
  assert.ok(legacy.elements.status.textContent.includes("已失效"), "the legacy token rejection is explained");
});

test("options connection test verifies the service identity before using the Token", async () => {
  const baseUrl = "http://127.0.0.1:43517";
  const identityHandler = (token) => async (url, init) => {
    if (new URL(url).pathname === "/api/web-capture/identity") {
      const { nonce } = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ proof: await identityProof(baseUrl, token, nonce) }) };
    }
    return undefined;
  };

  const happy = await createOptionsHarness({
    settings: { mosaBaseUrl: baseUrl, mosaToken: "", autoCapture: false },
    fetchHandler: async (url, init) => (await identityHandler("tok-1")(url, init))
      ?? (new URL(url).pathname === "/api/ingest/web-capture"
        ? { ok: false, status: 400, json: async () => ({ code: "WEB_CAPTURE_BAD_IMAGE" }) }
        : undefined),
  });
  happy.elements.mosaToken.value = "tok-1";
  await happy.click("test");
  await happy.flush();
  assert.equal(happy.elements.status.textContent, "连接测试通过。", "a verified identity plus the validation probe passes");
  const probe = happy.fetchCalls.find((call) => call.url.includes("/api/ingest/web-capture"));
  assert.equal(probe.init.headers.authorization, "Bearer tok-1", "the probe carries the real token path");
  const identityIndex = happy.fetchCalls.findIndex((call) => call.url.includes("/api/web-capture/identity"));
  const probeIndex = happy.fetchCalls.findIndex((call) => call.url.includes("/api/ingest/web-capture"));
  assert.ok(identityIndex >= 0, "the identity challenge happens");
  assert.ok(identityIndex < probeIndex, "identity first, token second");

  const unauthorized = await createOptionsHarness({
    settings: { mosaBaseUrl: baseUrl, mosaToken: "", autoCapture: false },
    fetchHandler: async (url, init) => (await identityHandler("stale-token")(url, init))
      ?? (new URL(url).pathname === "/api/ingest/web-capture"
        ? { ok: false, status: 401, json: async () => ({ code: "WEB_CAPTURE_UNAUTHORIZED" }) }
        : undefined),
  });
  unauthorized.elements.mosaToken.value = "stale-token";
  await unauthorized.click("test");
  await unauthorized.flush();
  assert.ok(unauthorized.elements.status.textContent.includes("令牌（Token）与 GravityPort 不一致"), "a rejected token is reported without re-pairing");

  const mismatch = await createOptionsHarness({
    settings: { mosaBaseUrl: baseUrl, mosaToken: "", autoCapture: false },
    fetchHandler: identityHandler("someone-elses-token"),
  });
  mismatch.elements.mosaToken.value = "tok-1";
  await mismatch.click("test");
  await mismatch.flush();
  assert.ok(mismatch.elements.status.textContent.includes("连接到的不是你的 GravityPort"), "a wrong identity proof stops the token from being used");
  assert.equal(mismatch.fetchCalls.some((call) => call.url.includes("/api/ingest/web-capture")), false, "the token is never sent to an unverified service");

  const notMosa = await createOptionsHarness({
    settings: { mosaBaseUrl: baseUrl, mosaToken: "", autoCapture: false },
    fetchHandler: async (url) => (new URL(url).pathname === "/api/health"
      ? { ok: true, status: 200, json: async () => ({ product: "someone-else", productVersion: "9.9.9" }) }
      : undefined),
  });
  await notMosa.click("test");
  await notMosa.flush();
  assert.ok(notMosa.elements.status.textContent.includes("不是 GravityPort"), "a non-GravityPort service is named as such");
});
