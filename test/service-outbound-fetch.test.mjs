// Unit tests for outbound-fetch and proxy integration (task 324).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { handleFeedbackRoute } from "../lib/api/feedback-routes.mjs";
import { outboundFetch, setOutboundFetch } from "../lib/outbound-fetch.mjs";
import { createPinterestClient } from "../lib/pinterest/client.mjs";
import {
  startFakeFeedbackCollector,
  startFakePinterestServer,
  startHttpProxy,
} from "./helpers/local-network-fakes.mjs";

function makeProxyFetch(proxyUrl) {
  const pUrl = new URL(proxyUrl);
  return function proxyFetch(url, init = {}) {
    return new Promise((resolveFetch, rejectFetch) => {
      const targetUrl = new URL(url);
      const headers = {};
      if (init.headers) {
        if (typeof init.headers.forEach === "function") {
          init.headers.forEach((v, k) => { headers[k] = v; });
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) headers[k] = v;
        } else {
          Object.assign(headers, init.headers);
        }
      }
      headers.host = targetUrl.host;

      const req = http.request({
        host: pUrl.hostname,
        port: pUrl.port,
        path: targetUrl.href,
        method: init.method || "GET",
        headers,
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          resolveFetch({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: new Headers(res.headers),
            text: async () => bodyText,
            json: async () => JSON.parse(bodyText),
          });
        });
      });

      req.on("error", rejectFetch);
      if (init.body) {
        req.write(init.body);
      }
      req.end();
    });
  };
}

async function sendFeedbackViaRoute() {
  const originalInfo = console.info;
  console.info = () => {};
  try {
    const reqBody = JSON.stringify({ kind: "bug", message: "test feedback", locale: "zh" });
    const req = Readable.from([Buffer.from(reqBody)]);
    req.method = "POST";
    req.headers = { "content-type": "application/json" };
    let resBody = "";
    const res = {
      statusCode: 0,
      writeHead(status) { this.statusCode = status; },
      setHeader() {},
      end(chunk) { if (chunk) resBody += chunk; },
    };
    const url = new URL("http://127.0.0.1/api/feedback/submit");
    const handled = await handleFeedbackRoute({ req, res, url, context: { libraryDir: "/tmp", buildIdentity: {} } });
    return { handled, status: res.statusCode, body: resBody };
  } finally {
    console.info = originalInfo;
  }
}

test("outboundFetch defaults to direct when no outbound function is configured", async () => {
  setOutboundFetch(null);
  const collector = await startFakeFeedbackCollector();
  const proxy = await startHttpProxy();
  const originalFeedbackUrl = process.env.MOSA_FEEDBACK_URL;
  process.env.MOSA_FEEDBACK_URL = collector.url;

  try {
    const result = await sendFeedbackViaRoute();
    assert.equal(result.handled, true);
    assert.equal(result.status, 200);
    assert.equal(collector.requests.length, 1, "Fake collector should have received 1 feedback");
    assert.equal(proxy.requests.length, 0, "HTTP proxy should have received 0 requests when direct");
  } finally {
    process.env.MOSA_FEEDBACK_URL = originalFeedbackUrl;
    await collector.close();
    await proxy.close();
  }
});

test("outboundFetch routes through custom proxy function when setOutboundFetch is configured", async () => {
  const collector = await startFakeFeedbackCollector();
  const pinServer = await startFakePinterestServer();
  const proxy = await startHttpProxy();
  const proxyFetch = makeProxyFetch(proxy.url);

  const originalFeedbackUrl = process.env.MOSA_FEEDBACK_URL;
  const originalPinTokenUrl = process.env.MOSA_PINTEREST_TOKEN_URL;
  const originalPinApiBase = process.env.MOSA_PINTEREST_API_BASE;

  process.env.MOSA_FEEDBACK_URL = collector.url;
  process.env.MOSA_PINTEREST_TOKEN_URL = pinServer.tokenUrl;
  process.env.MOSA_PINTEREST_API_BASE = pinServer.apiBase;

  const tempUserData = await mkdtemp(join(tmpdir(), "proxy-test-user-data-"));

  try {
    setOutboundFetch(proxyFetch);

    // 1. Send feedback
    const fbResult = await sendFeedbackViaRoute();
    assert.equal(fbResult.handled, true);
    assert.equal(fbResult.status, 200);
    assert.equal(collector.requests.length, 1);
    assert.equal(proxy.requests.length, 1);
    assert.equal(proxy.requests[0].method, "POST");
    assert.ok(proxy.requests[0].url.includes("/api/feedback"));

    // 2. Pinterest OAuth exchange (exchange code -> /v5/oauth/token and /user_account)
    const pinClient = createPinterestClient({ userDataDir: tempUserData });
    const { authorizeUrl } = pinClient.beginConnect({ port: 43517 });
    const state = new URL(authorizeUrl).searchParams.get("state");
    await pinClient.completeConnect({ code: "test_code_123", state });

    // Verify token exchange went through proxy
    const exchangeReq = proxy.requests.find(
      (r) => r.method === "POST" && r.url.includes("/v5/oauth/token") && r.url === pinServer.tokenUrl,
    );
    assert.ok(exchangeReq, "Token exchange request was sent through proxy");

    // 3. Expire token and trigger refresh + API call
    const tokenPath = join(tempUserData, "pinterest-auth.json");
    const tokenData = JSON.parse(await readFile(tokenPath, "utf8"));
    tokenData.access_expires_at = new Date(Date.now() - 60000).toISOString();
    await writeFile(tokenPath, JSON.stringify(tokenData));

    const pinClient2 = createPinterestClient({ userDataDir: tempUserData });
    const boards = await pinClient2.listBoards();
    assert.ok(Array.isArray(boards.items));

    // Verify refresh token and API calls went through proxy
    const refreshReq = proxy.requests.filter(
      (r) => r.method === "POST" && r.url.includes("/v5/oauth/token"),
    )[1];
    assert.ok(refreshReq, "Token refresh request was sent through proxy");

    const apiReq = proxy.requests.find(
      (r) => r.method === "GET" && r.url.includes("/v5/boards"),
    );
    assert.ok(apiReq, "Pinterest boards API call was sent through proxy");

    // 4. Confirm setOutboundFetch(null) restores direct connection
    setOutboundFetch(null);
    const proxyCountBefore = proxy.requests.length;
    const fbDirect = await sendFeedbackViaRoute();
    assert.equal(fbDirect.handled, true);
    assert.equal(fbDirect.status, 200);
    assert.equal(collector.requests.length, 2);
    assert.equal(proxy.requests.length, proxyCountBefore, "Proxy received 0 additional requests after setOutboundFetch(null)");
  } finally {
    setOutboundFetch(null);
    process.env.MOSA_FEEDBACK_URL = originalFeedbackUrl;
    process.env.MOSA_PINTEREST_TOKEN_URL = originalPinTokenUrl;
    process.env.MOSA_PINTEREST_API_BASE = originalPinApiBase;
    await collector.close();
    await pinServer.close();
    await proxy.close();
    await rm(tempUserData, { recursive: true, force: true });
  }
});

test("outboundFetch enforces redirect: 'error' on all requests", async () => {
  const recorded = [];
  setOutboundFetch((url, init) => {
    recorded.push({ url, init });
    return Promise.resolve(new Response("ok"));
  });

  try {
    await outboundFetch("http://127.0.0.1/follow", { method: "POST", redirect: "follow", headers: { x: "1" } });
    await outboundFetch("http://127.0.0.1/manual", { method: "GET", redirect: "manual" });
    await outboundFetch("http://127.0.0.1/default");

    assert.equal(recorded.length, 3);
    assert.equal(recorded[0].init.redirect, "error");
    assert.equal(recorded[0].init.method, "POST");
    assert.deepEqual(recorded[0].init.headers, { x: "1" });

    assert.equal(recorded[1].init.redirect, "error");
    assert.equal(recorded[1].init.method, "GET");

    assert.equal(recorded[2].init.redirect, "error");
  } finally {
    setOutboundFetch(null);
  }
});

test("outboundFetch evaluates globalThis.fetch dynamically at call time when unset", async () => {
  setOutboundFetch(null);
  const originalFetch = globalThis.fetch;
  let dynamicFetchCalled = false;
  try {
    globalThis.fetch = async (url, init) => {
      dynamicFetchCalled = true;
      return new Response(`dynamic-ok:${init.redirect}`);
    };
    const res = await outboundFetch("http://127.0.0.1/dynamic");
    assert.equal(dynamicFetchCalled, true);
    assert.equal(await res.text(), "dynamic-ok:error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lib/ has no direct fetch() or globalThis.fetch calls outside outbound-fetch.mjs", () => {
  const libDir = resolve(import.meta.dirname, "..", "lib");
  function findFiles(dir) {
    let files = [];
    for (const item of readdirSync(dir)) {
      const full = join(dir, item);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        files = files.concat(findFiles(full));
      } else if (full.endsWith(".mjs") || full.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  const libFiles = findFiles(libDir);
  const violations = [];
  for (const file of libFiles) {
    if (file.endsWith("outbound-fetch.mjs")) continue;
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      if (/(?<![a-zA-Z0-9_$.])fetch\(|(?<![a-zA-Z0-9_$.])fetch\s*[,=]|globalThis\.fetch/.test(line)) {
        violations.push(`${file}:${idx + 1}: ${trimmed}`);
      }
    });
  }

  assert.deepEqual(violations, [], `Direct fetch calls found in lib/:\n${violations.join("\n")}`);
});
