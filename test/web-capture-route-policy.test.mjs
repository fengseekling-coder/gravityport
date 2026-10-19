import assert from "node:assert/strict";
import test from "node:test";
import { isWebCaptureApiPath } from "../lib/api/bridge-routes.mjs";

test("web capture route policy includes metadata completion and chunked upload routes", () => {
  for (const path of [
    "/api/web-capture",
    "/api/web-capture/pair",
    "/api/ingest/web-capture",
    "/api/ingest/web-capture-metadata",
    "/api/ingest/web-capture-binary",
    "/api/ingest/web-capture-status",
    "/api/ingest/web-capture-session-title",
    "/api/ingest/web-capture-turn-bindings",
    "/api/ingest/web-capture-desktop-sync",
    "/api/ingest/web-capture-upload/begin",
    "/api/ingest/web-capture-upload/chunk",
    "/api/ingest/web-capture-upload/commit",
    "/api/ingest/web-capture-upload/abort",
  ]) {
    assert.equal(isWebCaptureApiPath(path), true, `${path} must share the Web Capture origin policy`);
  }
  assert.equal(isWebCaptureApiPath("/api/projects"), false);
});
