import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, stat, rm } from "node:fs/promises";
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
          statusText: res.statusMessage,
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

// Fake Pinterest API and token service.
function createFakeServices() {
  const requestLog = [];
  let pinterestRequestCount = 0;
  
  const fakeTokenServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        
        if (data.grant === "authorization_code") {
          if (data.code === "valid_code") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              access_token: "access_token_123",
              refresh_token: "refresh_token_123",
              expires_in: 2592000,
              refresh_token_expires_in: 5184000,
              scope: "user_accounts:read,boards:read",
            }));
          } else {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "pinterest_rejected", status: 401 }));
          }
        } else if (data.grant === "refresh_token") {
          if (data.refresh_token.includes("rejected")) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "pinterest_rejected", status: 401 }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              access_token: "new_access_token",
              refresh_token: "new_refresh_token",
              expires_in: 2592000,
              refresh_token_expires_in: 5184000,
              scope: "user_accounts:read,boards:read",
            }));
          }
        }
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
  });
  
  const fakePinterestApi = createServer((req, res) => {
    requestLog.push({ url: req.url });
    pinterestRequestCount++;
    
    const auth = req.headers.authorization;
    
    if (req.url === "/user_account") {
      if (auth?.includes("access_token") || auth?.includes("new_access_token")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ username: "testuser" }));
      } else {
        res.writeHead(401);
        res.end();
      }
    } else if (req.url.startsWith("/boards")) {
      if (!auth?.includes("token")) {
        res.writeHead(401);
        res.end();
        return;
      }
      
      if (req.url.includes("/123/pins")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          items: [{
            id: "pin1",
            title: "Pin 1",
            board_id: "123",
            media: {
              images: {
                "1200x": { url: "https://i.pinimg.com/1200x/a.jpg", width: 1200, height: 800 },
                "600x": { url: "https://i.pinimg.com/600x/a.jpg", width: 600, height: 400 },
              },
            },
          }],
          bookmark: "",
        }));
      } else if (req.url.includes("/999/pins")) {
        // Video pin
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          items: [{
            id: "vid1",
            title: "Video",
            board_id: "999",
            media: {
              media_type: "video",
              cover_image_url: "https://i.pinimg.com/cover.jpg",
              images: {
                "1200x": { url: "https://i.pinimg.com/1200x/v.jpg", width: 1200, height: 800 },
                "600x": { url: "https://i.pinimg.com/600x/v.jpg", width: 600, height: 400 },
              },
            },
          }],
          bookmark: "",
        }));
      } else if (req.url.includes("/888/pins")) {
        // Multiple images
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          items: [{
            id: "multi1",
            media: {
              media_type: "multiple_images",
              items: [{
                images: {
                  "1200x": { url: "https://i.pinimg.com/1200x/m.jpg", width: 1200, height: 1000 },
                  "600x": { url: "https://i.pinimg.com/600x/m.jpg", width: 600, height: 500 },
                },
              }],
            },
          }],
          bookmark: "",
        }));
      } else if (req.url.includes("/777/pins")) {
        // No images
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          items: [{ id: "noimg", media: {} }],
          bookmark: "",
        }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          items: [
            { id: "123", name: "Board 1", privacy: "PUBLIC", pin_count: 10, media: { image_cover_url: "https://i.pinimg.com/c.jpg" } },
          ],
          bookmark: "",
        }));
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  return { fakeTokenServer, fakePinterestApi, requestLog, getPinterestRequestCount: () => pinterestRequestCount };
}

async function startServer(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("Pinterest: full connection flow", async (t) => {
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
  
  const client = createPinterestClient({ userDataDir, fetchImpl });
  
  let status = await client.status();
  assert.equal(status.connected, false);
  
  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  assert.match(authorizeUrl, /pinterest\.com\/oauth/);
  const state = new URL(authorizeUrl).searchParams.get("state");
  
  await client.completeConnect({ code: "valid_code", state });
  
  const tokenPath = join(userDataDir, "pinterest-auth.json");
  const tokenStats = await stat(tokenPath);
  assert.ok(tokenStats.isFile());
  
  if (process.platform !== "win32") {
    assert.equal(tokenStats.mode & 0o777, 0o600);
  }
  
  status = await client.status();
  assert.equal(status.connected, true);
  assert.equal(status.username, "testuser");
  assert.doesNotMatch(JSON.stringify(status), /access_token|refresh_token/);
  
  const tokenContent = JSON.parse(await readFile(tokenPath, "utf-8"));
  assert.equal(tokenContent.access_token, "access_token_123");
  assert.equal(tokenContent.username, "testuser");
});

test("Pinterest: state validation", async (t) => {
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
  
  const client = createPinterestClient({ userDataDir, fetchImpl });
  
  await assert.rejects(
    client.completeConnect({ code: "valid_code", state: "invalid" }),
    { code: "PINTEREST_STATE_INVALID" }
  );
  
  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const state = new URL(authorizeUrl).searchParams.get("state");
  await client.completeConnect({ code: "valid_code", state });
  
  await assert.rejects(
    client.completeConnect({ code: "valid_code", state }),
    { code: "PINTEREST_STATE_INVALID" }
  );
});

test("Pinterest: port mismatch", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-"));
  t.after(() => rm(userDataDir, { recursive: true, force: true }));
  
  const client = createPinterestClient({ userDataDir });
  
  assert.throws(
    () => client.beginConnect({ port: 9999 }),
    { code: "PINTEREST_PORT_MISMATCH" }
  );
});

test("Pinterest: token refresh and field normalization", async (t) => {
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
  
  const client = createPinterestClient({ userDataDir, fetchImpl });
  
  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const state = new URL(authorizeUrl).searchParams.get("state");
  await client.completeConnect({ code: "valid_code", state });
  
  const boards = await client.listBoards();
  assert.equal(boards.items[0].id, "123");
  assert.equal(boards.items[0].cover_url, "https://i.pinimg.com/c.jpg");
  
  const pins = await client.listBoardPins("123");
  assert.equal(pins.items[0].id, "pin1");
  assert.equal(pins.items[0].image.url, "https://i.pinimg.com/1200x/a.jpg");
  assert.equal(pins.items[0].thumbnail.url, "https://i.pinimg.com/600x/a.jpg");
  assert.equal(pins.items[0].pin_url, "https://www.pinterest.com/pin/pin1/");
  
  const videoPins = await client.listBoardPins("999");
  assert.equal(videoPins.items[0].media_type, "video");
  assert.equal(videoPins.items[0].video_cover_url, "https://i.pinimg.com/cover.jpg");
  
  const multiPins = await client.listBoardPins("888");
  assert.equal(multiPins.items[0].image.url, "https://i.pinimg.com/1200x/m.jpg");
  
  const noimgPins = await client.listBoardPins("777");
  assert.equal(noimgPins.items[0].image, null);
});

test("Pinterest: caching and disconnect", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-"));
  t.after(() => rm(userDataDir, { recursive: true, force: true }));
  
  const { fakeTokenServer, fakePinterestApi, getPinterestRequestCount } = createFakeServices();
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
  
  const client = createPinterestClient({ userDataDir, fetchImpl });
  
  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const state = new URL(authorizeUrl).searchParams.get("state");
  await client.completeConnect({ code: "valid_code", state });
  
  const countBefore = getPinterestRequestCount();
  await client.listBoards();
  const countAfter1 = getPinterestRequestCount();
  assert.equal(countAfter1 - countBefore, 1);
  
  await client.listBoards();
  const countAfter2 = getPinterestRequestCount();
  assert.equal(countAfter2 - countAfter1, 0);
  
  await client.disconnect();
  await assert.rejects(stat(join(userDataDir, "pinterest-auth.json")), { code: "ENOENT" });
  
  const status = await client.status();
  assert.equal(status.connected, false);
});

test("Pinterest: invalid board ID", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-"));
  t.after(() => rm(userDataDir, { recursive: true, force: true }));
  
  const { fakeTokenServer, fakePinterestApi, getPinterestRequestCount } = createFakeServices();
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
  
  const client = createPinterestClient({ userDataDir, fetchImpl });
  
  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const state = new URL(authorizeUrl).searchParams.get("state");
  await client.completeConnect({ code: "valid_code", state });
  
  const countBefore = getPinterestRequestCount();
  
  await assert.rejects(
    client.listBoardPins("../etc/passwd"),
    { code: "PINTEREST_BAD_ID" }
  );
  
  assert.equal(getPinterestRequestCount(), countBefore);
});

test("Pinterest: no sensitive data in logs", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-"));
  t.after(() => rm(userDataDir, { recursive: true, force: true }));
  
  const { fakeTokenServer, fakePinterestApi } = createFakeServices();
  const tokenPort = await startServer(fakeTokenServer);
  const apiPort = await startServer(fakePinterestApi);
  t.after(() => Promise.all([stopServer(fakeTokenServer), stopServer(fakePinterestApi)]));
  
  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  t.after(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });
  
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
  
  const client = createPinterestClient({ userDataDir, fetchImpl });
  
  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const state = new URL(authorizeUrl).searchParams.get("state");
  await client.completeConnect({ code: "valid_code", state });
  await client.listBoards();
  
  const allLogs = logs.join("\n");
  assert.doesNotMatch(allLogs, /valid_code/);
  assert.doesNotMatch(allLogs, /access_token_123/);
  assert.doesNotMatch(allLogs, /refresh_token_123/);
  assert.doesNotMatch(allLogs, new RegExp(state));
});

test("Pinterest: refresh without new refresh_token keeps original value", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-"));
  t.after(() => rm(userDataDir, { recursive: true, force: true }));
  
  const { fakeTokenServer, fakePinterestApi } = createFakeServices();
  const tokenPort = await startServer(fakeTokenServer);
  const apiPort = await startServer(fakePinterestApi);
  t.after(() => Promise.all([stopServer(fakeTokenServer), stopServer(fakePinterestApi)]));
  
  // Create a custom token server that doesn't return refresh_token on refresh
  const customTokenServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (data.grant === "authorization_code") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            access_token: "access_token_123",
            refresh_token: "refresh_token_123",
            expires_in: 2592000,
            refresh_token_expires_in: 5184000,
            scope: "user_accounts:read,boards:read",
          }));
        } else if (data.grant === "refresh_token") {
          // Don't return new refresh_token or refresh_token_expires_in
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            access_token: "refreshed_access_token",
            expires_in: 2592000,
            scope: "user_accounts:read,boards:read",
          }));
        }
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
  });
  
  const customTokenPort = await startServer(customTokenServer);
  t.after(() => Promise.all([stopServer(customTokenServer), stopServer(fakePinterestApi)]));
  
  const fetchImpl = (url, options) => {
    const targetUrl = url.replace("http://token", `http://127.0.0.1:${customTokenPort}`)
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
  
  const client = createPinterestClient({ userDataDir, fetchImpl });
  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const state = new URL(authorizeUrl).searchParams.get("state");
  
  await client.completeConnect({ code: "valid_code", state });
  
  const tokenPath = join(userDataDir, "pinterest-auth.json");
  let tokenContent = JSON.parse(await readFile(tokenPath, "utf-8"));
  const originalRefreshToken = tokenContent.refresh_token;
  const originalRefreshExpires = tokenContent.refresh_expires_at;
  
  // Trigger refresh by simulating access token near expiry (but refresh token still valid)
  const futureTime = Date.now() + (29 * 24 * 60 * 60 * 1000); // 29 days later
  const clientWithFuture = createPinterestClient({ 
    userDataDir, 
    fetchImpl,
    now: () => futureTime,
  });
  
  await clientWithFuture.listBoards();
  
  tokenContent = JSON.parse(await readFile(tokenPath, "utf-8"));
  assert.equal(tokenContent.refresh_token, originalRefreshToken);
  assert.equal(tokenContent.refresh_expires_at, originalRefreshExpires);
  assert.equal(tokenContent.access_token, "refreshed_access_token");
});

test("Pinterest: status when not connected has needsReconnect false", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-"));
  t.after(() => rm(userDataDir, { recursive: true, force: true }));
  
  const client = createPinterestClient({ userDataDir });
  
  const status = await client.status();
  assert.equal(status.connected, false);
  assert.equal(status.needsReconnect, false);
});
