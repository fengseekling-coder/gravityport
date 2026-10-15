import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPinterestClient } from "../lib/pinterest/client.mjs";

function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };
    
    const req = request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: new Map(Object.entries(res.headers)),
          json: async () => JSON.parse(data),
          text: async () => data,
        });
      });
    });
    
    req.on("error", reject);
    
    if (options.body) {
      req.write(options.body);
    }
    
    req.end();
  });
}

function createFakeServices() {
  const fakeTokenServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const data = JSON.parse(body);
      if (data.grant === "refresh_token" && data.refresh_token === "rejected_refresh") {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "pinterest_rejected", status: 401 }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          access_token: "new_token",
          refresh_token: "new_refresh",
          expires_in: 2592000,
          refresh_token_expires_in: 5184000,
          scope: "user_accounts:read",
        }));
      }
    });
  });
  
  const fakePinterestApi = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (req.url === "/user_account" && auth?.includes("token")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ username: "testuser" }));
    } else if (req.url.startsWith("/boards") && auth?.includes("token")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [], bookmark: "" }));
    } else {
      res.writeHead(401);
      res.end();
    }
  });
  
  return { fakeTokenServer, fakePinterestApi };
}

async function startServer(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("Pinterest: auto-refresh near expiry", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-"));
  t.after(() => rm(userDataDir, { recursive: true, force: true }));
  
  const { fakeTokenServer, fakePinterestApi } = createFakeServices();
  const tokenPort = await startServer(fakeTokenServer);
  const apiPort = await startServer(fakePinterestApi);
  t.after(() => Promise.all([stopServer(fakeTokenServer), stopServer(fakePinterestApi)]));
  
  const fetchImpl = (url, options) => {
    const targetUrl = url.replace("http://token", `http://127.0.0.1:${tokenPort}`)
                         .replace("http://api", `http://127.0.0.1:${apiPort}`);
    return httpFetch(targetUrl, options);
  };
  
  const originalTokenUrl = process.env.MOSA_PINTEREST_TOKEN_URL;
  const originalApiBase = process.env.MOSA_PINTEREST_API_BASE;
  process.env.MOSA_PINTEREST_TOKEN_URL = "http://token";
  process.env.MOSA_PINTEREST_API_BASE = "http://api";
  t.after(() => {
    process.env.MOSA_PINTEREST_TOKEN_URL = originalTokenUrl;
    process.env.MOSA_PINTEREST_API_BASE = originalApiBase;
  });
  
  const baseNow = Date.now();
  let currentNow = baseNow;
  const mockNow = () => currentNow;
  
  const tokenPath = join(userDataDir, "pinterest-auth.json");
  await writeFile(tokenPath, JSON.stringify({
    access_token: "old_token",
    refresh_token: "old_refresh",
    access_expires_at: new Date(baseNow + 2 * 24 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(baseNow + 60 * 24 * 60 * 60 * 1000).toISOString(),
    scope: "user_accounts:read",
    username: "testuser",
    connected_at: new Date(baseNow).toISOString(),
  }), { mode: 0o600 });
  
  const client = createPinterestClient({ userDataDir, fetchImpl, now: mockNow });
  
  await client.listBoards();
  
  const tokenContent = JSON.parse(await readFile(tokenPath, "utf-8"));
  assert.equal(tokenContent.access_token, "new_token");
});

test("Pinterest: refresh rejected sets needsReconnect", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-"));
  t.after(() => rm(userDataDir, { recursive: true, force: true }));
  
  const { fakeTokenServer, fakePinterestApi } = createFakeServices();
  const tokenPort = await startServer(fakeTokenServer);
  const apiPort = await startServer(fakePinterestApi);
  t.after(() => Promise.all([stopServer(fakeTokenServer), stopServer(fakePinterestApi)]));
  
  const fetchImpl = (url, options) => {
    const targetUrl = url.replace("http://token", `http://127.0.0.1:${tokenPort}`)
                         .replace("http://api", `http://127.0.0.1:${apiPort}`);
    return httpFetch(targetUrl, options);
  };
  
  const originalTokenUrl = process.env.MOSA_PINTEREST_TOKEN_URL;
  const originalApiBase = process.env.MOSA_PINTEREST_API_BASE;
  process.env.MOSA_PINTEREST_TOKEN_URL = "http://token";
  process.env.MOSA_PINTEREST_API_BASE = "http://api";
  t.after(() => {
    process.env.MOSA_PINTEREST_TOKEN_URL = originalTokenUrl;
    process.env.MOSA_PINTEREST_API_BASE = originalApiBase;
  });
  
  const tokenPath = join(userDataDir, "pinterest-auth.json");
  await writeFile(tokenPath, JSON.stringify({
    access_token: "expiring_token",
    refresh_token: "rejected_refresh",
    access_expires_at: new Date(Date.now() + 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    scope: "user_accounts:read",
    username: "testuser",
    connected_at: new Date().toISOString(),
  }), { mode: 0o600 });
  
  const client = createPinterestClient({ userDataDir, fetchImpl });
  
  await assert.rejects(
    client.listBoards(),
    { code: "PINTEREST_RECONNECT_REQUIRED" }
  );
  
  const status = await client.status();
  assert.equal(status.needsReconnect, true);
});
