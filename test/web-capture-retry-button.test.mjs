// Task 416 (audit 低3 ①): the settings page's Retry button bumps
// retryRequestId on the server; reportCaptureQueueStatus reads it on the next
// beat. The background worker must drain the capture queue IMMEDIATELY when
// the id advances, and not when it stays the same — before this change every
// caller discarded the returned retryRequested flag.
import assert from "node:assert/strict";
import test from "node:test";

import { createBackgroundHarness, fakeImageBase64, PAIRING_TOKEN, BASE_URL, sleep } from "./helpers/background-harness.mjs";

const INGEST_URL = `${BASE_URL}/api/ingest/web-capture`;
const STATUS_URL = `${BASE_URL}/api/ingest/web-capture-status`;

function ingestCalls(harness) {
  return harness.fetchHarness.appRequests.filter((request) => request.url === INGEST_URL);
}

async function waitFor(poll, { timeoutMs = 5_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await poll();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// One byte ticket: the payload carries queuedMediaId and the bytes live in
// IndexedDB under `capture:<id>` (the same shape enqueueCapture writes).
async function seedRetryTicket(harness) {
  const ticket = {
    id: "ticket-retry-1",
    createdAt: Date.now(),
    payload: {
      provider: "chatgpt",
      mediaKind: "image",
      queuedMediaId: "ticket-retry-1",
      imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_retry&cid=conv1",
      mimeType: "image/png",
    },
  };
  await harness.writeQueue([ticket]);
  await harness.seedMediaRecord({
    key: `capture:${ticket.id}`,
    blob: new Blob([new Uint8Array(64)], { type: "image/png" }),
    updatedAt: Date.now(),
  });
  return ticket;
}

test("an advanced retryRequestId drains the queued ticket immediately", async () => {
  const harness = await createBackgroundHarness({ appOnline: true });

  // Settle the load-time status beat (background.js reports once at startup)
  // so the test's own report does not dedupe into the in-flight promise.
  await waitFor(() => harness.fetchHarness.appRequests.some((request) => request.url === STATUS_URL), { label: "startup status report" });
  const settled = await harness.context.reportCaptureQueueStatus();
  assert.equal(settled.retryRequested, false, "no retry requested while the id has not moved");
  assert.equal(ingestCalls(harness).length, 0, "nothing to deliver yet");

  await seedRetryTicket(harness);
  assert.equal(ingestCalls(harness).length, 0, "seeding the queue alone must not deliver");

  // The Retry button: the server answers the next status beat with a bigger id.
  harness.fetchHarness.setAppHandler((url) => {
    if (url.pathname === "/api/ingest/web-capture-status") {
      return new Response(JSON.stringify({ retryRequestId: 7 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return null;
  });
  const report = await harness.context.reportCaptureQueueStatus();
  assert.equal(report.retryRequested, true, "the bump is reported back to the caller");

  await waitFor(() => ingestCalls(harness).length >= 1, { label: "immediate re-send after the retry request" });
  const queue = await harness.readQueue();
  assert.deepEqual(queue, [], "the drained ticket left the queue");
});

test("an unchanged retryRequestId does not drain the queue", async () => {
  const harness = await createBackgroundHarness({ appOnline: true });

  await waitFor(() => harness.fetchHarness.appRequests.some((request) => request.url === STATUS_URL), { label: "startup status report" });
  const settled = await harness.context.reportCaptureQueueStatus();
  assert.equal(settled.retryRequested, false);

  await seedRetryTicket(harness);
  // Default status handler answers retryRequestId: 0 — same as last seen.
  const report = await harness.context.reportCaptureQueueStatus();
  assert.equal(report.retryRequested, false);

  await sleep(250);
  assert.equal(ingestCalls(harness).length, 0, "no re-send without a retry request");
  const queue = await harness.readQueue();
  assert.equal(queue.length, 1, "the ticket stays queued for the regular beats");
  assert.equal(String(harness.localStore.get("mosaToken")), PAIRING_TOKEN, "harness stayed paired");
});
