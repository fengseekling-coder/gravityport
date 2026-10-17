import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";

const manifest = JSON.parse(await readFile(new URL("../extensions/chatgpt-web-capture/manifest.json", import.meta.url), "utf8"));
const backgroundSource = await readFile(new URL("../extensions/chatgpt-web-capture/background.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../extensions/chatgpt-web-capture/content.js", import.meta.url), "utf8");
const generationRegistrySource = await readFile(new URL("../extensions/chatgpt-web-capture/generation-registry.js", import.meta.url), "utf8");
const contentCss = await readFile(new URL("../extensions/chatgpt-web-capture/content.css", import.meta.url), "utf8");
const optionsSource = await readFile(new URL("../extensions/chatgpt-web-capture/options.js", import.meta.url), "utf8");
const optionsHtml = await readFile(new URL("../extensions/chatgpt-web-capture/options.html", import.meta.url), "utf8");
const providerPolicySource = await readFile(new URL("../extensions/chatgpt-web-capture/provider-policy.js", import.meta.url), "utf8");
const providerSource = await readFile(new URL("../extensions/chatgpt-web-capture/provider-sites.js", import.meta.url), "utf8");

import {
  createHookHarness,
  generationEvents,
  hookSource,
  MockMessagePort,
} from "./helpers/page-hook-harness.mjs";

function createGenerationRegistryHarness({ imageLookupKeys } = {}) {
  const sandbox = {};
  vm.runInNewContext(generationRegistrySource, sandbox, { filename: "generation-registry.js" });
  return sandbox.MosaGenerationRegistry.createGenerationRegistry({
    imageLookupKeys: imageLookupKeys || ((imageUrl, meta = {}) => {
      const keys = [];
      if (meta.imageKey) keys.push(meta.imageKey);
      if (meta.assetId) keys.push(`asset:${meta.assetId}`);
      if (imageUrl) keys.push(`url:${imageUrl}`);
      return [...new Set(keys)];
    }),
    promptQuality: (entry) => Number(entry.promptPriority || 0) * 1_000_000 + String(entry.prompt || "").length,
  });
}

test("installs the page hook in the main world before ChatGPT page scripts", () => {
  const hook = manifest.content_scripts.find((entry) => entry.js?.includes("page-hook.js"));
  assert.equal(hook?.run_at, "document_start");
  assert.equal(hook?.world, "MAIN");
  // dev-raw-diagnostics.js must run before page-hook.js so the hook finds
  // MosaDevRawDiagnostics on the very first SSE/WS frame.
  assert.deepEqual(hook?.js, ["dev-raw-diagnostics.js", "page-hook.js"]);
});

test("declares the supported Google media sites and provider content script", () => {
  assert.equal(manifest.version, "0.15.32");
  assert.deepEqual(
    manifest.content_scripts.find((entry) => entry.js?.includes("provider-sites.js"))?.matches,
    ["https://gemini.google.com/*", "https://labs.google/*", "https://flow.google.com/*", "https://aistudio.google.com/*"],
  );
  for (const host of [
    "https://gemini.google.com/*",
    "https://labs.google/*",
    "https://flow.google.com/*",
    "https://aistudio.google.com/*",
    "https://*.googleusercontent.com/*",
    "https://storage.googleapis.com/*",
    "https://flow-content.google/*",
  ]) assert.ok(manifest.host_permissions.includes(host), `missing ${host}`);
  assert.match(providerPolicySource, /host === "gemini\.google\.com"/);
  assert.match(providerPolicySource, /host === "labs\.google"/);
  assert.match(providerPolicySource, /host === "flow\.google\.com"/);
  assert.match(providerPolicySource, /host === "aistudio\.google\.com"/);
});

test("Google adapters capture visible images and supported Flow / AI Studio videos with bounded Prompt lookup", () => {
  const executableProviderSource = providerSource.replace(/\/\/.*$/gm, "");
  assert.match(providerSource, /const IMAGE_HOSTS/);
  assert.match(providerSource, /getBoundingClientRect/);
  assert.match(providerSource, /document\.images/);
  assert.match(providerSource, /document\.querySelectorAll\?\.\("video"\)/);
  assert.match(providerSource, /function flowMediaIdFromImage\(img\)/);
  assert.match(providerSource, /media\.getMediaUrlRedirect/);
  assert.match(providerSource, /function captureFlowMediaThumbnail\(img\)/);
  assert.match(providerSource, /if \(!mediaId \|\| !isVisibleFlowMediaThumbnail\(img\)\) return false;/,
    "Flow media capture must not require Prompt text to render before the media");
  assert.match(providerSource, /function isCaptureEligibleImage\(provider, img\)/,
    "Flow thumbnail Prompt association must use the thumbnail floor, not the 512px generic-image floor");
  assert.match(providerSource, /FLOW_PROBE_BACKOFF_DELAYS = \[15_000, 60_000, 300_000\]/,
    "failed Flow media probes must back off instead of re-firing every scan");
  assert.match(providerSource, /flowProbeFailures\.clear\(\)/);
  assert.match(providerSource, /type: "mosa\.probeFlowMedia"/);
  assert.match(providerSource, /probe\.mediaKind === "video"/);
  assert.match(providerSource, /function isVisibleGeneratedVideo\(video\)/);
  assert.match(providerSource, /function isProviderGeneratedVideo\(provider, video\)/);
  assert.match(providerSource, /AI_STUDIO_VIDEO_PATH = \/\^\\\/generate-video/);
  assert.match(providerSource, /AI_STUDIO_VIDEO_PATH\.test\(String\(location\.pathname/);
  assert.match(providerSource, /document\.addEventListener\("loadedmetadata", \(\) => \{ if \(autoCapture\) scheduleScan\(\); \}, true\)/);
  assert.match(providerSource, /document\.addEventListener\("loadeddata", \(\) => \{ if \(autoCapture\) scheduleScan\(\); \}, true\)/);
  assert.match(providerSource, /document\.addEventListener\("canplay", \(\) => \{ if \(autoCapture\) scheduleScan\(\); \}, true\)/);
  assert.match(providerSource, /"flow-content\.google"/);
  assert.match(providerSource, /media\?\.videoWidth \|\| media\?\.naturalWidth \|\| media\?\.width/);
  assert.match(providerSource, /media\?\.videoHeight \|\| media\?\.naturalHeight \|\| media\?\.height/);
  assert.match(providerSource, /sendCapture\(provider, source, video, \{ mediaKind: "video" \}\)/);
  assert.match(providerSource, /promptStatus: "not-available"/);
  assert.match(providerSource, /promptSource: video \? "provider-visible-video" : "provider-visible-image"/);
  assert.match(providerSource, /promptStatus: "provider-visible-prompt"/);
  assert.match(providerSource, /promptSource: "gemini-visible-user-prompt"/);
  assert.match(providerSource, /promptSource: "flow-visible-prompt"/);
  assert.match(providerSource, /promptSource: "google-ai-studio-visible-user-prompt"/);
  assert.match(providerSource, /function geminiVisibleUserPromptForImage\(image\)/);
  assert.match(providerSource, /ancestorWithTag\(image, "model-response"\)/);
  assert.match(providerSource, /String\(previous\.tagName \|\| ""\)\.toLowerCase\(\) === "user-query"/);
  assert.match(providerSource, /GEMINI_PROMPT_MAX_CHARS = 24_000/);
  assert.match(providerSource, /GEMINI_MAX_PREVIOUS_TURNS = 8/);
  assert.match(providerSource, /FLOW_PROMPT_ANCHOR = \/reuse\\s\+prompt\/i/);
  assert.match(providerSource, /FLOW_PROMPT_MAX_CHARS = 20_000/);
  assert.match(providerSource, /FLOW_PROMPT_MAX_ANCESTORS = 14/);
  assert.match(providerSource, /function flowNodeIsUiGlyph\(node\)/);
  assert.match(providerSource, /className\.includes\("material-symbol"\)/);
  assert.match(providerSource, /className\.includes\("google-symbol"\)/);
  assert.match(providerSource, /if \(flowNodeIsUiGlyph\(node\)\) return true/);
  assert.match(providerSource, /flowHasReusePromptAnchor/);
  assert.match(providerSource, /flowReusePromptAnchorCount/);
  assert.match(providerSource, /const buttonLike = tag === "button" \|\| tag === "a" \|\| role === "button" \|\| Boolean\(label\)/);
  assert.match(providerSource, /flowNearbyPromptCard/);
  assert.match(providerSource, /const reusePromptCards = promptCards\.filter/);
  assert.match(providerSource, /if \(reusePromptCards\.length === 1\)/);
  assert.doesNotMatch(providerSource, /!\/\\bprompt\\b\/i\.test\(raw\)/);
  assert.doesNotMatch(providerSource, /bestPrompt/);
  assert.doesNotMatch(providerSource, /console\.log/);
  assert.match(providerSource, /AI_STUDIO_PROMPT_MAX_CHARS = 24_000/);
  assert.match(providerSource, /AI_STUDIO_PROMPT_MAX_NODES = 12_000/);
  assert.match(providerSource, /AI_STUDIO_MAX_PREVIOUS_TURNS = 16/);
  assert.match(providerSource, /function aiStudioVisibleUserPromptForImage\(image\)/);
  assert.match(providerSource, /function isProviderGeneratedOutput\(provider, img\)/);
  assert.match(providerSource, /if \(!isProviderGeneratedOutput\(provider, img\)\) continue/);
  assert.match(providerSource, /provider === "gemini"/);
  assert.match(providerSource, /provider === "flow"/);
  assert.match(providerSource, /provider === "google-ai-studio"/);
  assert.match(providerSource, /ancestorWithTag\(image, "ms-chat-turn"\)/);
  assert.match(providerSource, /sessionContent\?\.classList\?\.contains\("chat-session-content"\)/);
  assert.match(providerSource, /directTurnContainer\(imageTurn, "model"\)/);
  assert.match(providerSource, /directTurnContainer\(turn, "user"\)/);
  assert.match(providerSource, /descendantsWithClass\(userContainer, "user-prompt-container"\)/);
  assert.match(providerSource, /previous = previous\.previousElementSibling/);
  assert.match(providerSource, /contenteditable/);
  assert.match(providerSource, /"textarea"/);
  assert.match(providerSource, /"mosa\.capture\.saveVideoWithPrompt"/);
  assert.match(providerSource, /function supportedImageUrl\(value\)/);
  assert.match(providerSource, /const PROMPT_RETRY_DELAYS = \[900, 2_700, 7_200, 15_000, 30_000\]/);
  assert.match(providerSource, /function schedulePromptRetry\(provider, source, mediaKind = "image", \{/);
  assert.match(providerSource, /lookupSourceUrl: lookupSource\?\.url \|\| source\.url/);
  assert.match(providerSource, /lookupMediaKind: "image"/);
  assert.match(providerSource, /type: "mosa\.upgradeMetadata"/);
  assert.match(providerSource, /sourceMediaUrl: state\.source\.url/);
  assert.match(providerSource, /function attemptPendingPromptUpgrades\(\)/);
  assert.match(providerSource, /characterData: false/);
  assert.match(providerSource, /attributeFilter: \["src", "srcset", "class", "aria-hidden", "hidden"\]/);
  assert.match(providerSource, /document\.addEventListener\("load", \(\) => \{ if \(autoCapture\) scheduleScan\(\); \}, true\)/);
  assert.match(providerSource, /function startProviderObserver\(\)/);
  assert.match(providerSource, /observer\?\.disconnect\(\)/);
  const providerSourceWithoutVideoQueries = executableProviderSource.replace(/document\.querySelectorAll\?\.\("video"\)/g, "");
  assert.doesNotMatch(providerSourceWithoutVideoQueries, /innerText|textContent|innerHTML|querySelectorAll|conversation/);
  assert.doesNotMatch(executableProviderSource, /document\.body\.innerText|document\.documentElement\.innerText/);
});

test("Google adapters read only eligible page-local bytes and keep CDN URLs remote", () => {
  assert.match(providerSource, /src\.startsWith\("blob:"\)/);
  assert.match(providerSource, /url\.origin !== location\.origin/);
  assert.match(providerSource, /isAllowedLocalImageUrl/);
  assert.match(providerSource, /providerPolicy\.isFlowMediaRedirectUrl\(url\.href\)/);
  assert.match(providerPolicySource, /isFlowMediaRedirectUrl/);
  assert.match(providerPolicySource, /"\/fx\/api\/trpc\/media\.getMediaUrlRedirect"/);
  assert.match(providerPolicySource, /"\/api\/trpc\/media\.getMediaUrlRedirect"/);
  assert.match(providerSource, /credentials: "same-origin"/);
  assert.match(providerSource, /const bytes = video \? await bytesFromVisibleVideo\(source, media\) : await bytesFromVisibleImage\(source, media\)/);
  assert.match(providerSource, /payload\.imageBase64 = bytes\.imageBase64/);
  assert.match(providerSource, /payload\.imageUrl = source\.url/);
  assert.match(providerSource, /if \(source\.kind === "local" && source\.url\.startsWith\("blob:"\)\) \{/);
  assert.match(providerSource, /!isVisibleGeneratedImage\(image\)/);
  assert.match(providerSource, /if \(source\?\.kind !== "local" \|\| !isVisibleGeneratedImage\(img\)\)/);
  assert.match(providerSource, /if \(!response\?\.ok\) seen\.delete\(source\.url\)/);
  assert.match(providerSource, /\.catch\(\(\) => seen\.delete\(source\.url\)\)/);
  assert.match(providerSource, /!changes\.autoCapture && !changes\.mosaBaseUrl && !changes\.mosaToken/);
  assert.match(providerSource, /seen\.clear\(\);/);
  assert.doesNotMatch(providerSource, /chrome\.cookies|document\.cookie|authorization/i);
});

test("Google adapter capture work is limited to two concurrent tasks", async () => {
  assert.match(providerSource, /const CAPTURE_CONCURRENCY = 2/);
  assert.match(providerSource, /return withCaptureSlot\(async \(\) => \{/);

  const helperSource = [
    /const CAPTURE_CONCURRENCY = 2;/.exec(providerSource)?.[0],
    /let captureInFlight = 0;/.exec(providerSource)?.[0],
    /const captureWaiters = \[\];/.exec(providerSource)?.[0],
    /async function withCaptureSlot\(task\) \{[\s\S]*?\n  \}/.exec(providerSource)?.[0],
  ].filter(Boolean).join("\n");
  assert.match(helperSource, /withCaptureSlot/);

  const context = { Promise };
  vm.runInNewContext(`${helperSource}\nthis.withCaptureSlot = withCaptureSlot;`, context, { filename: "provider-capture-limit.js" });

  let active = 0;
  let maxActive = 0;
  const releases = [];
  const tasks = Array.from({ length: 5 }, (_, index) => context.withCaptureSlot(async () => {
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
  assert.equal(maxActive, 2);
});

test("uses safe local extension settings without a public Token default", () => {
  assert.equal(typeof manifest.key, "string");
  assert.ok(manifest.key.length > 300);
  assert.match(backgroundSource, /mosaBaseUrl:\s*"http:\/\/127\.0\.0\.1:43517"/);
  assert.match(backgroundSource, /mosaToken:\s*""/);
  assert.doesNotMatch(backgroundSource, /mosaToken:\s*"mosa-web-capture-dev"/);
  assert.match(backgroundSource, /DISCOVERY_PORTS = \[43517, 43518, 43519, 43520, 43521\]/);
  assert.match(backgroundSource, /async function discoverAndPairMosa\(\)/);
  assert.match(backgroundSource, /\/api\/web-capture\/pair/);
  assert.match(backgroundSource, /async function repairPairing\(\)/);
  assert.match(backgroundSource, /chrome\.storage\.local\.get/);
  assert.match(backgroundSource, /chrome\.storage\.local\.set/);
  assert.match(contentSource, /chrome\.storage\?\.local\?\.get\?\./);
  assert.doesNotMatch(contentSource, /chrome\.storage\.sync\.set/);
  assert.match(optionsSource, /chrome\.storage\.local\.set/);
  assert.match(optionsSource, /function normalizeBaseUrl\(value\)/);
  assert.match(optionsSource, /\["127\.0\.0\.1", "localhost"\]\.includes\(url\.hostname\)/);
  assert.match(optionsSource, /baseUrl = normalizeBaseUrl\(baseUrlEl\.value\.trim\(\) \|\| DEFAULTS\.mosaBaseUrl\)/);
  assert.match(optionsHtml, /type="password"/);
});

test("keeps the extension key, version, and pairing identifiers intact across the GravityPort rename", () => {
  // The key is pinned verbatim: changing it would change the extension ID and break pairing.
  assert.equal(
    manifest.key,
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAofKTi8b+4rBSTVqJFccjuwj7wljVkVriU4N05gYSDuHviShLUFQxMjYMGRUQFHi81Y3hx2hVCgB5Fuz3hxKiZvSsEnSOax7pp4raSu3st7r/SFXy7+T0Hwvrv47oDnbPDeYFoSrgRRHGSLaX0hid/EhALBunFpQJmjdKrA+OL9n6RQBe8Lp7hrkZhReMV8h569JEOnHNw63BGr9y8OgSjdtb680bpDg9Acz3yM5A9CeeIFhYPNVHL1uCGTyRUK/zAbaOeRFVJkyFu1tTnA901Ik0TzbPkPmSKdVW/BdvwrYZsieYJZbdaA9KGtUwfMCm8jC/t8y8+w1Zx4bmuPKplQIDAQAB",
  );
  assert.equal(manifest.name, "GravityPort Web Capture");
  assert.equal(manifest.version, "0.15.32");
  // Storage keys and the pairing product identifier stay "mosa" so old
  // extensions keep working with the renamed App and vice versa.
  assert.match(backgroundSource, /if \(identity\?\.product !== "mosa"\) continue;/);
  assert.match(backgroundSource, /if \(body\?\.product !== "mosa" \|\| !token\) continue;/);
  assert.match(backgroundSource, /return body\?\.product === "mosa";/);
  assert.match(optionsSource, /identity\?\.product !== "mosa"/);
  assert.match(backgroundSource, /mosaToken/);
  assert.match(backgroundSource, /mosaBaseUrl/);
});

test("surfaces MOSA's own ingest error when pairing repair keeps the same connection", async () => {
  // The failed body used to be drained before the repair attempt and read
  // again afterwards, so users saw "body stream already read" instead.
  const functionSource = (name) => new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(backgroundSource)?.[0];
  const source = ["ingestToMosa", "ingestResponseError", "mosaUnavailableError", "normalizeBaseUrl"].map(functionSource);
  assert.ok(source.every(Boolean));
  const connection = { baseUrl: "http://127.0.0.1:43519", token: "token-test" };

  for (const [status, error] of [[401, "Web Capture Token 无效"], [404, "Web Capture 路由不存在"], [500, "MOSA 内部错误"]]) {
    let requests = 0;
    const context = {
      URL,
      DEFAULTS: { mosaBaseUrl: connection.baseUrl },
      WEB_IMAGE_PROVIDERS: new Set(["chatgpt"]),
      WEB_VIDEO_PROVIDERS: new Set(),
      getSettings: async () => ({ mosaBaseUrl: connection.baseUrl, mosaToken: connection.token }),
      repairPairing: async () => ({ ...connection }),
      captureRequestPayload: (payload) => ({ ...payload }),
      fetchWithTimeout: async () => {
        requests += 1;
        return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
      },
    };
    vm.runInNewContext(`${source.join("\n")}\nthis.ingestToMosa = ingestToMosa;`, context, { filename: "background-ingest.js" });

    await assert.rejects(
      context.ingestToMosa({ provider: "chatgpt", imageBase64: "aW1hZ2U=" }),
      (thrown) => thrown.message === error && thrown.status === status,
    );
    assert.equal(requests, 1, "an unchanged pairing must not resend the capture");
  }
});

test("defaults capture off and keeps Chrome permissions minimal", () => {
  assert.deepEqual(manifest.permissions, ["storage", "contextMenus", "alarms", "unlimitedStorage"]);
  assert.equal(manifest.permissions.includes("activeTab"), false);
  assert.match(backgroundSource, /autoCapture:\s*false/);
  assert.match(optionsSource, /autoCapture:\s*false/);
  assert.match(contentSource, /let autoCapture = false/);
  assert.match(providerSource, /let autoCapture = false/);
  assert.match(optionsHtml, /默认关闭/);
  assert.match(backgroundSource, /if \(details\?\.reason === "install"\) await chrome\.runtime\.openOptionsPage\(\)/);
});

test("manual fallback controls cover ChatGPT images and Google videos", () => {
  assert.match(contentSource, /data-action="save-visible">保存当前图</);
  assert.match(contentSource, /data-action="save-all">保存全部大图</);
  assert.match(backgroundSource, /id: "mosa-save-video"/);
  assert.match(backgroundSource, /contexts: \["video"\]/);
  assert.match(providerSource, /"mosa\.capture\.saveVideoWithPrompt"/);
  assert.match(providerSource, /mediaKind: videoRequest \? "video" : "image"/);
});

test("ChatGPT hook stays dormant until capture is explicitly enabled", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      generated: {
        message: {
          id: "message-dormant",
          author: { role: "tool", name: "image_gen" },
          content: { parts: [{ asset_pointer: "sediment://file-dormant" }] },
        },
      },
    },
  }, "conversation-test", { captureEnabled: false });

  await harness.harvest();
  assert.equal(harness.events.some((event) => event.payload?.imageKey?.includes("file-dormant")), false);
  assert.match(hookSource, /if \(!isCaptureEnabled\(\)\) return response/);
  assert.match(hookSource, /if \(!isCaptureEnabled\(\)\) return;/);
});

test("ChatGPT generation asset hosts stay consistent across hook, content script, and manifest", () => {
  assert.ok(manifest.host_permissions.includes("https://*.blob.core.windows.net/*"));
  assert.match(hookSource, /blob\.core/);
  assert.match(contentSource, /"blob\.core\.windows\.net"/);
  assert.match(contentSource, /if \(!isLikelyGeneratedUrl\(imageUrl\)\) return;/);
});

test("ChatGPT startup and SPA conversation changes proactively recover missed generation metadata", () => {
  const bootStart = contentSource.indexOf("loadSettings().then(() => {");
  const intervalStart = contentSource.indexOf("autoScanInterval = setInterval", bootStart);
  const boot = contentSource.slice(bootStart, intervalStart);
  assert.ok(bootStart >= 0 && intervalStart > bootStart);
  assert.match(boot, /requestCurrentConversationRefresh\(null\);[\s\S]*scheduleScan\(true\);/);
  assert.match(contentSource, /const previousConversationId = activeConversationId;/);
  assert.match(contentSource, /adoptConversationId\(nextConversationId\);/);
  assert.match(contentSource, /nextConversationId !== previousConversationId\) requestCurrentConversationRefresh\(null\);/);
  assert.match(contentSource, /function scheduleGenerationEvidenceRecovery\(candidate\)/);
  assert.match(contentSource, /enqueueDomFallback\(candidate\)/);
});

test("new-chat conversation identity is adopted without clearing live-only generation state", () => {
  const functions = ["conversationIdFromUrl", "currentConversationId", "adoptConversationId"]
    .map((name) => new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(contentSource)?.[0])
    .filter(Boolean)
    .join("\n");
  let resets = 0;
  const context = {
    location: { pathname: "/", href: "https://chatgpt.com/" },
    activeConversationId: "",
    resetConversationTransientState() { resets += 1; },
  };
  vm.runInNewContext(`${functions}\nthis.adopt = adoptConversationId; this.current = currentConversationId;`, context);

  assert.equal(context.current(), "");
  assert.equal(context.adopt("conversation-new"), "conversation-new");
  assert.equal(resets, 0, "transport identity enrichment must preserve live-only evidence");
  context.location.pathname = "/c/conversation-new";
  assert.equal(context.adopt("conversation-new"), "conversation-new");
  assert.equal(resets, 0, "URL assignment for the same conversation must not reset state");

  assert.equal(context.adopt("conversation-stale"), "", "stale transport events must lose to the named URL conversation");
  assert.equal(resets, 0);
  context.location.pathname = "/c/conversation-other";
  assert.equal(context.adopt("conversation-other"), "conversation-other");
  assert.equal(resets, 1, "a real conversation switch must clear transient state once");
});

test("ChatGPT DOM hook reacts to both src and srcset changes", () => {
  assert.match(hookSource, /m\.attributeName === "src" \|\| m\.attributeName === "srcset"/);
  assert.match(hookSource, /attributeFilter: \["src", "srcset"\]/);
});

test("oversized ChatGPT metadata fails visibly while DOM fallback remains available", () => {
  assert.match(hookSource, /via === "conversation-refresh" \? 32_000_000 : 12_000_000/);
  assert.match(hookSource, /post\("harvest-skipped", \{ reason: "payload-too-large", size: text\.length, via \}\)/);
  assert.match(contentSource, /data\.type === "harvest-skipped"/);
  assert.match(contentSource, /会话元数据过大，已启用图片兜底/);
  assert.match(contentSource, /function enqueueDomFallback\(candidate\)/);
});

test("ChatGPT automatic capture work is limited to two concurrent tasks", async () => {
  const helperSource = [
    /const AUTO_CAPTURE_CONCURRENCY = 2;/.exec(contentSource)?.[0],
    /let autoCaptureInFlight = 0;/.exec(contentSource)?.[0],
    /const autoCaptureWaiters = \[\];/.exec(contentSource)?.[0],
    /async function withAutoCaptureSlot\(task\) \{[\s\S]*?\n  \}/.exec(contentSource)?.[0],
  ].filter(Boolean).join("\n");
  assert.match(helperSource, /withAutoCaptureSlot/);

  const context = { Promise };
  vm.runInNewContext(`${helperSource}\nthis.withAutoCaptureSlot = withAutoCaptureSlot;`, context, { filename: "chatgpt-capture-limit.js" });

  let active = 0;
  let maxActive = 0;
  const releases = [];
  const tasks = Array.from({ length: 5 }, (_, index) => context.withAutoCaptureSlot(async () => {
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
  assert.equal(maxActive, 2);
});

test("ChatGPT recovery never captures or replays page authentication headers", () => {
  assert.doesNotMatch(hookSource, /forwardedHeaders|rememberRequestHeaders|oai-device-id|oai-client-version|oai-language/i);
  assert.match(hookSource, /function isInterestingResponseUrl\(value\)/);
  assert.doesNotMatch(hookSource, /chatgpt\\\.com\|openai\\\.com\|backend-api\|conversation\|images\?/);
});

test("archives an image-generation tool result even when ChatGPT omits its prompt", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      generated: {
        message: {
          id: "message-no-prompt",
          author: { role: "tool", name: "image_gen" },
          content: { parts: [{ asset_pointer: "sediment://file-no-prompt" }] },
        },
      },
    },
  });

  await harness.harvest();

  const generation = harness.events.find((event) => (
    event.type === "generation-meta"
    && event.payload?.imageKey === "estuary:conversation-test:file-no-prompt"
  ));
  assert.ok(generation, "the image tool result should still emit generation evidence");
  assert.equal(generation.payload.prompt, "");
  assert.equal(generation.payload.promptStatus, "not-available");
  assert.equal(generation.payload.isGeneration, true);
  assert.equal(generation.payload.generationContextId, "chatgpt:conversation-test:message-no-prompt");
});

test("ordinary conversation JSON containing data: is not misclassified as SSE", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      generated: {
        message: {
          id: "message-data-text",
          author: { role: "tool", name: "image_gen" },
          content: {
            parts: [
              "Model caption: poster with literal data: labels in the typography system and editorial lighting.",
              { asset_pointer: "sediment://file-data-text" },
            ],
          },
        },
      },
    },
  });

  await harness.harvest();

  assert.ok(harness.events.some((event) => (
    event.type === "generation-meta"
    && event.payload?.imageKey === "estuary:conversation-test:file-data-text"
  )));
});

test("keeps provider runtime ids separate from MOSA capture context ids", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-provider-ids",
    mapping: {
      generated: {
        message: {
          id: "message-provider-ids",
          response_id: "resp-web-observed",
          author: { role: "tool", name: "image_gen" },
          metadata: { tool_call_id: "call-web-observed" },
          content: { parts: [{ asset_pointer: "sediment://file-provider-ids" }] },
        },
      },
    },
  });

  await harness.harvest();
  const generation = harness.events.find((event) => (
    event.type === "generation-meta"
    && event.payload?.imageKey === "estuary:conversation-provider-ids:file-provider-ids"
  ));
  assert.ok(generation);
  assert.equal(generation.payload.generationContextId, "chatgpt:conversation-provider-ids:call-web-observed");
  assert.equal(generation.payload.providerToolCallId, "call-web-observed");
  assert.equal(generation.payload.providerGenerationCallId, "");
  assert.equal(generation.payload.providerResponseId, "resp-web-observed");
});

test("captures an explicit provider generation-call id without promoting a generic tool-call id", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-generation-call",
    mapping: {
      generated: {
        message: {
          id: "message-generation-call",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            tool_call_id: "call-tool-generic",
            image_generation_call_id: "ig-web-explicit",
          },
          content: { parts: [{ asset_pointer: "sediment://file-generation-call" }] },
        },
      },
    },
  });

  await harness.harvest();
  const generation = harness.events.find((event) => (
    event.type === "generation-meta"
    && event.payload?.imageKey === "estuary:conversation-generation-call:file-generation-call"
  ));
  assert.ok(generation);
  assert.equal(generation.payload.providerToolCallId, "call-tool-generic");
  assert.equal(generation.payload.providerGenerationCallId, "ig-web-explicit");
});

test("preserves event-scoped conversation and generation-call identity through extension ingest", () => {
  assert.match(contentSource, /const transportConversationId = String\(item\.conversationId \|\| item\.conversation_id \|\| ""\)/);
  assert.match(contentSource, /conversationId: transportConversationId \|\| currentConversationId\(\)/);
  assert.match(contentSource, /providerGenerationCallId: String\(item\.providerGenerationCallId \|\| item\.provider_generation_call_id \|\| ""\)/);
  assert.match(contentSource, /conversationId: resolved\.conversationId \|\| currentConversationId\(\)/);
  assert.match(contentSource, /providerGenerationCallId: resolved\.providerGenerationCallId \|\| ""/);
  assert.match(backgroundSource, /providerGenerationCallId: payload\.providerGenerationCallId \|\| ""/);
});

test("accepts an assistant-owned image_gen result when ChatGPT does not use role=tool", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      generated: {
        message: {
          id: "message-assistant-image-gen",
          author: { role: "assistant", name: "image_gen" },
          content: { parts: [{ asset_pointer: "sediment://file-assistant-image" }] },
        },
      },
    },
  });

  await harness.harvest();

  const generation = harness.events.find((event) => (
    event.type === "generation-meta"
    && event.payload?.imageKey === "estuary:conversation-test:file-assistant-image"
  ));
  assert.ok(generation);
  assert.equal(generation.payload.isGeneration, true);
});

test("treats image_gen dalle.prompt as a trusted generation prompt", async () => {
  const prompt = "red sun over mountains";
  const harness = createHookHarness({
    conversation_id: "conversation-dalle-prompt",
    mapping: {
      generated: {
        message: {
          id: "message-dalle-prompt",
          author: { role: "tool", name: "image_gen" },
          metadata: { dalle: { prompt } },
          content: { parts: [{ asset_pointer: "sediment://file-dalle-prompt" }] },
        },
      },
    },
  }, "conversation-dalle-prompt");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-dalle-prompt");
  assert.equal(generation?.payload.prompt, prompt);
  assert.equal(generation?.payload.promptStatus, "generation-tool-prompt");
  assert.equal(generation?.payload.promptSource, "prompt");
});

test("recognizes dalle metadata as generation provenance when the tool name is omitted", async () => {
  const prompt = "red sun";
  const harness = createHookHarness({
    conversation_id: "conversation-dalle-unnamed",
    mapping: {
      generated: {
        message: {
          id: "message-dalle-unnamed",
          author: { role: "tool" },
          metadata: { dalle: { prompt } },
          content: { parts: [{ asset_pointer: "sediment://file-dalle-unnamed" }] },
        },
      },
    },
  }, "conversation-dalle-unnamed");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-dalle-unnamed");
  assert.equal(generation?.payload.prompt, prompt);
  assert.equal(generation?.payload.promptStatus, "generation-tool-prompt");
  assert.equal(generation?.payload.isGeneration, true);
});

test("normalizes camelCase ChatGPT prompt and asset fields", async () => {
  const prompt = "A detailed editorial poster with blue type and warm evening light";
  const harness = createHookHarness({
    conversation_id: "conversation-camel-prompt",
    mapping: {
      generated: {
        message: {
          id: "message-camel-prompt",
          author: { role: "tool", name: "imageGen" },
          metadata: { revisedPrompt: prompt },
          content: { parts: [{ assetPointer: "sediment://file-camel-prompt" }] },
        },
      },
    },
  }, "conversation-camel-prompt");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-camel-prompt");
  assert.equal(generation?.payload.prompt, prompt);
  assert.equal(generation?.payload.promptStatus, "generation-tool-prompt");
  assert.equal(generation?.payload.promptSource, "revised_prompt");
});

test("uses deterministic provider prompt priority instead of dropping equally trusted fields", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-prompt-priority",
    mapping: {
      generated: {
        message: {
          id: "message-prompt-priority",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            generation_prompt: "lower-priority generation prompt",
            revised_prompt: "provider revised prompt wins",
          },
          content: { parts: [{ asset_pointer: "sediment://file-priority" }] },
        },
      },
    },
  }, "conversation-prompt-priority");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-priority");
  assert.equal(generation?.payload.prompt, "provider revised prompt wins");
  assert.equal(generation?.payload.promptPriority, 700);
});

test("accepts a plain caption from an assistant-owned image_gen message", async () => {
  const prompt = "red sun";
  const harness = createHookHarness({
    conversation_id: "conversation-assistant-caption",
    mapping: {
      generated: {
        message: {
          id: "message-assistant-caption",
          author: { role: "assistant", name: "image_gen" },
          content: { parts: [{ asset_pointer: "sediment://file-assistant-caption" }, prompt] },
        },
      },
    },
  }, "conversation-assistant-caption");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-assistant-caption");
  assert.equal(generation?.payload.prompt, prompt);
  assert.equal(generation?.payload.promptStatus, "visible-caption");
});

test("keeps revised prompt provenance in generic non-message response objects", async () => {
  const prompt = "A cinematic desert poster with bold type";
  const harness = createHookHarness({
    generation: {
      revisedPrompt: prompt,
      assetPointer: "sediment://file-generic-revised",
    },
  }, "conversation-generic-revised");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-generic-revised");
  assert.equal(generation?.payload.prompt, prompt);
  assert.equal(generation?.payload.promptStatus, "generation-tool-prompt");
  assert.equal(generation?.payload.isGeneration, true);
});

test("reads a structured prompt from a generic realtime object", async () => {
  const prompt = "A precise editorial still life with black stone, chrome type, and narrow hard light.";
  const harness = createHookHarness({
    message_id: "message-generic-structured",
    generation_call_id: "generation-generic-structured",
    generation_prompt: {
      content: [{ type: "text", text: prompt }],
    },
  }, "conversation-generic-structured");

  await harness.harvest();
  const event = harness.events.find((item) => (
    item.type === "generation-meta"
      && item.payload?.providerGenerationCallId === "generation-generic-structured"
      && item.payload?.prompt
  ));
  assert.ok(event);
  assert.equal(event.payload.prompt, prompt);
  assert.equal(event.payload.promptStatus, "generation-tool-prompt");
  assert.equal(event.payload.promptScope, "attempt");
  assert.equal(event.payload.isGeneration, true);
});

test("uses a trusted generation.gen_id to bind a prompt-only realtime frame", async () => {
  const prompt = "A cinematic monochrome product portrait with etched metal type and a narrow beam of light.";
  const harness = createHookHarness({
    generation: {
      gen_id: "generation-nested-frame",
      prompt,
    },
  }, "conversation-nested-frame");

  await harness.harvest();
  const event = harness.events.find((item) => (
    item.type === "generation-meta"
      && item.payload?.providerGenerationCallId === "generation-nested-frame"
      && item.payload?.prompt
  ));
  assert.ok(event);
  assert.equal(event.payload.prompt, prompt);
  assert.equal(event.payload.promptStatus, "generation-tool-prompt");
  assert.equal(event.payload.promptScope, "attempt");
  assert.equal(event.payload.isGeneration, true);
});

test("generation registry can bind a prompt-only frame to a promptless output by one message identity", () => {
  const registry = createGenerationRegistryHarness();
  registry.remember({
    assetId: "file-message-only-binding",
    conversationId: "conversation-message-binding",
    messageId: "message-message-binding",
    isGeneration: true,
  });
  registry.remember({
    prompt: "A provider prompt delivered in a separate frame.",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "message",
    conversationId: "conversation-message-binding",
    messageId: "message-message-binding",
  });

  const resolved = registry.resolvedForImage("", { assetId: "file-message-only-binding" });
  assert.equal(resolved?.prompt, "A provider prompt delivered in a separate frame.");
  assert.equal(resolved?.promptScope, "message");
  assert.equal(resolved?.isGeneration, true);
});

test("generation registry binds late prompts by stable context and never downgrades the best provider prompt", () => {
  const sandbox = {};
  vm.runInNewContext(generationRegistrySource, sandbox, { filename: "generation-registry.js" });
  const registry = sandbox.MosaGenerationRegistry.createGenerationRegistry({
    imageLookupKeys: (imageUrl, meta = {}) => {
      if (meta.assetId) return [`asset:${meta.assetId}`];
      return imageUrl ? [`url:${imageUrl}`] : [];
    },
    promptQuality: (entry) => Number(entry.promptPriority || 0) * 1_000_000 + String(entry.prompt || "").length,
  });

  registry.remember({
    imageUrl: "https://images.example/generated.png",
    conversationId: "conversation-late",
    messageId: "message-late",
    providerGenerationCallId: "generation-call-late",
    isGeneration: true,
  });
  registry.remember({
    prompt: "provider revised prompt",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    conversationId: "conversation-late",
    messageId: "message-late",
    providerGenerationCallId: "generation-call-late",
  });
  registry.remember({
    prompt: "later but lower-quality caption that must not overwrite revised prompt",
    promptStatus: "visible-caption",
    promptPriority: 325,
    conversationId: "conversation-late",
    messageId: "message-late",
    providerGenerationCallId: "generation-call-late",
  });

  const resolved = registry.resolvedForImage("https://images.example/generated.png");
  assert.equal(resolved.prompt, "provider revised prompt");
  assert.equal(resolved.promptPriority, 700);
  assert.equal(resolved.isGeneration, true);
});

test("generation registry keeps sibling outputs distinct inside one tool call", () => {
  const registry = createGenerationRegistryHarness();
  registry.remember({
    assetId: "file-a",
    prompt: "prompt A",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "output",
    providerToolCallId: "call-shared",
    conversationId: "conversation-multi",
    messageId: "message-multi",
    isGeneration: true,
  });
  registry.remember({
    assetId: "file-b",
    prompt: "a longer prompt B that must stay on output B",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "output",
    providerToolCallId: "call-shared",
    conversationId: "conversation-multi",
    messageId: "message-multi",
    isGeneration: true,
  });

  const a = registry.resolvedForImage("", { assetId: "file-a" });
  const b = registry.resolvedForImage("", { assetId: "file-b" });
  assert.equal(a?.prompt, "prompt A");
  assert.equal(a?.assetId, "file-a");
  assert.equal(b?.prompt, "a longer prompt B that must stay on output B");
  assert.equal(b?.assetId, "file-b");
});

test("generation registry never binds a failed attempt prompt to a different retry call", () => {
  const registry = createGenerationRegistryHarness();
  registry.remember({
    prompt: "prompt from failed attempt A",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "attempt",
    generationStatus: "failed",
    providerGenerationCallId: "gen-a",
    conversationId: "conversation-retry",
    messageId: "message-retry",
    isGeneration: true,
  });
  registry.remember({
    assetId: "file-success",
    generationStatus: "completed",
    providerGenerationCallId: "gen-b",
    conversationId: "conversation-retry",
    messageId: "message-retry",
    isGeneration: true,
  });

  const success = registry.resolvedForImage("", { assetId: "file-success" });
  assert.equal(success?.prompt, "");
  assert.equal(success?.providerGenerationCallId, "gen-b");
  assert.equal(success?.generationStatus, "completed");
  assert.equal(registry.resolvedForMessage("conversation-retry", "message-retry"), null, "ambiguous retry messages must fail closed");
});

test("generation registry suppresses a failed shared prompt when a weak reused tool id later completes", () => {
  const registry = createGenerationRegistryHarness();
  registry.remember({
    prompt: "prompt belonging only to the failed weak-id attempt",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "attempt",
    generationStatus: "failed",
    providerToolCallId: "weak-reused-call",
    conversationId: "conversation-weak-retry",
    messageId: "message-weak-retry",
    isGeneration: true,
  });
  registry.remember({
    assetId: "file-weak-success",
    generationStatus: "completed",
    providerToolCallId: "weak-reused-call",
    conversationId: "conversation-weak-retry",
    messageId: "message-weak-retry",
    isGeneration: true,
  });

  const success = registry.resolvedForImage("", { assetId: "file-weak-success" });
  assert.equal(success?.prompt, "");
  assert.equal(success?.generationStatus, "completed");
  assert.equal(success?.providerToolCallId, "weak-reused-call");
});

test("generation registry never uses failed message-only prose as a later output prompt", () => {
  const registry = createGenerationRegistryHarness();
  registry.remember({
    prompt: "message-level text from a failed generation",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "message",
    generationStatus: "failed",
    conversationId: "conversation-message-retry",
    messageId: "message-message-retry",
    isGeneration: true,
  });
  registry.remember({
    assetId: "file-message-success",
    providerToolCallId: "message-retry-call",
    generationStatus: "completed",
    conversationId: "conversation-message-retry",
    messageId: "message-message-retry",
    isGeneration: true,
  });

  const success = registry.resolvedForImage("", { assetId: "file-message-success" });
  assert.equal(success?.prompt, "");
  assert.equal(success?.generationStatus, "completed");
});

test("attempt-scoped late prompts fan out to every saved output without collapsing output identity", () => {
  const registry = createGenerationRegistryHarness();
  for (const assetId of ["file-a", "file-b", "file-c"]) {
    registry.remember({
      assetId,
      providerToolCallId: "call-shared",
      conversationId: "conversation-fanout",
      messageId: "message-fanout",
      isGeneration: true,
    });
  }
  const promptEvent = {
    prompt: "one provider prompt shared by the whole generation attempt",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "attempt",
    providerToolCallId: "call-shared",
    conversationId: "conversation-fanout",
    messageId: "message-fanout",
    isGeneration: true,
  };
  registry.remember(promptEvent);

  const outputs = registry.resolvedOutputsForEntry(promptEvent);
  assert.equal(outputs.map((item) => item.assetId).sort().join(","), "file-a,file-b,file-c");
  assert.ok(outputs.every((item) => item.prompt === promptEvent.prompt));
  assert.equal(registry.debugSnapshot()[0].outputs.length, 3);
});

test("generation registry enriches a provisional ChatGPT context without splitting the attempt", () => {
  const registry = createGenerationRegistryHarness();
  registry.remember({
    assetId: "file-context-enrichment",
    providerGenerationCallId: "generation-context-enrichment",
    generationContextId: "chatgpt:generation-context-enrichment",
    messageId: "output-before-route",
    prompt: "Model caption: a clean editorial image with soft light and bold type.",
    promptStatus: "visible-caption",
    promptPriority: 425,
    isGeneration: true,
  });
  registry.remember({
    assetId: "file-context-enrichment",
    providerGenerationCallId: "generation-context-enrichment",
    generationContextId: "chatgpt:conversation-assigned:generation-context-enrichment",
    conversationId: "conversation-assigned",
    messageId: "output-after-route",
    isGeneration: true,
  });

  const snapshot = registry.debugSnapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].generationContextId, "chatgpt:conversation-assigned:generation-context-enrichment");
  assert.equal(snapshot[0].outputs.length, 1);
  assert.equal(registry.resolvedForImage("", { assetId: "file-context-enrichment" }).promptStatus, "visible-caption");
});

test("multi-message DOM wrappers bind only when every message resolves to one generation attempt", () => {
  const registry = createGenerationRegistryHarness();
  const shared = {
    assetId: "file-shared-wrapper",
    providerGenerationCallId: "generation-shared-wrapper",
    conversationId: "conversation-wrapper",
    isGeneration: true,
  };
  registry.remember({ ...shared, messageId: "display-message" });
  registry.remember({ ...shared, messageId: "commentary-message", prompt: "Model caption: one silver object on a black field.", promptStatus: "visible-caption", promptPriority: 425 });

  const resolved = registry.resolvedForMessages("conversation-wrapper", ["display-message", "commentary-message"]);
  assert.ok(resolved);
  assert.equal(resolved.providerGenerationCallId, "generation-shared-wrapper");

  registry.remember({
    assetId: "file-retry-wrapper",
    providerGenerationCallId: "generation-retry-wrapper",
    conversationId: "conversation-wrapper",
    messageId: "retry-message",
    isGeneration: true,
  });
  assert.equal(registry.resolvedForMessages("conversation-wrapper", ["display-message", "retry-message"]), null);
});

test("content capture uses stable generation context instead of time-window prompt guessing", () => {
  assert.match(contentSource, /function generationRegistryForPage\(\)/);
  assert.match(contentSource, /resolvedForImage/);
  assert.match(contentSource, /imageKeysForEntry/);
  assert.doesNotMatch(contentSource, /findRecentUnboundPrompt|recentPrompts/);
});

test("content capture waits for generation stability and upgrades every output independently", () => {
  assert.match(contentSource, /const AUTO_STABILITY_DELAY_MS = 900/);
  assert.match(contentSource, /const AUTO_IN_PROGRESS_STALE_MS = 6_000/);
  assert.match(contentSource, /const AUTO_PARTIAL_FALLBACK_MS = 15_000/);
  assert.match(contentSource, /function autoCandidateReadiness\(candidate, evidence, reason\)/);
  assert.match(contentSource, /if \(status === "in_progress"\)[\s\S]*age < AUTO_IN_PROGRESS_STALE_MS[\s\S]*return \{ ready: true, forceTerminalRefresh: false \};/);
  assert.match(contentSource, /if \(status === "partial"\)[\s\S]*!pixelSignature[\s\S]*age < AUTO_PARTIAL_FALLBACK_MS/);
  assert.match(contentSource, /readiness\.forceTerminalRefresh/);
  assert.match(contentSource, /resolvedOutputsForEntry\?\.\(meta\)/);
  assert.match(contentSource, /for \(const resolvedMeta of targets\)/);
  assert.match(contentSource, /resolvedForMessages\?\.\(currentConversationId\(\), domMessageIds\)/);
});

test("websocket image identifiers are treated as interesting generation metadata", async () => {
  const harness = createHookHarness({});
  await harness.socketFrame(JSON.stringify({
    conversation_id: "conversation-test",
    message: {
      id: "socket-image-message",
      author: { role: "tool", name: "image_gen" },
      content: { parts: [{ image_id: "file-socket-image" }] },
    },
  }));

  const generation = harness.events.find((event) => (
    event.type === "generation-meta"
    && event.payload?.imageKey === "estuary:conversation-test:file-socket-image"
  ));
  assert.ok(generation, "image_id-only socket frames should reach the generation parser");
  assert.equal(generation.payload.isGeneration, true);
});

test("websocket ingress recognizes conversation message structure without relying on tool keywords", () => {
  const fn = /function hasConversationMessageShape\(text\) \{[\s\S]*?\n  \}/.exec(hookSource)?.[0] || "";
  assert.ok(fn, "hasConversationMessageShape should be extractable");
  const context = {};
  vm.runInNewContext(`${fn}\nthis.hasShape = hasConversationMessageShape;`, context);
  assert.equal(context.hasShape(JSON.stringify({
    type: "opaque-provider-event",
    payload: { update_content: { messages: [{ content: { parts: ["hello"] } }] } },
  })), true);
  assert.equal(context.hasShape(JSON.stringify({ type: "token-delta", payload: { text: "hello" } })), false);
  assert.match(hookSource, /WS_INTEREST\.test\(text\) \|\| hasConversationMessageShape\(text\)/);
  assert.match(hookSource, /WS_INTEREST\.test\(decoded\) \|\| hasConversationMessageShape\(decoded\)/);
});

test("does not treat an unrelated tool image as generated artwork", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      chart: {
        message: {
          id: "message-python-image",
          author: { role: "tool", name: "python" },
          content: { parts: [{ asset_pointer: "sediment://file-chart" }] },
        },
      },
    },
  });

  await harness.harvest();

  assert.equal(harness.events.some((event) => event.type === "generation-meta" && event.payload?.isGeneration), false);
});

test("background limits generated video capture to Flow and Google AI Studio", () => {
  assert.match(backgroundSource, /import "\.\/provider-policy\.js"/);
  assert.match(backgroundSource, /function senderAllowedForMessage\(message, sender\)/);
  assert.match(backgroundSource, /sender\.id !== chrome\.runtime\.id/);
  assert.match(backgroundSource, /Number\(sender\.frameId \?\? 0\) !== 0/);
  assert.match(backgroundSource, /transfer\.senderKey !== senderKey\(sender\)/);
  assert.match(backgroundSource, /new Set\(\["chatgpt", "gemini", "flow", "google-ai-studio"\]\)/);
  assert.match(backgroundSource, /WEB_VIDEO_PROVIDERS = new Set\(\["flow", "google-ai-studio"\]\)/);
  assert.match(backgroundSource, /const provider = String\(payload\.provider \|\| "chatgpt"\)/);
  assert.match(backgroundSource, /if \(!WEB_IMAGE_PROVIDERS\.has\(provider\)\)/);
  assert.match(backgroundSource, /if \(mediaKind === "video" && !WEB_VIDEO_PROVIDERS\.has\(provider\)\)/);
  assert.match(backgroundSource, /fetchMediaAsBase64\(mediaUrl, \{ publicMedia: false, mediaKind, binary: mediaKind === "video" \}\)/);
  assert.match(backgroundSource, /\/api\/ingest\/web-capture-binary/);
  assert.match(backgroundSource, /message\.type === "mosa\.beginVideoTransfer"/);
  assert.match(backgroundSource, /message\.type === "mosa\.videoTransferChunk"/);
  assert.match(backgroundSource, /message\.type === "mosa\.commitVideoTransfer"/);
  assert.match(backgroundSource, /await captureMediaPut\(\{/,
    "page-local videos should spool decoded chunks durably before the tab can disappear");
  assert.match(backgroundSource, /videoChunkKey\(transferId, index\)/);
  assert.match(backgroundSource, /async function ingestQueuedVideoSpool\(item\)/);
  assert.doesNotMatch(backgroundSource, /chunks:\s*new Array\(totalChunks\)/,
    "the extension background must not retain the full video in memory");
  assert.match(backgroundSource, /async function streamRemoteVideoToMosa\(payload, mediaUrl, connection\)/);
  assert.match(backgroundSource, /if \(mediaKind === "video"\) \{\s*return streamRemoteVideoToMosa\(payload, mediaUrl, \{ baseUrl, token \}\);/,
    "remote videos should stream into the upload session instead of being buffered first");
  assert.match(backgroundSource, /CAPTURE_QUEUE_MAX_ATTEMPTS = 3/);
  assert.match(backgroundSource, /await pruneStoredCaptureQueue\(\)/);
  assert.match(backgroundSource, /error\?\.code === "MOSA_UNAVAILABLE"/);
  assert.match(backgroundSource, /function sanitizeProvenanceUrl\(value\)/);
  assert.match(backgroundSource, /function assertAllowedRemoteMediaUrl\(value\)/);
  assert.match(backgroundSource, /const MAX_VIDEO_BYTES = 96 \* 1024 \* 1024/);
  assert.match(backgroundSource, /message\.type === "mosa\.probeFlowMedia"/);
  assert.match(backgroundSource, /async function probeFlowMedia\(url\)/);
  assert.match(backgroundSource, /headers: \{ Range: "bytes=0-31" \}/);
  assert.match(backgroundSource, /finalPath\.includes\("\/video\/"\)/);
  assert.match(backgroundSource, /\.\.\.\(publicMedia \? \[\] : \[\{ credentials: "include", cache: "no-cache" \}\]\)/);
  assert.doesNotMatch(backgroundSource, /provider:\s*"chatgpt"/);
});

test("background reports only bounded retry-queue diagnostics to the local task center", () => {
  const start = backgroundSource.indexOf("async function captureQueueStatusSnapshot()");
  const end = backgroundSource.indexOf("function reportCaptureQueueStatus()", start);
  assert.ok(start >= 0 && end > start);
  const snapshot = backgroundSource.slice(start, end);
  assert.match(snapshot, /queue\.slice\(0, 20\)/);
  assert.match(snapshot, /attempts:/);
  assert.match(snapshot, /lastError:/);
  assert.match(snapshot, /promptStatus:/);
  assert.doesNotMatch(snapshot, /\bprompt:/, "raw Prompt text must not be copied into queue diagnostics");
  assert.doesNotMatch(snapshot, /pageUrl|imageUrl|mediaUrl/, "provider/page media URLs must stay out of queue diagnostics");
  assert.match(backgroundSource, /\/api\/ingest\/web-capture-status/);
  assert.match(backgroundSource, /authorization: `Bearer \$\{token\}`/);
  assert.match(backgroundSource, /lastSeenRetryRequestId/);
});

test("ChatGPT page bridge only trusts the first privately transferred port", () => {
  // page-hook: commands arrive only through the transferred port; the only
  // window message it still accepts is a port request, from the same window,
  // and only until the first port has been confirmed. No channel name is
  // published in the DOM anymore.
  assert.doesNotMatch(hookSource, /mosaPageHookChannel/);
  assert.match(hookSource, /commandPortPost = commandPort\.postMessage\.bind\(commandPort\)/);
  assert.match(hookSource, /commandPort\.addEventListener\("message", onPortMessage\)/);
  assert.match(hookSource, /window\.addEventListener\("message", \(event\) => \{/);
  assert.match(hookSource, /if \(event\.source !== window\) return;/);
  assert.match(hookSource, /if \(data\.type !== "hook-port-request"\) return;/);
  assert.match(hookSource, /if \(portConfirmed\) return;/);
  assert.match(hookSource, /post\("capture-state", \{ enabled: captureEnabled \}\)/);
  // content.js: only event.source === window hook-port transfers with a port
  // are accepted, only the first port is adopted, and the ack goes back
  // through that port.
  assert.doesNotMatch(contentSource, /mosaPageHookChannel/);
  assert.match(contentSource, /window\.addEventListener\("message", \(event\) => \{/);
  assert.match(contentSource, /if \(event\.source !== window\) return;/);
  assert.match(contentSource, /if \(data\.type !== "hook-port"\) return;/);
  assert.match(contentSource, /if \(hookPort \|\| !event\.ports\?\.\[0\]\) return;/);
  assert.match(contentSource, /type: "hook-port-ack"/);
  assert.match(contentSource, /function syncPageHookCaptureEnabled\(attempt = 0\)/);
  assert.match(contentSource, /function desiredPageHookCaptureEnabled\(\)/);
  assert.match(contentSource, /return autoCapture \|\| Date\.now\(\) < manualHookLeaseUntil/);
  assert.match(contentSource, /pageHookCaptureAck === desired/);
  assert.match(contentSource, /const retryDelays = \[25, 100, 300, 750, 1_500, 2_500\]/);
  assert.match(contentSource, /data\.type === "capture-state"/);
  assert.match(contentSource, /DOMContentLoaded", \(\) => syncPageHookCaptureEnabled\(\)/);
});

test("the page hook publishes one private port instead of a DOM channel", () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", { captureEnabled: false, ack: false });

  assert.equal(harness.documentElement.dataset.mosaPageHook, "1");
  assert.equal("mosaPageHookChannel" in harness.documentElement.dataset, false);
  assert.equal(harness.hookPortOffers.length, 1);
  assert.equal(harness.windowMessages.length, 1, "the hand-off is the hook's only window message");
  const offer = harness.windowMessages[0];
  assert.equal(offer.event.source, "mosa-chatgpt-capture");
  assert.equal(offer.event.type, "hook-port");
  assert.equal(offer.targetOrigin, "https://chatgpt.com");
  assert.ok(offer.transfer?.[0] instanceof MockMessagePort, "the hand-off must transfer a MessagePort");
});

test("generation events travel only through the private port", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      poster: {
        message: {
          id: "message-poster",
          author: { role: "tool", name: "image_gen" },
          content: {
            parts: [
              { asset_pointer: "sediment://file-poster" },
            ],
          },
          metadata: { dalle: { prompt: "A silkscreen poster of a lighthouse in fog" } },
        },
      },
    },
  });

  await harness.harvest();

  assert.ok(generationEvents(harness).length > 0, "the harvest should still produce generation events");
  assert.equal(harness.hookPortOffers.length, 1);
  for (const entry of harness.windowMessages) {
    if (entry.event?.source !== "mosa-chatgpt-capture") continue;
    assert.equal(entry.event.type, "hook-port", "no capture message other than the port hand-off may use window.postMessage");
  }
});

test("forged window messages cannot enable capture or trigger a refresh", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", { captureEnabled: false });

  // Old-format forgeries, with or without a channel field, must be inert.
  harness.dispatchWindowMessage({
    source: "mosa-chatgpt-capture",
    channel: "forged-channel",
    type: "set-capture-enabled",
    payload: { enabled: true },
  });
  harness.dispatchWindowMessage({
    source: "mosa-chatgpt-capture",
    type: "refresh-current-conversation",
    payload: { conversationId: "conversation-test" },
  });
  await harness.harvest();
  assert.equal(generationEvents(harness).length, 0, "a window message must not enable capture");
  assert.deepEqual(harness.requestedUrls.filter((url) => url.includes("/conversations/")), [], "a window message must not trigger a conversation refresh");

  // The same commands through the real port keep working.
  await harness.sendToPageHook({ source: "mosa-chatgpt-capture", type: "set-capture-enabled", payload: { enabled: true } });
  harness.dispatchWindowMessage({
    source: "mosa-chatgpt-capture",
    type: "refresh-current-conversation",
    payload: { conversationId: "conversation-test" },
  });
  await setImmediate();
  assert.deepEqual(harness.requestedUrls.filter((url) => url.includes("/conversations/")), []);
  await harness.refreshCurrentConversation();
  assert.deepEqual(harness.requestedUrls.filter((url) => url.includes("/conversations/")), [
    "https://chatgpt.com/backend-api/conversations/conversation-test",
  ]);
});

test("before confirmation a port request mints a replacement port", () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", { captureEnabled: false, ack: false });
  assert.equal(harness.hookPortOffers.length, 1);

  harness.dispatchWindowMessage({ source: "mosa-chatgpt-capture", type: "hook-port-request" });
  assert.equal(harness.hookPortOffers.length, 2);
  assert.equal(harness.windowMessages[1].event.type, "hook-port");
  assert.notEqual(
    harness.windowMessages[1].transfer?.[0],
    harness.windowMessages[0].transfer?.[0],
    "the replacement must be a fresh port",
  );

  // Non-mosaic markers and other window commands mint nothing.
  harness.dispatchWindowMessage({ source: "other-extension", type: "hook-port-request" });
  harness.dispatchWindowMessage({ source: "mosa-chatgpt-capture", type: "set-capture-enabled", payload: { enabled: true } });
  assert.equal(harness.hookPortOffers.length, 2);
});

test("a port request from another window is ignored even before confirmation", () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", { captureEnabled: false, ack: false });

  harness.dispatchWindowMessage(
    { source: "mosa-chatgpt-capture", type: "hook-port-request" },
    { source: {} },
  );
  assert.equal(harness.hookPortOffers.length, 1);
});

test("after confirmation the page hook ignores further port requests", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", { captureEnabled: false });
  assert.equal(harness.hookPortOffers.length, 1);
  await setImmediate();

  harness.dispatchWindowMessage({ source: "mosa-chatgpt-capture", type: "hook-port-request" });
  await setImmediate();
  assert.equal(harness.hookPortOffers.length, 1, "a confirmed port must never be replaced");

  // The confirmed port keeps carrying commands.
  await harness.sendToPageHook({ source: "mosa-chatgpt-capture", type: "set-capture-enabled", payload: { enabled: true } });
  assert.equal(harness.events.some((event) => event.type === "capture-state" && event.payload?.enabled === true), true);
});

test("provider content scripts only receive the autoCapture setting", () => {
  const handlerStart = backgroundSource.indexOf('if (message.type === "mosa.getSettings")');
  const handlerEnd = backgroundSource.indexOf('if (message.type === "mosa.probeFlowMedia")', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = backgroundSource.slice(handlerStart, handlerEnd);
  // The response for non-extension-page senders must still be a single object
  // literal whose primary field is autoCapture, but it can carry a
  // captureDiagnostics flag gated to chatgpt.com content scripts only.
  assert.match(handler, /extensionPageSender\(sender\)\s*\?\s*settings\s*:\s*\{[\s\S]*?autoCapture: settings\.autoCapture/);
  assert.match(handler, /isChatGptPageSender\(sender\)/);
  // Extract the branch executed for non-extension-page senders. We strip out
  // the chatgpt-only branch so we can assert provider pages never see
  // captureDiagnostics.
  const providerResponse = handler
    .replace(/extensionPageSender\(sender\)\s*\?\s*settings\s*:/, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/captureDiagnostics:\s*isChatGptPageSender\(sender\)\s*\?\s*Boolean\(settings\.captureDiagnostics\)\s*:\s*false,?\s*/, "");
  assert.doesNotMatch(providerResponse, /mosaToken|mosaBaseUrl/, "the provider-page settings response must not expose the Token or base URL");
  assert.doesNotMatch(providerResponse, /captureDiagnostics/, "provider pages must not receive the captureDiagnostics flag");
  // The sender gate itself is unchanged: extension pages and provider pages only.
  assert.match(backgroundSource, /return extensionPageSender\(sender\) \|\| Boolean\(pageSenderContext\(sender\)\);/);
});

test("clears the legacy development Token and verifies the real ingest authorization path", () => {
  assert.match(backgroundSource, /const LEGACY_DEV_TOKEN = "mosa-web-capture-dev"/);
  assert.match(backgroundSource, /const localToken = normalizeStoredToken\(local\.mosaToken\)/);
  assert.match(backgroundSource, /mosaToken: localToken \|\| migratedToken \|\| DEFAULTS\.mosaToken/);
  assert.match(optionsSource, /authorization: `Bearer \$\{token\}`/);
  assert.match(optionsSource, /WEB_CAPTURE_BAD_IMAGE/);
  assert.match(optionsSource, /WEB_CAPTURE_UNAUTHORIZED/);
});

function loadImageLookupKeys() {
  // imageLookupKeys reads the blob: -> file id table through blobAssetIdForUrl,
  // so extract those helpers too and run the existing checks with an empty table.
  const source = ["chatGptImageProxyInfo", "normalizeAssetId", "isTrustedBlobAssetUrl", "normalizeBlobAssetId", "rememberBlobAsset", "blobAssetIdForUrl", "imageLookupKeys"].map((name) => {
    const match = new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(contentSource);
    assert.ok(match, `${name} should be extractable from content.js`);
    return match[0];
  }).join("\n");
  const context = {
    Set,
    Map,
    String,
    URL,
    location: { origin: "https://chatgpt.com", href: "https://chatgpt.com/c/demo" },
    blobAssetIds: new Map(),
    MAX_BLOB_ASSETS: 400,
  };
  vm.runInNewContext(source, context, { filename: "content-lookup.js" });
  return context.imageLookupKeys;
}

test("resolves every URL variant of one ChatGPT file to a shared identity", () => {
  const imageLookupKeys = loadImageLookupKeys();
  const estuary = imageLookupKeys("https://chatgpt.com/backend-api/estuary/content?cid=demo&id=file-abc123def&ts=1&sig=first");
  const estuaryWithoutConversation = imageLookupKeys("https://chatgpt.com/backend-api/estuary/content?id=file-abc123def&ts=2&sig=no-cid");
  const cdn = imageLookupKeys("https://files.oaiusercontent.com/file-abc123def?se=2026-07-26&sig=second");
  const cdnResigned = imageLookupKeys("https://files.oaiusercontent.com/file-abc123def?se=2026-07-27&sig=third");
  const other = imageLookupKeys("https://files.oaiusercontent.com/file-zzz987yyy?se=2026-07-26&sig=fourth");

  assert.ok(estuary.includes("asset:file-abc123def"));
  assert.ok(estuaryWithoutConversation.includes("asset:file-abc123def"), "Estuary asset identity must survive when ChatGPT omits cid");
  assert.ok(cdn.includes("asset:file-abc123def"));
  assert.ok(estuary.some((key) => cdn.includes(key)), "Estuary and CDN links must share an identity");
  assert.deepEqual(cdn, cdnResigned, "a re-signed link is the same image");
  assert.equal(other.some((key) => cdn.includes(key)), false, "different files stay separate");
});

test("archives one row per uploaded reference photo", () => {
  // The same upload surfaces as a composer blob, an Estuary proxy URL and a
  // signed CDN link. Keying on the raw src archived it once per variant.
  assert.match(contentSource, /const savedIdentityKeys = new Set\(\)/);
  assert.match(contentSource, /function isSavedCandidate\(candidate\)/);
  assert.match(contentSource, /function rememberSavedCandidate\(candidate, generationStatus = "unknown"\)/);
  assert.match(contentSource, /if \(isSavedCandidate\(candidate\)\) return false;/);
  assert.doesNotMatch(contentSource, /if \(savedKeys\.has\(key\)\) return false;/);

  // A composer attachment is re-rendered inside the sent message at a capped
  // size, so capturing both produced two differently sized assets.
  assert.match(contentSource, /function isComposerNode\(node\)/);
  assert.match(contentSource, /if \(!manual && isComposerNode\(img\)\) return false;/);
  assert.match(contentSource, /if \(manual\) \{[\s\S]*document\.querySelectorAll\("div, section, main, figure"\)/);

  // The Estuary proxy and the signed CDN link carry the same file id. Without
  // it they read as two images, and their bytes differ (canvas re-encode vs
  // served file), so the server content-hash dedupe cannot merge them either.
  assert.match(contentSource, /if \(fileId\) keys\.push\(`asset:\$\{fileId\}`\);/);

  // Preserve the provider-served original whenever available. The server's
  // pixel hash keeps an older canvas-encoded copy from becoming a second asset.
  const bytesFn = /async function bytesFromUrlOrImg\(candidate\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  assert.ok(bytesFn, "bytesFromUrlOrImg should exist");
  assert.ok(bytesFn.indexOf("originalBytesFromUrl(") < bytesFn.indexOf("canvasBytesFromImage(candidate.el)"));

  assert.match(contentSource, /isReference: isReferenceCandidate\(candidate\)/);
  assert.match(backgroundSource, /is_reference: Boolean\(payload\.isReference\)/);
  assert.match(contentSource, /function hasObservedGenerationEvidence\(candidate\)/);
  assert.match(contentSource, /function findGenerationEvidenceForCandidate\(candidate\)/);
  assert.match(contentSource, /const evidence = findGenerationEvidenceForCandidate\(candidate\);/);
  assert.match(contentSource, /if \(!evidence && isRecoverableGenerationCandidate\(candidate\)\) scheduleGenerationEvidenceRecovery\(candidate\);/);
  assert.match(contentSource, /function enqueueDomFallback\(candidate\)/);
  assert.match(contentSource, /reason: "dom-fallback"/);
  assert.match(contentSource, /const provenGeneration = !manual && !reference/);
  assert.match(contentSource, /const minEdge = reference \? 32 : manual \? 360 : provenGeneration \? 256 : MIN_EDGE/);
  assert.match(contentSource, /if \(!reference && byteLength > 0 && byteLength < MIN_BYTES\) return false/);
  assert.match(contentSource, /const needsReferenceRepair = stagedReferences > 0[\s\S]*isSavedCandidate\(candidate\)/);
  assert.match(contentSource, /force: needsReferenceRepair/);
  assert.match(contentSource, /rememberSet\(referenceSyncKeys, syncKey\)/);
  // A previously-seen reference still has to reach the server for each new
  // generation context. The server deduplicates the blob and appends usage.
  const stageReferences = /async function stageGenerationReferences\(candidate\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  assert.ok(stageReferences, "stageGenerationReferences should exist");
  assert.doesNotMatch(stageReferences, /isSavedCandidate\(reference\)/);
  assert.match(stageReferences, /reason: "auto-reference"/);
  // An optional reference failure must never surface as a user-facing error.
  assert.match(contentSource, /const optionalReferenceFailure = reason === "auto-reference"/);
  assert.match(hookSource, /isGeneration: extra\.isGeneration === true/);
  assert.match(hookSource, /if \(url && payload\.isGeneration\) post\("auto-image", payload\)/);
});

test("automatic capture does not starve new images behind already-saved DOM candidates", () => {
  const scanStart = contentSource.indexOf("const candidates = collectDomCandidates();");
  const scanEnd = contentSource.indexOf("}, force ? 120 : 600);", scanStart);
  const scan = contentSource.slice(scanStart, scanEnd);
  assert.ok(scanStart >= 0 && scanEnd > scanStart, "scan block should be extractable");
  assert.match(scan, /const eligible = candidates\.filter\(\(candidate\) => \{/);
  assert.match(scan, /if \(!canAttempt\(candidate\)\) return false;/);
  assert.match(scan, /if \(hasObservedGenerationEvidence\(candidate\)\) return true;/);
  assert.match(scan, /if \(isRecoverableGenerationCandidate\(candidate\)\) scheduleGenerationEvidenceRecovery\(candidate\);/);
  assert.match(scan, /\}\)\.slice\(0, 6\);/);
  assert.doesNotMatch(scan, /for \(const candidate of candidates\.slice\(0, 6\)\)/);
});

test("ChatGPT DOM fallback recognizes generated-image turn structure without legacy role nesting", () => {
  assert.match(contentSource, /const CHATGPT_TURN_SELECTOR = '\[data-testid\^="conversation-turn-"\]'/);
  assert.match(contentSource, /function hasGeneratedImageDomMarker\(image\)/);
  assert.match(contentSource, /generated image\|image generated/);
  assert.match(contentSource, /const explicitGeneratedImage = hasGeneratedImageDomMarker\(image\)/);
  assert.match(contentSource, /if \(!roleScope && !turnOwnsAssistantContent && !explicitGeneratedImage\) return false;/);
  assert.match(contentSource, /if \(explicitGeneratedImage\) return true;/);
  assert.match(contentSource, /attributeFilter: \["src", "srcset", "alt", "aria-label"\]/);
});

test("ChatGPT generation evidence recovery spans slow multi-image renders", () => {
  assert.match(contentSource, /const GENERATION_EVIDENCE_RECOVERY_DELAYS = \[2_800, 7_200, 15_000\]/);
  assert.match(contentSource, /GENERATION_EVIDENCE_RECOVERY_DELAYS\.map\(\(delay, index\) => setTimeout/);
  assert.match(contentSource, /index !== GENERATION_EVIDENCE_RECOVERY_DELAYS\.length - 1/);
  assert.match(contentSource, /enqueueDomFallback\(candidate\);/);
});

test("temporary small ChatGPT generation candidates remain retryable", () => {
  const ingestStart = contentSource.indexOf("async function ingestCandidate(candidate");
  const enqueueStart = contentSource.indexOf("function enqueueAuto(candidate", ingestStart);
  const ingest = contentSource.slice(ingestStart, enqueueStart);
  assert.ok(ingestStart >= 0 && enqueueStart > ingestStart);
  assert.match(ingest, /hasObservedGenerationEvidence\(candidate\) \|\| isRecoverableGenerationCandidate\(candidate\)/);
  assert.match(ingest, /failedAt\.set\(key, Date\.now\(\)\)/);
});

test("promptless generation events can archive before the DOM finishes rendering", () => {
  const autoImageStart = contentSource.indexOf('if (data.type === "auto-image"');
  const domImageStart = contentSource.indexOf('if (data.type === "dom-image"', autoImageStart);
  const block = contentSource.slice(autoImageStart, domImageStart);
  assert.ok(autoImageStart >= 0 && domImageStart > autoImageStart);
  assert.match(block, /if \(meta\.isGeneration !== true\) return;/);
  assert.match(block, /enqueueAuto\(\{/);
  assert.doesNotMatch(block, /\["generation-tool-prompt", "visible-caption"\]\.includes\(meta\.promptStatus\)/);
  assert.match(contentSource, /const failedNetworkIdentityKeys = new Set\(\)/);
  assert.match(contentSource, /candidateLookupKeys\(candidate\)\.some\(\(identity\) => failedNetworkIdentityKeys\.has\(identity\)\)/);
});

test("splits sibling generations without tool call ids into per-asset reference scopes", async () => {
  // Two generated assets flattened into one tool message, without per-call
  // ids: they are still distinct generations, so references of one must not
  // attach to the sibling output through a shared message-scoped context.
  const harness = createHookHarness({
    conversation_id: "conversation-multi-asset",
    mapping: {
      generated: {
        message: {
          id: "message-multi-asset",
          author: { role: "tool", name: "image_gen" },
          content: { parts: [
            { asset_pointer: "sediment://file-one" },
            { asset_pointer: "sediment://file-two" },
          ] },
        },
      },
    },
  });

  await harness.harvest();

  const generations = harness.events.filter((event) => event.type === "generation-meta" && event.payload?.isGeneration);
  assert.equal(generations.length, 2);
  assert.deepEqual(
    generations.map((event) => event.payload.generationContextId).sort(),
    [
      "chatgpt:conversation-multi-asset:asset:file-one",
      "chatgpt:conversation-multi-asset:asset:file-two",
    ],
  );
  assert.deepEqual(
    manifest.content_scripts.find((entry) => entry.js?.includes("provider-sites.js"))?.js,
    ["provider-policy.js", "provider-sites.js"],
  );
});

test("provider policy classifies only supported top-level product URLs", () => {
  const sandbox = { URL };
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  const policy = sandbox.MosaProviderPolicy;
  assert.equal(policy.providerForPageUrl("https://chatgpt.com/c/abc"), "chatgpt");
  assert.equal(policy.providerForPageUrl("https://gemini.google.com/app/abc"), "gemini");
  assert.equal(policy.providerForPageUrl("https://aistudio.google.com/generate-video"), "google-ai-studio");
  assert.equal(policy.providerForPageUrl("https://labs.google/fx/en/tools/flow/project/abc"), "flow");
  assert.equal(policy.providerForPageUrl("https://flow.google.com/project/abc"), "flow");
  assert.equal(policy.providerForPageUrl("https://labs.google/search"), "");
  assert.equal(policy.isFlowMediaRedirectUrl("https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=abc"), true);
  assert.equal(policy.isFlowMediaRedirectUrl("https://flow.google.com/api/trpc/media.getMediaUrlRedirect?name=abc"), true);
  assert.equal(policy.isFlowMediaRedirectUrl("https://flow.google.com/fx/api/trpc/media.getMediaUrlRedirect?name=abc"), true);
  assert.equal(policy.isFlowMediaRedirectUrl("https://flow.google.com/api/trpc/media.getMediaUrlRedirect"), false);
  assert.equal(policy.isFlowMediaRedirectUrl("https://evil.example/api/trpc/media.getMediaUrlRedirect?name=abc"), false);
  assert.equal(policy.isFlowMediaRedirectUrl("https://flow.google.com/api/trpc/media.getSomethingElse?name=abc"), false);
  assert.equal(policy.providerForPageUrl("http://gemini.google.com/app/abc"), "");
  assert.equal(policy.providerForPageUrl("https://evil.example/?next=https://gemini.google.com"), "");
  assert.equal(policy.supportsVideo("flow"), true);
  assert.equal(policy.supportsVideo("google-ai-studio"), true);
  assert.equal(policy.supportsVideo("gemini"), false);
});

test("url and asset events of one generation share a single reference scope", async () => {
  const proxyUrl = "https://chatgpt.com/backend-api/estuary/content?cid=conversation-test&id=file-bangkok&sig=signed-value";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      bangkok: {
        message: {
          id: "message-bangkok",
          content: { parts: [{ asset_pointer: "file-service://file-bangkok", image_url: proxyUrl }] },
          metadata: { dalle: { revised_prompt: "A detailed travel poster for Bangkok with saffron temples, red typography, and an editorial print layout." } },
        },
      },
    },
  });

  await harness.harvest();

  const contexts = new Set(harness.events
    .filter((event) => (
      event.type === "generation-meta"
      && event.payload?.imageKey === "estuary:conversation-test:file-bangkok"
    ))
    .map((event) => event.payload.generationContextId));
  assert.equal(contexts.size, 1, `URL and asset events must carry one scope, got: ${[...contexts].join(", ")}`);
  assert.ok([...contexts][0], "the shared scope must be non-empty");
});

test("the XHR interceptor skips binary image responses like the fetch interceptor", () => {
  assert.ok(hookSource.includes('this.getResponseHeader?.("content-type")'));
  assert.ok(hookSource.includes('const responseType = String(this.responseType || "").toLowerCase();'));
  assert.ok(hookSource.includes('responseType === "json" && this.response'));
  // harvest() is now wrapped in a try-block that also records an HTTP
  // diagnostic frame before the harvest call. Either literal is acceptable
  // as long as the harvest call is still reached when text is non-empty.
  assert.ok(
    hookSource.includes('if (text) harvest(text, "xhr");')
      || /if \(text\)\s*\{[\s\S]*harvest\(text,\s*"xhr"\)/.test(hookSource),
    "XHR interceptor must still call harvest(text, 'xhr') on non-empty text"
  );
});

test("does not flatten multiple image tool calls into one prompt binding", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-multi-call",
    mapping: {
      generated: {
        message: {
          id: "message-multi-call",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            calls: [
              { tool_call_id: "call-a", prompt: "first detailed cinematic image prompt", asset_pointer: "sediment://file-a" },
              { tool_call_id: "call-b", prompt: "second detailed editorial image prompt", asset_pointer: "sediment://file-b" },
            ],
          },
          content: { parts: [] },
        },
      },
    },
  });

  await harness.harvest();
  const generations = harness.events.filter((event) => event.type === "generation-meta" && event.payload?.isGeneration);
  assert.equal(generations.length, 2);
  assert.deepEqual(generations.map((event) => event.payload.prompt), [
    "first detailed cinematic image prompt",
    "second detailed editorial image prompt",
  ]);
  assert.deepEqual(generations.map((event) => event.payload.promptStatus), ["generation-tool-prompt", "generation-tool-prompt"]);
  assert.deepEqual(generations.map((event) => event.payload.providerToolCallId), ["call-a", "call-b"]);
});

test("one image tool call keeps per-output prompts on their own sibling images", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-one-call-many-outputs",
    mapping: {
      generated: {
        message: {
          id: "message-one-call-many-outputs",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            call: {
              tool_call_id: "call-shared",
              outputs: [
                { revised_prompt: "red editorial poster for output A", asset_pointer: "sediment://file-output-a" },
                { revised_prompt: "blue cinematic poster for output B", asset_pointer: "sediment://file-output-b" },
              ],
            },
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-one-call-many-outputs");

  await harness.harvest();
  const outputs = harness.events.filter((event) => event.type === "generation-meta" && event.payload?.assetId?.startsWith("file-output-"));
  assert.equal(outputs.length, 2);
  const byAsset = new Map(outputs.map((event) => [event.payload.assetId, event.payload]));
  assert.equal(byAsset.get("file-output-a")?.prompt, "red editorial poster for output A");
  assert.equal(byAsset.get("file-output-a")?.promptScope, "output");
  assert.equal(byAsset.get("file-output-b")?.prompt, "blue cinematic poster for output B");
  assert.equal(byAsset.get("file-output-b")?.promptScope, "output");
});

test("a promptless sibling output is still emitted when another image call succeeds with a prompt", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-partial-multi",
    mapping: {
      generated: {
        message: {
          id: "message-partial-multi",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            calls: [
              { tool_call_id: "call-a", prompt: "complete prompt for output A", asset_pointer: "sediment://file-a-complete" },
              { tool_call_id: "call-b", asset_pointer: "sediment://file-b-promptless", status: "failed" },
            ],
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-partial-multi");

  await harness.harvest();
  const outputs = harness.events.filter((event) => event.type === "generation-meta" && event.payload?.assetId);
  const byAsset = new Map(outputs.map((event) => [event.payload.assetId, event.payload]));
  assert.equal(byAsset.get("file-a-complete")?.prompt, "complete prompt for output A");
  assert.equal(byAsset.get("file-b-promptless")?.prompt, "");
  assert.equal(byAsset.get("file-b-promptless")?.promptStatus, "not-available");
  assert.equal(byAsset.get("file-b-promptless")?.generationStatus, "failed");
  assert.equal(byAsset.get("file-b-promptless")?.isGeneration, true);
});

test("output-specific failure status is not overwritten by an attempt-level completed state", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-mixed-status",
    mapping: {
      generated: {
        message: {
          id: "message-mixed-status",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            call: {
              tool_call_id: "call-mixed-status",
              status: "completed",
              outputs: [
                { asset_pointer: "sediment://file-status-ok", status: "completed" },
                { asset_pointer: "sediment://file-status-failed", status: "failed" },
              ],
            },
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-mixed-status");

  await harness.harvest();
  const outputs = harness.events.filter((event) => event.type === "generation-meta" && event.payload?.assetId?.startsWith("file-status-"));
  const byAsset = new Map(outputs.map((event) => [event.payload.assetId, event.payload]));
  assert.equal(byAsset.get("file-status-ok")?.generationStatus, "completed");
  assert.equal(byAsset.get("file-status-failed")?.generationStatus, "failed");
});

test("generation error prose beside a surviving image is status evidence, never a prompt", async () => {
  const errorText = "Generation failed while creating the cinematic poster because the image service timed out; a partial result may still be visible.";
  const harness = createHookHarness({
    conversation_id: "conversation-error-image",
    mapping: {
      generated: {
        message: {
          id: "message-error-image",
          author: { role: "tool", name: "image_gen" },
          metadata: { call: { tool_call_id: "call-error-image", asset_pointer: "sediment://file-error-image" } },
          content: { parts: [errorText] },
        },
      },
    },
  }, "conversation-error-image");

  await harness.harvest();
  const output = harness.events.find((event) => event.type === "generation-meta" && event.payload?.assetId === "file-error-image")?.payload;
  assert.ok(output);
  assert.equal(output.prompt, "");
  assert.equal(output.promptStatus, "not-available");
  assert.equal(output.generationStatus, "failed");
});

test("failed attempt prompt does not leak into a later successful retry in the same tool call", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-retry-boundary",
    mapping: {
      generated: {
        message: {
          id: "message-retry-boundary",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            call: {
              tool_call_id: "call-retry",
              attempts: [
                {
                  generation_call_id: "gen-failed",
                  status: "failed",
                  revised_prompt: "prompt belonging only to the failed attempt",
                },
                {
                  generation_call_id: "gen-success",
                  status: "completed",
                  asset_pointer: "sediment://file-retry-success",
                },
              ],
            },
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-retry-boundary");

  await harness.harvest();
  const success = harness.events.find((event) => event.type === "generation-meta" && event.payload?.assetId === "file-retry-success")?.payload;
  assert.ok(success);
  assert.equal(success.providerGenerationCallId, "gen-success");
  assert.equal(success.generationStatus, "completed");
  assert.equal(success.prompt, "");
  const failed = harness.events.find((event) => event.type === "generation-meta" && event.payload?.providerGenerationCallId === "gen-failed")?.payload;
  assert.equal(failed?.prompt, "prompt belonging only to the failed attempt");
  assert.equal(failed?.generationStatus, "failed");
});

test("one collage asset with several panel prompts stays prompt-ambiguous instead of choosing a panel", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-collage",
    mapping: {
      generated: {
        message: {
          id: "message-collage",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            call: {
              tool_call_id: "call-collage",
              panels: [
                { revised_prompt: "panel one revised prompt: a red product poster with dramatic light" },
                { generation_prompt: "panel two generation prompt: a blue product poster with soft light" },
              ],
              result: { asset_pointer: "sediment://file-collage" },
            },
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-collage");

  await harness.harvest();
  const collage = harness.events.find((event) => event.type === "generation-meta" && event.payload?.assetId === "file-collage")?.payload;
  assert.ok(collage);
  assert.equal(collage.prompt, "");
  assert.equal(collage.promptStatus, "not-available");
});

test("one shared attempt prompt can legitimately bind to every output in that call", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-shared-prompt",
    mapping: {
      generated: {
        message: {
          id: "message-shared-prompt",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            call: {
              tool_call_id: "call-shared-prompt",
              revised_prompt: "one shared prompt for a coordinated three-image campaign",
              outputs: [
                { asset_pointer: "sediment://file-shared-a" },
                { asset_pointer: "sediment://file-shared-b" },
                { asset_pointer: "sediment://file-shared-c" },
              ],
            },
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-shared-prompt");

  await harness.harvest();
  const outputs = harness.events.filter((event) => event.type === "generation-meta" && event.payload?.assetId?.startsWith("file-shared-"));
  assert.equal(outputs.length, 3);
  assert.ok(outputs.every((event) => event.payload.prompt === "one shared prompt for a coordinated three-image campaign"));
  assert.ok(outputs.every((event) => event.payload.promptScope === "attempt"));
});

test("binds prompt and asset when one image call splits them across nested request/result objects", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-split-call",
    mapping: {
      generated: {
        message: {
          id: "message-split-call",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            calls: [{
              tool_call_id: "call-split",
              request: { revisedPrompt: "A precise split-call prompt for a red architectural poster" },
              result: { assetPointer: "sediment://file-split-call" },
            }],
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-split-call");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-split-call");
  assert.equal(generation?.payload.prompt, "A precise split-call prompt for a red architectural poster");
  assert.equal(generation?.payload.providerToolCallId, "call-split");
  assert.equal(generation?.payload.promptSource, "revised_prompt");
});

test("uses only a same-message Model caption when conversation metadata is cached", () => {
  assert.equal(manifest.version, "0.15.32");
  assert.match(contentSource, /function messageScopeForCandidate\(candidate\)/);
  assert.match(contentSource, /function domCaptionForCandidate\(candidate\)/);
  assert.match(contentSource, /model caption\\s\*:\\s\*\(\.\+\)\$/i);
  assert.match(contentSource, /via: "dom-message-caption"/);
});

function currentChatGptConversation(prompt = "", role = "tool") {
  return {
    conversation_id: "conversation-test",
    messages: [{
      id: "output-message",
      author: { role, name: "opaque_namespace.opaque_tool" },
      status: "finished_successfully",
      metadata: { image_gen_title: "Generated image" },
      content: { content_type: "multimodal_text", parts: [{
        content_type: "image_asset_pointer",
        asset_pointer: "sediment://file-current-output",
        metadata: { dalle: { gen_id: "generation-output", prompt } },
      }] },
    }],
  };
}

test("reads the plural conversation response and recognizes an opaque image tool", async () => {
  const prompt = "Create a red poster with metallic typography and soft lighting.";
  const harness = createHookHarness(currentChatGptConversation(prompt));
  await harness.harvest(undefined, "https://chatgpt.com/backend-api/conversations/conversation-test?limit=20");
  const output = generationEvents(harness).find((event) => event.payload.assetId === "file-current-output")?.payload;
  assert.ok(output);
  assert.equal(output.prompt, prompt);
  assert.equal(output.promptStatus, "generation-tool-prompt");
  assert.equal(output.messageId, "output-message");
  assert.equal(output.providerGenerationCallId, "generation-output");
  assert.equal(output.isGeneration, true);
});

test("harvests generation metadata from the bare ChatGPT conversation stream endpoint", async () => {
  const prompt = "Create a cobalt poster with chrome lettering and hard rim lighting.";
  const harness = createHookHarness(currentChatGptConversation(prompt));
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/conversation");
  const output = generationEvents(harness).find((event) => event.payload.assetId === "file-current-output")?.payload;
  assert.ok(output, "the live conversation stream must be harvested before metadata disappears from later conversation reads");
  assert.equal(output.prompt, prompt);
  assert.equal(output.promptStatus, "generation-tool-prompt");
  assert.equal(output.messageId, "output-message");
  assert.equal(output.providerGenerationCallId, "generation-output");
  assert.equal(output.isGeneration, true);
});

test("reads a generation prompt encoded inside tool arguments JSON", async () => {
  const prompt = "Create a black editorial poster with silver type and a hard spotlight.";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    message: {
      id: "message-json-args",
      author: { role: "tool", name: "opaque_tool" },
      metadata: { image_gen_title: "Generated image" },
      content: {
        parts: [{
          content_type: "image_asset_pointer",
          asset_pointer: "sediment://file-json-args",
        }],
      },
      tool_call_id: "tool-json-args",
      arguments: JSON.stringify({ revised_prompt: prompt }),
    },
  });
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/conversation");
  const output = generationEvents(harness).find((event) => event.payload.assetId === "file-json-args")?.payload;
  assert.ok(output);
  assert.equal(output.prompt, prompt);
  assert.equal(output.promptStatus, "generation-tool-prompt");
  assert.equal(output.isGeneration, true);
});

test("recognizes image_gen_title plus image asset pointer without a legacy tool name", async () => {
  const prompt = "Create a minimal green poster with embossed sans serif typography and studio light.";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    message: {
      id: "message-title-marker",
      author: { role: "assistant", name: "opaque_tool" },
      metadata: { image_gen_title: "Generated image", revised_prompt: prompt },
      content: { parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file-title-marker" }] },
    },
  });
  await harness.harvest();
  const output = generationEvents(harness).find((event) => event.payload.assetId === "file-title-marker")?.payload;
  assert.ok(output);
  assert.equal(output.prompt, prompt);
  assert.equal(output.isGeneration, true);
});

test("capture diagnostics never include the prompt text", async () => {
  const secretPrompt = "SECRET_DIAGNOSTIC_PROMPT_SHOULD_NOT_LEAK";
  const harness = createHookHarness(currentChatGptConversation(secretPrompt));
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/conversation");
  const diagnostics = harness.events.filter((event) => event.type === "capture-debug");
  assert.ok(diagnostics.length > 0);
  assert.equal(JSON.stringify(diagnostics).includes(secretPrompt), false);
});

test("keeps a Skill's instructions in the same turn out of the image prompt", async () => {
  // Real 2026-09 shape: a Skill resource is read in the same turn, the image
  // tool is called with prompt: null, and the image message has no caption.
  const turn = { turn_exchange_id: "turn-skill", working_turn_id: "working-skill" };
  const skillText = "# Poster skill\nBefore calling the image tool, choose the style, composition, lighting, palette, and layout. "
    + "Keep the typography bold, the background clean, and the scene cinematic. ".repeat(12);
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    messages: [
      {
        id: "skill-resource",
        author: { role: "tool", name: "api_tool.read_resource" },
        content: { content_type: "text", parts: [skillText] },
        metadata: { ...turn, skill_name: "poster-skill" },
      },
      {
        id: "image-call",
        author: { role: "assistant" },
        recipient: "t2uay3k.sj1i4kz",
        channel: "commentary",
        content: {
          content_type: "code",
          text: JSON.stringify({ size: "1024x1536", n: 1, referenced_image_ids: [], prompt: null }),
        },
        metadata: { ...turn },
      },
      {
        id: "image-output",
        author: { role: "tool", name: "t2uay3k.sj1i4kz" },
        content: {
          content_type: "multimodal_text",
          parts: [{
            content_type: "image_asset_pointer",
            asset_pointer: "sediment://file-skill-output",
            metadata: { dalle: { gen_id: "generation-skill-output", prompt: "" } },
          }],
        },
        metadata: { ...turn, parent_id: "image-call", image_gen_title: "Generated image" },
      },
    ],
  });

  await harness.harvest(undefined, "https://chatgpt.com/backend-api/conversations/conversation-test");

  assert.equal(generationEvents(harness).some((event) => event.payload.prompt === skillText.trim()), false);
  const registry = createGenerationRegistryHarness();
  for (const event of harness.events.filter((item) => item.type === "generation-meta")) registry.remember(event.payload);
  const resolved = registry.resolvedForImage("", { assetId: "file-skill-output" });
  assert.ok(resolved, "the generated image must still be archived");
  assert.equal(resolved.isGeneration, true);
  assert.equal(resolved.prompt, "");
});

test("binds the live image tool caption to the displayed image message", async () => {
  // Real 2026-09 stream: the displayed "final" tool message holds only the
  // image; a live-only "commentary" copy of the same generation carries the
  // Model caption; then a tool status text follows. Only the caption counts.
  const caption = "Model caption: A clean, flat, cute vector cartoon illustration on a pale cream background: a single gray tabby cat centered in the frame, soft lighting, simple layered shapes.";
  const statusText = "Generated images from the last `image_gen.text2im` call were saved at:\n- /mnt/data/generated/a_clean_flat_vector_illustration_style_scene_1.png (wxh = 1254 x 1254)\n\nYou can visually inspect the generated image directly in the tool result above.";
  const turn = { turn_exchange_id: "turn-live", working_turn_id: "working-live" };
  const imagePart = {
    content_type: "image_asset_pointer",
    asset_pointer: "sediment://file-live-cat",
    width: 1254,
    height: 1254,
    metadata: {
      dalle: { gen_id: "generation-live-cat", prompt: "", serialization_title: "DALL-E generation metadata" },
      generation: { gen_id: "generation-live-cat", gen_size: "smimage", serialization_title: "Image Generation metadata" },
    },
  };
  const update = (message) => JSON.stringify({
    type: "conversation-update",
    payload: { conversation_id: "conversation-test", update_type: "add-messages", update_content: { messages: [message] } },
  });
  const toolMessage = (id, channel, parts) => ({
    id,
    author: { role: "tool", name: "t2uay3k.sj1i4kz", metadata: {} },
    recipient: "all",
    channel,
    content: { content_type: "multimodal_text", parts },
    status: "finished_successfully",
    metadata: { ...turn, image_gen_title: "灰色虎斑猫插画" },
  });
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });

  await harness.socketFrame(update(toolMessage("displayed-output", "final", [imagePart])));
  await harness.socketFrame(update(toolMessage("live-caption-copy", "commentary", [imagePart, caption])));
  await harness.socketFrame(update({
    ...toolMessage("tool-status", "commentary", [statusText]),
    content: { content_type: "text", parts: [statusText] },
  }));
  await harness.socketFrame(update(toolMessage("displayed-output", "final", [imagePart])));

  const metas = harness.events.filter((event) => event.type === "generation-meta").map((event) => event.payload);
  assert.equal(metas.some((meta) => meta.prompt === statusText), false);
  const captionEvent = metas.find((meta) => meta.prompt === caption);
  assert.ok(captionEvent);
  assert.equal(captionEvent.promptStatus, "visible-caption");
  assert.equal(captionEvent.promptScope, "output");
  assert.equal(captionEvent.assetId, "file-live-cat");

  const registry = createGenerationRegistryHarness();
  for (const meta of metas) registry.remember(meta);
  for (const resolved of [
    registry.resolvedForMessage("conversation-test", "displayed-output"),
    registry.resolvedForImage("", { assetId: "file-live-cat" }),
  ]) {
    assert.ok(resolved);
    assert.equal(resolved.prompt, caption);
    assert.equal(resolved.promptStatus, "visible-caption");
    assert.equal(resolved.isGeneration, true);
  }
});

function liveImageTurnFrames({ turn = "turn-request", calls = [], outputs = [] } = {}) {
  const update = (message) => JSON.stringify({
    type: "conversation-update",
    payload: { conversation_id: "conversation-test", update_type: "add-messages", update_content: { messages: [message] } },
  });
  const callFrames = calls.map(({ id, prompt, recipient = "t2uay3k.sj1i4kz" }) => update({
    id,
    author: { role: "assistant", name: null, metadata: {} },
    recipient,
    channel: "commentary",
    content: {
      content_type: "code",
      language: "json",
      text: JSON.stringify({ prompt, reference_image_paths: [], aspect_ratio: "1:1", transparent_background: false }),
    },
    status: "finished_successfully",
    metadata: { turn_exchange_id: turn },
  }));
  const outputFrames = outputs.map(({ id, channel = "final", assetId, genId, parentId = "", caption = "" }) => update({
    id,
    author: { role: "tool", name: "t2uay3k.sj1i4kz", metadata: {} },
    recipient: "all",
    channel,
    content: {
      content_type: "multimodal_text",
      parts: [{
        content_type: "image_asset_pointer",
        asset_pointer: `sediment://${assetId}`,
        metadata: { dalle: { gen_id: genId, prompt: "" }, generation: { gen_id: genId } },
      }, ...(caption ? [caption] : [])],
    },
    status: "finished_successfully",
    metadata: { turn_exchange_id: turn, parent_id: parentId, image_gen_title: "Generated image" },
  }));
  return { callFrames, outputFrames };
}

test("keeps the live image tool request Prompt beside the caption", async () => {
  const requestPrompt = "Create a new image in the same visual style as Image A. Generate a simple flat illustration of a gray tabby cat.";
  const caption = "Model caption: A clean, flat, cute vector cartoon illustration on a pale cream background: a single gray tabby cat, soft lighting.";
  const { callFrames, outputFrames } = liveImageTurnFrames({
    calls: [{ id: "call-cat", prompt: requestPrompt }],
    outputs: [
      { id: "displayed-cat", assetId: "file-request-cat", genId: "generation-request-cat", parentId: "user-message" },
      { id: "caption-cat", channel: "commentary", assetId: "file-request-cat", genId: "generation-request-cat", parentId: "call-cat", caption },
    ],
  });
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  for (const frame of [...callFrames, ...outputFrames]) await harness.socketFrame(frame);

  const metas = harness.events.filter((event) => event.type === "generation-meta").map((event) => event.payload);
  const outputs = metas.filter((meta) => meta.assetId === "file-request-cat");
  assert.equal(outputs.length, 2);
  assert.ok(outputs.every((meta) => meta.generationRequestPrompt === requestPrompt));
  assert.equal(metas.some((meta) => meta.prompt === requestPrompt), false, "the request Prompt never becomes the caption Prompt");

  const registry = createGenerationRegistryHarness();
  for (const meta of metas) registry.remember(meta);
  const resolved = registry.resolvedForMessage("conversation-test", "displayed-cat");
  assert.equal(resolved.prompt, caption);
  assert.equal(resolved.generationRequestPrompt, requestPrompt);
  assert.match(backgroundSource, /generation_request_prompt: payload\.generationRequestPrompt/);
  assert.match(contentSource, /generationRequestPrompt: resolved\.generationRequestPrompt/);
});

test("binds request Prompts in a multi-call turn only by parent_id", async () => {
  const { callFrames, outputFrames } = liveImageTurnFrames({
    calls: [
      { id: "call-red", prompt: "Draw a red paper lantern on a dark background with warm light." },
      { id: "call-blue", prompt: "Draw a blue paper lantern on a dark background with cool light." },
    ],
    outputs: [
      { id: "unlinked-red", assetId: "file-red", genId: "generation-red", parentId: "user-message" },
      { id: "linked-blue", channel: "commentary", assetId: "file-blue", genId: "generation-blue", parentId: "call-blue" },
    ],
  });
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  for (const frame of [...callFrames, ...outputFrames]) await harness.socketFrame(frame);

  const byAsset = new Map(harness.events
    .filter((event) => event.type === "generation-meta" && event.payload?.assetId)
    .map((event) => [event.payload.assetId, event.payload.generationRequestPrompt]));
  assert.equal(byAsset.get("file-red"), "", "two calls in one turn are ambiguous without parent_id");
  assert.equal(byAsset.get("file-blue"), "Draw a blue paper lantern on a dark background with cool light.");
});

test("does not borrow a request Prompt from a call to another tool", async () => {
  const { callFrames, outputFrames } = liveImageTurnFrames({
    calls: [{ id: "call-video", prompt: "A slow pan across a rainy neon street.", recipient: "video_gen.create" }],
    outputs: [{ id: "image-out", assetId: "file-other-tool", genId: "generation-other-tool", parentId: "call-video" }],
  });
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  for (const frame of [...callFrames, ...outputFrames]) await harness.socketFrame(frame);

  const output = harness.events.find((event) => event.type === "generation-meta" && event.payload?.assetId === "file-other-tool");
  assert.ok(output);
  assert.equal(output.payload.generationRequestPrompt, "");
});

// ---- Async ghostrider turns: the caption lives on hidden tool messages ----
//
// In an async image turn the visible message shows the images with blank
// dalle.prompt while a hidden gpt-5-4 submessage carries each image together
// with its "Model caption:". The caption must reach the displayed image by
// its own asset_pointer file id (or gen_id), in either arrival order, and the
// blank prompt of the visible message must never erase it.

const ASYNC_CAPTION_A = "Model caption: A flat vector turnaround sheet of a round mascot, three evenly spaced views, thick outlines, plain white background, children's book style.";
const ASYNC_CAPTION_B = "Model caption: A flat vector sticker sheet of a round mascot waving, bold outlines, pastel palette, plain background.";
const ASYNC_REQUEST_PROMPT_A = "Create a clean character turnaround sheet for a small round mascot: three views, flat vector, white background.";
const ASYNC_REQUEST_PROMPT_B = "Create a clean sticker sheet for a small round mascot waving: flat vector, pastel palette, bold outlines.";

function asyncTurnUpdate(message) {
  return JSON.stringify({
    type: "conversation-update",
    payload: { conversation_id: "conversation-test", update_type: "add-messages", update_content: { messages: [message] } },
  });
}

function asyncImagePart(fileId, genId) {
  return {
    content_type: "image_asset_pointer",
    asset_pointer: `sediment://${fileId}`,
    mime_type: "image/png",
    size_bytes: 1280833,
    width: 1448,
    height: 1086,
    metadata: {
      dalle: { gen_id: genId, prompt: "", serialization_title: "DALL-E generation metadata" },
      generation: { gen_id: genId, serialization_title: "Image Generation metadata" },
    },
  };
}

function asyncHiddenCall() {
  return asyncTurnUpdate({
    id: "msg-async-call",
    author: { role: "assistant", name: null, metadata: {} },
    recipient: "t2uay3k.sj1i4kz",
    content: {
      content_type: "code",
      language: "json",
      response_format_name: "t2uay3k.sj1i4kz",
      text: JSON.stringify({ batch_requests: [
        { prompt: ASYNC_REQUEST_PROMPT_A, aspect_ratio: "4:3", referenced_image_ids: [], transparent_background: false },
        { prompt: ASYNC_REQUEST_PROMPT_B, aspect_ratio: "4:3", referenced_image_ids: [], transparent_background: false },
      ] }),
    },
    status: "finished_successfully",
    metadata: { is_visually_hidden_from_conversation: true, message_type: "next", model_slug: "gpt-5-4-thinking", turn_exchange_id: "turn-async" },
  });
}

function asyncHiddenReturn({ id, fileId, genId, caption, parentId }) {
  return asyncTurnUpdate({
    id,
    author: { role: "tool", name: "t2uay3k.sj1i4kz", metadata: {} },
    recipient: "all",
    content: { content_type: "multimodal_text", parts: [asyncImagePart(fileId, genId), caption] },
    status: "finished_successfully",
    metadata: {
      is_visually_hidden_from_conversation: true,
      image_gen_title: "Generated image",
      message_type: "next",
      model_slug: "gpt-5-4-thinking",
      parent_id: parentId,
      turn_exchange_id: "turn-async",
    },
  });
}

function asyncVisibleMessage(parts, { status = "finished_successfully" } = {}) {
  return asyncTurnUpdate({
    id: "msg-async-visible",
    author: { role: "tool", name: "t2uay3k.sj1i4kz", metadata: {} },
    recipient: "all",
    content: { content_type: "multimodal_text", parts },
    status,
    metadata: {
      async_source: "saserver-example:ghostrider-user-example__00000000-0000-0000-0000-00000000example",
      ghostrider: { status: status === "finished_successfully" ? "final" : "intermediate", is_feature_trial: false },
      turn_exchange_id: "turn-async",
    },
  });
}

function asyncVisibleFrames({ order }) {
  const visibleEmpty = asyncVisibleMessage([], { status: "in_progress" });
  const visibleOne = asyncVisibleMessage([asyncImagePart("file-async-a", "gen-async-a")], { status: "in_progress" });
  const visibleBoth = asyncVisibleMessage([asyncImagePart("file-async-a", "gen-async-a"), asyncImagePart("file-async-b", "gen-async-b")]);
  const hiddenCall = asyncHiddenCall();
  const hiddenReturnA = asyncHiddenReturn({ id: "msg-async-return-a", fileId: "file-async-a", genId: "gen-async-a", caption: ASYNC_CAPTION_A, parentId: "msg-async-call" });
  const hiddenReturnB = asyncHiddenReturn({ id: "msg-async-return-b", fileId: "file-async-b", genId: "gen-async-b", caption: ASYNC_CAPTION_B, parentId: "msg-async-return-a" });
  // Real order: the displayed message streams its placeholders first, the
  // hidden call and returns follow. Reverse: the hidden evidence is already
  // on record when the displayed message arrives.
  return order === "visible-first"
    ? [visibleEmpty, visibleOne, visibleBoth, hiddenCall, hiddenReturnA, hiddenReturnB, visibleBoth]
    : [visibleEmpty, hiddenCall, hiddenReturnA, hiddenReturnB, visibleOne, visibleBoth];
}

async function feedAsyncTurn(order) {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  for (const frame of asyncVisibleFrames({ order })) await harness.socketFrame(frame);
  return harness;
}

for (const order of ["hidden-first", "visible-first"]) {
  test(`adopts hidden worker captions onto the displayed images by file id (${order})`, async () => {
    const harness = await feedAsyncTurn(order);
    const metas = harness.events.filter((event) => event.type === "generation-meta").map((event) => event.payload);

    // Only the two captions ever surface as prompts; the blank dalle.prompt
    // values and the raw batch JSON never do.
    const prompts = new Set(metas.filter((meta) => meta.prompt).map((meta) => meta.prompt));
    assert.deepEqual([...prompts].sort(), [ASYNC_CAPTION_A, ASYNC_CAPTION_B].sort());

    // The displayed message's own events carry the captions — a consumer that
    // only knows the visible message id still gets each image's caption.
    for (const [fileId, caption] of [["file-async-a", ASYNC_CAPTION_A], ["file-async-b", ASYNC_CAPTION_B]]) {
      const adopted = metas.find((meta) => meta.messageId === "msg-async-visible"
        && meta.assetId === fileId
        && meta.promptStatus === "visible-caption"
        && meta.prompt === caption);
      assert.ok(adopted, `the displayed message's event for ${fileId} must adopt its caption`);
      assert.equal(adopted.promptScope, "output");
      assert.equal(adopted.isGeneration, true);
    }

    // No request Prompt may be guessed in a two-entry batch turn.
    for (const meta of metas) assert.equal(meta.generationRequestPrompt || "", "");

    const registry = createGenerationRegistryHarness();
    for (const meta of metas) registry.remember(meta);
    for (const [fileId, caption] of [["file-async-a", ASYNC_CAPTION_A], ["file-async-b", ASYNC_CAPTION_B]]) {
      const resolved = registry.resolvedForImage("", { assetId: fileId });
      assert.ok(resolved, `${fileId} must resolve`);
      assert.equal(resolved.prompt, caption);
      assert.equal(resolved.promptStatus, "visible-caption");
      assert.equal(resolved.isGeneration, true);
    }
  });
}

test("keeps a single-entry batch request Prompt beside the hidden caption", async () => {
  const call = asyncTurnUpdate({
    id: "msg-async-single-call",
    author: { role: "assistant", name: null, metadata: {} },
    recipient: "t2uay3k.sj1i4kz",
    content: {
      content_type: "code",
      language: "json",
      text: JSON.stringify({ batch_requests: [
        { prompt: ASYNC_REQUEST_PROMPT_A, aspect_ratio: "4:3", referenced_image_ids: [], transparent_background: false },
      ] }),
    },
    status: "finished_successfully",
    metadata: { is_visually_hidden_from_conversation: true, model_slug: "gpt-5-4-thinking", turn_exchange_id: "turn-async-single" },
  });
  const hiddenReturn = asyncHiddenReturn({
    id: "msg-async-single-return",
    fileId: "file-async-single",
    genId: "gen-async-single",
    caption: ASYNC_CAPTION_A,
    parentId: "msg-async-single-call",
  });
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  for (const frame of [call, hiddenReturn]) await harness.socketFrame(frame);

  const metas = harness.events.filter((event) => event.type === "generation-meta").map((event) => event.payload);
  const captioned = metas.find((meta) => meta.prompt === ASYNC_CAPTION_A);
  assert.ok(captioned);
  assert.equal(captioned.promptStatus, "visible-caption");
  assert.equal(captioned.generationRequestPrompt, ASYNC_REQUEST_PROMPT_A, "an unambiguous single-entry batch names its request Prompt");
});

test("does not adopt a Model caption pasted into a hidden user message", async () => {
  // A hidden user turn (tool telemetry, pasted snippets) is not provider
  // output; its caption-looking text must stay inert even for the same file id.
  const pasted = "Model caption: Cute pastel kawaii illustration scene with a soft pink background, rounded characters, gentle lighting and a clean poster layout.";
  const hiddenUser = asyncTurnUpdate({
    id: "msg-hidden-user",
    author: { role: "user", name: null, metadata: {} },
    content: { content_type: "text", parts: [pasted] },
    metadata: { is_visually_hidden_from_conversation: true },
  });
  const visibleImage = asyncVisibleMessage([asyncImagePart("file-async-a", "gen-async-a")]);
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  for (const frame of [hiddenUser, visibleImage]) await harness.socketFrame(frame);

  const metas = harness.events.filter((event) => event.type === "generation-meta").map((event) => event.payload);
  assert.equal(metas.some((meta) => meta.prompt === pasted), false, "the pasted caption is never a prompt");
  const registry = createGenerationRegistryHarness();
  for (const meta of metas) registry.remember(meta);
  const resolved = registry.resolvedForImage("", { assetId: "file-async-a" });
  assert.equal(resolved?.prompt || "", "", "no caption may reach the image from a user message");
});

test("does not treat a pasted Model caption in a user message as a generation caption", async () => {
  // Users paste earlier captions back into the composer next to a reference
  // upload; only provider output may supply a visible caption.
  const pasted = "Model caption: Cute pastel kawaii illustration scene with a soft pink background, rounded characters, gentle lighting and a clean poster layout.";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    messages: [{
      id: "user-upload",
      author: { role: "user" },
      content: {
        content_type: "multimodal_text",
        parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file-user-upload" }, pasted],
      },
      metadata: { attachments: [{ id: "file-user-upload" }] },
    }],
  });

  await harness.harvest(undefined, "https://chatgpt.com/backend-api/conversations/conversation-test");

  assert.equal(harness.events.some((event) => (
    event.type === "generation-meta"
    && (event.payload?.promptStatus === "visible-caption" || event.payload?.isGeneration === true)
  )), false);
});

test("does not promote an ordinary assistant long reply through turn identity alone", async () => {
  const prose = "This is a long assistant explanation about image workflows, composition choices, lighting references, typography, layout, style systems, and general creative direction. It is intentionally long enough to resemble a descriptive paragraph, but it is still ordinary assistant prose rather than a provider-owned image generation caption.";
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-assistant-turn");

  await harness.socketFrame(JSON.stringify({
    type: "image_generation.update",
    payload: {
      update_content: {
        messages: [{
          id: "assistant-long-reply",
          author: { role: "assistant", name: "assistant" },
          content: { content_type: "text", parts: [prose] },
          metadata: { turn_exchange_id: "turn-assistant-only" },
        }],
      },
    },
    metadata: {},
  }));

  assert.equal(
    harness.events.some((event) => event.type === "generation-meta" && event.payload?.prompt === prose),
    false,
  );
});

test("parses a JSON async_source without exposing its raw text", async () => {
  const prompt = "Create a glossy black packaging render with silver foil type and a single hard key light.";
  const asyncSource = JSON.stringify({
    generation: {
      gen_id: "generation-async-json",
      prompt,
    },
  });
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    message: {
      id: "message-async-json",
      author: { role: "tool", name: "opaque_tool" },
      metadata: {
        image_gen_title: "Generated image",
        async_source: asyncSource,
      },
      content: {
        parts: [{
          content_type: "image_asset_pointer",
          asset_pointer: "sediment://file-async-json",
          metadata: {
            generation: { gen_id: "generation-async-json" },
            dalle: { gen_id: "generation-async-json", prompt: "" },
          },
        }],
      },
    },
  });
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/conversation");
  const output = generationEvents(harness).find((event) => event.payload.assetId === "file-async-json")?.payload;
  assert.ok(output);
  assert.equal(output.prompt, prompt);
  assert.equal(output.promptStatus, "generation-tool-prompt");
  assert.equal(output.providerGenerationCallId, "generation-async-json");
  const diagnostics = harness.events.filter((event) => event.type === "capture-debug");
  assert.equal(JSON.stringify(diagnostics).includes(prompt), false);
  assert.equal(JSON.stringify(diagnostics).includes(asyncSource), false);
  const messageDebug = diagnostics.find((event) => event.payload?.stage === "message")?.payload;
  assert.deepEqual(messageDebug?.opaqueSources?.[0]?.rootKeys, ["generation"]);
  assert.equal(messageDebug?.opaqueSources?.[0]?.kind, "json");
});

test("classifies an async_source URI without exposing query values", async () => {
  const secretValue = "SECRET_ASYNC_TASK_VALUE";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    message: {
      id: "message-async-uri",
      author: { role: "tool", name: "opaque_tool" },
      metadata: {
        image_gen_title: "Generated image",
        async_source: `openai-async://image/task?id=${secretValue}&generation_id=gen-uri`,
      },
      content: {
        parts: [{
          content_type: "image_asset_pointer",
          asset_pointer: "sediment://file-async-uri",
          metadata: { generation: { gen_id: "gen-uri" } },
        }],
      },
    },
  });
  await harness.harvest();
  const messageDebug = harness.events.find(
    (event) => event.type === "capture-debug" && event.payload?.stage === "message",
  )?.payload;
  assert.equal(messageDebug?.opaqueSources?.[0]?.kind, "uri");
  assert.equal(messageDebug?.opaqueSources?.[0]?.scheme, "openai-async");
  assert.equal(JSON.stringify(messageDebug?.opaqueSources?.[0]?.queryKeys), JSON.stringify(["id", "generation_id"]));
  assert.equal(JSON.stringify(messageDebug).includes(secretValue), false);
});

test("reads a structured prompt object from the current image tool message", async () => {
  const prompt = "Create a warm editorial portrait with cream typography and directional studio light.";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    message: {
      id: "message-structured-prompt",
      author: { role: "tool", name: "opaque_tool" },
      metadata: { image_gen_title: "Generated image" },
      content: {
        parts: [{
          content_type: "image_asset_pointer",
          asset_pointer: "sediment://file-structured-prompt",
        }],
      },
      prompt: {
        content: [{ type: "text", text: prompt }],
      },
      generation: { status: "finished_successfully" },
    },
  });
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/conversation");
  const output = generationEvents(harness).find((event) => event.payload.assetId === "file-structured-prompt")?.payload;
  assert.ok(output);
  assert.equal(output.prompt, prompt);
  assert.equal(output.promptStatus, "generation-tool-prompt");
  assert.equal(output.promptSource, "prompt");
  assert.equal(output.isGeneration, true);
});

test("keeps a structured prompt ambiguous when it contains multiple different text candidates", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    message: {
      id: "message-ambiguous-structured-prompt",
      author: { role: "tool", name: "opaque_tool" },
      metadata: { image_gen_title: "Generated image" },
      content: {
        parts: [{
          content_type: "image_asset_pointer",
          asset_pointer: "sediment://file-ambiguous-structured-prompt",
        }],
      },
      prompt: {
        content: [
          { type: "text", text: "Create a blue poster with hard light." },
          { type: "text", text: "Create a red poster with soft light." },
        ],
      },
    },
  });
  await harness.harvest();
  const output = harness.events.find(
    (event) => event.type === "generation-meta"
      && event.payload?.assetId === "file-ambiguous-structured-prompt",
  )?.payload;
  assert.ok(output);
  assert.equal(output.prompt, "");
  assert.equal(output.promptStatus, "not-available");
  assert.equal(output.isGeneration, true);
});

test("keeps current tool output identity when ChatGPT omits its generation prompt", async () => {
  const harness = createHookHarness(currentChatGptConversation());
  await harness.refreshCurrentConversation();
  const output = harness.events.find((event) => event.type === "generation-meta" && event.payload.assetId === "file-current-output")?.payload;
  assert.ok(output);
  assert.equal(output.prompt, "");
  assert.equal(output.promptStatus, "not-available");
  assert.equal(output.messageId, "output-message");
  assert.equal(output.providerGenerationCallId, "generation-output");
  assert.equal(output.isGeneration, true);
  assert.equal(output.generationStatus, "completed");
  assert.equal(output.generationContextId, "chatgpt:conversation-test:generation-output");
});

test("does not treat a reuploaded generated image as a new tool output", async () => {
  const harness = createHookHarness(currentChatGptConversation("", "user"));
  await harness.harvest();
  assert.equal(harness.events.some((event) => event.payload?.isGeneration), false);
});

test("plural response interception excludes sidebar, batch, and other conversations", async () => {
  const harness = createHookHarness(currentChatGptConversation("Create a green poster with soft lighting."));
  for (const path of ["conversations", "conversations/batch", "conversations/other-chat"]) {
    await harness.harvest(undefined, `https://chatgpt.com/backend-api/${path}`);
  }
  assert.equal(generationEvents(harness).length, 0);
});

test("falls back to the legacy conversation endpoint when the plural endpoint is unavailable", async () => {
  const harness = createHookHarness(currentChatGptConversation(), "conversation-test", {
    respond: (url) => url.includes("/conversations/") ? { ok: false, status: 404 } : null,
  });
  await harness.refreshCurrentConversation();
  assert.deepEqual(harness.requestedUrls, [
    "https://chatgpt.com/backend-api/conversations/conversation-test",
    "https://chatgpt.com/backend-api/conversation/conversation-test",
  ]);
  assert.ok(harness.events.some((event) => event.payload?.isGeneration));
});

function currentChatGptContentHarness() {
  const names = [
    "conversationIdFromUrl", "currentConversationId", "conversationTurnForNode", "turnContainsRole", "nearestPrecedingUserScope",
    "userMessageForCandidate", "messageIdsForCandidate", "messageIdForCandidate", "messageScopeForCandidate", "domCaptionForCandidate",
    "chatGptImageProxyInfo", "normalizeAssetId", "isTrustedBlobAssetUrl", "normalizeBlobAssetId", "blobAssetIdForUrl", "imageLookupKeys", "candidateLookupKeys",
    "findGenerationEvidenceForCandidate", "resolvePrompt", "buildStoredPrompt", "cleanPromptText",
    "extractPlaceHints", "promptMentionsPlace", "looksLikeGenerationCaption", "isWeakChatPrompt",
    "scorePromptText", "normalizeGenerationStatus",
  ];
  const source = names.map((name) => {
    const match = new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(contentSource);
    assert.ok(match, `missing ${name}`);
    return match[0];
  }).join("\n");
  const constants = ["CHATGPT_TURN_SELECTOR", "CHATGPT_USER_SELECTOR", "CHATGPT_MESSAGE_SELECTOR"]
    .map((name) => new RegExp(`const ${name} = [^;]+;`).exec(contentSource)[0]).join("\n");
  const userNode = {
    innerText: "Make the lettering blue and keep the background red.",
    matches: () => false,
    closest: () => null,
    compareDocumentPosition: () => 4,
  };
  const messageNode = { getAttribute: () => "output-message" };
  class TestImage {
    closest(selector) {
      if (selector.includes("data-chatgpt-search-message-ids")) return messageNode;
      return null;
    }
    getAttribute() { return "Generated image 1"; }
  }
  const registry = createGenerationRegistryHarness();
  const context = {
    HTMLImageElement: TestImage, Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    URL, location: { href: "https://chatgpt.com/c/conversation-test", origin: "https://chatgpt.com", pathname: "/c/conversation-test" },
    blobAssetIds: new Map(),
    MAX_BLOB_ASSETS: 400,
    activeConversationId: "conversation-test",
    document: { querySelectorAll: (selector) => selector.includes('data-content-search-unit-key$=":user"') ? [userNode] : [] },
    STYLE_HINTS: [],
    findBoundPromptForImage: () => null,
    findGenerationEvidenceForImage: () => null,
    generationRegistryForPage: () => registry,
  };
  vm.runInNewContext(`${constants}\n${source}`, context);
  return { context, registry, messageNode, userNode, candidate: { el: new TestImage(), imageUrl: "blob:https://chatgpt.com/preview-1" } };
}

test("new blob previews preserve user input and output identity without inventing a prompt", async () => {
  const hook = createHookHarness(currentChatGptConversation());
  await hook.refreshCurrentConversation();
  const { context, registry, candidate, userNode } = currentChatGptContentHarness();
  for (const event of hook.events.filter((event) => event.type === "generation-meta")) registry.remember(event.payload);
  const resolved = context.resolvePrompt(candidate.imageUrl, candidate);
  assert.equal(resolved.prompt, "");
  assert.equal(resolved.promptStatus, "not-available");
  assert.equal(resolved.userMessage, userNode.innerText);
  assert.equal(resolved.messageId, "output-message");
  assert.equal(resolved.providerAssetId, "file-current-output");
  assert.ok(context.candidateLookupKeys(candidate).includes("asset:file-current-output"));
});

test("late generation metadata upgrades only the matching current blob message", async () => {
  const prompt = "Create blue metallic lettering on a red poster, with soft lighting.";
  const { context, registry, candidate, messageNode } = currentChatGptContentHarness();
  const hook = createHookHarness(currentChatGptConversation(prompt));
  await hook.refreshCurrentConversation();
  for (const event of generationEvents(hook)) registry.remember(event.payload);
  assert.equal(context.resolvePrompt(candidate.imageUrl, candidate).prompt, prompt);
  messageNode.getAttribute = () => "another-output";
  assert.equal(context.resolvePrompt(candidate.imageUrl, candidate).prompt, "");
  assert.equal(context.candidateLookupKeys(candidate).includes("asset:file-current-output"), false);
  messageNode.getAttribute = () => "output-message another-output";
  assert.equal(context.messageIdForCandidate(candidate), "");
  assert.equal(context.resolvePrompt(candidate.imageUrl, candidate).prompt, "");
});

test("an already saved blob is upgraded when its provider identity arrives late", async () => {
  const { context, registry, candidate } = currentChatGptContentHarness();
  const savedKeys = context.candidateLookupKeys(candidate);
  const ingests = [];
  Object.assign(context, {
    savedPromptRanks: new Map(savedKeys.map((key) => [key, 0])),
    capturedCandidates: new Map(),
    collectDomCandidates: () => [candidate],
    promptUpgradeInFlight: new Set(),
    clearPromptRecovery: () => {},
    withAutoCaptureSlot: async (task) => task(),
    ingestCandidate: async (item, options) => { ingests.push({ item, options }); },
  });
  const source = ["findCandidateForMeta", "candidateOperationKey", "savedPromptRankForKeys", "promptQuality", "metaPromptQuality", "schedulePromptUpgrade"]
    .map((name) => new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(contentSource)[0]).join("\n");
  vm.runInNewContext(source, context);
  const hook = createHookHarness(currentChatGptConversation("Create a poster with blue lettering and soft lighting."));
  await hook.refreshCurrentConversation();
  const meta = generationEvents(hook)[0].payload;
  registry.remember(meta);
  context.schedulePromptUpgrade(meta);
  await setImmediate();
  assert.equal(ingests.length, 1);
  assert.equal(ingests[0].item, candidate);
  assert.equal(ingests[0].options.reason, "prompt-upgrade");
  assert.equal(ingests[0].options.force, true);
});

test("keeps a same-message user instruction separate and retries for a late caption", () => {
  assert.doesNotMatch(contentSource, /allowUserMessageFallback/);
  assert.doesNotMatch(contentSource, /promptSource: "bound-user-message"/);
  assert.match(contentSource, /function domCandidateForImage\(imageUrl(?:, \{ manual = false \} = \{\})?\)/);
  assert.match(contentSource, /function enqueueDomCandidateForImage\(imageUrl, reason\)/);
  assert.match(contentSource, /function schedulePromptRecovery\(candidate, \{ needPrompt = true, needTerminal = false \} = \{\}\)/);
  assert.match(contentSource, /function currentViewportCandidate\(candidates\)/);
  assert.match(contentSource, /const delays = \[2_800, 7_200, 15_000\]/);
});

test("an orphaned content script explains itself instead of dying on sendMessage", () => {
  // Reloading or re-adding the unpacked extension leaves the injected script
  // running with chrome.runtime gone; every save then failed with a raw
  // "Cannot read properties of undefined (reading 'sendMessage')".
  assert.match(contentSource, /function extensionAlive\(\)/);
  assert.match(contentSource, /function markContextLost\(\)/);
  assert.match(contentSource, /const CONTEXT_LOST_MESSAGE = /);

  const send = /async function runtimeSend\(message\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  assert.ok(send, "runtimeSend should be extractable from content.js");
  assert.ok(
    send.indexOf("extensionAlive()") !== -1
      && send.indexOf("extensionAlive()") < send.indexOf("chrome.runtime.sendMessage(message)"),
    "runtimeSend must verify the extension context before touching chrome.runtime",
  );
  assert.match(send, /reading 'sendMessage'/);

  // The scan interval doubles as the watchdog: an orphaned page flips to the
  // refresh instruction on its own instead of waiting for a failed save.
  const interval = /autoScanInterval = setInterval\(\(\) => \{[\s\S]*?\n {2}\}, 5000\);/.exec(contentSource)?.[0] || "";
  assert.ok(interval, "auto scan interval should be extractable from content.js");
  assert.match(interval, /markContextLost\(\)/);
});

function loadSettingsHarness({ response, responseError, localValue = true } = {}) {
  const loadSettings = /async function loadSettings\(\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  assert.ok(loadSettings, "loadSettings should be extractable from content.js");
  const localReads = [];
  const localWrites = [];
  const context = {
    chrome: {
      storage: {
        local: {
          get: async (defaults) => {
            localReads.push(defaults);
            return { autoCapture: localValue };
          },
          set: async (value) => localWrites.push(value),
        },
      },
    },
    contextLost: false,
    runtimeSend: async () => {
      if (responseError) throw responseError;
      return response;
    },
    syncPageHookCaptureEnabled: () => {},
    syncPageHookDevRawDiagnostics: () => {},
  };
  vm.runInNewContext(`
    let autoCapture = false;
    let pageHookCaptureAck = null;
    ${loadSettings}
    globalThis.runLoadSettings = async () => {
      await loadSettings();
      return autoCapture;
    };
  `, context, { filename: "content-settings.js" });
  return { context, localReads, localWrites };
}

test("a settings read failure preserves an explicit local auto-capture choice", async () => {
  const harness = loadSettingsHarness({
    responseError: new Error("background temporarily unavailable"),
    localValue: false,
  });

  assert.equal(await harness.context.runLoadSettings(), false);
  assert.equal(harness.localReads.length, 1);
  assert.equal(harness.localReads[0].autoCapture, false);
  assert.deepEqual(harness.localWrites, [], "the content script must not rewrite settings");
});

test("the background setting wins without a redundant local read", async () => {
  const harness = loadSettingsHarness({
    response: { ok: true, settings: { autoCapture: false } },
    localValue: true,
  });

  assert.equal(await harness.context.runLoadSettings(), false);
  assert.deepEqual(harness.localReads, []);
  assert.deepEqual(harness.localWrites, []);
});

test("startup context loss disconnects an initialized observer without a TDZ error", async () => {
  const observerAssignment = contentSource.indexOf("observer = new MutationObserver");
  const settingsBoot = contentSource.indexOf("loadSettings().then");
  assert.ok(observerAssignment !== -1 && observerAssignment < settingsBoot);
  assert.match(contentSource, /observer\?\.disconnect\(\)/);

  const markContextLost = /function markContextLost\(\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  const runtimeSend = /async function runtimeSend\(message\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  const context = {
    CONTEXT_LOST_MESSAGE: "refresh required",
    Error,
    autoScanInterval: null,
    clearInterval,
    clearTimeout,
    chrome: {},
    contextLost: false,
    document: { getElementById: () => null },
    extensionAlive: () => false,
    observer: { disconnectCalled: 0, disconnect() { this.disconnectCalled += 1; } },
    autoStabilityStates: new Map(),
    autoStabilityTimers: new Map(),
    generationEvidenceRecoveryTimers: new Map(),
    manualHookDisableTimer: null,
    promptRecoveryTimers: new Map(),
    scanTimer: null,
    setStatus: () => {},
    showToast: () => {},
  };
  vm.runInNewContext(`
    ${markContextLost}
    ${runtimeSend}
    globalThis.runRuntimeSend = () => runtimeSend({ type: "mosa.getSettings" });
  `, context, { filename: "content-context-loss.js" });

  await assert.rejects(context.runRuntimeSend(), /refresh required/);
  assert.equal(context.observer.disconnectCalled, 1);
  assert.equal(context.contextLost, true);
});

test("an open page follows auto-capture changes from local storage only", () => {
  const listener = /chrome\.storage\?\.onChanged\?\.addListener\(\(changes, area\) => \{[\s\S]*?\n {2}\}\);/.exec(contentSource)?.[0] || "";
  assert.ok(listener, "storage listener should be extractable from content.js");
  let storageListener = null;
  const context = {
    chrome: { storage: { onChanged: { addListener: (callback) => { storageListener = callback; } } } },
    clearTimeout,
    autoStabilityStates: new Map(),
    autoStabilityTimers: new Map(),
    observer: { disconnect() {} },
    scanTimer: null,
    requestCurrentConversationRefresh: () => false,
    setPageHookCaptureEnabled: () => {},
    startObs: () => {},
    state: {},
  };
  vm.runInNewContext(`
    let autoCapture = true;
    let manualHookLeaseUntil = 0;
    let manualHookDisableTimer = null;
    let pageHookCaptureAck = null;
    let scheduled = 0;
    let status = "";
    function scheduleScan() { scheduled += 1; }
    function setStatus(value) { status = value; }
    function syncPageHookCaptureEnabled() {}
    ${listener}
    globalThis.readState = () => ({ autoCapture, scheduled, status });
  `, context, { filename: "content-storage-listener.js" });

  assert.equal(typeof storageListener, "function");
  storageListener({ autoCapture: { newValue: false } }, "local");
  assert.equal(JSON.stringify(context.readState()), JSON.stringify({ autoCapture: false, scheduled: 0, status: "自动关" }));
  storageListener({ autoCapture: { newValue: true } }, "sync");
  assert.equal(JSON.stringify(context.readState()), JSON.stringify({ autoCapture: false, scheduled: 0, status: "自动关" }));
  storageListener({ autoCapture: { newValue: true } }, "local");
  assert.equal(JSON.stringify(context.readState()), JSON.stringify({ autoCapture: true, scheduled: 1, status: "自动开" }));
});

test("refreshes only the active conversation to recover a late Model caption", async () => {
  const caption = "Model caption: A detailed retro travel poster for Nanjing, China, with cream paper, bold red Art Deco typography, city vignettes, and a screen-print editorial layout.";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      nanjing: {
        message: {
          id: "message-nanjing",
          author: { role: "tool" },
          content: {
            parts: [
              caption,
              { asset_pointer: "sediment://file-nanjing" },
            ],
          },
        },
      },
    },
  });

  await harness.refreshCurrentConversation();

  assert.deepEqual(harness.requestedUrls, [
    "https://chatgpt.com/backend-api/conversations/conversation-test",
  ]);
  assert.deepEqual(generationEvents(harness).map((event) => ({
    imageKey: event.payload.imageKey,
    prompt: event.payload.prompt,
    promptStatus: event.payload.promptStatus,
  })), [{
    imageKey: "estuary:conversation-test:file-nanjing",
    prompt: caption,
    promptStatus: "visible-caption",
  }]);
});

test("binds revised prompts to ChatGPT Estuary cid/id keys", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      bangkok: {
        message: {
          id: "message-bangkok",
          content: { parts: [{ asset_pointer: "file-service://file-bangkok" }] },
          metadata: { dalle: { revised_prompt: "red sun" } },
        },
      },
    },
  });

  await harness.harvest();

  assert.deepEqual(generationEvents(harness).map((event) => ({
    imageKey: event.payload.imageKey,
    assetId: event.payload.assetId,
    promptStatus: event.payload.promptStatus,
    prompt: event.payload.prompt,
  })), [{
    imageKey: "estuary:conversation-test:file-bangkok",
    assetId: "file-bangkok",
    promptStatus: "generation-tool-prompt",
    prompt: "red sun",
  }]);
});

test("keeps prompts separate when Estuary images share a pathname", async () => {
  const proxyUrl = (assetId) => `https://chatgpt.com/backend-api/estuary/content?cid=conversation-test&id=${assetId}&sig=signed-value`;
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      bangkok: {
        message: {
          id: "message-bangkok",
          content: { parts: [{ asset_pointer: "file-service://file-bangkok", image_url: proxyUrl("file-bangkok") }] },
          metadata: { dalle: { revised_prompt: "A detailed travel poster for Bangkok with saffron temples, red typography, geometric clouds, and a premium editorial layout." } },
        },
      },
      shanghai: {
        message: {
          id: "message-shanghai",
          content: { parts: [{ asset_pointer: "file-service://file-shanghai", image_url: proxyUrl("file-shanghai") }] },
          metadata: { dalle: { revised_prompt: "A detailed travel poster for Shanghai with neon skyline reflections, blue typography, a river promenade, and an editorial print layout." } },
        },
      },
    },
  });

  await harness.harvest();

  const byKey = new Map(generationEvents(harness).map((event) => [event.payload.imageKey, event.payload.prompt]));
  assert.equal(byKey.get("estuary:conversation-test:file-bangkok"), "A detailed travel poster for Bangkok with saffron temples, red typography, geometric clouds, and a premium editorial layout.");
  assert.equal(byKey.get("estuary:conversation-test:file-shanghai"), "A detailed travel poster for Shanghai with neon skyline reflections, blue typography, a river promenade, and an editorial print layout.");
  assert.equal(byKey.size, 2);
});

test("binds a Model caption in the same tool message when dalle.prompt is blank", async () => {
  const caption = "Model caption: A detailed retro travel poster for Chengdu, China, with a cream field, bold red and black Art Deco typography, illustrated city vignettes, a skyline strip, and an editorial print layout.";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      chengdu: {
        message: {
          id: "message-chengdu",
          author: { role: "tool" },
          content: {
            content_type: "multimodal_text",
            parts: [
              caption,
              {
                asset_pointer: "sediment://file-chengdu",
                metadata: { dalle: { prompt: "" } },
              },
            ],
          },
        },
      },
    },
  });

  await harness.harvest();

  assert.deepEqual(generationEvents(harness).map((event) => ({
    imageKey: event.payload.imageKey,
    assetId: event.payload.assetId,
    promptStatus: event.payload.promptStatus,
    prompt: event.payload.prompt,
  })), [{
    imageKey: "estuary:conversation-test:file-chengdu",
    assetId: "file-chengdu",
    promptStatus: "visible-caption",
    prompt: caption,
  }]);
});

test("refreshes the active conversation without copying authentication headers", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });

  // Even if the page makes an authenticated request, MOSA must not copy or
  // replay any of those request headers into its recovery request.
  await harness.harvest({
    headers: {
      Authorization: "Bearer page-session-token",
      "OAI-Device-Id": "device-abc",
      "X-Unrelated-Secret": "must-not-be-copied",
    },
  });
  await harness.refreshCurrentConversation();

  const refreshIndex = harness.requestedUrls.indexOf("https://chatgpt.com/backend-api/conversations/conversation-test");
  assert.ok(refreshIndex >= 0, "the refresh should reach the conversation endpoint");
  const init = harness.requestedInits[refreshIndex] || {};
  assert.equal(init.credentials, "include");
  assert.equal(init.cache, "no-store");
  assert.equal(Object.hasOwn(init, "headers"), false, "recovery must not replay page request headers");
});

test("does not capture page authentication headers", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  await harness.harvest({ headers: { Authorization: "Bearer page-session-token" } });
  await harness.refreshCurrentConversation();

  const posted = JSON.stringify(harness.events);
  assert.equal(posted.includes("page-session-token"), false, "a page token must never be posted out of the page");
  assert.doesNotMatch(contentSource, /authorization/i);
  assert.doesNotMatch(hookSource, /forwardedHeaders|rememberRequestHeaders|oai-device-id|oai-client-version|oai-language/i);
  const refreshIndex = harness.requestedUrls.indexOf("https://chatgpt.com/backend-api/conversations/conversation-test");
  assert.ok(refreshIndex >= 0);
  assert.equal(Object.hasOwn(harness.requestedInits[refreshIndex] || {}, "headers"), false);
});

test("reports a failed conversation refresh instead of losing it silently", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", {
    respond: () => ({ ok: false, status: 401, text: async () => "", clone: () => ({ text: async () => "" }) }),
  });

  await harness.refreshCurrentConversation();

  const failure = harness.events.find((event) => event.type === "conversation-refresh-failed");
  assert.ok(failure, "a rejected refresh must be reported");
  assert.equal(failure.payload.status, 401);
  assert.equal(Object.hasOwn(failure.payload, "authorized"), false);
  assert.match(contentSource, /data\.type === "conversation-refresh-failed"/);
});

test("treats a missing conversation recovery endpoint as a soft failure", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", {
    respond: () => ({ ok: false, status: 404, text: async () => "", clone: () => ({ text: async () => "" }) }),
  });

  await harness.refreshCurrentConversation();

  const failure = harness.events.find((event) => event.type === "conversation-refresh-failed");
  assert.ok(failure);
  assert.equal(failure.payload.status, 404);
  assert.equal(failure.payload.soft, true);
  assert.match(contentSource, /实时 Hook 正常 · 历史会话回读不可用/);
});

test("harvests a caption from the live WebSocket stream", async () => {
  // ChatGPT streams a live answer over a socket, so fetch and XHR never see the
  // caption of an image generated while the page stays open.
  const caption = "Model caption: 一张暖色沙漠时装大片海报，构图为低角度仰拍，画面有强烈的电影感光影与胶片颗粒，排版为杂志封面风格。";
  const frame = `data: ${JSON.stringify({
    conversation_id: "conversation-test",
    message: {
      id: "message-live",
      author: { role: "tool" },
      content: { parts: [caption, { asset_pointer: "sediment://file-live" }] },
    },
  })}\n\n`;
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });

  await harness.socketFrame(JSON.stringify({
    type: "http.response.body",
    body: Buffer.from(frame, "utf8").toString("base64"),
    more_body: true,
  }));

  assert.deepEqual(generationEvents(harness).map((event) => ({
    imageKey: event.payload.imageKey,
    prompt: event.payload.prompt,
    promptStatus: event.payload.promptStatus,
  })), [{
    imageKey: "estuary:conversation-test:file-live",
    prompt: caption,
    promptStatus: "visible-caption",
  }]);
});

// ---- Streaming SSE fetch responses (delta encoding v1) ----

const STREAM_ABORT_ERROR = Object.assign(new Error("The user aborted a request."), { name: "AbortError" });

function chunkText(text, size = 40) {
  const pieces = [];
  for (let index = 0; index < text.length; index += size) pieces.push(text.slice(index, index + size));
  return pieces;
}

/** A fetch Response stub whose body streams the given pieces through getReader(). */
function streamingResponse(pieces, {
  url = "https://chatgpt.com/backend-api/f/conversation",
  contentType = "text/event-stream",
  failAfter = null,
  error = STREAM_ABORT_ERROR,
  stall = false,
} = {}) {
  let cursor = 0;
  const reader = {
    read: async () => {
      if (stall) await setImmediate();
      if (failAfter !== null && cursor >= failAfter) throw error;
      if (cursor >= pieces.length) return { done: true, value: undefined };
      const value = pieces[cursor];
      cursor += 1;
      return { done: false, value };
    },
  };
  const headers = new Map([["content-type", contentType]]);
  const response = {
    ok: true,
    status: 200,
    url,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    body: { getReader: () => reader },
    clone: () => response,
  };
  return response;
}

function deltaEvent(data) {
  return `event: delta\ndata: ${JSON.stringify(data)}`;
}

function sseEventsText(events) {
  return `${events.join("\n\n")}\n\n`;
}

/** A synthetic delta encoding v1 image turn: user input, code call, tool image. */
function deltaV1StreamEvents({
  codePrompt = "A misty mountain valley travel poster in flat vector style",
  codeAppendixCount = 2,
  codeMessageId = "message-code",
  codeStatusFinished = false,
  toolAssetId = "file-poster",
  toolGenId = "generation-poster",
  toolMessageId = "message-tool-image",
  toolCaptionAppended = null,
  toolExtraPatches = [],
  toolStatusFinished = false,
  withDoneMarker = true,
} = {}) {
  const codeArgsText = JSON.stringify({ prompt: codePrompt, aspect_ratio: "2:3" });
  const pieceLength = Math.ceil(codeArgsText.length / codeAppendixCount);
  const codePieces = [];
  for (let index = 0; index < codeArgsText.length; index += pieceLength) {
    codePieces.push(codeArgsText.slice(index, index + pieceLength));
  }
  const toolMessage = {
    id: toolMessageId,
    author: { role: "tool", name: "image_gen.text2im", metadata: {} },
    recipient: "all",
    channel: "commentary",
    content: {
      content_type: "multimodal_text",
      parts: [{
        content_type: "image_asset_pointer",
        asset_pointer: `sediment://${toolAssetId}`,
        size: { width: 1024, height: 1536 },
        metadata: { dalle: { gen_id: toolGenId, prompt: "" } },
      }],
    },
    status: "in_progress",
    metadata: { turn_exchange_id: "turn-poster", parent_id: codeMessageId, image_gen_title: "Generated image" },
  };
  const events = [
    "event: delta_encoding\ndata: \"v1\"",
    deltaEvent({
      type: "input_message",
      message: {
        id: "message-user",
        author: { role: "user", metadata: {} },
        content: { content_type: "text", parts: ["Draw a poster of a misty mountain valley"] },
        status: "finished_successfully",
        metadata: {},
      },
    }),
    deltaEvent({
      p: "",
      o: "add",
      v: {
        message: {
          id: codeMessageId,
          author: { role: "assistant", name: null, metadata: {} },
          recipient: "image_gen.text2im",
          channel: "commentary",
          content: { content_type: "code", language: "json", text: codePieces[0] },
          status: "in_progress",
          metadata: { turn_exchange_id: "turn-poster" },
        },
        conversation_id: "conversation-test",
      },
    }),
    // All but the last piece arrive as path appends; the last one arrives as a
    // bare {"v":"..."} continuation of the previous patch path.
    ...codePieces.slice(1, -1).map((piece) => deltaEvent({ p: "/message/content/text", o: "append", v: piece })),
    ...(codePieces.length > 1 ? [deltaEvent({ v: codePieces.at(-1) })] : []),
  ];
  if (codeStatusFinished) {
    events.push(deltaEvent({ p: "/message/status", o: "replace", v: "finished_successfully" }));
  }
  events.push(deltaEvent({ o: "add", v: { message: toolMessage, conversation_id: "conversation-test" } }));
  if (toolCaptionAppended !== null) {
    events.push(deltaEvent({ p: "/message/content/parts/1", o: "append", v: toolCaptionAppended }));
  }
  for (const patch of toolExtraPatches) events.push(deltaEvent(patch));
  if (toolStatusFinished) {
    events.push(deltaEvent({ p: "/message/status", o: "replace", v: "finished_successfully" }));
  }
  if (withDoneMarker) events.push("data: [DONE]");
  return events;
}

function streamedHarness(events, { pieces = null, abortAtEnd = false, ...responseOptions } = {}) {
  const streamPieces = pieces || chunkText(sseEventsText(events));
  return createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", {
    respond: () => streamingResponse(streamPieces, {
      ...responseOptions,
      ...(abortAtEnd ? { failAfter: streamPieces.length } : {}),
    }),
  });
}

function imageOutputsFor(harness, assetId) {
  return harness.events
    .filter((event) => event.type === "generation-meta" && event.payload?.assetId === assetId)
    .map((event) => event.payload);
}

test("rebuilds a delta encoding v1 stream and binds the generated image immediately", async () => {
  const harness = streamedHarness(deltaV1StreamEvents());
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/f/conversation");

  const outputs = imageOutputsFor(harness, "file-poster");
  assert.equal(outputs.length, 1);
  const payload = outputs[0];
  assert.equal(payload.messageId, "message-tool-image");
  assert.equal(payload.providerGenerationCallId, "generation-poster");
  assert.equal(payload.imageKey, "estuary:conversation-test:file-poster");
  assert.equal(payload.isGeneration, true);
});

test("keeps the rebuilt bindings when the page aborts the stream after [DONE]", async () => {
  const harness = streamedHarness(deltaV1StreamEvents(), { abortAtEnd: true });
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/f/conversation");

  const payload = imageOutputsFor(harness, "file-poster")[0];
  assert.ok(payload, "an AbortError after [DONE] must not discard the parsed turn");
  assert.equal(payload.messageId, "message-tool-image");
  assert.equal(payload.providerGenerationCallId, "generation-poster");
  assert.equal(payload.imageKey, "estuary:conversation-test:file-poster");
});

test("keeps the emitted image binding when the stream is aborted before [DONE]", async () => {
  const caption = "Model caption: A misty mountain valley travel poster in flat vector style with cinematic light.";
  const events = deltaV1StreamEvents({ toolCaptionAppended: caption, withDoneMarker: false });
  const pieces = chunkText(sseEventsText(events));
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", {
    respond: () => streamingResponse(pieces, { failAfter: pieces.length }),
  });
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/f/conversation");

  assert.deepEqual(imageOutputsFor(harness, "file-poster").map((payload) => [payload.prompt, payload.promptStatus]), [
    ["", "not-available"],
    [caption, "visible-caption"],
  ]);
});

test("binds a caption that arrives as a parts patch to the image output", async () => {
  const caption = "Model caption: A misty mountain valley travel poster in flat vector style with cinematic light.";
  const harness = streamedHarness(deltaV1StreamEvents({ toolCaptionAppended: caption, toolStatusFinished: true }));
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/f/conversation");

  assert.deepEqual(imageOutputsFor(harness, "file-poster").map((payload) => [payload.prompt, payload.promptStatus]), [
    ["", "not-available"],
    [caption, "visible-caption"],
  ]);
});

test("rebuilds the generation request prompt from appended code text", async () => {
  const requestPrompt = "A misty mountain valley travel poster in flat vector style, saffron temples, red typography";

  async function toolRequestPromptFor(codePrompt) {
    const runHarness = streamedHarness(deltaV1StreamEvents({ codePrompt, codeAppendixCount: 4, codeStatusFinished: true }));
    await runHarness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/f/conversation");
    return imageOutputsFor(runHarness, "file-poster")[0]?.generationRequestPrompt;
  }

  assert.equal(await toolRequestPromptFor(requestPrompt), requestPrompt);
  assert.equal(await toolRequestPromptFor(null), "", "a null prompt argument yields an empty request prompt");
});

test("rebuilds concurrent streams independently", async () => {
  const captionA = "Model caption: Stream one poster with warm desert light and bold editorial typography.";
  const captionB = "Model caption: Stream two poster with cool neon light and thin vector linework.";
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", {
    respond: (url) => {
      if (String(url).includes("/f/conversation")) {
        return streamingResponse(chunkText(sseEventsText(deltaV1StreamEvents({
          codeMessageId: "message-code-a",
          toolAssetId: "file-poster-a",
          toolGenId: "generation-a",
          toolMessageId: "message-tool-a",
          toolCaptionAppended: captionA,
          toolStatusFinished: true,
        }))), { stall: true, url: "https://chatgpt.com/backend-api/f/conversation" });
      }
      if (String(url).endsWith("/backend-api/conversation")) {
        return streamingResponse(chunkText(sseEventsText(deltaV1StreamEvents({
          codeMessageId: "message-code-b",
          toolAssetId: "file-poster-b",
          toolGenId: "generation-b",
          toolMessageId: "message-tool-b",
          toolCaptionAppended: captionB,
          toolStatusFinished: true,
        }))), { stall: true, url: "https://chatgpt.com/backend-api/conversation" });
      }
      return null;
    },
  });

  await Promise.all([
    harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/f/conversation"),
    harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/conversation"),
  ]);
  for (let index = 0; index < 200; index += 1) await setImmediate();

  const finalA = imageOutputsFor(harness, "file-poster-a").at(-1);
  const finalB = imageOutputsFor(harness, "file-poster-b").at(-1);
  assert.equal(finalA.prompt, captionA);
  assert.equal(finalA.messageId, "message-tool-a");
  assert.equal(finalB.prompt, captionB);
  assert.equal(finalB.messageId, "message-tool-b");
  assert.equal(harness.events.some((event) => (
    event.payload?.assetId === "file-poster-b" && event.payload?.prompt === captionA
  )), false, "stream A's caption must not land on stream B's image");
});

test("keeps parsing old-format SSE where every data line is a complete object", async () => {
  const prompt = "Create a teal poster with embossed lettering and soft studio light.";
  const lines = [
    `data: ${JSON.stringify({
      type: "input_message",
      message: {
        id: "message-old-user",
        author: { role: "user" },
        content: { content_type: "text", parts: ["Draw a teal poster"] },
      },
    })}`,
    `data: ${JSON.stringify({
      conversation_id: "conversation-test",
      message: {
        id: "message-old-tool",
        author: { role: "tool", name: "image_gen" },
        status: "finished_successfully",
        metadata: { image_gen_title: "Generated image" },
        content: {
          content_type: "multimodal_text",
          parts: [{
            content_type: "image_asset_pointer",
            asset_pointer: "sediment://file-old-format",
            metadata: { dalle: { gen_id: "generation-old", prompt } },
          }],
        },
      },
    })}`,
  ];
  // No blank lines between events: the whole body is one partial block until EOF.
  const harness = streamedHarness(null, { pieces: chunkText(`${lines.join("\n")}\n`) });
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/f/conversation");

  const payload = imageOutputsFor(harness, "file-old-format")[0];
  assert.ok(payload, "old-format SSE over fetch must still be harvested");
  assert.equal(payload.prompt, prompt);
  assert.equal(payload.promptStatus, "generation-tool-prompt");
});

test("keeps the buffered JSON treatment for non-SSE bodies on the stream endpoint", async () => {
  const body = currentChatGptConversation("Create an amber poster with grainy typography and warm backlight.");
  const harness = streamedHarness(null, { pieces: chunkText(JSON.stringify(body)), contentType: "application/json" });
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/f/conversation");

  const payload = imageOutputsFor(harness, "file-current-output")[0];
  assert.ok(payload, "a plain JSON body on the stream endpoint is still harvested");
  assert.equal(payload.promptStatus, "generation-tool-prompt");
});

test("ignores unknown patch operations and keeps applying later events", async () => {
  const captionBase = "Model caption: A misty mountain valley travel poster in flat vector style";
  const events = deltaV1StreamEvents({
    toolCaptionAppended: captionBase,
    toolExtraPatches: [
      { p: "/message/content/parts/1", o: "frobnicate", v: "junk" },
      { p: "/message/unknown/deep/path", o: "append", v: "junk" },
      { o: "patch", v: [
        { p: "/message/recipient", o: "splice", v: [0, 1] },
        { p: "/message/content/parts/1", o: "append", v: " with soft light." },
      ] },
    ],
    toolStatusFinished: true,
  });
  const harness = streamedHarness(events);
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/f/conversation");

  const outputs = imageOutputsFor(harness, "file-poster");
  assert.equal(outputs.length, 2);
  assert.deepEqual([outputs[1].prompt, outputs[1].promptStatus], [
    `${captionBase} with soft light.`,
    "visible-caption",
  ]);
});

test("stops parsing a stream past the harvest size ceiling but keeps earlier bindings", async () => {
  const text = sseEventsText(deltaV1StreamEvents());
  const harness = streamedHarness(null, { pieces: [text, "x".repeat(12_000_001)] });
  await harness.harvest({ method: "POST" }, "https://chatgpt.com/backend-api/f/conversation");

  const skipped = harness.events.find((event) => event.type === "harvest-skipped");
  assert.ok(skipped, "an oversized stream must be reported once");
  assert.equal(skipped.payload.reason, "payload-too-large");
  assert.ok(skipped.payload.size > 12_000_000);
  assert.equal(harness.events.filter((event) => event.type === "harvest-skipped").length, 1);
  const payload = imageOutputsFor(harness, "file-poster")[0];
  assert.ok(payload, "bindings processed before the ceiling survive");
  assert.equal(payload.messageId, "message-tool-image");
});

test("accepts an unmarked caption in the image tool message", async () => {
  // The "Model caption:" marker is OpenAI wording that has changed before.
  const caption = "A dramatic low-angle sports portrait scene with cinematic side lighting, a warm desert background, bold editorial typography, and a premium magazine cover layout.";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      unmarked: {
        message: {
          id: "message-unmarked",
          author: { role: "tool" },
          content: { parts: [caption, { asset_pointer: "sediment://file-unmarked" }] },
        },
      },
    },
  });

  await harness.harvest();

  assert.deepEqual(generationEvents(harness).map((event) => ({
    prompt: event.payload.prompt,
    promptStatus: event.payload.promptStatus,
  })), [{ prompt: caption, promptStatus: "visible-caption" }]);
});

test("does not mistake assistant prose about an image for its caption", async () => {
  const prose = "Here is the poster you asked for. I kept the lighting cinematic and the typography bold so the layout reads clearly, and I can adjust the composition or palette if you want a different style.";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      prose: {
        message: {
          id: "message-prose",
          author: { role: "assistant" },
          content: { content_type: "multimodal_text", parts: [prose, { asset_pointer: "sediment://file-prose" }] },
        },
      },
    },
  });

  await harness.harvest();

  assert.deepEqual(generationEvents(harness), [], "chat prose is not a generation caption");
});

test("does not attach a prompt from one message to an unrelated image message", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      promptOnly: {
        message: {
          id: "message-prompt",
          content: { parts: ["Image generation complete"] },
          metadata: { dalle: { revised_prompt: "A richly detailed landscape illustration with a misty mountain valley, ceramic blue palette, morning light, and cinematic composition." } },
        },
      },
      imageOnly: {
        message: {
          id: "message-image",
          content: { parts: [{ asset_pointer: "file-service://file-unrelated" }] },
        },
      },
    },
  });

  await harness.harvest();

  assert.equal(generationEvents(harness).some((event) => event.payload.imageKey === "estuary:conversation-test:file-unrelated"), false);
});

test("opens the in-page control panel in the lower-right corner instead of relying on popup UI", () => {
  assert.match(contentSource, /mosa\.capture\.togglePanel/);
  assert.match(contentSource, /function ensureControlPanel\(\)/);
  assert.match(contentSource, /function toggleControlPanel\(\)/);
  assert.match(contentSource, /mosa-capture-panel/);
  assert.match(contentCss, /#mosa-capture-panel/);
  assert.match(contentCss, /right:\s*16px/);
  assert.match(contentCss, /bottom:\s*16px/);
  assert.doesNotMatch(contentCss, /top:\s*14px/);
  assert.doesNotMatch(JSON.stringify(manifest.action), /popup\.html/);
});

test("keeps the capture toast compact in the viewport corner", () => {
  const toastCss = contentCss.slice(0, contentCss.indexOf("#mosa-capture-panel"));
  assert.match(toastCss, /right:\s*16px/);
  assert.match(toastCss, /bottom:\s*16px/);
  assert.match(toastCss, /width:\s*max-content/);
  assert.match(toastCss, /max-width:\s*min\(260px/);
  assert.match(toastCss, /font:\s*600 12px/);
  assert.doesNotMatch(toastCss, /left:\s*50%/);
  assert.doesNotMatch(toastCss, /translateX\(\s*-50%\s*\)/);
});

// Multi-image gallery: blob: images bind their prompts through the estuary file id.

const BATCH_CONVERSATION = "conversation-batch-e2e";
const BATCH_TOOL = "t2uay3k.sj1i4kz";
// [file id, that image's Model caption]; captions stay long enough for looksLikePrompt.
const BATCH_FILES = [
  ["file-qae2e000001", "Model caption: 第一张的提示词，冰蓝色雕塑与金属质感练习。"],
  ["file-qae2e000002", "Model caption: 第二张的提示词，暖橙色块构成与材质研究。"],
  ["file-qae2e000003", "Model caption: 第三张的提示词，黑白极简形态的构成练习。"],
  ["file-qae2e000004", "Model caption: 第四张的提示词，柔软形态与织物质感实验。"],
];
// Request prompts in the batch call, distinct from every caption so leaks are visible.
const BATCH_REQUEST_PROMPTS = [
  "request-prompt-alpha：一整段与四张图都不同的发起调用提示词甲。",
  "request-prompt-bravo：一整段与四张图都不同的发起调用提示词乙。",
  "request-prompt-charlie：一整段与四张图都不同的发起调用提示词丙。",
  "request-prompt-delta：一整段与四张图都不同的发起调用提示词丁。",
];

function batchPointer(fileId) {
  return {
    content_type: "image_asset_pointer",
    asset_pointer: `sediment://${fileId}`,
    metadata: { dalle: { gen_id: `gen-${fileId.slice(-4)}` }, generation: { gen_id: `gen-${fileId.slice(-4)}` } },
  };
}

async function feedBatchGalleryTurn(harness) {
  // The tool call: four batch_requests, in request order.
  await harness.socketFrame(JSON.stringify({
    conversation_id: BATCH_CONVERSATION,
    message: {
      id: "msg-init-batch",
      author: { role: "assistant" },
      recipient: BATCH_TOOL,
      content: {
        content_type: "code",
        text: JSON.stringify({ batch_requests: BATCH_REQUEST_PROMPTS.map((requestPrompt) => ({ prompt: requestPrompt, size: "1024x1024" })) }),
      },
      metadata: { parent_id: "msg-user-batch", turn_exchange_id: "turn-batch-1" },
    },
  }));
  // Four tool messages arrive in completion order, each parented to the previous one;
  // every caption travels with its own file id.
  const completionOrder = [1, 0, 3, 2];
  let previousId = "msg-init-batch";
  for (const [step, fileIndex] of completionOrder.entries()) {
    const [fileId, caption] = BATCH_FILES[fileIndex];
    await harness.socketFrame(JSON.stringify({
      conversation_id: BATCH_CONVERSATION,
      message: {
        id: `msg-tool-batch-${step}`,
        author: { role: "tool", name: BATCH_TOOL },
        content: { content_type: "multimodal_text", parts: [batchPointer(fileId), caption] },
        metadata: { parent_id: previousId, turn_exchange_id: "turn-batch-1", finished_successfully: true },
      },
    }));
    previousId = `msg-tool-batch-${step}`;
  }
  // The tool status note, which is not a prompt.
  await harness.socketFrame(JSON.stringify({
    conversation_id: BATCH_CONVERSATION,
    message: {
      id: "msg-status-batch",
      author: { role: "tool", name: BATCH_TOOL },
      content: { content_type: "text", parts: ["Generated images from the last model call were saved at /mnt/data."] },
      metadata: { turn_exchange_id: "turn-batch-1", finished_successfully: true },
    },
  }));
  // The final message starts empty, gains images in completion order, and is
  // reordered into request order only by its last update.
  const finalMessage = (parts) => ({
    conversation_id: BATCH_CONVERSATION,
    message: {
      id: "msg-final-batch",
      author: { role: "tool", name: BATCH_TOOL },
      content: { content_type: "multimodal_text", parts },
      metadata: { turn_exchange_id: "turn-batch-1", finished_successfully: true },
    },
  });
  await harness.socketFrame(JSON.stringify(finalMessage([])));
  await harness.socketFrame(JSON.stringify(finalMessage([batchPointer(BATCH_FILES[1][0]), batchPointer(BATCH_FILES[0][0])])));
  await harness.socketFrame(JSON.stringify(finalMessage(BATCH_FILES.map(([fileId]) => batchPointer(fileId)))));
}

async function postBlobAssetsForBatch(harness) {
  for (const [fileId] of BATCH_FILES) {
    const response = new harness.responseClass("", {
      url: `https://chatgpt.com/backend-api/estuary/content?id=${fileId}&ts=1700000000&p=probe&cid=${BATCH_CONVERSATION}&sig=sig-value&v=2`,
    });
    const blob = await response.blob();
    harness.urlClass.createObjectURL(blob);
  }
  await setImmediate();
  return harness.events.filter((event) => event.type === "blob-asset").map((event) => event.payload);
}

function loadContentLookupWithBlobAssets() {
  const names = ["chatGptImageProxyInfo", "normalizeAssetId", "isTrustedBlobAssetUrl", "normalizeBlobAssetId", "rememberBlobAsset", "blobAssetIdForUrl", "imageLookupKeys"];
  const source = names.map((name) => {
    const match = new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(contentSource);
    assert.ok(match, `${name} should be extractable from content.js`);
    return match[0];
  }).join("\n");
  const context = {
    Set,
    Map,
    String,
    URL,
    location: { origin: "https://chatgpt.com", href: "https://chatgpt.com/c/demo" },
    blobAssetIds: new Map(),
    MAX_BLOB_ASSETS: 400,
  };
  vm.runInNewContext(source, context, { filename: "content-blob-lookup.js" });
  return context;
}

function batchGenerationMetas(harness) {
  return harness.events.filter((event) => event.type === "generation-meta" && event.payload).map((event) => event.payload);
}

// Mirrors findBoundPromptForImage in content.js: the registry first, then a reverse
// scan of metadata, both through the real imageLookupKeys.
function resolveBoundPromptForBlob(lookup, registry, metas, blobUrl) {
  const wanted = lookup.imageLookupKeys(blobUrl);
  const registryResolved = registry.resolvedForImage(blobUrl);
  if (registryResolved?.prompt) return { via: "registry", prompt: registryResolved.prompt };
  for (let index = metas.length - 1; index >= 0; index -= 1) {
    const meta = metas[index];
    if (!meta.prompt) continue;
    if (lookup.imageLookupKeys(meta.imageUrl || "", meta).some((key) => wanted.includes(key))) {
      return { via: "network-meta", prompt: meta.prompt };
    }
  }
  return { via: "none", prompt: "" };
}

test("page hook maps the estuary blob download chain to file ids and posts blob-asset", async () => {
  const harness = createHookHarness({});
  const response = new harness.responseClass("", {
    url: "https://chatgpt.com/backend-api/estuary/content?id=file-qae2e000001&ts=1700000000&p=probe&cid=conversation-batch-e2e&sig=sig-value&v=2",
  });
  const blob = await response.blob();
  assert.ok(blob instanceof harness.blobClass, "the page still receives its Blob");
  const blobUrl = harness.urlClass.createObjectURL(blob);
  const event = harness.events.find((item) => item.type === "blob-asset");
  assert.ok(event, "blob-asset should be posted through the page bridge");
  // Objects from another vm context fail deepEqual on prototype; compare keys instead.
  assert.equal(Object.keys(event.payload).sort().join(","), "assetId,blobUrl", "only blobUrl and the id parameter are sent");
  assert.equal(event.payload.blobUrl, blobUrl);
  assert.equal(event.payload.assetId, "file-qae2e000001");
  assert.ok(!["sig", "ts", "p", "cid", "v"].some((key) => key in event.payload), "no signature or token parameter leaks into the message");
});

test("page hook ignores non-estuary, id-less, non-file and cross-origin sources and keeps page calls intact", async () => {
  const harness = createHookHarness({});
  const sources = [
    "https://chatgpt.com/backend-api/files/download/file-qae2e000001",
    "https://chatgpt.com/backend-api/estuary/content?ts=1&sig=only-signature",
    "https://chatgpt.com/backend-api/estuary/content?id=abc123def456",
    "https://evil.example/backend-api/estuary/content?id=file-qae2e000001",
  ];
  for (const url of sources) {
    const response = new harness.responseClass("", { url });
    const blob = await response.blob();
    const blobUrl = harness.urlClass.createObjectURL(blob);
    assert.ok(blobUrl.startsWith("blob:https://chatgpt.com/"), "createObjectURL keeps working");
  }
  assert.equal(harness.events.filter((item) => item.type === "blob-asset").length, 0);
  // With capture off nothing is tagged or reported, and page calls still work.
  const disabled = createHookHarness({}, "conversation-test", { captureEnabled: false });
  const response = new disabled.responseClass("", { url: "https://chatgpt.com/backend-api/estuary/content?id=file-qae2e000001" });
  const blob = await response.blob();
  disabled.urlClass.createObjectURL(blob);
  assert.equal(disabled.events.filter((item) => item.type === "blob-asset").length, 0);
});

test("page hook blob mapping survives hook-internal errors without touching the page", async () => {
  const harness = createHookHarness({});
  const response = new harness.responseClass("", {});
  Object.defineProperty(response, "url", {
    get() {
      throw new Error("synthetic read failure");
    },
  });
  const blob = await response.blob();
  assert.ok(blob instanceof harness.blobClass, "the original blob result is preserved");
  const blobUrl = harness.urlClass.createObjectURL(blob);
  assert.ok(blobUrl.startsWith("blob:"));
  assert.equal(harness.events.filter((item) => item.type === "blob-asset").length, 0);
  // A rejected blob() still rejects for the page.
  class RejectingResponse extends harness.responseClass {
    async blob() {
      throw new Error("network died");
    }
  }
  await assert.rejects(new RejectingResponse("", { url: "https://chatgpt.com/backend-api/estuary/content?id=file-qae2e000001" }).blob(), /network died/);
});

test("multi-image gallery binds every blob to its own caption via the estuary file id", async () => {
  const harness = createHookHarness({});
  const lookup = loadContentLookupWithBlobAssets();
  const registry = createGenerationRegistryHarness({ imageLookupKeys: lookup.imageLookupKeys });
  await feedBatchGalleryTurn(harness);
  const payloads = await postBlobAssetsForBatch(harness);
  assert.equal(payloads.length, 4);
  for (const payload of payloads) assert.ok(lookup.rememberBlobAsset(payload), "each mapping passes content-side validation");

  const metas = batchGenerationMetas(harness);
  for (const meta of metas) registry.remember(meta);
  const blobUrls = harness.createdObjectUrls.map((entry) => entry.blobUrl);
  assert.equal(blobUrls.length, 4);
  for (const [index, [fileId, caption]] of BATCH_FILES.entries()) {
    const blobUrl = blobUrls[index];
    const wanted = lookup.imageLookupKeys(blobUrl);
    assert.ok(wanted.includes(`asset:${fileId}`), `blob ${index} must carry its own file id key`);
    const outcome = resolveBoundPromptForBlob(lookup, registry, metas, blobUrl);
    assert.equal(outcome.prompt, caption, `image ${index} must get its own caption by file id, not by position`);
    assert.ok(!outcome.prompt.includes("Generated images from the last"), "the tool status sentence is never a caption");
  }
});

test("the same gallery without blob-asset mappings still fails closed on prompts", async () => {
  const harness = createHookHarness({});
  const lookup = loadContentLookupWithBlobAssets();
  const registry = createGenerationRegistryHarness({ imageLookupKeys: lookup.imageLookupKeys });
  await feedBatchGalleryTurn(harness);
  const metas = batchGenerationMetas(harness);
  for (const meta of metas) registry.remember(meta);
  for (const [index, [fileId]] of BATCH_FILES.entries()) {
    const blobUrl = `blob:https://chatgpt.com/unmapped-${index}-test`;
    const wanted = lookup.imageLookupKeys(blobUrl);
    assert.equal(wanted.some((key) => key === `asset:${fileId}`), false, "no file id key without the mapping");
    assert.ok(!registry.resolvedForImage(blobUrl)?.prompt, "the registry must not hand out any prompt");
    const bound = metas.find((meta) => meta.prompt && lookup.imageLookupKeys(meta.imageUrl || "", meta).some((key) => wanted.includes(key)));
    assert.equal(bound, undefined, "no caption may bind to an unmapped blob");
  }
});

test("batch_requests with 4 entries leaves the request prompt empty instead of guessing", async () => {
  const harness = createHookHarness({});
  await feedBatchGalleryTurn(harness);
  const metas = batchGenerationMetas(harness);
  assert.ok(metas.length >= 8, "tool captions and final-message asset events should be emitted");
  for (const meta of metas) {
    assert.equal(meta.generationRequestPrompt || "", "", "no per-image request prompt may be assigned in a batch turn");
    for (const requestPrompt of BATCH_REQUEST_PROMPTS) {
      assert.notEqual(meta.prompt || "", requestPrompt, "no image may receive a sibling request prompt");
    }
    assert.ok(!(meta.prompt || "").includes("batch_requests"), "the raw batch JSON must never become a prompt");
  }
  const captions = metas.filter((meta) => meta.prompt).map((meta) => meta.prompt);
  // The captions may surface on the tool messages and, adopted by image id,
  // on the final gallery message — but never any text beyond those four.
  assert.deepEqual(new Set(captions).size, 4, "exactly the four tool captions survive as prompts");
  for (const caption of captions) {
    assert.ok(BATCH_FILES.some(([, known]) => known === caption), "no caption beyond the four tool captions may appear");
  }
});

test("content-side blob-asset validation drops cross-origin urls and malformed ids", () => {
  const lookup = loadContentLookupWithBlobAssets();
  assert.equal(lookup.rememberBlobAsset({ blobUrl: "blob:https://evil.example/mosa-1", assetId: "file-qae2e000001" }), null, "cross-origin blob is dropped");
  assert.equal(lookup.rememberBlobAsset({ blobUrl: "blob:https://chatgpt.com/mosa-2", assetId: "sediment://file-qae2e000002" }), null, "pointer-shaped id is dropped");
  assert.equal(lookup.rememberBlobAsset({ blobUrl: "https://chatgpt.com/backend-api/estuary/content?id=file-qae2e000003", assetId: "file-qae2e000003" }), null, "non-blob url is dropped");
  const ok = lookup.rememberBlobAsset({ blobUrl: "blob:https://chatgpt.com/mosa-4", assetId: "file-qae2e000004" });
  assert.equal(ok?.blobUrl, "blob:https://chatgpt.com/mosa-4");
  assert.equal(ok?.assetId, "file-qae2e000004");
  assert.ok(lookup.imageLookupKeys("blob:https://chatgpt.com/mosa-4").includes("asset:file-qae2e000004"));
  assert.equal(lookup.imageLookupKeys("blob:https://evil.example/mosa-1").some((key) => key.startsWith("asset:")), false);
  // The table is bounded and drops the oldest entries first.
  for (let index = 0; index < 400; index += 1) {
    lookup.rememberBlobAsset({ blobUrl: `blob:https://chatgpt.com/overflow-${index}`, assetId: "file-qae2e000004" });
  }
  assert.equal(lookup.blobAssetIds.size, 400);
  assert.equal(lookup.blobAssetIds.has("blob:https://chatgpt.com/mosa-4"), false);
});

// Proven gallery blob auto-capture: a multi-image gallery thumbnail that was
// never clicked must still be archived. Drives the real enqueue → ingest
// pipeline in a vm with a fake DOM, the real registry, and stubbed page APIs.

const GALLERY_FILE_ID = "file-qae2e000001";
const GALLERY_BLOB_URL = "blob:https://chatgpt.com/gallery-thumb-test";
const GALLERY_CAPTION = "Model caption: 未点开缩略图的提示词，柔软形态与织物质感实验。";

function galleryGenerationEvidence() {
  return {
    assetId: GALLERY_FILE_ID,
    prompt: GALLERY_CAPTION,
    promptStatus: "visible-caption",
    promptPriority: 425,
    promptScope: "output",
    conversationId: "conversation-test",
    messageId: "output-message",
    generationStatus: "completed",
    isGeneration: true,
  };
}

function currentChatGptAutoCaptureHarness() {
  const constants = [
    "BLOCK_URL_HINTS", "GENERATION_HOST_HINTS", "MIN_EDGE", "MIN_BYTES", "PROVEN_GENERATION_MIN_EDGE",
    "COMPOSER_SELECTOR", "CHATGPT_TURN_SELECTOR", "CHATGPT_USER_SELECTOR", "CHATGPT_MESSAGE_SELECTOR", "STYLE_HINTS",
    "MAX_BLOB_ASSETS", "SESSION_CACHE_MAX", "SIZE_FAILURE_LIMIT", "SIZE_FAILURE_BACKOFF_MS",
    "AUTO_STABILITY_DELAY_MS", "AUTO_IN_PROGRESS_STALE_MS", "AUTO_PARTIAL_FALLBACK_MS", "DOM_MEDIA_GRACE_MS",
    "SESSION_TITLE_MAX_LENGTH", "SESSION_TITLE_PLACEHOLDERS",
  ].map((name) => new RegExp(`const ${name} = [^;]+;`).exec(contentSource)?.[0]);
  assert.ok(constants.every(Boolean), "auto-capture constants should be extractable from content.js");

  const names = [
    "rememberSet", "rememberMap", "rememberCandidate",
    "isBlockedUrl", "chatGptImageProxyInfo", "normalizeAssetId", "isTrustedBlobAssetUrl", "normalizeBlobAssetId",
    "rememberBlobAsset", "blobAssetIdForUrl", "imageLookupKeys", "isLikelyGeneratedUrl",
    "conversationIdFromUrl", "currentConversationId",
    "normalizeConversationTitle", "conversationTitleFromSidebar", "currentConversationTitle", "sessionTitleForConversation",
    "hasGeneratedImageDomMarker", "isComposerNode", "conversationTurnForNode", "turnContainsRole", "nearestPrecedingUserScope",
    "isReferenceCandidate", "isRecoverableGenerationCandidate", "looksLikeGeneratedImage",
    "isProvenGalleryBlobUrl", "isProvenGalleryBlobImage", "collectDomCandidates", "domCandidateForImage", "enqueueDomCandidateForImage",
    "findBoundPromptForImage", "findGenerationEvidenceForImage", "findGenerationEvidenceForCandidate", "hasObservedGenerationEvidence",
    "candidateLookupKeys", "candidateOperationKey", "candidateSizeSignature", "renderedPixelSignature",
    "markSizeFailure", "isSizeFailureBlocked", "normalizeGenerationStatus", "isTerminalGenerationStatus",
    "isSavedCandidate", "rememberSavedCandidate", "savedGenerationStatusForCandidate", "rememberSavedPrompt",
    "clearAutoStability", "scheduleAutoStabilityRetry", "autoCandidateReadiness",
    "isArchiveWorthyCandidate", "canAttempt", "enqueueAuto", "ingestCandidate", "findCandidateForMeta", "resolvePrompt",
    "bytesFromUrlOrImg", "waitForRenderedCandidate", "renderedCandidateFor", "originalBytesFromUrl", "canvasBytesFromImage",
    "arrayBufferToBase64", "decodedImageDimensions",
    "userMessageForCandidate", "messageScopeForCandidate", "domCaptionForCandidate", "messageIdsForCandidate", "messageIdForCandidate",
    "buildStoredPrompt", "cleanPromptText", "extractPlaceHints", "promptMentionsPlace", "looksLikeGenerationCaption", "isWeakChatPrompt",
    "scorePromptText", "promptQuality", "metaPromptQuality",
  ];
  const source = names.map((name) => {
    const match = new RegExp(`\\n {2}(?:async )?function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(contentSource);
    assert.ok(match, `missing ${name}`);
    return match[0];
  }).join("\n");

  // Blob bytes big enough to pass the 20KB MIN_BYTES floor; the decoded pixel
  // size is what the tests control through context.decodedSize.
  class FakeBlob {
    constructor(parts = [], opts = {}) { this.type = opts?.type || ""; }
    async arrayBuffer() { return new Uint8Array(30_000).fill(7).buffer; }
  }
  const userNode = {
    innerText: "Make the lettering blue and keep the background red.",
    matches: () => false,
    closest: () => null,
    compareDocumentPosition: () => 4,
  };
  const composerScope = { matches: () => true, querySelector: () => null };
  const messageNode = { getAttribute: () => "output-message" };
  class GalleryImage {
    constructor({ src, complete = false, naturalWidth = 0, naturalHeight = 0, width = 54, height = 54, scope = null } = {}) {
      this.src = src;
      this.currentSrc = src;
      this.complete = complete;
      this.naturalWidth = naturalWidth;
      this.naturalHeight = naturalHeight;
      this.width = width;
      this.height = height;
      this.__scope = scope; // "composer" | "user" | null
    }

    closest(selector) {
      const s = String(selector || "");
      if (s.includes("data-chatgpt-search-message-ids")) return messageNode;
      if (this.__scope === "composer" && s.includes("unified-composer")) return composerScope;
      if (this.__scope === "user" && s.includes('data-message-author-role="user"')) return userNode;
      return null;
    }

    getAttribute() { return ""; }
  }

  const context = {
    HTMLImageElement: GalleryImage, Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    URL, Date, JSON, Math, Set, Map, String, Promise, Uint8Array, ArrayBuffer, Error,
    btoa: globalThis.btoa, atob: globalThis.atob,
    location: { href: "https://chatgpt.com/c/conversation-test", origin: "https://chatgpt.com", pathname: "/c/conversation-test" },
    blobAssetIds: new Map(), networkMeta: [],
    inFlight: new Set(), queuedAutoKeys: new Set(), savedKeys: new Set(), savedIdentityKeys: new Set(),
    capturedCandidates: new Map(), savedPromptRanks: new Map(), referenceSyncKeys: new Set(),
    failedNetworkIdentityKeys: new Set(), promptUpgradeInFlight: new Set(),
    failedAt: new Map(), sizeFailureStates: new Map(),
    autoStabilityStates: new Map(), autoStabilityTimers: new Map(), savedGenerationStatuses: new Map(),
    conversationEpoch: 0, activeConversationId: "conversation-test", autoCapture: true,
    generationRegistry: null,
    images: [], fetchCalls: [], ingestMessages: [], statusTexts: [], toasts: [], scheduledTimers: [],
    Blob: FakeBlob,
    fetch: async (url) => {
      context.fetchCalls.push(String(url));
      return { ok: true, blob: async () => new FakeBlob([], { type: "image/png" }) };
    },
    runtimeSend: async (message) => {
      context.ingestMessages.push(message);
      return { ok: true, result: { status: "imported" } };
    },
    showToast: (message) => { context.toasts.push(message); },
    setStatus: (text) => { context.statusTexts.push(text); },
    scheduleScan: () => {},
    scheduleGenerationEvidenceRecovery: () => {},
    schedulePromptUpgrade: () => {},
    schedulePromptRecovery: () => {},
    clearPromptRecovery: () => {},
    requestCurrentConversationRefresh: () => false,
    stageGenerationReferences: async () => ({ generationContextId: "", stagedReferences: 0 }),
    withAutoCaptureSlot: async (task) => task(),
    setTimeout: (fn, ms) => { context.scheduledTimers.push({ fn, ms }); return 0; },
    clearTimeout: () => {},
    document: {
      querySelector: () => null,
      querySelectorAll: (selector) => (String(selector).includes('data-content-search-unit-key$=":user"')
        ? [userNode]
        : (String(selector) === "img" ? context.images : [])),
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    },
    decodedSize: { width: 1024, height: 1024 },
    createImageBitmapCalls: [],
    closedBitmaps: 0,
    createImageBitmap: async (blob) => {
      context.createImageBitmapCalls.push(blob);
      return { width: context.decodedSize.width, height: context.decodedSize.height, close: () => { context.closedBitmaps += 1; } };
    },
  };
  vm.runInNewContext(`${constants.join("\n")}\n${source}`, context, { filename: "content-auto-capture.js" });
  const registry = createGenerationRegistryHarness({ imageLookupKeys: context.imageLookupKeys });
  context.generationRegistryForPage = () => registry;
  return { context, registry, userNode, GalleryImage };
}

async function flushAutoCapture(times = 10) {
  for (let index = 0; index < times; index += 1) await setImmediate();
}

test("an unclicked proven gallery thumbnail is archived from its blob bytes without loading the img", async () => {
  const { context, registry, userNode } = currentChatGptAutoCaptureHarness();
  assert.equal(context.rememberBlobAsset({ blobUrl: GALLERY_BLOB_URL, assetId: GALLERY_FILE_ID })?.assetId, GALLERY_FILE_ID);
  registry.remember(galleryGenerationEvidence());
  // naturalWidth 0 / complete false: the lazy thumbnail never decoded; 54px is only its display size.
  context.images.push(new context.HTMLImageElement({ src: GALLERY_BLOB_URL }));

  const candidates = context.collectDomCandidates();
  assert.equal(candidates.length, 1, "the unloaded proven thumbnail is collected");
  assert.equal(candidates[0].width, 0, "the unknown size stays unknown instead of the 54px display size");

  assert.equal(context.enqueueDomCandidateForImage(GALLERY_BLOB_URL, "blob-asset"), true, "the blob-asset trigger finds the thumbnail");
  await flushAutoCapture();

  assert.equal(context.ingestMessages.length, 1, "exactly one mosa.ingest is sent");
  const payload = context.ingestMessages[0].payload;
  assert.equal(payload.imageUrl, GALLERY_BLOB_URL);
  assert.equal(payload.prompt, GALLERY_CAPTION, "the caption bound to this file id is kept");
  assert.equal(payload.userMessage, userNode.innerText, "the user's own message still travels the existing path");
  assert.ok(payload.imageBase64.length > 0);
  assert.deepEqual(context.fetchCalls, [GALLERY_BLOB_URL], "bytes come from the page-local blob: URL");
  assert.equal(context.createImageBitmapCalls.length, 1, "the real size is decoded from the bytes");
  assert.equal(context.closedBitmaps, 1, "the decoded bitmap is released");
  assert.equal(context.scheduledTimers.length, 0, "archiving does not wait for the img to render");
});

test("a gallery thumbnail without a mapping or without generation evidence stays filtered", async () => {
  // Generation evidence present, blob mapping missing.
  const withoutMapping = currentChatGptAutoCaptureHarness();
  withoutMapping.registry.remember(galleryGenerationEvidence());
  withoutMapping.context.images.push(new withoutMapping.context.HTMLImageElement({ src: GALLERY_BLOB_URL }));
  assert.equal(withoutMapping.context.collectDomCandidates().length, 0, "no mapping means no proven gallery blob");

  // Blob mapping present, generation evidence missing, still unloaded.
  const withoutEvidence = currentChatGptAutoCaptureHarness();
  withoutEvidence.context.rememberBlobAsset({ blobUrl: GALLERY_BLOB_URL, assetId: GALLERY_FILE_ID });
  const thumb = new withoutEvidence.context.HTMLImageElement({ src: GALLERY_BLOB_URL });
  withoutEvidence.context.images.push(thumb);
  assert.equal(withoutEvidence.context.isProvenGalleryBlobImage(thumb), false);
  assert.equal(withoutEvidence.context.collectDomCandidates().length, 0, "a mapped blob without generation evidence stays filtered");
  assert.equal(withoutEvidence.context.enqueueDomCandidateForImage(GALLERY_BLOB_URL, "blob-asset"), false);
  await flushAutoCapture();
  assert.equal(withoutEvidence.context.ingestMessages.length, 0);

  // A loaded large mapped blob without evidence keeps today's behavior:
  // collected by size, then rejected at enqueue time for missing evidence.
  const loadedWithoutEvidence = currentChatGptAutoCaptureHarness();
  loadedWithoutEvidence.context.rememberBlobAsset({ blobUrl: GALLERY_BLOB_URL, assetId: GALLERY_FILE_ID });
  loadedWithoutEvidence.context.images.push(new loadedWithoutEvidence.context.HTMLImageElement({
    src: GALLERY_BLOB_URL, complete: true, naturalWidth: 1024, naturalHeight: 1024, width: 680, height: 680,
  }));
  const candidates = loadedWithoutEvidence.context.collectDomCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].width, 1024);
  loadedWithoutEvidence.context.enqueueAuto(candidates[0], "dom-scan");
  await flushAutoCapture();
  assert.equal(loadedWithoutEvidence.context.ingestMessages.length, 0, "no evidence means no auto archive");
});

test("a proven gallery blob whose decoded size is below the proven floor is not archived", async () => {
  const { context, registry } = currentChatGptAutoCaptureHarness();
  context.rememberBlobAsset({ blobUrl: GALLERY_BLOB_URL, assetId: GALLERY_FILE_ID });
  registry.remember(galleryGenerationEvidence());
  context.images.push(new context.HTMLImageElement({ src: GALLERY_BLOB_URL }));
  context.decodedSize = { width: 200, height: 200 };

  context.enqueueDomCandidateForImage(GALLERY_BLOB_URL, "blob-asset");
  await flushAutoCapture();

  assert.equal(context.createImageBitmapCalls.length, 1, "the bytes were decoded");
  assert.equal(context.ingestMessages.length, 0, "a 200px decoded proven blob stays out");
  assert.ok(context.sizeFailureStates.get(`asset:${GALLERY_FILE_ID}`), "the small proven blob is recorded as a size failure");
});

test("the displayed gallery image and its thumbnail share one blob identity and archive once", async () => {
  const { context, registry } = currentChatGptAutoCaptureHarness();
  context.rememberBlobAsset({ blobUrl: GALLERY_BLOB_URL, assetId: GALLERY_FILE_ID });
  registry.remember(galleryGenerationEvidence());
  // The page shows the large image and the 54px thumbnail of the SAME blob URL.
  context.images.push(new context.HTMLImageElement({ src: GALLERY_BLOB_URL }));
  context.images.push(new context.HTMLImageElement({
    src: GALLERY_BLOB_URL, complete: true, naturalWidth: 1024, naturalHeight: 1024, width: 680, height: 680,
  }));

  const candidates = context.collectDomCandidates();
  assert.equal(candidates.length, 1, "one blob: URL is one candidate no matter how many <img> show it");

  context.enqueueAuto(candidates[0], "dom-scan");
  await flushAutoCapture();
  assert.equal(context.ingestMessages.length, 1);

  // A later trigger for the other <img> must not archive a second time.
  assert.equal(context.enqueueDomCandidateForImage(GALLERY_BLOB_URL, "blob-asset"), true);
  await flushAutoCapture();
  assert.equal(context.ingestMessages.length, 1, "the shared asset identity dedupes the second <img>");
});

test("composer and reference images with a valid blob mapping are never archived", async () => {
  const { context, registry } = currentChatGptAutoCaptureHarness();
  context.rememberBlobAsset({ blobUrl: GALLERY_BLOB_URL, assetId: GALLERY_FILE_ID });
  registry.remember(galleryGenerationEvidence());
  const composerImage = new context.HTMLImageElement({
    src: GALLERY_BLOB_URL, complete: true, naturalWidth: 1024, naturalHeight: 1024, width: 680, height: 680, scope: "composer",
  });
  const referenceImage = new context.HTMLImageElement({
    src: GALLERY_BLOB_URL, complete: true, naturalWidth: 1024, naturalHeight: 1024, width: 680, height: 680, scope: "user",
  });
  context.images.push(composerImage, referenceImage);

  assert.equal(context.isProvenGalleryBlobImage(composerImage), false, "composer images are never proven gallery blobs");
  assert.equal(context.isProvenGalleryBlobImage(referenceImage), false, "reference images are never proven gallery blobs");

  const candidates = context.collectDomCandidates();
  assert.equal(candidates.some((candidate) => candidate.el === composerImage), false, "composer images are not collected");

  // A large user-turn reference still reaches the candidate list by size, but
  // the auto path refuses it like any other reference.
  const reference = candidates.find((candidate) => candidate.el === referenceImage);
  assert.ok(reference, "size-based collection is unchanged for references");
  context.enqueueAuto(reference, "dom-scan");
  await flushAutoCapture();
  assert.equal(context.ingestMessages.length, 0, "references with a mapping are not archived");
});

test("generation evidence arriving after the blob mapping still picks up the unclicked thumbnail", async () => {
  const { context, registry } = currentChatGptAutoCaptureHarness();
  context.rememberBlobAsset({ blobUrl: GALLERY_BLOB_URL, assetId: GALLERY_FILE_ID });
  context.images.push(new context.HTMLImageElement({ src: GALLERY_BLOB_URL }));

  // The mapping arrives first; nothing is proven yet.
  assert.equal(context.collectDomCandidates().length, 0);

  // The live stream later binds the caption to this file id.
  const meta = galleryGenerationEvidence();
  registry.remember(meta);
  const candidate = context.findCandidateForMeta(context.imageLookupKeys(meta.imageUrl || "", meta));
  assert.ok(candidate, "the metadata trigger finds the unloaded thumbnail");
  context.enqueueAuto(candidate, "metadata-recovered");
  await flushAutoCapture();
  assert.equal(context.ingestMessages.length, 1);
  assert.equal(context.ingestMessages[0].payload.prompt, GALLERY_CAPTION);
});

// ChatGPT image-to-image reference capture (0.15.23): one user message now
// arrives as sibling units (attachments first, then text) inside a turn-key
// container that also holds the generated gallery. Reference lookup must span
// every user unit of that message without ever leaving them — the gallery in
// the assistant unit shares the container.

function referenceScopeHarness() {
  const constants = ["COMPOSER_SELECTOR", "CHATGPT_TURN_SELECTOR", "CHATGPT_USER_SELECTOR", "CHATGPT_MESSAGE_SELECTOR"]
    .map((name) => new RegExp(`const ${name} = [^;]+;`).exec(contentSource)?.[0]);
  assert.ok(constants.every(Boolean), "reference scope constants should be extractable");
  const names = [
    "hasGeneratedImageDomMarker", "isComposerNode", "conversationTurnForNode", "turnContainsRole",
    "nearestPrecedingUserScope", "userUnitKeyPrefix", "userUnitsOfSameMessage", "isReferenceCandidate",
    "referenceCandidatesForGeneration",
  ];
  const source = names.map((name) => {
    const match = new RegExp(`\\n {2}(?:async )?function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(contentSource);
    assert.ok(match, `missing ${name}`);
    return match[0];
  }).join("\n");

  let order = 0;
  class FakeNode {
    constructor(tagName, attributes = {}) {
      this.tagName = tagName;
      this.attributes = attributes;
      this.children = [];
      this.parent = null;
      this.order = order += 1;
    }

    append(child) { child.parent = this; this.children.push(child); return child; }

    getAttribute(name) { return this.attributes[name] ?? null; }

    matches(selector) {
      return String(selector).split(",").map((part) => part.trim()).some((part) => {
        if (!part.startsWith("[")) return this.tagName === part.toLowerCase();
        const match = /^\[([^\]~^$*|=]+)(?:([~^$*|]?=)"([^"]*)")?\]$/.exec(part);
        if (!match) return false;
        const actual = this.getAttribute(match[1]);
        if (actual == null) return false;
        if (!match[2]) return true;
        if (match[2] === "=") return actual === match[3];
        if (match[2] === "^=") return actual.startsWith(match[3]);
        if (match[2] === "$=") return actual.endsWith(match[3]);
        return false;
      });
    }

    closest(selector) {
      for (let node = this; node; node = node.parent) {
        if (node.matches(selector)) return node;
      }
      return null;
    }

    querySelectorAll(selector) {
      const found = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.matches(selector)) found.push(child);
          walk(child);
        }
      };
      walk(this);
      return found;
    }

    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

    compareDocumentPosition(node) { return node.order > this.order ? 4 : 2; }
  }
  class FakeImage extends FakeNode {
    constructor({ src = "", alt = "", label = "", naturalWidth = 0, naturalHeight = 0, width = 0, height = 0 } = {}) {
      super("img", { ...(alt ? { alt } : {}), ...(label ? { "aria-label": label } : {}) });
      this.src = src;
      this.currentSrc = src;
      this.naturalWidth = naturalWidth;
      this.naturalHeight = naturalHeight;
      this.width = width;
      this.height = height;
    }
  }

  const root = new FakeNode("#document");
  const context = {
    HTMLImageElement: FakeImage,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    document: { querySelectorAll: (selector) => root.querySelectorAll(selector) },
  };
  vm.runInNewContext(`${constants.join("\n")}\n${source}`, context, { filename: "content-reference-scope.js" });

  // The 2026-09 turn layout: an attachment unit (chatgpt-search unit key), a
  // text unit (content-search unit key), then the assistant unit holding the
  // generated gallery — all inside one shared turn-key container.
  const buildTurn = (index, { attachmentCount = 2, attachmentOutsideSearchTurn = false } = {}) => {
    const turn = root.append(new FakeNode("div", { "data-turn-key": `turn-key-${index}` }));
    const appendSearchTurn = () => turn.append(new FakeNode("div", { "data-content-search-turn-key": `fallback-turn-${index}` }));
    let searchTurn = attachmentOutsideSearchTurn ? null : appendSearchTurn();
    const attachments = [];
    let attachmentUnit = null;
    if (attachmentCount > 0) {
      attachmentUnit = (searchTurn || turn).append(new FakeNode("div", {
        "data-chatgpt-search-unit-key": `fallback-turn-${index}:0:user`,
        "data-chatgpt-search-message-ids": `user-message-${index}`,
      }));
      for (let nth = 0; nth < attachmentCount; nth += 1) {
        attachments.push(attachmentUnit.append(new FakeImage({
          src: `blob:https://chatgpt.com/reference-${index}-${nth}`,
          label: "用户附件",
          naturalWidth: 2048, naturalHeight: 1143, width: 78, height: 44,
        })));
      }
    }
    searchTurn ||= appendSearchTurn();
    searchTurn.append(new FakeNode("div", { "data-content-search-unit-key": `fallback-turn-${index}:0:user` }));
    const assistantUnit = searchTurn.append(new FakeNode("div", { "data-chatgpt-search-unit-key": `fallback-turn-${index}:1:assistant` }));
    const gallery = assistantUnit.append(new FakeNode("div", {
      "data-testid": "generated-image-gallery",
      "data-chatgpt-search-message-ids": `output-message-${index}`,
    }));
    const generated = gallery.append(new FakeImage({
      src: `blob:https://chatgpt.com/generated-${index}`,
      alt: "Generated image 1",
      naturalWidth: 1024, naturalHeight: 1024, width: 680, height: 680,
    }));
    return { attachmentUnit, attachments, generated, candidate: { el: generated, imageUrl: generated.src } };
  };

  return { context, root, FakeImage, FakeNode, buildTurn };
}

test("the user selector recognizes the split attachment unit alongside the legacy scopes", () => {
  assert.match(contentSource, /const CHATGPT_USER_SELECTOR = '\[data-message-author-role="user"\], \[data-content-search-unit-key\$=":user"\], \[data-chatgpt-search-unit-key\$=":user"\]'/);
  assert.match(contentSource, /for \(const unit of userUnitsOfSameMessage\(nearestUser, image\)\)/);
});

test("reference lookup spans the split attachment and text units of one user message", () => {
  const { context, buildTurn } = referenceScopeHarness();
  const turn = buildTurn(1);
  const references = context.referenceCandidatesForGeneration(turn.candidate);
  assert.deepEqual([...references.map((reference) => reference.el)], turn.attachments, "exactly the two uploaded attachments");
  assert.deepEqual([...references.map((reference) => reference.key)], [
    "blob:https://chatgpt.com/reference-1-0",
    "blob:https://chatgpt.com/reference-1-1",
  ]);
  assert.equal(references[0].width, 2048, "the natural upload size is kept");
});

test("reference lookup reaches an attachment unit that sits beside the inner content-search turn", () => {
  const { context, buildTurn } = referenceScopeHarness();
  buildTurn(1, { attachmentOutsideSearchTurn: true });
  const turn = buildTurn(2, { attachmentOutsideSearchTurn: true });
  const references = context.referenceCandidatesForGeneration(turn.candidate);
  assert.deepEqual([...references.map((reference) => reference.el)], turn.attachments, "the outer turn-key wrapper bounds the message");
});

test("attachment unit images are reference candidates while gallery images never are", () => {
  const { context, buildTurn } = referenceScopeHarness();
  const turn = buildTurn(1);
  for (const image of turn.attachments) {
    assert.equal(context.isReferenceCandidate({ el: image }), true, `attachment ${image.src} is a reference`);
  }
  assert.equal(context.isReferenceCandidate({ el: turn.generated }), false, "the generated gallery image is not a reference");
});

test("a generation only inherits the attachments of its own user message", () => {
  const { context, buildTurn } = referenceScopeHarness();
  buildTurn(1);
  const second = buildTurn(2);
  const references = context.referenceCandidatesForGeneration(second.candidate);
  assert.deepEqual([...references.map((reference) => reference.el)], second.attachments, "turn one's attachments stay out");
});

test("a text-only user message yields no reference candidates", () => {
  const { context, buildTurn } = referenceScopeHarness();
  const turn = buildTurn(1, { attachmentCount: 0 });
  assert.deepEqual([...context.referenceCandidatesForGeneration(turn.candidate)], []);
});

test("user units without a shared turn container merge by their unit-key prefix", () => {
  const { context, root, FakeImage, FakeNode } = referenceScopeHarness();
  // An earlier message's units also precede the generated image, so only the
  // shared "fallback-turn-9" prefix may merge them into one scope.
  const earlierAttachmentUnit = root.append(new FakeNode("div", { "data-chatgpt-search-unit-key": "fallback-turn-10:0:user" }));
  earlierAttachmentUnit.append(new FakeImage({ src: "blob:https://chatgpt.com/earlier-reference", label: "用户附件", naturalWidth: 2048, naturalHeight: 1143 }));
  root.append(new FakeNode("div", { "data-content-search-unit-key": "fallback-turn-10:0:user" }));
  const attachmentUnit = root.append(new FakeNode("div", { "data-chatgpt-search-unit-key": "fallback-turn-9:0:user" }));
  const reference = attachmentUnit.append(new FakeImage({ src: "blob:https://chatgpt.com/reference-9", label: "用户附件", naturalWidth: 2048, naturalHeight: 1143 }));
  root.append(new FakeNode("div", { "data-content-search-unit-key": "fallback-turn-9:0:user" }));
  const assistantUnit = root.append(new FakeNode("div", { "data-chatgpt-search-unit-key": "fallback-turn-9:1:assistant" }));
  const generated = assistantUnit.append(new FakeImage({ src: "blob:https://chatgpt.com/generated-9", alt: "Generated image 1", naturalWidth: 1024, naturalHeight: 1024 }));
  const references = context.referenceCandidatesForGeneration({ el: generated, imageUrl: generated.src });
  assert.deepEqual([...references.map((item) => item.el)], [reference]);
});

test("attachments still sitting in the composer are never staged as references", () => {
  const { context, root, FakeImage, FakeNode, buildTurn } = referenceScopeHarness();
  const composer = root.append(new FakeNode("form", { "data-type": "unified-composer" }));
  const draft = composer.append(new FakeImage({ src: "blob:https://chatgpt.com/composer-draft", label: "用户附件", naturalWidth: 2048, naturalHeight: 1143 }));
  const turn = buildTurn(1);
  // A draft parked in a composer frame inside the sent attachment unit must
  // hit the same skip.
  const inlineComposer = turn.attachmentUnit.append(new FakeNode("form", { "data-type": "unified-composer" }));
  const inlineDraft = inlineComposer.append(new FakeImage({ src: "blob:https://chatgpt.com/composer-draft-2", label: "用户附件", naturalWidth: 2048, naturalHeight: 1143 }));
  assert.equal(context.isComposerNode(draft), true);
  assert.equal(context.isComposerNode(inlineDraft), true);
  const references = context.referenceCandidatesForGeneration(turn.candidate);
  assert.deepEqual([...references.map((reference) => reference.el)], turn.attachments);
  assert.equal(references.some((reference) => reference.el === draft || reference.el === inlineDraft), false);
});

test("the legacy conversation-turn structure keeps staging references from the user turn", () => {
  const { context, root, FakeImage, FakeNode } = referenceScopeHarness();
  const userTurn = root.append(new FakeNode("div", { "data-testid": "conversation-turn-1" }));
  const roleUnit = userTurn.append(new FakeNode("div", { "data-message-author-role": "user" }));
  const legacyReferences = [
    roleUnit.append(new FakeImage({ src: "blob:https://chatgpt.com/legacy-reference-1", naturalWidth: 2048, naturalHeight: 1143 })),
    roleUnit.append(new FakeImage({ src: "blob:https://chatgpt.com/legacy-reference-2", naturalWidth: 2048, naturalHeight: 1143 })),
  ];
  const assistantTurn = root.append(new FakeNode("div", { "data-testid": "conversation-turn-2" }));
  const generated = assistantTurn.append(new FakeImage({
    src: "https://chatgpt.com/backend-api/files/generated-legacy", alt: "Generated image 1",
    naturalWidth: 1024, naturalHeight: 1024, width: 680, height: 680,
  }));
  const references = context.referenceCandidatesForGeneration({ el: generated, imageUrl: generated.src });
  assert.deepEqual([...references.map((reference) => reference.el)], legacyReferences);
  assert.equal(context.isReferenceCandidate({ el: legacyReferences[0] }), true);
  assert.equal(context.isReferenceCandidate({ el: generated }), false);
});

// --- ChatGPT conversation session title for stack naming (0.15.24) ---

function sessionTitleHarness({ title = "", sidebarTitle = "", pathname = "/c/conv-1" } = {}) {
  const pieces = [
    /const SESSION_TITLE_MAX_LENGTH = [^\n]*/.exec(contentSource)?.[0],
    /const SESSION_TITLE_PLACEHOLDERS = new Set\([^\n]*/.exec(contentSource)?.[0],
    ...["conversationIdFromUrl", "normalizeConversationTitle", "conversationTitleFromSidebar", "currentConversationTitle", "sessionTitleForConversation"]
      .map((name) => new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(contentSource)?.[0]),
  ].filter(Boolean).join("\n");
  const context = {
    document: { title, querySelector: () => ({ textContent: sidebarTitle }) },
    location: { pathname, href: `https://chatgpt.com${pathname}` },
  };
  vm.runInNewContext(
    `${pieces}\nthis.normalize = normalizeConversationTitle; this.current = currentConversationTitle; this.forConversation = sessionTitleForConversation;`,
    context,
    { filename: "chatgpt-session-title.js" },
  );
  return context;
}

test("conversation titles strip the site suffix, trim, and keep the 200-char cap", () => {
  const context = sessionTitleHarness({ title: "Bangkok Travel Poster - ChatGPT", pathname: "/c/conv-title" });
  assert.equal(context.normalize("Bangkok Travel Poster - ChatGPT"), "Bangkok Travel Poster");
  assert.equal(context.normalize("Skyline Edit | ChatGPT"), "Skyline Edit");
  assert.equal(context.normalize("  Padded Title  "), "Padded Title");
  assert.equal(context.normalize("x".repeat(250)).length, 200);
  assert.equal(context.current(), "Bangkok Travel Poster", "document.title is the first source");
});

test("placeholder titles count as no title, and the sidebar entry is the fallback", () => {
  const context = sessionTitleHarness({ title: "New chat", sidebarTitle: "Sidebar Named Chat" });
  for (const placeholder of ["ChatGPT", "new chat", "新聊天", "新对话", "   ", ""]) {
    assert.equal(context.normalize(placeholder), "", JSON.stringify(placeholder));
  }
  assert.equal(context.current(), "Sidebar Named Chat", "a placeholder document.title falls through to the sidebar entry");
});

test("a session title only rides with captures of the conversation open in the URL", () => {
  const context = sessionTitleHarness({ title: "Matched Chat", pathname: "/c/conv-1" });
  assert.equal(context.forConversation("conv-1"), "Matched Chat");
  assert.equal(context.forConversation("conv-other"), "", "a different conversation id carries no title");
  assert.equal(context.forConversation(""), "", "no conversation id, no title");
});

test("the ingest payload and server request carry the session title", () => {
  assert.match(
    contentSource,
    /conversationId: resolved\.conversationId \|\| currentConversationId\(\),\n {10}generationSessionTitle: sessionTitleForConversation\(resolved\.conversationId \|\| currentConversationId\(\)\),/,
  );
  assert.match(contentSource, /type: "mosa\.reportSessionTitle",/);
  assert.match(contentSource, /titleObserver\.observe\(title, \{ childList: true, characterData: true, subtree: true \}\)/);
  assert.match(backgroundSource, /if \(message\.type === "mosa\.reportSessionTitle"\) return context\.provider === "chatgpt";/);
  assert.match(backgroundSource, /generation_session_title: String\(payload\.generationSessionTitle \|\| payload\.generation_session_title \|\| ""\)\.trim\(\)\.slice\(0, 200\),/);
});

function sessionTitleReportHarness(fetchBehavior) {
  const requests = [];
  const pieces = [
    "const reportedSessionTitles = new Set();",
    /async function reportSessionTitleOnce\([\s\S]*?\n}\n/.exec(backgroundSource)?.[0],
    /function normalizeBaseUrl\([\s\S]*?\n}\n/.exec(backgroundSource)?.[0],
  ].filter(Boolean).join("\n");
  const context = {
    URL,
    DEFAULTS: { mosaBaseUrl: "http://127.0.0.1:43517" },
    getSettings: async () => ({ mosaBaseUrl: "", mosaToken: "token-test" }),
    fetchWithTimeout: async (url, init) => fetchBehavior(requests, url, JSON.parse(init.body)),
  };
  vm.runInNewContext(`${pieces}\nthis.report = reportSessionTitleOnce;`, context, { filename: "background-session-title.js" });
  return { context, requests };
}

test("the same conversation and title is reported to MOSA only once per session", async () => {
  const { context, requests } = sessionTitleReportHarness((tracked, url, body) => {
    tracked.push({ url, body });
    return { ok: true, status: 200 };
  });

  const first = await context.report({ conversationId: "conv-1", title: "Named" });
  assert.equal(first.reported, true);
  assert.equal(first.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:43517/api/ingest/web-capture-session-title");
  assert.deepEqual(requests[0].body, { provider: "chatgpt", conversationId: "conv-1", title: "Named" });

  const duplicate = await context.report({ conversationId: "conv-1", title: "Named" });
  assert.equal(duplicate.reported, false);
  assert.equal(duplicate.reason, "already-reported");
  assert.equal(requests.length, 1, "the same conversation and title never posts twice");

  await context.report({ conversationId: "conv-1", title: "Renamed" });
  assert.equal(requests.length, 2, "a changed title is a new report");
});

test("failed session title reports are abandoned silently, never retried", async () => {
  const { context, requests } = sessionTitleReportHarness((tracked, url, body) => {
    tracked.push({ url, body });
    throw new Error("MOSA is down");
  });
  assert.equal((await context.report({ conversationId: "conv-2", title: "Named" })).reported, false);
  assert.equal((await context.report({ conversationId: "conv-2", title: "Named" })).reason, "already-reported");
  assert.equal(requests.length, 1, "the failed POST is remembered as sent and never retried");
});

test("session title reporting stays silent without a token or a usable payload", async () => {
  const { context, requests } = sessionTitleReportHarness((tracked, url, body) => {
    tracked.push({ url, body });
    return { ok: true, status: 200 };
  });
  context.getSettings = async () => ({ mosaBaseUrl: "", mosaToken: "   " });
  const unpaired = await context.report({ conversationId: "conv-3", title: "Named" });
  assert.equal(unpaired.reported, false);
  assert.equal(unpaired.reason, "no-token");
  assert.equal(requests.length, 0, "unpaired runtimes never receive title reports");
  const emptyId = await context.report({ conversationId: "", title: "Named" });
  assert.equal(emptyId.reason, "empty");
  const emptyTitle = await context.report({ conversationId: "conv-3", title: "  " });
  assert.equal(emptyTitle.reason, "empty");
  assert.equal(requests.length, 0);
});

// --- ChatGPT conversation turn bindings (0.15.25) ---

function turnBindingsFixtureNode(id, message, parent, children = []) {
  return { id, message, parent, children };
}

function turnBindingsUserNode({ id, parent, children = [], hidden = false, uploads = [] } = {}) {
  return turnBindingsFixtureNode(id, {
    id,
    author: { role: "user" },
    content: {
      content_type: "text",
      parts: [
        "MOSA turn-bindings fixture instruction",
        ...uploads.map((fileId) => ({ content_type: "image_asset_pointer", asset_pointer: `file-service://${fileId}` })),
      ],
    },
    metadata: hidden ? { is_visually_hidden_from_conversation: true } : {},
  }, parent, children);
}

function turnBindingsAssistantNode({ id, parent, children = [], references = [] } = {}) {
  return turnBindingsFixtureNode(id, {
    id,
    author: { role: "assistant" },
    content: {
      content_type: "text",
      parts: [
        "MOSA turn-bindings fixture reply",
        ...references.map((fileId) => ({ content_type: "image_asset_pointer", asset_pointer: `sediment:// ${fileId}`.trim() })),
      ],
    },
    metadata: {},
    status: "finished_successfully",
  }, parent, children);
}

function turnBindingsGenerationNode({ id, parent, children = [], scheme = "file-service", files = [], role = "tool" } = {}) {
  return turnBindingsFixtureNode(id, {
    id,
    author: { role, name: "image_gen" },
    recipient: role === "tool" ? "assistant" : "all",
    content: {
      content_type: "multimodal_text",
      parts: files.map((fileId) => ({
        content_type: "image_asset_pointer",
        asset_pointer: `${scheme}://${fileId}`,
        metadata: { dalle: { gen_id: `gen-${fileId}` } },
      })),
    },
    metadata: {},
    status: "finished_successfully",
  }, parent, children);
}

function turnBindingsConversation(nodes, currentNode, conversationId = "conversation-test") {
  const mapping = {};
  for (const node of nodes) mapping[node.id] = node;
  return { title: "fixture", conversation_id: conversationId, mapping, current_node: currentNode };
}

function conversationBindingsContext() {
  const names = [
    "normalizeAssetId",
    "isHiddenConversationUserMessage",
    "isConversationUserMessage",
    "conversationGenerationAssets",
    "extractConversationTurnBindings",
    "extractMessagesConversationTurnBindings",
  ];
  const pieces = [/const MAX_CONVERSATION_TURN_BINDINGS = [^;]+;/.exec(hookSource)?.[0]];
  for (const name of names) {
    const match = new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(hookSource);
    assert.ok(match, `page-hook.js should keep ${name} extractable`);
    pieces.push(match[0]);
  }
  const context = {};
  // The extractor runs in the vm realm; report objects cross back through
  // JSON so plain deepEqual works on test-realm values.
  vm.runInNewContext(`${pieces.filter(Boolean).join("\n")}\nthis.extractRaw = extractConversationTurnBindings;`, context, { filename: "page-hook-turn-bindings.js" });
  return {
    extract(input) {
      const report = context.extractRaw(input);
      return report ? JSON.parse(JSON.stringify(report)) : null;
    },
  };
}

test("turn bindings count visible user messages and bind each generated file to its turn", () => {
  const { extract } = conversationBindingsContext();
  const conversation = turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["u1"]),
    turnBindingsUserNode({ id: "u1", parent: "root", children: ["g1"] }),
    turnBindingsGenerationNode({ id: "g1", parent: "u1", children: ["a1"], files: ["file_turn1"] }),
    turnBindingsAssistantNode({ id: "a1", parent: "g1", children: ["u2"] }),
    turnBindingsUserNode({ id: "u2", parent: "a1", children: ["g2"] }),
    turnBindingsGenerationNode({ id: "g2", parent: "u2", children: ["a2"], files: ["file_aaa1", "file_bbb2"] }),
    turnBindingsAssistantNode({ id: "a2", parent: "g2", children: ["u3"] }),
    turnBindingsUserNode({ id: "u3", parent: "a2", children: ["a3"] }),
    turnBindingsAssistantNode({ id: "a3", parent: "u3" }),
  ], "a3");
  const report = extract(conversation);
  assert.ok(report, "a populated branch must produce a report");
  assert.equal(report.conversationId, "conversation-test");
  assert.equal(report.turnCount, 3);
  assert.deepEqual(report.bindings, [
    { provider_asset_id: "file_turn1", message_id: "u1", turn_index: 1 },
    { provider_asset_id: "file_aaa1", message_id: "u2", turn_index: 2 },
    { provider_asset_id: "file_bbb2", message_id: "u2", turn_index: 2 },
  ]);
});

test("turn bindings follow the branch current_node points at, never the edited-away one", () => {
  const { extract } = conversationBindingsContext();
  const conversation = turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["u1"]),
    turnBindingsUserNode({ id: "u1", parent: "root", children: ["a1"] }),
    turnBindingsAssistantNode({ id: "a1", parent: "u1", children: ["u2old", "u2new"] }),
    turnBindingsUserNode({ id: "u2old", parent: "a1", children: ["gold"] }),
    turnBindingsGenerationNode({ id: "gold", parent: "u2old", children: ["aold"], files: ["file_old"] }),
    turnBindingsAssistantNode({ id: "aold", parent: "gold" }),
    turnBindingsUserNode({ id: "u2new", parent: "a1", children: ["gnew"] }),
    turnBindingsGenerationNode({ id: "gnew", parent: "u2new", children: ["anew"], files: ["file_new"] }),
    turnBindingsAssistantNode({ id: "anew", parent: "gnew" }),
  ], "anew");
  const report = extract(conversation);
  assert.equal(report.turnCount, 2);
  assert.deepEqual(report.bindings, [
    { provider_asset_id: "file_new", message_id: "u2new", turn_index: 2 },
  ]);
});

test("hidden system user messages do not count as turns", () => {
  const { extract } = conversationBindingsContext();
  const conversation = turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["sys1"]),
    turnBindingsUserNode({ id: "sys1", parent: "root", children: ["a1"], hidden: true }),
    turnBindingsAssistantNode({ id: "a1", parent: "sys1", children: ["u2"] }),
    turnBindingsUserNode({ id: "u2", parent: "a1", children: ["g2"] }),
    turnBindingsGenerationNode({ id: "g2", parent: "u2", children: ["a2"], files: ["file_hidden_check"] }),
    turnBindingsAssistantNode({ id: "a2", parent: "g2" }),
  ], "a2");
  const report = extract(conversation);
  assert.equal(report.turnCount, 1, "the hidden user message must not raise the turn count");
  assert.deepEqual(report.bindings, [
    { provider_asset_id: "file_hidden_check", message_id: "u2", turn_index: 1 },
  ]);
});

test("uploads and merely referenced images are never reported as generation outputs", () => {
  const { extract } = conversationBindingsContext();
  const conversation = turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["u1"]),
    turnBindingsUserNode({ id: "u1", parent: "root", children: ["g1"], uploads: ["file_upload1"] }),
    turnBindingsGenerationNode({ id: "g1", parent: "u1", children: ["a1"], files: ["file_gen1"] }),
    turnBindingsAssistantNode({ id: "a1", parent: "g1", children: ["u2"], references: ["file_upload1"] }),
    turnBindingsUserNode({ id: "u2", parent: "a1", children: ["a2"] }),
    turnBindingsAssistantNode({ id: "a2", parent: "u2" }),
  ], "a2");
  const report = extract(conversation);
  assert.deepEqual(report.bindings.map((binding) => binding.provider_asset_id), ["file_gen1"]);
});

test("a file that two branch messages both present as a generation output is omitted", () => {
  const { extract } = conversationBindingsContext();
  const conversation = turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["u1"]),
    turnBindingsUserNode({ id: "u1", parent: "root", children: ["g1"] }),
    turnBindingsGenerationNode({ id: "g1", parent: "u1", children: ["a1"], files: ["file_dup"] }),
    turnBindingsAssistantNode({ id: "a1", parent: "g1", children: ["galley"] }),
    turnBindingsGenerationNode({ id: "galley", parent: "a1", files: ["file_dup"] }),
  ], "galley");
  const report = extract(conversation);
  assert.equal(report, null, "the only file in the branch is ambiguous, so there is nothing to report");
});

test("file-service:// and sediment:// pointers both reduce to the bare file id", () => {
  const { extract } = conversationBindingsContext();
  const conversation = turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["u1"]),
    turnBindingsUserNode({ id: "u1", parent: "root", children: ["g1"] }),
    turnBindingsGenerationNode({ id: "g1", parent: "u1", children: ["a1"], files: ["file_ser1"] }),
    turnBindingsGenerationNode({ id: "a1", parent: "g1", scheme: "sediment", files: ["file_sed1"], role: "assistant" }),
  ], "a1");
  const report = extract(conversation);
  assert.deepEqual(report.bindings.map((binding) => binding.provider_asset_id), ["file_sed1", "file_ser1"]);
});

test("over 2000 bindings come back marked overLimit with empty bindings", () => {
  const { extract } = conversationBindingsContext();
  const files = Array.from({ length: 2001 }, (_, index) => `file_${String(index).padStart(4, "0")}`);
  const conversation = turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["u1"]),
    turnBindingsUserNode({ id: "u1", parent: "root", children: ["g1"] }),
    turnBindingsGenerationNode({ id: "g1", parent: "u1", files }),
  ], "g1");
  const report = extract(conversation);
  assert.equal(report.overLimit, true);
  assert.deepEqual(report.bindings, []);
  assert.equal(report.turnCount, 1);
});

test("conversations without user messages, images, a mapping, or an id report nothing", () => {
  const { extract } = conversationBindingsContext();
  assert.equal(extract(null), null);
  assert.equal(extract("not-an-object"), null);
  assert.equal(extract({ mapping: {} }), null);
  assert.equal(extract(turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["g1"]),
    turnBindingsGenerationNode({ id: "g1", parent: "root", files: ["file_orphan"] }),
  ], "g1")), null, "no user message, no turns");
  assert.equal(extract(turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["u1"]),
    turnBindingsUserNode({ id: "u1", parent: "root" }),
  ], "u1")), null, "no generation output, no bindings");
  const noId = turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["u1"]),
    turnBindingsUserNode({ id: "u1", parent: "root", children: ["g1"] }),
    turnBindingsGenerationNode({ id: "g1", parent: "u1", files: ["file_noid"] }),
  ], "g1");
  noId.conversation_id = "";
  assert.equal(extract(noId), null);
});

// --- Flat messages format (0.15.26): ChatGPT also serves the open
// --- conversation as a pre-flattened branch with page_info paging.

function turnBindingsFlatUserMessage({ id, parentId, hidden = false, uploads = [] } = {}) {
  return {
    id,
    author: { role: "user" },
    content: {
      content_type: "text",
      parts: [
        "MOSA turn-bindings fixture instruction",
        ...uploads.map((fileId) => ({ content_type: "image_asset_pointer", asset_pointer: `file-service://${fileId}` })),
      ],
    },
    metadata: {
      ...(hidden ? { is_visually_hidden_from_conversation: true } : {}),
      ...(parentId !== undefined ? { parent_id: parentId } : {}),
    },
  };
}

function turnBindingsFlatSystemMessage({ id, parentId } = {}) {
  return {
    id,
    author: { role: "system" },
    content: { content_type: "text", parts: ["MOSA turn-bindings fixture system message"] },
    metadata: parentId !== undefined ? { parent_id: parentId } : {},
  };
}

function turnBindingsFlatAssistantMessage({ id, parentId } = {}) {
  return {
    id,
    author: { role: "assistant" },
    content: { content_type: "text", parts: ["MOSA turn-bindings fixture reply"] },
    metadata: parentId !== undefined ? { parent_id: parentId } : {},
    status: "finished_successfully",
  };
}

function turnBindingsFlatGenerationMessage({ id, parentId, scheme = "file-service", files = [], role = "tool" } = {}) {
  return {
    id,
    author: { role, name: "image_gen" },
    recipient: role === "tool" ? "assistant" : "all",
    content: {
      content_type: "multimodal_text",
      parts: files.map((fileId) => ({
        content_type: "image_asset_pointer",
        asset_pointer: `${scheme}://${fileId}`,
        metadata: { dalle: { gen_id: `gen-${fileId}` } },
      })),
    },
    metadata: parentId !== undefined ? { parent_id: parentId } : {},
    status: "finished_successfully",
  };
}

function turnBindingsFlatConversation(messages, { currentNode, hasPreviousPage = false, withPageInfo = true } = {}) {
  const conversation = {
    conversation_id: "conversation-test",
    current_node: currentNode !== undefined ? currentNode : messages[messages.length - 1]?.id,
    messages,
  };
  if (withPageInfo) {
    conversation.page_info = {
      start_cursor: "cursor-older",
      end_cursor: "cursor-newest",
      has_previous_page: hasPreviousPage,
      has_next_page: false,
    };
  }
  return conversation;
}

function turnBindingsFlatThreeTurnConversation() {
  return turnBindingsFlatConversation([
    // The first message may name a parent outside the list; it is not checked.
    turnBindingsFlatUserMessage({ id: "flat-u1", parentId: "flat-root-outside-list" }),
    turnBindingsFlatGenerationMessage({ id: "flat-g1", parentId: "flat-u1", files: ["file_flat1"] }),
    turnBindingsFlatAssistantMessage({ id: "flat-a1", parentId: "flat-g1" }),
    turnBindingsFlatUserMessage({ id: "flat-u2", parentId: "flat-a1" }),
    turnBindingsFlatGenerationMessage({ id: "flat-g2", parentId: "flat-u2", files: ["file_flat2a", "file_flat2b"] }),
    turnBindingsFlatAssistantMessage({ id: "flat-a2", parentId: "flat-g2" }),
    turnBindingsFlatUserMessage({ id: "flat-u3", parentId: "flat-a2" }),
    turnBindingsFlatAssistantMessage({ id: "flat-a3", parentId: "flat-u3" }),
  ]);
}

test("flat messages conversations bind each generated file to its turn", () => {
  const { extract } = conversationBindingsContext();
  const report = extract(turnBindingsFlatThreeTurnConversation());
  assert.ok(report, "a complete flat read must produce a report");
  assert.equal(report.conversationId, "conversation-test");
  assert.equal(report.turnCount, 3);
  assert.deepEqual(report.bindings, [
    { provider_asset_id: "file_flat1", message_id: "flat-u1", turn_index: 1 },
    { provider_asset_id: "file_flat2a", message_id: "flat-u2", turn_index: 2 },
    { provider_asset_id: "file_flat2b", message_id: "flat-u2", turn_index: 2 },
  ]);
});

test("flat conversations with older pages outstanding report nothing", () => {
  const { extract } = conversationBindingsContext();
  const paged = turnBindingsFlatThreeTurnConversation();
  paged.page_info.has_previous_page = true;
  assert.equal(extract(paged), null, "an older page exists, so the turn count would come out too low");
});

test("flat conversations without page_info report nothing", () => {
  const { extract } = conversationBindingsContext();
  const noPageInfo = turnBindingsFlatThreeTurnConversation();
  delete noPageInfo.page_info;
  assert.equal(extract(noPageInfo), null);
  const nullPageInfo = turnBindingsFlatThreeTurnConversation();
  nullPageInfo.page_info = null;
  assert.equal(extract(nullPageInfo), null);
});

test("flat conversations whose list does not end at current_node report nothing", () => {
  const { extract } = conversationBindingsContext();
  const wrongTail = turnBindingsFlatThreeTurnConversation();
  wrongTail.current_node = "flat-not-the-last-message";
  assert.equal(extract(wrongTail), null);
  const missingTail = turnBindingsFlatThreeTurnConversation();
  missingTail.current_node = undefined;
  assert.equal(extract(missingTail), null);
});

test("flat conversations whose parent link points forward report nothing", () => {
  const { extract } = conversationBindingsContext();
  const outOfOrder = turnBindingsFlatThreeTurnConversation();
  const laterId = outOfOrder.messages[outOfOrder.messages.length - 1].id;
  outOfOrder.messages[4].metadata.parent_id = laterId;
  assert.equal(extract(outOfOrder), null, "a parent after its child fails the whole batch");
  const selfParent = turnBindingsFlatThreeTurnConversation();
  selfParent.messages[4].metadata.parent_id = selfParent.messages[4].id;
  assert.equal(extract(selfParent), null, "a message cannot be its own parent");
});

test("flat conversations tolerate parent links to internal nodes left out of the list", () => {
  // Shape seen on chatgpt.com (10-07, structure only): two hidden system
  // messages, the user turn with uploads, the image tool output, then two
  // assistant messages whose parent_id names tool-call nodes ChatGPT omits.
  const { extract } = conversationBindingsContext();
  const conversation = turnBindingsFlatConversation([
    turnBindingsFlatSystemMessage({ id: "flat-real-sys0" }),
    turnBindingsFlatSystemMessage({ id: "flat-real-sys1" }),
    turnBindingsFlatUserMessage({ id: "flat-real-u1", uploads: ["file_upload_a", "file_upload_b"] }),
    turnBindingsFlatGenerationMessage({ id: "flat-real-tool", parentId: "flat-real-u1", scheme: "sediment", files: ["file_generated_1"] }),
    turnBindingsFlatAssistantMessage({ id: "flat-real-a1", parentId: "flat-omitted-call-1" }),
    turnBindingsFlatAssistantMessage({ id: "flat-real-a2", parentId: "flat-omitted-call-2" }),
  ]);
  const result = extract(conversation);
  assert.ok(result, "omitted internal parents must not drop the batch");
  assert.equal(result.turnCount, 1);
  assert.equal(JSON.stringify(result.bindings), JSON.stringify([
    { provider_asset_id: "file_generated_1", message_id: "flat-real-u1", turn_index: 1 },
  ]));
});

test("hidden user messages and system messages do not count as turns in flat conversations", () => {
  const { extract } = conversationBindingsContext();
  const conversation = turnBindingsFlatConversation([
    turnBindingsFlatSystemMessage({ id: "flat-sys0", parentId: "flat-root-outside-list" }),
    turnBindingsFlatUserMessage({ id: "flat-hidden0", parentId: "flat-sys0", hidden: true }),
    turnBindingsFlatAssistantMessage({ id: "flat-a0", parentId: "flat-hidden0" }),
    turnBindingsFlatUserMessage({ id: "flat-u1", parentId: "flat-a0" }),
    turnBindingsFlatGenerationMessage({ id: "flat-g1", parentId: "flat-u1", files: ["file_flat_hidden"] }),
    turnBindingsFlatAssistantMessage({ id: "flat-a1", parentId: "flat-g1" }),
  ]);
  const report = extract(conversation);
  assert.ok(report);
  assert.equal(report.turnCount, 1, "hidden and system messages must not raise the turn count");
  assert.deepEqual(report.bindings, [
    { provider_asset_id: "file_flat_hidden", message_id: "flat-u1", turn_index: 1 },
  ]);
});

test("a file two flat messages both present as a generation output is omitted, the rest still report", () => {
  const { extract } = conversationBindingsContext();
  const conversation = turnBindingsFlatConversation([
    turnBindingsFlatUserMessage({ id: "flat-u1", parentId: "flat-root-outside-list" }),
    turnBindingsFlatGenerationMessage({ id: "flat-g1", parentId: "flat-u1", files: ["file_dup_flat", "file_solo_flat"] }),
    turnBindingsFlatAssistantMessage({ id: "flat-a1", parentId: "flat-g1" }),
    turnBindingsFlatUserMessage({ id: "flat-u2", parentId: "flat-a1" }),
    turnBindingsFlatGenerationMessage({ id: "flat-g2", parentId: "flat-u2", files: ["file_dup_flat"] }),
    turnBindingsFlatAssistantMessage({ id: "flat-a2", parentId: "flat-g2" }),
  ]);
  const report = extract(conversation);
  assert.ok(report);
  assert.deepEqual(report.bindings, [
    { provider_asset_id: "file_solo_flat", message_id: "flat-u1", turn_index: 1 },
  ]);
});

test("flat conversations keep uploads out of the generation outputs", () => {
  const { extract } = conversationBindingsContext();
  const conversation = turnBindingsFlatConversation([
    turnBindingsFlatUserMessage({ id: "flat-u1", parentId: "flat-root-outside-list", uploads: ["file_upload_flat"] }),
    turnBindingsFlatGenerationMessage({ id: "flat-g1", parentId: "flat-u1", files: ["file_gen_flat"] }),
    turnBindingsFlatAssistantMessage({ id: "flat-a1", parentId: "flat-g1" }),
  ]);
  const report = extract(conversation);
  assert.ok(report);
  assert.deepEqual(report.bindings.map((binding) => binding.provider_asset_id), ["file_gen_flat"]);
});

test("conversations with neither a mapping nor a messages list report nothing", () => {
  const { extract } = conversationBindingsContext();
  assert.equal(extract({}), null);
  assert.equal(extract({ messages: [] }), null);
  assert.equal(extract({ messages: "not-an-array" }), null);
  assert.equal(extract({ messages: [null, "junk", 42], page_info: { has_previous_page: false }, current_node: "42" }), null);
});

function jsonResponsePayload(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : "") },
    clone: () => ({ json: async () => payload }),
    json: async () => payload,
  };
}

test("the open conversation's own JSON reports turn bindings over the private page channel", async () => {
  const conversation = turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["u1"]),
    turnBindingsUserNode({ id: "u1", parent: "root", children: ["g1"] }),
    turnBindingsGenerationNode({ id: "g1", parent: "u1", children: ["a1"], files: ["file_live1"] }),
    turnBindingsAssistantNode({ id: "a1", parent: "g1" }),
  ], "a1");
  const harness = createHookHarness(undefined, "conversation-test", {
    respond: (url) => (url.includes("/backend-api/conversation/conversation-test") ? jsonResponsePayload(conversation) : null),
  });
  await harness.harvest(null, "https://chatgpt.com/backend-api/conversation/conversation-test");
  const event = harness.events.find((item) => item.type === "conversation-turn-bindings");
  assert.ok(event, "the reduced turn snapshot should ride the private page channel");
  const payload = JSON.parse(JSON.stringify(event.payload));
  assert.equal(payload.conversationId, "conversation-test");
  assert.equal(payload.turnCount, 1);
  assert.deepEqual(payload.bindings, [
    { provider_asset_id: "file_live1", message_id: "u1", turn_index: 1 },
  ]);
});

test("conversation items for a different conversation are never reported", async () => {
  const conversation = turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["u1"]),
    turnBindingsUserNode({ id: "u1", parent: "root", children: ["g1"] }),
    turnBindingsGenerationNode({ id: "g1", parent: "u1", files: ["file_other1"] }),
  ], "g1", "conversation-other");
  const harness = createHookHarness(undefined, "conversation-test", {
    respond: (url) => (url.includes("/backend-api/conversation/conversation-other") ? jsonResponsePayload(conversation) : null),
  });
  await harness.harvest(null, "https://chatgpt.com/backend-api/conversation/conversation-other");
  assert.equal(
    harness.events.some((item) => item.type === "conversation-turn-bindings"),
    false,
    "a conversation the user has not open must not be reported",
  );
});

test("an over-ceiling conversation read is dropped with one debug line and no report", async () => {
  const files = Array.from({ length: 2001 }, (_, index) => `file_${String(index).padStart(4, "0")}`);
  const conversation = turnBindingsConversation([
    turnBindingsFixtureNode("root", null, null, ["u1"]),
    turnBindingsUserNode({ id: "u1", parent: "root", children: ["g1"] }),
    turnBindingsGenerationNode({ id: "g1", parent: "u1", files }),
  ], "g1");
  const harness = createHookHarness(undefined, "conversation-test", {
    respond: (url) => (url.includes("/backend-api/conversation/conversation-test") ? jsonResponsePayload(conversation) : null),
  });
  await harness.harvest(null, "https://chatgpt.com/backend-api/conversation/conversation-test");
  assert.equal(harness.events.some((item) => item.type === "conversation-turn-bindings"), false);
  assert.equal(harness.consoleDebugs.length, 1, "the drop must leave exactly one debug line");
  assert.match(harness.consoleDebugs[0], /2000/);
});

test("the plural conversations URL reports flat-format turn bindings over the private page channel", async () => {
  const conversation = turnBindingsFlatThreeTurnConversation();
  const harness = createHookHarness(undefined, "conversation-test", {
    respond: (url) => (url.includes("/backend-api/conversations/conversation-test") ? jsonResponsePayload(conversation) : null),
  });
  await harness.harvest(null, "https://chatgpt.com/backend-api/conversations/conversation-test?num_turns=10&include_has_versions=true");
  const event = harness.events.find((item) => item.type === "conversation-turn-bindings");
  assert.ok(event, "the flat-format snapshot should ride the private page channel");
  const payload = JSON.parse(JSON.stringify(event.payload));
  assert.equal(payload.conversationId, "conversation-test");
  assert.equal(payload.turnCount, 3);
  assert.deepEqual(payload.bindings, [
    { provider_asset_id: "file_flat1", message_id: "flat-u1", turn_index: 1 },
    { provider_asset_id: "file_flat2a", message_id: "flat-u2", turn_index: 2 },
    { provider_asset_id: "file_flat2b", message_id: "flat-u2", turn_index: 2 },
  ]);
});

test("a flat conversation read that still has older pages is never reported over the channel", async () => {
  const conversation = turnBindingsFlatThreeTurnConversation();
  conversation.page_info.has_previous_page = true;
  const harness = createHookHarness(undefined, "conversation-test", {
    respond: (url) => (url.includes("/backend-api/conversations/conversation-test") ? jsonResponsePayload(conversation) : null),
  });
  await harness.harvest(null, "https://chatgpt.com/backend-api/conversations/conversation-test?num_turns=10&include_has_versions=true");
  assert.equal(
    harness.events.some((item) => item.type === "conversation-turn-bindings"),
    false,
    "a paged read must not produce turn numbers",
  );
});

test("the XHR conversation path reports turn bindings under the same open-conversation gate", () => {
  assert.ok(
    hookSource.includes('if (text) harvest(text, "xhr");')
      || /if \(text\)\s*\{[\s\S]*harvest\(text,\s*"xhr"\)/.test(hookSource),
    "XHR interceptor must still call harvest(text, 'xhr') on non-empty text"
  );
  assert.match(hookSource, /if \(isCurrentConversationItemUrl\(url\)\) reportConversationTurnBindingsFromText\(text\);/);
  assert.match(hookSource, /if \(isCurrentConversationItemUrl\(url\)\) reportConversationTurnBindings\(payload\);/);
  assert.match(contentSource, /data\.type === "conversation-turn-bindings"/);
  assert.match(contentSource, /type: "mosa\.reportConversationTurns",/);
  assert.match(backgroundSource, /if \(message\.type === "mosa\.reportConversationTurns"\) return context\.provider === "chatgpt";/);
});

function turnBindingReportHarness(fetchBehavior) {
  const requests = [];
  const pieces = [
    "const reportedTurnBindingSummaries = new Map();",
    "const pendingTurnBindingReports = new Map();",
    "const TURN_BINDING_REPORT_THROTTLE_MS = 5;",
    /function turnBindingSummaryKey\([\s\S]*?\n}\n/.exec(backgroundSource)?.[0],
    /async function reportConversationTurnsOnce\([\s\S]*?\n}\n/.exec(backgroundSource)?.[0],
    /function reportConversationTurnsThrottled\([\s\S]*?\n}\n/.exec(backgroundSource)?.[0],
    /function normalizeBaseUrl\([\s\S]*?\n}\n/.exec(backgroundSource)?.[0],
  ].filter(Boolean).join("\n");
  const context = {
    URL,
    setTimeout,
    clearTimeout,
    DEFAULTS: { mosaBaseUrl: "http://127.0.0.1:43517" },
    getSettings: async () => ({ mosaBaseUrl: "", mosaToken: "token-test" }),
    fetchWithTimeout: async (url, init) => fetchBehavior(requests, url, JSON.parse(init.body)),
  };
  vm.runInNewContext(
    `${pieces}\nthis.report = reportConversationTurnsThrottled; this.reportNow = reportConversationTurnsOnce; this.summary = turnBindingSummaryKey;`,
    context,
    { filename: "background-turn-bindings.js" },
  );
  return { context, requests };
}

const TURN_REPORT_FIXTURE = {
  provider: "chatgpt",
  conversationId: "conv-turn-1",
  turnCount: 3,
  bindings: [
    { provider_asset_id: "file_b1", message_id: "user-2", turn_index: 2 },
    { provider_asset_id: "file_a1", message_id: "user-1", turn_index: 1 },
  ],
};

test("turn bindings POST to the message-binding endpoint and repeat only on change", async () => {
  const { context, requests } = turnBindingReportHarness((tracked, url, body) => {
    tracked.push({ url, body });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  });

  const first = await context.reportNow(TURN_REPORT_FIXTURE);
  assert.equal(first.reported, true);
  assert.equal(first.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:43517/api/ingest/web-capture-turn-bindings");
  assert.deepEqual(requests[0].body, {
    project_id: "default",
    provider: "chatgpt",
    conversation_id: "conv-turn-1",
    turn_count: 3,
    bindings: [
      { provider_asset_id: "file_b1", message_id: "user-2", turn_index: 2 },
      { provider_asset_id: "file_a1", message_id: "user-1", turn_index: 1 },
    ],
  });

  const duplicate = await context.reportNow(TURN_REPORT_FIXTURE);
  assert.equal(duplicate.reported, false);
  assert.equal(duplicate.reason, "already-reported");
  assert.equal(requests.length, 1, "an unchanged read is never posted twice");

  const reordered = {
    ...TURN_REPORT_FIXTURE,
    bindings: [...TURN_REPORT_FIXTURE.bindings].reverse(),
  };
  assert.equal((await context.reportNow(reordered)).reason, "already-reported",
    "the summary must not depend on binding order");
  assert.equal(requests.length, 1);

  await context.reportNow({ ...TURN_REPORT_FIXTURE, turnCount: 4 });
  assert.equal(requests.length, 2, "a changed branch is a new snapshot");
});

test("failed turn-binding reports are not remembered, so the next load retries", async () => {
  let failRequests = 0;
  const failing = turnBindingReportHarness((tracked, url, body) => {
    tracked.push({ url, body });
    failRequests += 1;
    if (failRequests === 1) return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  await assert.rejects(failing.context.reportNow(TURN_REPORT_FIXTURE));
  const retried = await failing.context.reportNow(TURN_REPORT_FIXTURE);
  assert.equal(retried.reported, true);
  assert.equal(failing.requests.length, 2, "a failed POST must not be remembered as sent");

  let throwRequests = 0;
  const throwing = turnBindingReportHarness((tracked, url) => {
    tracked.push({ url: String(url) });
    throwRequests += 1;
    if (throwRequests <= 2) throw new Error("MOSA is down");
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  await assert.rejects(throwing.context.reportNow(TURN_REPORT_FIXTURE), /MOSA is down/);
  // The throttled path turns a failure into a result for the page, and the
  // summary stays unrecorded so the next report posts again.
  const throttledFailure = await throwing.context.report(TURN_REPORT_FIXTURE);
  assert.equal(throttledFailure.reported, false);
  assert.match(throttledFailure.reason, /MOSA is down/);
  const throttledRetry = await throwing.context.report(TURN_REPORT_FIXTURE);
  assert.equal(throttledRetry.reported, true);
  assert.equal(throwing.requests.length, 3);
});

test("turn bindings stay silent without a token or a usable snapshot", async () => {
  const { context, requests } = turnBindingReportHarness((tracked, url, body) => {
    tracked.push({ url, body });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  context.getSettings = async () => ({ mosaBaseUrl: "", mosaToken: "   " });
  const unpaired = await context.reportNow(TURN_REPORT_FIXTURE);
  assert.equal(unpaired.reported, false);
  assert.equal(unpaired.reason, "no-token");
  assert.equal(requests.length, 0, "unpaired runtimes never receive turn snapshots");
  assert.equal((await context.reportNow({ ...TURN_REPORT_FIXTURE, conversationId: "" })).reason, "empty");
  assert.equal((await context.reportNow({ ...TURN_REPORT_FIXTURE, turnCount: 0 })).reason, "empty");
  assert.equal((await context.reportNow({ ...TURN_REPORT_FIXTURE, bindings: [] })).reason, "empty");
  assert.equal(requests.length, 0);
});

test("rapid reads of one conversation collapse into the single newest snapshot", async () => {
  const { context, requests } = turnBindingReportHarness((tracked, url, body) => {
    tracked.push({ url, body });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  const first = context.report(TURN_REPORT_FIXTURE);
  const second = context.report({ ...TURN_REPORT_FIXTURE, turnCount: 4 });
  const third = context.report({ ...TURN_REPORT_FIXTURE, turnCount: 5 });
  await Promise.all([first, second, third]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(requests.length, 1, "one 2s window sends once");
  assert.equal(requests[0].body.turn_count, 5, "the newest read wins");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await context.report({ ...TURN_REPORT_FIXTURE, turnCount: 6 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(requests.length, 2, "a read after the window opens a new one");
});
