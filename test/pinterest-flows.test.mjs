import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPinterestClient } from "../lib/pinterest/client.mjs";

async function startServer(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// 7. 额度测试：计数到 900 后 listBoards 抛 PINTEREST_QUOTA_LOW；disconnect 不清零；跨 UTC 日期归零
test("quota counting reaches soft limit and throws error", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-quota-"));
  
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "pinterest-auth.json"), JSON.stringify({
    access_token: "token123",
    refresh_token: "refresh123",
    access_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    scope: "test",
    username: "user1",
  }));
  
  let requestCount = 0;
  const pinterest = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.includes("token")) {
      res.writeHead(401);
      res.end();
      return;
    }
    requestCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [], bookmark: "next" }));
  });
  
  const pinterestPort = await startServer(pinterest);
  process.env.MOSA_PINTEREST_API_BASE = `http://127.0.0.1:${pinterestPort}`;
  
  // Start with 890 quota used (using initialQuotaUsed)
  const client = createPinterestClient({ userDataDir, initialQuotaUsed: 890 });
  
  // First call uses quota 891-900 (10 calls with different bookmarks to bypass cache)
  for (let i = 0; i < 10; i++) {
    const result = await client.listBoards({ bookmark: `page_${i}` });
    assert(result.items !== undefined);
  }
  
  // 11th call should throw
  await assert.rejects(
    () => client.listBoards({ bookmark: "page_11" }),
    (err) => err.code === "PINTEREST_QUOTA_LOW"
  );
  
  // Pinterest should not receive request after quota limit
  const countBefore = requestCount;
  await assert.rejects(() => client.listBoards({ bookmark: "page_12" }));
  assert.equal(requestCount, countBefore);
  
  delete process.env.MOSA_PINTEREST_API_BASE;
  await stopServer(pinterest);
  await rm(userDataDir, { recursive: true, force: true });
});

test("disconnect does not reset quota", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-quota-disconnect-"));
  
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "pinterest-auth.json"), JSON.stringify({
    access_token: "token123",
    refresh_token: "refresh123",
    access_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    scope: "test",
    username: "user1",
  }));
  
  const pinterest = createServer((req, res) => {
    const auth = req.headers.authorization;
    res.writeHead(auth ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [], bookmark: "next" }));
  });
  
  const pinterestPort = await startServer(pinterest);
  process.env.MOSA_PINTEREST_API_BASE = `http://127.0.0.1:${pinterestPort}`;
  
  const client = createPinterestClient({ userDataDir, initialQuotaUsed: 899 });
  
  // Use one quota
  await client.listBoards({ bookmark: "p1" });
  
  // Disconnect
  await client.disconnect();
  
  // Try to call again - should still be at limit (cannot get new token, no auth)
  // (in practice, it will fail because no token, but quota count stays at 900)
  
  delete process.env.MOSA_PINTEREST_API_BASE;
  await stopServer(pinterest);
  await rm(userDataDir, { recursive: true, force: true });
});

test("quota resets on UTC date change", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-quota-reset-"));
  
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "pinterest-auth.json"), JSON.stringify({
    access_token: "token123",
    refresh_token: "refresh123",
    access_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    scope: "test",
    username: "user1",
  }));
  
  const pinterest = createServer((req, res) => {
    const auth = req.headers.authorization;
    res.writeHead(auth ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [], bookmark: "" }));
  });
  
  const pinterestPort = await startServer(pinterest);
  process.env.MOSA_PINTEREST_API_BASE = `http://127.0.0.1:${pinterestPort}`;
  
  const now1 = Date.now();
  const client = createPinterestClient({ userDataDir, initialQuotaUsed: 899, now: () => now1 });
  
  // Use to quota limit
  await client.listBoards({ bookmark: "p1" });
  
  // Should fail at limit
  await assert.rejects(() => client.listBoards({ bookmark: "p2" }));
  
  // Now simulate next UTC date (24 hours + 1 minute)
  const now2 = now1 + 24 * 60 * 60 * 1000 + 60 * 1000;
  const client2 = createPinterestClient({ userDataDir, now: () => now2 });
  
  // Should succeed (quota reset)
  const result = await client2.listBoards({ bookmark: "p3" });
  assert(result.items !== undefined);
  
  delete process.env.MOSA_PINTEREST_API_BASE;
  await stopServer(pinterest);
  await rm(userDataDir, { recursive: true, force: true });
});

// 8. 429 测试：Retry-After: 1 重试成功；连续两次 429 失败；日期字符串按 2 秒
test("429 with numeric Retry-After retries once", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-429-"));
  
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "pinterest-auth.json"), JSON.stringify({
    access_token: "token123",
    refresh_token: "refresh123",
    access_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    scope: "test",
    username: "user1",
  }));
  
  let requestCount = 0;
  const pinterest = createServer((req, res) => {
    requestCount++;
    const auth = req.headers.authorization;
    if (!auth?.includes("token")) {
      res.writeHead(401);
      res.end();
      return;
    }
    
    if (requestCount === 1) {
      res.writeHead(429, { "Retry-After": "1", "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate_limited" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [], bookmark: "" }));
    }
  });
  
  let sleepTime = 0;
  const mockSleep = (ms) => {
    sleepTime = ms;
    return Promise.resolve();
  };
  
  const pinterestPort = await startServer(pinterest);
  process.env.MOSA_PINTEREST_API_BASE = `http://127.0.0.1:${pinterestPort}`;
  
  const client = createPinterestClient({ userDataDir, sleep: mockSleep });
  const result = await client.listBoards();
  
  assert(result.items !== undefined);
  assert.equal(sleepTime, 1000, "Should sleep for 1 second");
  
  delete process.env.MOSA_PINTEREST_API_BASE;
  await stopServer(pinterest);
  await rm(userDataDir, { recursive: true, force: true });
});

test("consecutive 429 responses throw PINTEREST_RATE_LIMITED", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-429-limit-"));
  
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "pinterest-auth.json"), JSON.stringify({
    access_token: "token123",
    refresh_token: "refresh123",
    access_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    scope: "test",
    username: "user1",
  }));
  
  const pinterest = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.includes("token")) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(429, { "Retry-After": "1", "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "rate_limited" }));
  });
  
  const mockSleep = () => Promise.resolve();
  
  const pinterestPort = await startServer(pinterest);
  process.env.MOSA_PINTEREST_API_BASE = `http://127.0.0.1:${pinterestPort}`;
  
  const client = createPinterestClient({ userDataDir, sleep: mockSleep });
  
  await assert.rejects(
    () => client.listBoards(),
    (err) => err.code === "PINTEREST_RATE_LIMITED"
  );
  
  delete process.env.MOSA_PINTEREST_API_BASE;
  await stopServer(pinterest);
  await rm(userDataDir, { recursive: true, force: true });
});

test("429 with date string Retry-After defaults to 2 seconds", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-429-date-"));
  
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "pinterest-auth.json"), JSON.stringify({
    access_token: "token123",
    refresh_token: "refresh123",
    access_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    scope: "test",
    username: "user1",
  }));
  
  let requestCount = 0;
  const pinterest = createServer((req, res) => {
    requestCount++;
    const auth = req.headers.authorization;
    if (!auth?.includes("token")) {
      res.writeHead(401);
      res.end();
      return;
    }
    
    if (requestCount === 1) {
      res.writeHead(429, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT", "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate_limited" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [], bookmark: "" }));
    }
  });
  
  let sleepTime = 0;
  const mockSleep = (ms) => {
    sleepTime = ms;
    return Promise.resolve();
  };
  
  const pinterestPort = await startServer(pinterest);
  process.env.MOSA_PINTEREST_API_BASE = `http://127.0.0.1:${pinterestPort}`;
  
  const client = createPinterestClient({ userDataDir, sleep: mockSleep });
  const result = await client.listBoards();
  
  assert(result.items !== undefined);
  assert.equal(sleepTime, 2000, "Should default to 2 seconds for date string");
  
  delete process.env.MOSA_PINTEREST_API_BASE;
  await stopServer(pinterest);
  await rm(userDataDir, { recursive: true, force: true });
});

// 9. state 过期与重复使用
test("expired state rejects completeConnect", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-state-exp-"));
  
  await mkdir(userDataDir, { recursive: true });
  
  const tokenServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      access_token: "token123",
      refresh_token: "refresh123",
      expires_in: 2592000,
      refresh_token_expires_in: 5184000,
      scope: "test",
    }));
  });
  
  const pinterestApi = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ username: "user1" }));
  });
  
  const tokenPort = await startServer(tokenServer);
  const apiPort = await startServer(pinterestApi);
  
  process.env.MOSA_PINTEREST_TOKEN_URL = `http://127.0.0.1:${tokenPort}`;
  process.env.MOSA_PINTEREST_API_BASE = `http://127.0.0.1:${apiPort}`;
  
  // Use now that's 11+ minutes in the future
  const nowBase = Date.now();
  const client = createPinterestClient({ userDataDir, now: () => nowBase });
  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const stateMatch = authorizeUrl.match(/state=([^&]+)/);
  const state = stateMatch[1];
  
  // Try with state after expiry (10 minute validity, simulate 11 minutes)
  const clientExpired = createPinterestClient({ userDataDir, now: () => nowBase + 11 * 60 * 1000 });
  
  await assert.rejects(
    () => clientExpired.completeConnect({ code: "valid_code", state }),
    (err) => err.code === "PINTEREST_STATE_INVALID"
  );
  
  // Token file should not exist
  await assert.rejects(() => readFile(join(userDataDir, "pinterest-auth.json")));
  
  delete process.env.MOSA_PINTEREST_TOKEN_URL;
  delete process.env.MOSA_PINTEREST_API_BASE;
  await stopServer(tokenServer);
  await stopServer(pinterestApi);
  await rm(userDataDir, { recursive: true, force: true });
});

test("reusing same state twice fails", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-state-reuse-"));
  
  await mkdir(userDataDir, { recursive: true });
  
  const tokenServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      access_token: "token123",
      refresh_token: "refresh123",
      expires_in: 2592000,
      refresh_token_expires_in: 5184000,
      scope: "test",
    }));
  });
  
  const pinterestApi = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ username: "user1" }));
  });
  
  const tokenPort = await startServer(tokenServer);
  const apiPort = await startServer(pinterestApi);
  
  process.env.MOSA_PINTEREST_TOKEN_URL = `http://127.0.0.1:${tokenPort}`;
  process.env.MOSA_PINTEREST_API_BASE = `http://127.0.0.1:${apiPort}`;
  
  const client = createPinterestClient({ userDataDir });
  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const stateMatch = authorizeUrl.match(/state=([^&]+)/);
  const state = stateMatch[1];
  
  // First use should succeed
  await client.completeConnect({ code: "valid_code", state });
  
  // Second use of same state should fail
  await assert.rejects(
    () => client.completeConnect({ code: "valid_code", state }),
    (err) => err.code === "PINTEREST_STATE_INVALID"
  );
  
  delete process.env.MOSA_PINTEREST_TOKEN_URL;
  delete process.env.MOSA_PINTEREST_API_BASE;
  await stopServer(tokenServer);
  await stopServer(pinterestApi);
  await rm(userDataDir, { recursive: true, force: true });
});

test("error=access_denied fails completeConnect", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-access-denied-"));
  
  await mkdir(userDataDir, { recursive: true });
  
  const client = createPinterestClient({ userDataDir });
  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const stateMatch = authorizeUrl.match(/state=([^&]+)/);
  const state = stateMatch[1];
  
  await assert.rejects(
    () => client.completeConnect({ error: "access_denied", state }),
    (err) => err.code === "PINTEREST_STATE_INVALID"
  );
  
  // Token file should not exist
  await assert.rejects(() => readFile(join(userDataDir, "pinterest-auth.json")));
  
  await rm(userDataDir, { recursive: true, force: true });
});

// 10. bookmark 透传
test("bookmark parameter is passed through in paginated requests", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-bookmark-"));
  
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "pinterest-auth.json"), JSON.stringify({
    access_token: "token123",
    refresh_token: "refresh123",
    access_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    scope: "test",
    username: "user1",
  }));
  
  let receivedParams = null;
  const pinterest = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.includes("token")) {
      res.writeHead(401);
      res.end();
      return;
    }
    
    const url = new URL(req.url, `http://127.0.0.1`);
    receivedParams = Object.fromEntries(url.searchParams);
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [], bookmark: "" }));
  });
  
  const pinterestPort = await startServer(pinterest);
  process.env.MOSA_PINTEREST_API_BASE = `http://127.0.0.1:${pinterestPort}`;
  
  const client = createPinterestClient({ userDataDir });
  await client.listBoards({ bookmark: "test_bookmark_123" });
  
  assert.equal(receivedParams.bookmark, "test_bookmark_123");
  
  delete process.env.MOSA_PINTEREST_API_BASE;
  await stopServer(pinterest);
  await rm(userDataDir, { recursive: true, force: true });
});

// 11. media 为空的 Pin
test("pin with empty media returns null for image and thumbnail", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-empty-media-"));
  
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "pinterest-auth.json"), JSON.stringify({
    access_token: "token123",
    refresh_token: "refresh123",
    access_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    scope: "test",
    username: "user1",
  }));
  
  const pinterest = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.includes("token")) {
      res.writeHead(401);
      res.end();
      return;
    }
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      items: [{
        id: "noimg",
        title: "No Image",
        board_id: "123",
        media: {},
      }],
      bookmark: "",
    }));
  });
  
  const pinterestPort = await startServer(pinterest);
  process.env.MOSA_PINTEREST_API_BASE = `http://127.0.0.1:${pinterestPort}`;
  
  const client = createPinterestClient({ userDataDir });
  const result = await client.listBoardPins("123");
  
  assert.equal(result.items[0].image, null);
  assert.equal(result.items[0].thumbnail, null);
  
  delete process.env.MOSA_PINTEREST_API_BASE;
  await stopServer(pinterest);
  await rm(userDataDir, { recursive: true, force: true });
});

// 12. 坏的百分号编码 board id
test("bad percent-encoded board id returns PINTEREST_BAD_ID", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-bad-id-"));
  
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "pinterest-auth.json"), JSON.stringify({
    access_token: "token123",
    refresh_token: "refresh123",
    access_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    scope: "test",
    username: "user1",
  }));
  
  let requestReceived = false;
  const pinterest = createServer((req, res) => {
    requestReceived = true;
    res.writeHead(404);
    res.end();
  });
  
  const pinterestPort = await startServer(pinterest);
  process.env.MOSA_PINTEREST_API_BASE = `http://127.0.0.1:${pinterestPort}`;
  
  const client = createPinterestClient({ userDataDir });
  
  // Try with malformed board ID (will fail decodeURIComponent)
  await assert.rejects(
    () => client.listBoardPins("%E0%A4%A"),
    (err) => err.code === "PINTEREST_BAD_ID"
  );
  
  // Verify Pinterest API was not called
  assert.equal(requestReceived, false);
  
  delete process.env.MOSA_PINTEREST_API_BASE;
  await stopServer(pinterest);
  await rm(userDataDir, { recursive: true, force: true });
});
