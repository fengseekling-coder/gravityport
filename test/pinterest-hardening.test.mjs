// 任务 312 Pinterest App 侧加固：
// 1. 授权链接和换令牌请求体的回调地址写死 127.0.0.1；
// 2. 出站端点环境变量只认回环地址，其余一律回退内置默认；
// 3. 五处出站请求都带 redirect: "error"，拒绝重定向按「连不上」处理，
//    已存令牌不被清掉、不被覆盖。
// 全部走注入的 fetchImpl 或未监听的回环端口，不连线上接口。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PINTEREST_REDIRECT_URI,
  getPinterestApiBase,
  getPinterestAuthorizeUrl,
  getPinterestTokenUrl,
} from "../lib/pinterest/config.mjs";
import { getFeedbackCollectUrl } from "../lib/feedback/config.mjs";
import { createPinterestClient } from "../lib/pinterest/client.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const CALLBACK_URI = "http://127.0.0.1:43517/api/pinterest/callback";

const BOARDS_BODY = {
  items: [{ id: "123", name: "Board", privacy: "PUBLIC", pin_count: 1, media: { image_cover_url: "https://i.pinimg.com/c.jpg" } }],
  bookmark: "",
};

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => body,
  };
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

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

async function makeUserDataDir(t) {
  const userDataDir = await mkdtemp(join(tmpdir(), "pinterest-hardening-"));
  t.after(() => rm(userDataDir, { recursive: true, force: true }));
  return userDataDir;
}

// 1. 回调地址：常量本身、授权链接、换令牌请求体三处一致。
test("the authorize URL and the exchange body carry the 127.0.0.1 callback", async (t) => {
  assert.equal(PINTEREST_REDIRECT_URI, CALLBACK_URI);

  const userDataDir = await makeUserDataDir(t);
  const exchangeBodies = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes("/api/pinterest/token")) {
      exchangeBodies.push(JSON.parse(options.body));
      return jsonResponse(200, {
        access_token: "access_1",
        refresh_token: "refresh_1",
        expires_in: 30 * DAY_MS / 1000,
        refresh_token_expires_in: 60 * DAY_MS / 1000,
        scope: "boards:read",
      });
    }
    return jsonResponse(200, { username: "user1" });
  };
  const client = createPinterestClient({ userDataDir, fetchImpl });

  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const params = new URL(authorizeUrl).searchParams;
  assert.equal(params.get("redirect_uri"), CALLBACK_URI);

  await client.completeConnect({ code: "c", state: params.get("state") });
  assert.equal(exchangeBodies.length, 1);
  assert.equal(exchangeBodies[0].redirect_uri, CALLBACK_URI);
});

// 2. 环境变量白名单：只有回环地址被采用。
test("outbound endpoint env overrides are honored only for loopback addresses", () => {
  // Read the built-in defaults with every override cleared, so an ambient
  // value (e2e runs export MOSA_FEEDBACK_URL) cannot leak into the baseline.
  const restoreDefaults = setEnv({
    MOSA_PINTEREST_TOKEN_URL: "",
    MOSA_PINTEREST_API_BASE: "",
    MOSA_PINTEREST_AUTHORIZE_URL: "",
    MOSA_FEEDBACK_URL: "",
  });
  let defaults;
  try {
    defaults = {
      token: getPinterestTokenUrl(),
      api: getPinterestApiBase(),
      authorize: getPinterestAuthorizeUrl(),
      feedback: getFeedbackCollectUrl(),
    };
  } finally {
    restoreDefaults();
  }
  assert.ok(defaults.feedback.startsWith("https://"), "the built-in feedback collector is the default");
  assert.ok(defaults.token.startsWith("https://") && !defaults.token.includes("127.0.0.1"));

  const cases = [
    ["https://evil.example/x", false],
    ["http://10.1.2.3:8080/x", false],
    ["http://token", false],
    ["not a url", false],
    ["file:///tmp/pinterest", false],
    ["", false],
    ["   ", false],
    ["http://127.0.0.1:9/x", true],
    ["http://localhost:9944/x", true],
    ["http://[::1]:9/x", true],
    ["https://127.0.0.1:8443/x", true],
  ];

  for (const [value, accepted] of cases) {
    const restore = setEnv({
      MOSA_PINTEREST_TOKEN_URL: value,
      MOSA_PINTEREST_API_BASE: value,
      MOSA_PINTEREST_AUTHORIZE_URL: value,
      MOSA_FEEDBACK_URL: value,
    });
    try {
      const expected = accepted ? value.trim() : null;
      const check = (actual, fallback, label) => assert.equal(actual, expected ?? fallback, `${label} with ${JSON.stringify(value)}`);
      check(getPinterestTokenUrl(), defaults.token, "MOSA_PINTEREST_TOKEN_URL");
      check(getPinterestApiBase(), defaults.api, "MOSA_PINTEREST_API_BASE");
      check(getPinterestAuthorizeUrl(), defaults.authorize, "MOSA_PINTEREST_AUTHORIZE_URL");
      check(getFeedbackCollectUrl(), defaults.feedback, "MOSA_FEEDBACK_URL");
    } finally {
      restore();
    }
  }
});

// 3. 五处出站请求（换令牌、刷新令牌、API 首次、401 重试、限流重试）都带 redirect: "error"。
test("every outbound Pinterest request opts out of redirect following", async (t) => {
  const userDataDir = await makeUserDataDir(t);
  const seen = [];
  const isTokenUrl = (url) => String(url).includes("/api/pinterest/token");
  let boardsCalls = 0;
  const fetchImpl = async (url, options) => {
    seen.push({ url: String(url), redirect: options?.redirect });
    if (isTokenUrl(url)) {
      const grant = JSON.parse(options.body).grant;
      if (grant === "authorization_code") {
        return jsonResponse(200, {
          access_token: "access_1",
          refresh_token: "refresh_1",
          expires_in: 30 * DAY_MS / 1000,
          refresh_token_expires_in: 60 * DAY_MS / 1000,
          scope: "boards:read",
        });
      }
      return jsonResponse(200, { access_token: "access_2", refresh_token: "refresh_2", expires_in: 30 * DAY_MS / 1000, scope: "boards:read" });
    }
    if (String(url).includes("/user_account")) {
      return jsonResponse(200, { username: "user1" });
    }
    boardsCalls++;
    if (boardsCalls === 1) return jsonResponse(401);
    if (boardsCalls === 2) return jsonResponse(200, BOARDS_BODY);
    if (boardsCalls === 3) return jsonResponse(429, {}, { "Retry-After": "0" });
    return jsonResponse(200, { items: [], bookmark: "" });
  };

  const client = createPinterestClient({ userDataDir, fetchImpl, sleep: async () => {} });

  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const state = new URL(authorizeUrl).searchParams.get("state");
  await client.completeConnect({ code: "c", state });
  await client.listBoards();
  await client.listBoards({ bookmark: "p2" });

  // 换令牌、user_account、画板 401、刷新令牌、401 重试、画板 429、限流重试。
  assert.equal(seen.length, 7);
  assert.deepEqual(seen.map((call) => call.redirect), Array.from({ length: 7 }, () => "error"));
  assert.equal(seen.filter((call) => isTokenUrl(call.url)).length, 2, "exchange plus one refresh");
});

// 4. 换令牌被拒（模拟 redirect: "error" 抛 TypeError）→ PINTEREST_UNREACHABLE、不落盘。
test("a refused redirect during token exchange maps to PINTEREST_UNREACHABLE and writes nothing", async (t) => {
  const userDataDir = await makeUserDataDir(t);
  // undici rejects a redirect under redirect: "error" with TypeError("fetch failed").
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const client = createPinterestClient({ userDataDir, fetchImpl });

  const { authorizeUrl } = client.beginConnect({ port: 43517 });
  const state = new URL(authorizeUrl).searchParams.get("state");
  await assert.rejects(
    () => client.completeConnect({ code: "c", state }),
    (error) => error.code === "PINTEREST_UNREACHABLE"
  );
  assert.equal(await exists(join(userDataDir, "pinterest-auth.json")), false);
  assert.equal((await client.status()).connected, false);
});

// 5. 刷新令牌被拒 → PINTEREST_UNREACHABLE、已存令牌原样保留、不要求重连。
test("a refused redirect during refresh keeps the stored token untouched", async (t) => {
  const userDataDir = await makeUserDataDir(t);
  const tokenPath = join(userDataDir, "pinterest-auth.json");
  await writeFile(tokenPath, JSON.stringify({
    access_token: "old_access",
    refresh_token: "old_refresh",
    access_expires_at: new Date(Date.now() + DAY_MS).toISOString(),
    refresh_expires_at: new Date(Date.now() + 60 * DAY_MS).toISOString(),
    scope: "boards:read",
    username: "user1",
  }));
  const before = await readFile(tokenPath, "utf-8");

  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const client = createPinterestClient({ userDataDir, fetchImpl });

  await assert.rejects(
    () => client.listBoards(),
    (error) => error.code === "PINTEREST_UNREACHABLE"
  );
  assert.equal(await readFile(tokenPath, "utf-8"), before, "stored token neither cleared nor overwritten");
  const status = await client.status();
  assert.equal(status.connected, true);
  assert.equal(status.needsReconnect, false);
});
