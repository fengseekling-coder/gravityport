import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { handleBridgeRoute } from "../lib/api/bridge-routes.mjs";

async function requestRoute({ body, installed, failRead = false, noManaged = false, method = "POST", reportBeforeGet = false }) {
  const seen = { version: "", id: "", managedId: "" };
  const capture = {
    token: "token",
    assertToken: (value) => { assert.equal(value, "token"); },
    status: () => ({ lastManagedInstallId: seen.managedId }),
    updateClientStatus: (input) => {
      seen.version = input.extensionVersion || "";
      seen.id = input.extensionId || "";
      seen.managedId = input.managedInstall?.installId || "";
      return { ok: true, retryRequestId: 0 };
    },
  };
  const context = {
    webCaptureIngest: capture,
    ...(!noManaged ? { managedExtension: { read: () => {
      if (failRead) throw new Error("read failed");
      return installed;
    } } } : {}),
  };
  const server = createServer(async (req, res) => {
    try {
      const handled = await handleBridgeRoute({ req, res, url: new URL(req.url, "http://localhost"), context });
      if (!handled) { res.statusCode = 404; res.end(); }
    } catch (error) {
      res.statusCode = 500;
      res.end(error.message);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const payload = JSON.stringify(body || {});
    if (reportBeforeGet) {
      const reported = await fetch(url + "/api/ingest/web-capture-status", {
        method: "POST",
        headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
        body: payload,
      });
      assert.equal(reported.status, 200);
    }
    const response = await fetch(url + (method === "GET" ? "/api/web-capture" : "/api/ingest/web-capture-status"), {
      method,
      ...(method === "POST" ? { headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: payload } : {}),
    });
    return { status: response.status, data: await response.json(), seen, url, context };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const managed = { path: "/test/chrome", version: "0.15.46", installId: "abc" };
const input = { extensionId: "test", extensionVersion: "0.15.45", managedInstall: { installId: "abc" } };

test("matched managed install and older version gets exact reload instruction", async () => {
  const result = await requestRoute({ body: input, installed: managed });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.extensionReload, { version: "0.15.46", installId: "abc" });
});

for (const [name, changes] of [
  ["different install ID", { managedInstall: { installId: "xyz" } }],
  ["null managed install", { managedInstall: null }],
  ["already current version", { extensionVersion: "0.15.46" }],
]) {
  test(`no reload for ${name}`, async () => {
    const result = await requestRoute({ body: { ...input, ...changes }, installed: managed });
    assert.equal(result.status, 200);
    assert.equal(Object.hasOwn(result.data, "extensionReload"), false);
  });
}

test("no managed extension injection is compatible", async () => {
  const result = await requestRoute({ body: input, noManaged: true });
  assert.equal(result.status, 200);
  assert.equal(Object.hasOwn(result.data, "extensionReload"), false);
});

test("managed read errors do not fail status reporting", async () => {
  const result = await requestRoute({ body: input, installed: managed, failRead: true });
  assert.equal(result.status, 200);
  assert.equal(Object.hasOwn(result.data, "extensionReload"), false);
});

test("GET includes managedExtension availability and metadata", async () => {
  const result = await requestRoute({ method: "GET", installed: managed, body: input, reportBeforeGet: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.managedExtension, {
    available: true, path: managed.path, version: managed.version,
    installId: managed.installId, extensionManaged: true,
  });
});
