/**
 * Behavior tests for Flow's new Angular grid tiles (task 402).
 *
 * The real page (flow.google.com/project/<uuid>, probed 2026-11-13) renders
 * generated images as flow-* components: flow-grid-tile-container >
 * flow-tile-container > div > flow-image-tile > div > img, where the img
 * points at a same-origin /asb/… thumbnail and carries a UUID in
 * data-media-id. Every test boots the REAL extension sources through
 * test/helpers/provider-sites-harness.mjs with that structure as the fixture;
 * nothing here matches on source text or copies functions into the tests.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderSitesHarness,
  FakeProviderImage,
  textNode,
} from "./helpers/provider-sites-harness.mjs";

const FLOW = { host: "flow.google.com", pathname: "/project/p1" };
const MEDIA_ID = "0f2c7a9e-5b1d-4c8a-9e2f-6a3b7c1d5e9f";
const asbThumbnailUrl = (token) => `https://flow.google.com/asb/${token}`;
const flowRedirectUrl = (name) => `https://flow.google.com/api/trpc/media.getMediaUrlRedirect?name=${name}`;
const flowFxRedirectUrl = (name) => `https://flow.google.com/fx/api/trpc/media.getMediaUrlRedirect?name=${name}`;
const messagesOf = (harness, type) => harness.sentMessages.filter((entry) => entry.message?.type === type);

const visibleRect = (width = 800, height = 600) => ({
  x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height,
});

/** A new-page grid tile: the exact outer path observed on the real page. */
function newGridTileImage(overrides = {}) {
  return new FakeProviderImage({
    src: asbThumbnailUrl("ANqvLO-token-1"),
    alt: "显示用户图片的图块",
    attrs: { "data-media-id": MEDIA_ID, draggable: "true" },
    naturalWidth: 286,
    naturalHeight: 512,
    rect: visibleRect(286, 512),
    ...overrides,
  });
}

/** Mount an img in the real new-page chain and register it with the page. */
function mountGridTile(harness, img) {
  const imageTileInner = harness.document.createElement("div");
  imageTileInner.appendChild(img);
  const imageTile = harness.document.createElement("flow-image-tile");
  imageTile.appendChild(imageTileInner);
  const tileInner = harness.document.createElement("div");
  tileInner.appendChild(imageTile);
  const tileContainer = harness.document.createElement("flow-tile-container");
  tileContainer.appendChild(tileInner);
  const grid = harness.document.createElement("flow-grid-tile-container");
  grid.appendChild(tileContainer);
  harness.document.body.appendChild(grid);
  harness.document.images.push(img);
  return grid;
}

/** A new-page failure tile: a sibling tile component holding error text. */
function mountFailureTile(harness, grid, text) {
  const imageTile = harness.document.createElement("flow-image-tile");
  const tileText = harness.document.createElement("div");
  tileText.appendChild(textNode(text));
  imageTile.appendChild(tileText);
  const tileContainer = harness.document.createElement("flow-tile-container");
  tileContainer.appendChild(imageTile);
  grid.appendChild(tileContainer);
  return tileContainer;
}

const runScan = async (harness) => {
  harness.runScheduledScan();
  await harness.flush();
};

test("new-page grid tiles are scanned and probed through the redirect endpoint", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const tile = mountGridTile(harness, newGridTileImage());
  await harness.flush();
  await runScan(harness);

  const probe = messagesOf(harness, "mosa.probeFlowMedia")[0];
  assert.ok(probe, "the new tile is scanned and probed");
  assert.equal(probe.message.url, flowFxRedirectUrl(MEDIA_ID));
  assert.equal(probe.message.url.includes("/asb/"), false, "the /asb/ thumbnail is never probed");

  const ingest = messagesOf(harness, "mosa.ingest")[0];
  assert.ok(ingest, "the probe answer archives the media");
  assert.equal(ingest.message.payload.provider, "flow");
  assert.equal(ingest.message.payload.imageUrl, flowFxRedirectUrl(MEDIA_ID), "the capture uses the redirect endpoint");
  assert.equal(ingest.message.payload.localMediaIdentity, flowFxRedirectUrl(MEDIA_ID));
  assert.equal(ingest.message.payload.promptStatus, "not-available", "a tile without cards has no Prompt");
  assert.equal(ingest.message.payload.prompt, undefined, "the Prompt stays empty instead of guessing");

  assert.deepEqual([...harness.state.seen], [`flow-media:${MEDIA_ID}`], "the dedupe key stays flow-media:<id>");
  assert.equal(harness.state.seen.has(tile.src), false, "the thumbnail URL is not a seen key");
});

test("new-page tiles without a canonical data-media-id are never captured", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const invalidIds = ["../x", "", "abc123?extra", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"];
  for (const [index, mediaId] of invalidIds.entries()) {
    mountGridTile(harness, newGridTileImage({
      src: asbThumbnailUrl(`token-${index}`),
      attrs: { "data-media-id": mediaId },
    }));
  }
  await harness.flush();
  await runScan(harness);

  assert.equal(messagesOf(harness, "mosa.probeFlowMedia").length, 0, "no invalid id is probed");
  assert.equal(messagesOf(harness, "mosa.ingest").length, 0, "no invalid id is captured");
  assert.equal(harness.state.seen.size, 0, "invalid tiles leave no seen key");
});

test("valid ids on non-/asb/ sources are never captured", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  mountGridTile(harness, newGridTileImage({ src: "https://cdn.example.com/asb/token-1" }));
  mountGridTile(harness, newGridTileImage({ src: "https://flow.google.com/other/token-2.png" }));
  await harness.flush();
  await runScan(harness);

  assert.equal(messagesOf(harness, "mosa.probeFlowMedia").length, 0, "a foreign-host /asb/ twin is not probed");
  assert.equal(messagesOf(harness, "mosa.ingest").length, 0, "a same-origin non-/asb/ path is not captured");
  assert.equal(harness.state.seen.size, 0);
});

test("old redirect-src tiles keep their exact probe and capture URL", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const tile = new FakeProviderImage({
    src: flowRedirectUrl("legacy-media-1"),
    naturalWidth: 200,
    naturalHeight: 200,
    rect: visibleRect(200, 200),
  });
  harness.document.body.appendChild(tile);
  harness.document.images.push(tile);
  await harness.flush();
  await runScan(harness);

  const probe = messagesOf(harness, "mosa.probeFlowMedia")[0];
  assert.ok(probe, "the legacy tile is still scanned");
  assert.equal(probe.message.url, flowRedirectUrl("legacy-media-1"), "the old rule is untouched");
  assert.equal(messagesOf(harness, "mosa.ingest")[0]?.message?.payload?.imageUrl, flowRedirectUrl("legacy-media-1"));
  assert.deepEqual([...harness.state.seen], ["flow-media:legacy-media-1"]);
});

test("the user-visible failure copy never becomes the Prompt", async () => {
  const failureText = "失败 我们发现了一些异常活动。请注意，修改页面的浏览器扩展程序可能会导致问题。如需了解详情，请访问 。 本次生成不计费。";

  // (a) The exact screenshot copy on a plain sibling card is dropped by text.
  const exact = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const exactGrid = mountGridTile(exact, newGridTileImage());
  const exactCard = exact.document.createElement("div");
  exactCard.appendChild(textNode(failureText));
  exactGrid.appendChild(exactCard);
  await exact.flush();
  await runScan(exact);
  const exactPayload = messagesOf(exact, "mosa.ingest")[0]?.message?.payload;
  assert.ok(exactPayload, "the image itself is still captured");
  assert.equal(exactPayload.prompt, undefined, "the failure copy is never attached as the Prompt");
  assert.equal(exactPayload.promptStatus, "not-available");

  // (b) The failure word followed by whitespace is dropped even without the
  // two hint sentences.
  const prefix = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const prefixGrid = mountGridTile(prefix, newGridTileImage());
  const prefixCard = prefix.document.createElement("div");
  prefixCard.appendChild(textNode("失败 请稍后再试。"));
  prefixGrid.appendChild(prefixCard);
  await runScan(prefix);
  const prefixPayload = messagesOf(prefix, "mosa.ingest")[0]?.message?.payload;
  assert.ok(prefixPayload, "the image itself is still captured");
  assert.equal(prefixPayload.prompt, undefined);

  // (b2) A user's own prompt that merely starts with 失败 is still the Prompt.
  const userPrompt = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const userGrid = mountGridTile(userPrompt, newGridTileImage());
  const userCard = userPrompt.document.createElement("div");
  userCard.appendChild(textNode("失败的蛋糕，暖色调"));
  userGrid.appendChild(userCard);
  await runScan(userPrompt);
  const userPayload = messagesOf(userPrompt, "mosa.ingest")[0]?.message?.payload;
  assert.ok(userPayload, "the image itself is still captured");
  assert.equal(userPayload.prompt, "失败的蛋糕，暖色调", "a prompt that only starts with 失败 is not a failure notice");

  // (c) A tile component holding prose is dropped by structure, not by text.
  const structural = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const structuralGrid = mountGridTile(structural, newGridTileImage());
  mountFailureTile(structural, structuralGrid, "普通文字，不是失败文案");
  await runScan(structural);
  const structuralPayload = messagesOf(structural, "mosa.ingest")[0]?.message?.payload;
  assert.ok(structuralPayload, "the image itself is still captured");
  assert.equal(structuralPayload.prompt, undefined, "tile components are never Prompt cards");
  assert.equal(structuralPayload.promptStatus, "not-available");
});

test("a plain non-tile text card beside the tile still becomes the Prompt", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const grid = mountGridTile(harness, newGridTileImage());
  const card = harness.document.createElement("div");
  card.appendChild(textNode("A cabin in the woods"));
  grid.appendChild(card);
  await harness.flush();
  await runScan(harness);

  const payload = messagesOf(harness, "mosa.ingest")[0]?.message?.payload;
  assert.ok(payload, "the tile is captured");
  assert.equal(payload.prompt, "A cabin in the woods", "the old one-card association is preserved");
  assert.equal(payload.promptStatus, "provider-visible-prompt");
  assert.equal(payload.promptSource, "flow-visible-prompt");
});

test("the same media id as /asb/ and as a redirect URL is captured once", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const tile = mountGridTile(harness, newGridTileImage());
  await harness.flush();
  await runScan(harness);
  assert.equal(messagesOf(harness, "mosa.probeFlowMedia").length, 1);
  assert.equal(messagesOf(harness, "mosa.ingest").length, 1);

  // Flow rerenders the same generation with the redirect-src markup.
  tile.src = flowRedirectUrl(MEDIA_ID);
  tile.currentSrc = flowRedirectUrl(MEDIA_ID);
  tile.setAttribute("src", flowRedirectUrl(MEDIA_ID));
  await runScan(harness);

  assert.equal(messagesOf(harness, "mosa.probeFlowMedia").length, 1, "the redirect markup is not probed again");
  assert.equal(messagesOf(harness, "mosa.ingest").length, 1, "the media is not captured twice");
  assert.deepEqual([...harness.state.seen], [`flow-media:${MEDIA_ID}`]);
});

// ---- Manual save (right-click) on the new grid: issue #363 ----
// The context menu hands over the rendered src, which on the new grid is the
// same-origin /asb/… address. Automatic capture keeps refusing that address
// (thumbnail bytes); a manual save resolves it against the clicked element.

const manualSave = (harness, imageUrl) => harness.dispatchRuntimeMessage({
  type: "mosa.capture.saveImageWithPrompt",
  imageUrl,
});

test("manual save of a grid tile archives the original through the redirect endpoint", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: false, ...FLOW });
  const tile = newGridTileImage();
  mountGridTile(harness, tile);
  await harness.flush();

  const response = await manualSave(harness, tile.src);
  assert.equal(response?.ok, true, "the save is accepted");
  const probe = messagesOf(harness, "mosa.probeFlowMedia")[0];
  assert.equal(probe?.message?.url, flowFxRedirectUrl(MEDIA_ID), "the original is looked up by media id");
  const payload = messagesOf(harness, "mosa.ingest")[0]?.message?.payload;
  assert.ok(payload, "the tile is archived");
  assert.equal(payload.captureMode, "manual");
  assert.equal(payload.mediaKind, "image");
  assert.equal(payload.imageUrl, flowFxRedirectUrl(MEDIA_ID), "the archived bytes are the original, not the thumbnail");
  assert.equal(payload.localMediaIdentity, flowFxRedirectUrl(MEDIA_ID), "the identity matches automatic capture, so one image is stored once");
});

test("manual save of a grid tile keeps its visible Prompt card", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: false, ...FLOW });
  const tile = newGridTileImage();
  const grid = mountGridTile(harness, tile);
  const card = harness.document.createElement("div");
  card.appendChild(textNode("A cabin in the woods"));
  grid.appendChild(card);
  await harness.flush();

  await manualSave(harness, tile.src);
  const payload = messagesOf(harness, "mosa.ingest")[0]?.message?.payload;
  assert.equal(payload?.prompt, "A cabin in the woods");
  assert.equal(payload?.promptSource, "flow-visible-prompt");
});

test("manual save of a video tile archives the video the tile stands for", async () => {
  const videoUrl = "https://flow-content.google/video/generated-1.mp4";
  const harness = await createProviderSitesHarness({
    autoCapture: false,
    ...FLOW,
    probeFlowMedia: { ok: true, result: { mediaKind: "video", mediaUrl: videoUrl, mimeType: "video/mp4" } },
  });
  const tile = newGridTileImage();
  mountGridTile(harness, tile);
  await harness.flush();

  const response = await manualSave(harness, tile.src);
  assert.equal(response?.ok, true);
  const payload = messagesOf(harness, "mosa.ingest")[0]?.message?.payload;
  assert.equal(payload?.mediaKind, "video");
  assert.equal(payload?.mediaUrl, videoUrl);
  assert.equal(payload?.captureMode, "manual");
  assert.equal(payload?.imageUrl, undefined, "the poster thumbnail is not archived as an image");
});

test("manual save of a grid tile whose original cannot be reached saves nothing", async () => {
  const harness = await createProviderSitesHarness({
    autoCapture: false,
    ...FLOW,
    probeFlowMedia: { ok: false, error: "Flow media probe failed (503)" },
  });
  const tile = newGridTileImage();
  mountGridTile(harness, tile);
  await harness.flush();

  const response = await manualSave(harness, tile.src);
  assert.equal(response?.ok, false);
  assert.equal(response?.error, "无法保存：未获取到原图，请稍后重试");
  assert.equal(messagesOf(harness, "mosa.ingest").length, 0, "the thumbnail never stands in for the original");
});

test("manual save of an enlarged /asb/ preview without a media id archives the image on screen", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: false, ...FLOW });
  const previewUrl = `${asbThumbnailUrl("ANqvLO-token-preview")}=s0`;
  const preview = new FakeProviderImage({
    src: previewUrl,
    naturalWidth: 1478,
    naturalHeight: 3200,
    rect: visibleRect(370, 800),
  });
  harness.document.body.appendChild(preview);
  harness.document.images.push(preview);
  await harness.flush();

  const response = await manualSave(harness, previewUrl);
  assert.equal(response?.ok, true);
  assert.equal(messagesOf(harness, "mosa.probeFlowMedia").length, 0, "there is no media id to look up");
  const payload = messagesOf(harness, "mosa.ingest")[0]?.message?.payload;
  assert.equal(payload?.imageUrl, previewUrl);
  assert.equal(payload?.localMediaIdentity, previewUrl);
  assert.equal(payload?.captureMode, "manual");
  assert.equal(payload?.width, 1478);
  assert.equal(payload?.height, 3200);
});

test("manual save refuses /asb/ addresses that are thumbnails, off-origin, or not on the page", async () => {
  const rejection = "无法保存：请在支持的网站上选择生成的图片";
  const harness = await createProviderSitesHarness({ autoCapture: false, ...FLOW });
  // A thumbnail-sized /asb/ image with no usable media id.
  const bare = newGridTileImage({ src: asbThumbnailUrl("token-bare"), attrs: { "data-media-id": "../x" } });
  mountGridTile(harness, bare);
  // A foreign host that merely copies the path shape.
  const foreign = new FakeProviderImage({ src: "https://cdn.example.com/asb/token-foreign=s0", naturalWidth: 2048, naturalHeight: 2048, rect: visibleRect() });
  harness.document.body.appendChild(foreign);
  harness.document.images.push(foreign);
  await harness.flush();

  for (const imageUrl of [bare.src, foreign.src, `${asbThumbnailUrl("token-not-rendered")}=s0`, "https://flow.google.com/asb/"]) {
    const response = await manualSave(harness, imageUrl);
    assert.equal(response?.ok, false, imageUrl);
    assert.equal(response?.error, rejection, imageUrl);
  }
  assert.equal(messagesOf(harness, "mosa.probeFlowMedia").length, 0);
  assert.equal(messagesOf(harness, "mosa.ingest").length, 0);
});

test("automatic capture still ignores an enlarged /asb/ preview without a media id", async () => {
  const harness = await createProviderSitesHarness({ autoCapture: true, ...FLOW });
  const grid = mountGridTile(harness, newGridTileImage());
  const preview = new FakeProviderImage({
    src: `${asbThumbnailUrl("ANqvLO-token-preview")}=s0`,
    naturalWidth: 1478,
    naturalHeight: 3200,
    rect: visibleRect(370, 800),
  });
  grid.appendChild(preview);
  harness.document.images.push(preview);
  const card = harness.document.createElement("div");
  card.appendChild(textNode("A cabin in the woods"));
  grid.appendChild(card);
  await harness.flush();
  await runScan(harness);

  const ingests = messagesOf(harness, "mosa.ingest");
  assert.equal(ingests.length, 1, "only the tile is captured; its preview would store the same image twice");
  assert.equal(ingests[0].message.payload.imageUrl, flowFxRedirectUrl(MEDIA_ID));
});
