import test from "node:test";
import assert from "node:assert/strict";
import {
  CHATGPT_TAB_URL,
  createBackgroundHarness,
  extensionPageSender,
  fakeImageBase64,
  senderFor,
  sleep,
} from "./helpers/background-harness.mjs";

function jsonRoute(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withTimeout(promise, ms, label) {
  promise.catch(() => {});
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test("task 466: clicking Connect on the settings page is not absorbed by an older background pairing attempt", async () => {
  const harness = await createBackgroundHarness({
    emptyStorage: true,
    appOnline: false,
    delayOverrides: { 1500: 20, 2000: 5 },
  });

  let finished = false;
  let pairPosts = 0;
  let gateEntered = false;
  let resolveGateEntered = null;
  const gateEnteredPromise = new Promise((resolve) => {
    resolveGateEntered = resolve;
  });
  let rejectGate = null;
  let gatePromise = null;

  const RealmError = harness.context.Error || Error;
  harness.fetchHarness.setAppHandler((url) => {
    if (url.port !== "43517") {
      return Promise.reject(new RealmError(`connection refused: ${url.href}`));
    }
    if (url.pathname === "/api/health") {
      const count = harness.fetchHarness.appRequests.filter(
        (req) => req.url === "http://127.0.0.1:43517/api/health",
      ).length;
      if (count === 2) {
        gateEntered = true;
        resolveGateEntered?.();
        gatePromise = new Promise((_, reject) => {
          rejectGate = reject;
        });
        return gatePromise;
      }
      return null;
    }
    if (url.pathname === "/api/web-capture/pair") {
      pairPosts += 1;
      return jsonRoute({
        product: "mosa",
        status: "pending",
        requestId: "req-user",
        expiresInMs: 120000,
      }, 202);
    }
    if (url.pathname === "/api/web-capture/pair/req-user") {
      if (finished) return jsonRoute({ status: "expired" });
      return jsonRoute({ product: "mosa", status: "approved", token: "user-token" });
    }
    return null;
  });

  try {
    harness.triggerInstalled({ reason: "install" }).catch(() => {});
    harness.fireAlarm();
    harness.dispatchMessage({ type: "mosa.getSettings" }, senderFor(CHATGPT_TAB_URL)).catch(() => {});

    await Promise.race([gateEnteredPromise, sleep(500)]);

    harness.fetchHarness.setAppOnline(true);
    const postsBeforeClick = pairPosts;

    const click = harness.dispatchMessage({ type: "mosa.repairPairing" }, extensionPageSender());
    click.catch(() => {});

    if (gateEntered && rejectGate) {
      rejectGate(new RealmError("connection refused"));
      rejectGate = null;
    }

    const response = await Promise.race([
      click,
      sleep(3000).then(() => ({ timedOut: true })),
    ]);

    assert.equal(response?.ok, true, "the click was absorbed by an older background attempt");
    assert.equal(response?.settings?.mosaToken, "user-token");
    assert.equal(pairPosts - postsBeforeClick, 1, "clicking Connect must send its own single POST /api/web-capture/pair");
    assert.equal(harness.localStore.get("mosaToken"), "user-token");
  } finally {
    finished = true;
    if (rejectGate) {
      rejectGate(new RealmError("connection refused"));
      rejectGate = null;
    }
    await sleep(30);
  }
});

test("task 466: with no token stored, background entrypoints never pair and install opens options immediately", async (t) => {
  const harness = await createBackgroundHarness({
    emptyStorage: true,
    appOnline: true,
    fastTimers: true,
  });

  let finished = false;
  let pairPosts = 0;

  harness.fetchHarness.setAppHandler((url) => {
    if (url.pathname === "/api/web-capture/pair") {
      pairPosts += 1;
      return jsonRoute({
        product: "mosa",
        status: "pending",
        requestId: "req-bg",
        expiresInMs: 120000,
      }, 202);
    }
    if (url.pathname === "/api/web-capture/pair/req-bg") {
      return jsonRoute({ status: finished ? "expired" : "pending" });
    }
    return null;
  });

  try {
    await sleep(50);

    // a. First install opens options page and creates both context menus immediately.
    await withTimeout(harness.triggerInstalled({ reason: "install" }), 1000, "onInstalled");
    assert.equal(harness.isOptionsPageOpened(), true, "first install opens the options page");
    assert.equal(harness.createdContextMenus.length, 2, "first install creates both context menus");

    // b. Periodic queue alarm.
    harness.fireAlarm();
    await sleep(50);

    // c. Content script reads settings.
    const contentSettings = await withTimeout(
      harness.dispatchMessage({ type: "mosa.getSettings" }, senderFor(CHATGPT_TAB_URL)),
      1000,
      "content mosa.getSettings",
    );
    assert.equal(contentSettings?.ok, true);
    assert.deepEqual({ ...contentSettings.settings }, { autoCapture: false });

    // d. Options page reads settings.
    const optionsSettings = await withTimeout(
      harness.dispatchMessage({ type: "mosa.getSettings" }, extensionPageSender()),
      1000,
      "options mosa.getSettings",
    );
    assert.equal(optionsSettings?.ok, true);
    assert.equal(optionsSettings.settings.mosaToken, "");

    // e. Toggling autoCapture in storage.
    harness.fireStorageChanged({ autoCapture: { oldValue: false, newValue: true } });
    await sleep(50);

    // f. Manual save queues with reason "pairing" without starting pairing.
    const payload = {
      provider: "chatgpt",
      mediaKind: "image",
      imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_pairing&cid=conv1",
      imageBase64: fakeImageBase64(1024),
      mimeType: "image/png",
      promptStatus: "not-available",
    };
    const ingest = await withTimeout(
      harness.dispatchMessage({ type: "mosa.ingest", payload }, senderFor(CHATGPT_TAB_URL)),
      1000,
      "mosa.ingest",
    );
    assert.equal(ingest?.ok, true);
    assert.equal(ingest.result.status, "queued");
    assert.equal(ingest.result.reason, "pairing");

    assert.equal(pairPosts, 0, "no background entrypoint may POST /api/web-capture/pair");
    const pairRequests = harness.fetchHarness.appRequests.filter((req) => req.url.includes("/api/web-capture/pair"));
    assert.equal(pairRequests.length, 0, "appRequests must not contain any /api/web-capture/pair request");
    t.diagnostic(`test2 appRequests URLs: ${JSON.stringify(harness.fetchHarness.appRequests.map((req) => req.url))}`);
  } finally {
    finished = true;
    await sleep(30);
  }
});
