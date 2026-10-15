// 任务 135 返工 2 验收补测（Claude 接手）：返工 1 要求的第 1~6 项。
// 全部走注入的假 fetchImpl，不开真服务；每条测试用 t.after 清理，失败也不会留下句柄。
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handlePinterestRoute } from "../lib/api/pinterest-routes.mjs";
import { createPinterestClient } from "../lib/pinterest/client.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => body,
  };
}

const isTokenUrl = (url) => String(url).includes("/api/pinterest/token");

const BOARDS_BODY = {
  items: [{ id: "123", name: "Board", privacy: "PUBLIC", pin_count: 1, media: { image_cover_url: "https://i.pinimg.com/c.jpg" } }],
  bookmark: "",
};

async function makeUserDataDir(t, tokenOverrides = null) {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-core-"));
  t.after(async () => {
    await chmod(userDataDir, 0o700).catch(() => {});
    await rm(userDataDir, { recursive: true, force: true });
  });
  if (tokenOverrides) {
    await writeToken(userDataDir, tokenOverrides);
  }
  return userDataDir;
}

function tokenRecord(overrides = {}) {
  return {
    access_token: "old_access",
    refresh_token: "old_refresh",
    access_expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    refresh_expires_at: new Date(Date.now() + 60 * DAY_MS).toISOString(),
    scope: "boards:read",
    username: "user1",
    ...overrides,
  };
}

async function writeToken(userDataDir, overrides) {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "pinterest-auth.json"), JSON.stringify(tokenRecord(overrides)));
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

// 1. 换令牌时令牌服务返回缺 access_token → completeConnect 失败、令牌文件不存在
test("completeConnect fails and leaves no token file when the exchange response lacks access_token", async (t) => {
  const userDataDir = await makeUserDataDir(t);
  const fetchImpl = async (url) => {
    assert.ok(isTokenUrl(url), "only the token service may be called before a valid exchange");
    return jsonResponse(200, { refresh_token: "r", expires_in: 3600, scope: "boards:read" });
  };
  const client = createPinterestClient({ userDataDir, fetchImpl });
  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const state = new URL(authorizeUrl).searchParams.get("state");

  await assert.rejects(() => client.completeConnect({ code: "c", state }), /access_token/);
  assert.equal(await exists(join(userDataDir, "pinterest-auth.json")), false);
  assert.equal((await client.status()).connected, false);
});

// 2. 刷新时令牌服务 502：bad_response 不要求重连，rejected 要求重连
test("a 502 pinterest_bad_response refresh keeps needsReconnect false", async (t) => {
  const userDataDir = await makeUserDataDir(t, { access_expires_at: new Date(Date.now() + DAY_MS).toISOString() });
  const fetchImpl = async (url) => {
    assert.ok(isTokenUrl(url));
    return jsonResponse(502, { error: "pinterest_bad_response" });
  };
  const client = createPinterestClient({ userDataDir, fetchImpl });

  await assert.rejects(() => client.listBoards());
  assert.equal((await client.status()).needsReconnect, false);
});

test("a 502 pinterest_rejected refresh sets needsReconnect true", async (t) => {
  const userDataDir = await makeUserDataDir(t, { access_expires_at: new Date(Date.now() + DAY_MS).toISOString() });
  const fetchImpl = async (url) => {
    assert.ok(isTokenUrl(url));
    return jsonResponse(502, { error: "pinterest_rejected" });
  };
  const client = createPinterestClient({ userDataDir, fetchImpl });

  await assert.rejects(() => client.listBoards(), (error) => error.code === "PINTEREST_RECONNECT_REQUIRED");
  assert.equal((await client.status()).needsReconnect, true);
});

// 3. 刷新时写盘失败 → 令牌文件内容不变，内存里的令牌也不变（下次刷新仍用旧刷新令牌）
test("a failed token write keeps the file and the in-memory token unchanged", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("directory permissions cannot make the write fail on this platform/user");
    return;
  }
  const userDataDir = await makeUserDataDir(t, { access_expires_at: new Date(Date.now() + DAY_MS).toISOString() });
  const tokenPath = join(userDataDir, "pinterest-auth.json");
  const before = await readFile(tokenPath, "utf-8");

  const refreshBodies = [];
  const fetchImpl = async (url, options) => {
    assert.ok(isTokenUrl(url));
    refreshBodies.push(JSON.parse(options.body));
    return jsonResponse(200, { access_token: "new_access", refresh_token: "new_refresh", expires_in: 3600 });
  };
  const client = createPinterestClient({ userDataDir, fetchImpl });

  await chmod(userDataDir, 0o500); // 目录不可写：临时文件建不出来
  await assert.rejects(() => client.listBoards());
  await assert.rejects(() => client.listBoards());

  assert.equal(await readFile(tokenPath, "utf-8"), before, "token file content is untouched");
  assert.equal(refreshBodies.length, 2);
  assert.equal(refreshBodies[1].refresh_token, "old_refresh", "the in-memory token was not advanced by the failed write");
});

// 4. 假 Pinterest 不响应 → 路由 504 { code: "PINTEREST_UNREACHABLE" }
test("an unresponsive Pinterest API maps to 504 PINTEREST_UNREACHABLE on the route", async (t) => {
  const userDataDir = await makeUserDataDir(t, {});
  // AbortSignal.timeout() does not keep the event loop alive; without this the
  // runner would see nothing pending while the fake fetch waits for the abort.
  const keepAlive = setTimeout(() => {}, 10000);
  t.after(() => clearTimeout(keepAlive));
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason));
  });
  const client = createPinterestClient({ userDataDir, fetchImpl, requestTimeoutMs: 50 });

  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
  const handled = await handlePinterestRoute({
    req: { method: "GET" },
    res,
    url: new URL("http://127.0.0.1/api/pinterest/boards"),
    context: { pinterest: client, port: 43517 },
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 504);
  assert.deepEqual(JSON.parse(res.body), { code: "PINTEREST_UNREACHABLE" });
});

// 5. 并发刷新只发一次
test("concurrent calls near expiry trigger exactly one token refresh", async (t) => {
  const userDataDir = await makeUserDataDir(t, { access_expires_at: new Date(Date.now() + DAY_MS).toISOString() });
  let refreshCount = 0;
  const fetchImpl = async (url) => {
    if (isTokenUrl(url)) {
      refreshCount++;
      await new Promise((resolve) => setTimeout(resolve, 50)); // 让第二个调用在刷新进行中到达
      return jsonResponse(200, { access_token: "new_access", refresh_token: "new_refresh", expires_in: 3600 });
    }
    return jsonResponse(200, String(url).includes("/pins") ? { items: [], bookmark: "" } : BOARDS_BODY);
  };
  const client = createPinterestClient({ userDataDir, fetchImpl });

  const [boards, pins] = await Promise.all([client.listBoards(), client.listBoardPins("123")]);

  assert.equal(refreshCount, 1, "the token service saw a single refresh_token request");
  assert.equal(boards.items.length, 1);
  assert.deepEqual(pins.items, []);
});

// 6. 401 后刷新再重试成功
test("a 401 triggers one refresh and the retry returns the second response", async (t) => {
  const userDataDir = await makeUserDataDir(t, {});
  let refreshCount = 0;
  const apiAuth = [];
  const fetchImpl = async (url, options) => {
    if (isTokenUrl(url)) {
      refreshCount++;
      return jsonResponse(200, { access_token: "fresh_access", refresh_token: "fresh_refresh", expires_in: 3600 });
    }
    apiAuth.push(options.headers.Authorization);
    return apiAuth.length === 1 ? jsonResponse(401, {}) : jsonResponse(200, BOARDS_BODY);
  };
  const client = createPinterestClient({ userDataDir, fetchImpl });

  const result = await client.listBoards();

  assert.equal(result.items[0].id, "123");
  assert.equal(refreshCount, 1);
  assert.deepEqual(apiAuth, ["Bearer old_access", "Bearer fresh_access"]);
});
