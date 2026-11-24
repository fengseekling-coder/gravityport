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
  let confirmationOpened = false;
  let confirmationsOpened = 0;
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
      // The App merges a re-sent POST from the same Origin into the request
      // that is already waiting; the user clicked Allow right away, so the
      // re-send (the extension's poll) collects the token. Only the first POST
      // opens a confirmation.
      if (confirmationOpened) {
        return jsonRoute({ product: "mosa", token: "user-token" });
      }
      confirmationOpened = true;
      confirmationsOpened += 1;
      return jsonRoute({
        product: "mosa",
        status: "pending",
        requestId: "req-user",
        expiresInMs: 120000,
      }, 202);
    }
    return null;
  });

  try {
    harness.triggerInstalled({ reason: "install" }).catch(() => {});
    harness.fireAlarm();
    harness.dispatchMessage({ type: "mosa.getSettings" }, senderFor(CHATGPT_TAB_URL)).catch(() => {});

    await Promise.race([gateEnteredPromise, sleep(500)]);

    harness.fetchHarness.setAppOnline(true);
    const confirmationsBeforeClick = confirmationsOpened;

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
    assert.equal(confirmationsOpened - confirmationsBeforeClick, 1, "clicking Connect must open its own single confirmation in the App");
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
      // After the test, answer "denied" so a pre-fix background attempt ends.
      if (finished) return jsonRoute({ error: "denied" }, 403);
      return jsonRoute({
        product: "mosa",
        status: "pending",
        requestId: "req-bg",
        expiresInMs: 120000,
      }, 202);
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

// 466 acceptance: Chrome sends no Origin on a GET from the extension, and the
// App binds a pairing request to the Origin that created it, so the worker
// polls by re-sending POST /pair (always sent with the Origin) instead of
// GET /pair/<id>.
function pairingPollHandler(counters, { requestId, expiresInMs, tokenOnPost = Infinity }) {
  return (url, init) => {
    if (url.pathname.startsWith("/api/web-capture/pair/")) {
      counters.gets += 1;
      return jsonRoute({ error: "Cross-origin requests are not allowed." }, 403);
    }
    if (url.pathname === "/api/web-capture/pair") {
      assert.equal(String(init?.method || "GET"), "POST");
      counters.posts += 1;
      if (counters.posts >= tokenOnPost) return jsonRoute({ product: "mosa", token: "polled-token" });
      return jsonRoute({ product: "mosa", status: "pending", requestId, expiresInMs }, 202);
    }
    return null;
  };
}

test("466 验收：pairing polls by re-sending POST, never GET /pair/<id>, and stops before the window ends", async () => {
  const harness = await createBackgroundHarness({ emptyStorage: true, appOnline: true });
  const counters = { posts: 0, gets: 0 };
  // Window 5.5 s, poll every 2 s, stop when under 1 s remain:
  //   t=0 first POST (202), t~2 s POST (3.5 s left), t~4 s POST (1.5 s left),
  //   t~6 s: under 1 s left -> no send, give up.
  // So exactly 3 POSTs, and no retry round after the window (a re-POST then
  // would open a second confirmation in the App). 5.5 s rather than a round
  // 7 s keeps every check away from the 1 s boundary, and the whole run under
  // the harness's 8 s message limit.
  harness.fetchHarness.setAppHandler(pairingPollHandler(counters, { requestId: "req-window", expiresInMs: 5500 }));
  const response = await withTimeout(
    harness.dispatchMessage({ type: "mosa.repairPairing" }, extensionPageSender()),
    15000,
    "repairPairing to give up",
  );
  assert.equal(response?.ok, false, "nobody approved: not connected");
  assert.equal(counters.gets, 0, "never GET /pair/<id>");
  assert.equal(counters.posts, 3, "first POST plus two polls inside the window");
  await sleep(2300);
  assert.equal(counters.posts, 3, "no further POST after the window, including no discovery retry round");
  assert.equal(harness.localStore.get("mosaToken") || "", "");
});

test("466 验收：a poll POST that returns 200 with the token connects and stores it", async () => {
  const harness = await createBackgroundHarness({
    emptyStorage: true,
    appOnline: true,
    delayOverrides: { 2000: 5 },
  });
  const counters = { posts: 0, gets: 0 };
  // POST 1 opens the confirmation (202), polls 1 and 2 still 202, poll 3 is 200.
  harness.fetchHarness.setAppHandler(pairingPollHandler(counters, { requestId: "req-approve", expiresInMs: 120000, tokenOnPost: 4 }));
  const response = await withTimeout(
    harness.dispatchMessage({ type: "mosa.repairPairing" }, extensionPageSender()),
    5000,
    "repairPairing",
  );
  assert.equal(response?.ok, true);
  assert.equal(response.settings.mosaToken, "polled-token");
  assert.equal(harness.localStore.get("mosaToken"), "polled-token");
  assert.equal(counters.gets, 0, "never GET /pair/<id>");
  assert.equal(counters.posts, 4);
});
