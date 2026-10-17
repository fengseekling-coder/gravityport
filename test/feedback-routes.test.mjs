// Task 158: feedback routes — real runtime + a local fake collection service.
// MOSA_FEEDBACK_URL / MOSA_FEEDBACK_TIMEOUT_MS steer the forwarder at request
// time, so one runtime covers the success, mapping, refused, and timeout cases.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Buffer } from "node:buffer";
import test from "node:test";

import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { uninstallDiagnosticLog } from "../lib/diagnostic-log.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageVersion = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version;

function mutationHeaders(runtime) {
  return { "content-type": "application/json", "x-mosa-client-token": runtime.clientToken };
}

function setEnv(values) {
  const saved = Object.entries(values).map(([key, value]) => [key, process.env[key], value]);
  for (const [key, , value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, previous] of saved) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  };
}

// The submit outcome log line carries CJK text; silence console.info for the
// runtime's lifetime so it never prints through the node:test IPC.
async function startFeedbackRuntime(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-feedback-api-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  await mkdir(join(root, "generated-images"), { recursive: true });
  const originalInfo = console.info;
  console.info = () => {};
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir: join(root, "library"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-data"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });
  t.after(async () => {
    await runtime.stop();
    // Fresh buffer and fresh wrapper for the next runtime in this process.
    uninstallDiagnosticLog();
    console.info = originalInfo;
  });
  return runtime;
}

function startFakeCollector(respond) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const record = { url: req.url, method: req.method, headers: req.headers, raw: Buffer.concat(chunks).toString("utf8"), body: null };
      try { record.body = record.raw ? JSON.parse(record.raw) : null; } catch { /* raw kept for diagnosis */ }
      requests.push(record);
      respond(req, res, record);
    });
  });
  return new Promise((resolveCollector) => {
    server.listen(0, "127.0.0.1", () => resolveCollector({
      requests,
      url: `http://127.0.0.1:${server.address().port}/api/feedback`,
      close: () => new Promise((done) => server.close(() => done())),
    }));
  });
}

async function submit(runtime, payload, headers) {
  return fetch(`${runtime.url}/api/feedback/submit`, {
    method: "POST",
    headers: headers || mutationHeaders(runtime),
    body: JSON.stringify(payload),
  });
}

test("GET diagnostics serves the redacted buffer and the app identity", async (t) => {
  const restore = setEnv({ MOSA_FEEDBACK_URL: "http://127.0.0.1:1/api/feedback" });
  try {
    const runtime = await startFeedbackRuntime(t);
    console.error("[MOSA] leak probe token=abcdef and alice@example.com");
    const response = await fetch(`${runtime.url}/api/feedback/diagnostics`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.app.product, "GravityPort");
    assert.equal(data.app.version, packageVersion);
    const expectedPlatform = { darwin: "macos", win32: "windows" }[process.platform] || "other";
    assert.equal(data.app.platform, expectedPlatform);
    assert.equal(data.app.arch, process.arch);
    assert.ok(typeof data.app.osVersion === "string" && data.app.osVersion.length > 0);
    if (data.app.gitSha !== undefined) {
      assert.ok(data.app.gitSha.length > 0 && data.app.gitSha.length <= 40);
    }
    assert.ok(data.diagnostics.text.includes("leak probe"), "the buffered line reaches the preview");
    assert.ok(data.diagnostics.text.includes("token=<已隐藏>"), "token values masked");
    assert.ok(!data.diagnostics.text.includes("abcdef"), "raw token value gone");
    assert.ok(data.diagnostics.text.includes("<邮箱>"), "emails masked");
    assert.equal(data.diagnostics.lines, data.diagnostics.text ? data.diagnostics.text.split("\n").length : 0);
    assert.equal(data.diagnostics.bytes, Buffer.byteLength(data.diagnostics.text, "utf8"));
  } finally {
    restore();
  }
});

test("a valid submit forwards the contract payload and returns ok", async (t) => {
  const collector = await startFakeCollector((req, res) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: "fb_123" }));
  });
  const restore = setEnv({ MOSA_FEEDBACK_URL: collector.url });
  try {
    const runtime = await startFeedbackRuntime(t);
    const response = await submit(runtime, {
      kind: "idea",
      message: "  请给画廊加一个排序  ",
      contact: "me@example.com",
      locale: "zh",
      diagnostics: `preview with ${homedir()}/inside and token=secret123`,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, id: "fb_123" });
    assert.equal(collector.requests.length, 1);
    const sent = collector.requests[0];
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, "/api/feedback");
    assert.equal(sent.headers["x-gravityport-client"], "desktop");
    assert.ok(String(sent.headers["content-type"]).startsWith("application/json"));
    assert.equal(sent.body.schema, 1);
    assert.equal(sent.body.kind, "idea");
    assert.equal(sent.body.message, "请给画廊加一个排序", "message trimmed");
    assert.equal(sent.body.contact, "me@example.com");
    assert.equal(sent.body.locale, "zh");
    assert.equal(sent.body.app.product, "GravityPort");
    for (const key of Object.keys(sent.body.app)) {
      assert.ok(["product", "version", "platform", "osVersion", "arch", "gitSha"].includes(key), `app field ${key}`);
    }
    assert.deepEqual(
      Object.keys(sent.body).sort(),
      ["app", "contact", "diagnostics", "kind", "locale", "message", "schema"],
      "no extra fields beyond the contract",
    );
    // The forwarded copy is re-redacted locally, never trusted from the panel.
    assert.ok(sent.body.diagnostics.includes("token=<已隐藏>"), "token re-redacted");
    assert.ok(!sent.body.diagnostics.includes("secret123"), "raw token gone");
    assert.ok(sent.body.diagnostics.includes("~/inside"), "home dir re-redacted");
    assert.ok(!sent.body.diagnostics.includes(`${homedir()}/inside`), "raw home path gone");
  } finally {
    restore();
    await collector.close();
  }
});

test("an unchecked log box sends no diagnostics and an empty contact is omitted", async (t) => {
  const collector = await startFakeCollector((req, res) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: "fb_x" }));
  });
  const restore = setEnv({ MOSA_FEEDBACK_URL: collector.url });
  try {
    const runtime = await startFeedbackRuntime(t);
    const response = await submit(runtime, { kind: "bug", message: "内容", contact: "", locale: "en" });
    assert.equal(response.status, 200);
    assert.equal(collector.requests.length, 1);
    const body = collector.requests[0].body;
    assert.ok(!("diagnostics" in body), "no diagnostics field when unchecked");
    assert.ok(!("contact" in body), "empty contact omitted");
    assert.equal(body.locale, "en");
  } finally {
    restore();
    await collector.close();
  }
});

test("local validation rejects bad payloads before anything is sent", async (t) => {
  const collector = await startFakeCollector((req, res) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: "fb_never" }));
  });
  const restore = setEnv({ MOSA_FEEDBACK_URL: collector.url });
  try {
    const runtime = await startFeedbackRuntime(t);
    const cases = [
      [{ kind: "bug", message: "   ", locale: "zh" }, "message"],
      [{ kind: "bug", message: "x".repeat(5001), locale: "zh" }, "message"],
      [{ kind: "bug", message: "ok", contact: "y".repeat(201), locale: "zh" }, "contact"],
      [{ kind: "feature", message: "ok", locale: "zh" }, "kind"],
      [{ kind: "bug", message: "ok", locale: "fr" }, "locale"],
      [{ kind: "bug", message: "ok", locale: "zh", diagnostics: 42 }, "diagnostics"],
    ];
    for (const [payload, field] of cases) {
      const response = await submit(runtime, payload);
      assert.equal(response.status, 400, JSON.stringify(payload).slice(0, 60));
      const data = await response.json();
      assert.equal(data.code, "FEEDBACK_INVALID");
      assert.equal(data.field, field);
    }
    assert.equal(collector.requests.length, 0, "the collector never sees rejected payloads");
  } finally {
    restore();
    await collector.close();
  }
});

test("collector statuses map onto the local codes", async (t) => {
  let respondWith = { status: 201, body: { ok: true, id: "fb_1" } };
  const collector = await startFakeCollector((req, res) => {
    res.writeHead(respondWith.status, { "content-type": "application/json" });
    res.end(JSON.stringify(respondWith.body));
  });
  const restore = setEnv({ MOSA_FEEDBACK_URL: collector.url });
  try {
    const runtime = await startFeedbackRuntime(t);
    const mappings = [
      [400, 400, "FEEDBACK_INVALID"],
      [413, 413, "FEEDBACK_TOO_LARGE"],
      [429, 429, "FEEDBACK_RATE_LIMITED"],
      [503, 503, "FEEDBACK_UNAVAILABLE"],
      [500, 502, "FEEDBACK_UPSTREAM"],
      [302, 502, "FEEDBACK_UPSTREAM"],
    ];
    for (const [upstream, expectedStatus, expectedCode] of mappings) {
      respondWith = { status: upstream, body: { code: "UPSTREAM_SAYS" } };
      const response = await submit(runtime, { kind: "bug", message: "map this", locale: "zh" });
      assert.equal(response.status, expectedStatus, `upstream ${upstream}`);
      const data = await response.json();
      assert.equal(data.code, expectedCode, `upstream ${upstream}`);
    }
    assert.equal(collector.requests.length, mappings.length);
  } finally {
    restore();
    await collector.close();
  }
});

test("a refused connection maps to FEEDBACK_OFFLINE", async (t) => {
  const restore = setEnv({ MOSA_FEEDBACK_URL: "http://127.0.0.1:1/api/feedback" });
  try {
    const runtime = await startFeedbackRuntime(t);
    const response = await submit(runtime, { kind: "bug", message: "offline", locale: "zh" });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "FEEDBACK_OFFLINE");
  } finally {
    restore();
  }
});

test("a slow collection service hits the timeout and maps to FEEDBACK_OFFLINE", async (t) => {
  const collector = await startFakeCollector((req, res) => {
    // Never answer inside the injected timeout window.
    setTimeout(() => {
      try {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: "fb_late" }));
      } catch { /* the socket is already gone. */ }
    }, 3000);
  });
  const restore = setEnv({ MOSA_FEEDBACK_URL: collector.url, MOSA_FEEDBACK_TIMEOUT_MS: "150" });
  try {
    const runtime = await startFeedbackRuntime(t);
    const started = Date.now();
    const response = await submit(runtime, { kind: "bug", message: "timeout", locale: "zh" });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "FEEDBACK_OFFLINE");
    assert.ok(Date.now() - started < 2500, "the local timeout fires well before the upstream answer");
    assert.equal(collector.requests.length, 1, "the request did leave for the collector");
  } finally {
    restore();
    await collector.close();
  }
});

test("an outbound payload above 300 KB is refused locally", async (t) => {
  const collector = await startFakeCollector((req, res) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: "fb_never" }));
  });
  const restore = setEnv({ MOSA_FEEDBACK_URL: collector.url });
  try {
    const runtime = await startFeedbackRuntime(t);
    const response = await submit(runtime, {
      kind: "bug",
      message: "大内容",
      locale: "zh",
      diagnostics: "造".repeat(120000),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, "FEEDBACK_TOO_LARGE");
    assert.equal(collector.requests.length, 0);
  } finally {
    restore();
    await collector.close();
  }
});

test("POST without the mutation client token is rejected", async (t) => {
  const collector = await startFakeCollector((req, res) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: "fb_never" }));
  });
  const restore = setEnv({ MOSA_FEEDBACK_URL: collector.url });
  try {
    const runtime = await startFeedbackRuntime(t);
    const response = await submit(runtime, { kind: "bug", message: "no token", locale: "zh" }, {
      "content-type": "application/json",
      "x-mosa-client-token": "not-the-real-token",
    });
    assert.equal(response.status, 401);
    assert.equal(collector.requests.length, 0);
  } finally {
    restore();
    await collector.close();
  }
});
