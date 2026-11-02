import assert from "node:assert/strict";
import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadOrCreateWebCaptureToken,
  MOSA_WEB_CAPTURE_DEFAULT_ORIGINS,
  MOSA_WEB_CAPTURE_DEVELOPMENT_EXTENSION_ID,
  MOSA_WEB_CAPTURE_EXTENSION_ID,
  MOSA_WEB_CAPTURE_EXTENSION_IDS,
  MOSA_WEB_CAPTURE_EXTENSION_ORIGIN,
  MOSA_WEB_CAPTURE_EXTENSION_ORIGINS,
  MOSA_WEB_CAPTURE_STORE_EXTENSION_ID,
} from "../desktop/web-capture-pairing.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

test("desktop Web Capture pairing accepts both development and Chrome Web Store identities", () => {
  assert.match(MOSA_WEB_CAPTURE_EXTENSION_ID, /^[a-p]{32}$/);
  assert.equal(MOSA_WEB_CAPTURE_EXTENSION_ORIGIN, `chrome-extension://${MOSA_WEB_CAPTURE_EXTENSION_ID}`);
  assert.equal(MOSA_WEB_CAPTURE_EXTENSION_ID, MOSA_WEB_CAPTURE_DEVELOPMENT_EXTENSION_ID);
  assert.equal(MOSA_WEB_CAPTURE_STORE_EXTENSION_ID, "bhjibabaiccjjfcdbimeeaoaikhcfncc");
  assert.deepEqual(MOSA_WEB_CAPTURE_EXTENSION_IDS, [
    MOSA_WEB_CAPTURE_DEVELOPMENT_EXTENSION_ID,
    MOSA_WEB_CAPTURE_STORE_EXTENSION_ID,
  ]);
  assert.deepEqual(MOSA_WEB_CAPTURE_EXTENSION_ORIGINS, [
    `chrome-extension://${MOSA_WEB_CAPTURE_DEVELOPMENT_EXTENSION_ID}`,
    `chrome-extension://${MOSA_WEB_CAPTURE_STORE_EXTENSION_ID}`,
  ]);
  assert.equal(MOSA_WEB_CAPTURE_DEFAULT_ORIGINS, MOSA_WEB_CAPTURE_EXTENSION_ORIGINS.join(","));
});

test("desktop pairing is confirmed in the App UI, never a native dialog or a silent handout", async () => {
  const [mainSource, notificationSource, bridgeSource] = await Promise.all([
    readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/notification-i18n.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/api/bridge-routes.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(mainSource, /webCapturePairingEnabled:\s*true/);
  // The confirmation lives in the App's authorization dialog (task 333); the
  // desktop shell only flips the switch and must never open a native prompt.
  assert.doesNotMatch(mainSource, /confirmWebCapturePairing|WEB_CAPTURE_PAIR_CONFIRM_TIMEOUT_MS|pairConfirm/);
  assert.doesNotMatch(notificationSource, /pairConfirm/);
  // POST /pair no longer hands out the token unconditionally: it opens (or
  // merges into) a pending request, and the token leaves only through the
  // poll route or decide()'s one-shot approval for pre-polling extensions.
  assert.match(bridgeSource, /status: "pending",\s*\n\s*requestId/);
  assert.match(bridgeSource, /WEB_CAPTURE_PAIR_POLL_PATTERN/);
  assert.match(bridgeSource, /webCapturePairRequests\?\.decide\(/);
  assert.match(bridgeSource, /webCaptureIdentityProof\(/);
  assert.match(bridgeSource, /WEB_CAPTURE_PAIRING_DENIED/);
  assert.match(bridgeSource, /WEB_CAPTURE_PAIRING_BUSY/);
});

test("desktop creates one private persistent Web Capture token", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-pairing-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const first = await loadOrCreateWebCaptureToken(root);
  const second = await loadOrCreateWebCaptureToken(root);
  assert.equal(second, first);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);

  const tokenPath = join(root, "web-capture-token");
  await access(tokenPath);
  assert.equal((await readFile(tokenPath, "utf8")).trim(), first);
  if (process.platform !== "win32") {
    const mode = (await stat(tokenPath)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});
