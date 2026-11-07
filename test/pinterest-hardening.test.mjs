// 任务 312 Pinterest App 侧加固：
// 1. 授权链接和换令牌请求体的回调地址写死 localhost（返工 1：Pinterest 后台
//    不接受 127.0.0.1，::1 抢占风险改由 runtime 在 [::1] 同端口监听来堵）；
// 2. 出站端点环境变量只认回环地址，其余一律回退内置默认；
// 3. 五处出站请求都带 redirect: "error"，拒绝重定向按「连不上」处理，
//    已存令牌不被清掉、不被覆盖。
// 返工 1 新增：beginConnect 在 [::1] 监听状态为 "taken" 时拒绝发授权链接
// （client 单元、真路由、真起 runtime 三层都有）；runtime 在 [::1] 上真听、
// 关停后端口立刻可以让出来。
// 全部走注入的 fetchImpl 或未监听的回环端口，不连线上接口。
import assert from "node:assert/strict";
import { createServer, get as httpGetImpl } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PINTEREST_REDIRECT_URI,
  getPinterestApiBase,
  getPinterestAuthorizeUrl,
  getPinterestTokenUrl,
} from "../lib/pinterest/config.mjs";
import { getFeedbackCollectUrl } from "../lib/feedback/config.mjs";
import { createPinterestClient } from "../lib/pinterest/client.mjs";
import { handlePinterestRoute } from "../lib/api/pinterest-routes.mjs";
import { getIpv6LoopbackState, startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
// 返工 1：Pinterest 开发者后台对 http 回调只收 localhost（127.0.0.1 会报
// 「看起来不像有效的 OAuth 2.0 重定向 URI」），回调地址改回 localhost。
const CALLBACK_URI = "http://localhost:43517/api/pinterest/callback";

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

// 1. 回调地址：常量本身、授权链接、换令牌请求体三处一致（返工 1：localhost）。
test("the authorize URL and the exchange body carry the localhost callback", async (t) => {
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

// 1b. 返工 1：[::1] 副监听状态为 "taken" 时 beginConnect 抛出和端口不对一样的
//     PINTEREST_PORT_MISMATCH；"bound" / "unavailable" 照常发授权链接。
//     fetchImpl 一旦被调用就抛错，证明拒绝发生在任何出站请求之前。
test("beginConnect refuses to authorize while the [::1] listener is taken", async (t) => {
  const userDataDir = await makeUserDataDir(t);
  const fetchImpl = async () => {
    throw new Error("no outbound request may happen while refusing");
  };
  const client = createPinterestClient({ userDataDir, fetchImpl });

  for (const state of ["bound", "unavailable"]) {
    const { authorizeUrl } = client.beginConnect({ port: 43517, ipv6ListenState: state });
    assert.ok(new URL(authorizeUrl), `${state} still returns an authorize URL`);
    assert.equal(new URL(authorizeUrl).searchParams.get("redirect_uri"), CALLBACK_URI);
  }
  assert.throws(
    () => client.beginConnect({ port: 43517, ipv6ListenState: "taken" }),
    (error) => error.code === "PINTEREST_PORT_MISMATCH",
    "taken must refuse with PINTEREST_PORT_MISMATCH"
  );
});

// 1c. 返工 1：路由层用真 client（非手抄逻辑）：传 "taken" 时真 beginConnect
//     同步抛错，路由回 409 {"code":"PINTEREST_PORT_MISMATCH"}；传 "bound"
//     照常 200。res 用记录型假对象（同 pinterest-routes.test.mjs 的形状）。
test("POST /api/pinterest/connect answers 409 while the [::1] listener is taken", async (t) => {
  const userDataDir = await makeUserDataDir(t);
  const fetchImpl = async () => {
    throw new Error("no outbound request may happen in this test");
  };
  const pinterest = createPinterestClient({ userDataDir, fetchImpl });
  const callRoute = async (ipv6ListenState) => {
    const res = {
      statusCode: undefined,
      headers: {},
      endBody: undefined,
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        this.endBody = body;
      },
    };
    await handlePinterestRoute({
      req: { method: "POST" },
      res,
      url: new URL("http://127.0.0.1/api/pinterest/connect"),
      context: { pinterest, port: 43517, ipv6ListenState },
    });
    return res;
  };

  const taken = await callRoute("taken");
  assert.equal(taken.statusCode, 409);
  assert.deepEqual(JSON.parse(taken.endBody), { code: "PINTEREST_PORT_MISMATCH" });

  const bound = await callRoute("bound");
  assert.equal(bound.statusCode, 200);
  assert.equal(new URL(JSON.parse(bound.endBody).authorizeUrl).searchParams.get("redirect_uri"), CALLBACK_URI);
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

// ── 返工 1：真起 runtime 的 [::1] 副监听 ─────────────────────────────────────
// 起法照 test/mosa-runtime.test.mjs 的 runtimeOptions：全部源目录指到临时根，
// 不碰真实库。runtime 随机端口；assertion 用真 http.get / 真 server。

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function runtimeOptions(root) {
  const libraryDir = join(root, "library");
  return {
    port: 0,
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  };
}

async function makeTemporaryRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  return root;
}

// 机器没开 IPv6 时 [::1] 根本绑不上，对应的断言只能 skip，不许假装通过。
function canBindIpv6Loopback() {
  return new Promise((resolveAvailable) => {
    const probe = createServer();
    probe.once("error", () => resolveAvailable(false));
    probe.listen(0, "::1", () => probe.close(() => resolveAvailable(true)));
  });
}

function httpGet(host, port, path) {
  return new Promise((resolveGet, rejectGet) => {
    httpGetImpl({ host, port, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolveGet({ status: res.statusCode, body }));
    }).on("error", rejectGet);
  });
}

function listenOn(serverInstance, host, port) {
  return new Promise((resolveListen, rejectListen) => {
    serverInstance.once("error", rejectListen);
    serverInstance.listen(port, host, () => {
      serverInstance.off("error", rejectListen);
      resolveListen();
    });
  });
}

function closeServer2(serverInstance) {
  if (!serverInstance.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    serverInstance.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

// 2a. [::1] 绑定成功：同一个端口上，::1 和 127.0.0.1 对同一接口给出同一响应。
test("the runtime serves [::1] on the same port as 127.0.0.1", async (t) => {
  if (!(await canBindIpv6Loopback())) {
    t.skip("this machine has no IPv6 loopback; the [::1] side listener cannot bind here");
    return;
  }
  const root = await makeTemporaryRoot(t, "pinterest-ipv6-");
  const runtime = await startMosaRuntime(runtimeOptions(root));
  t.after(() => runtime.stop());

  assert.equal(getIpv6LoopbackState(), "bound");
  const viaV4 = await httpGet("127.0.0.1", runtime.port, "/api/health");
  const viaV6 = await httpGet("::1", runtime.port, "/api/health");
  assert.equal(viaV4.status, 200, "127.0.0.1 answers 200");
  assert.equal(viaV6.status, 200, "::1 answers 200 with the same handler");
  assert.equal(viaV6.body, viaV4.body, "same health payload on both transports");

  // 关停后 [::1]:<端口> 必须能立刻被新 server 占上（副 server 已关）。
  await runtime.stop();
  const reclaim = createServer();
  try {
    await listenOn(reclaim, "::1", runtime.port);
    assert.ok(reclaim.listening, "a new server can bind [::1] right after shutdown");
  } finally {
    await closeServer2(reclaim);
  }
});

// 2b. [::1] 被别的进程先占：runtime 照常起来、状态 "taken"、连接接口回 409。
//     注：测试里 runtime 用随机高位端口，真 client 的端口闸（43517）先触发，
//     409 由同一个 PINTEREST_PORT_MISMATCH 分支回出；"taken" 这条路本身由
//     上面 1b/1c 两条在 43517 上钉住。状态断言用 getIpv6LoopbackState()。
//     runtime 只在 actualUserData 存在时才建 pinterest client，所以要传
//     userData（指向临时根，不碰真实 userData）。
test("a squatted [::1] port leaves the runtime up with state taken and connect refused", async (t) => {
  if (!(await canBindIpv6Loopback())) {
    t.skip("this machine has no IPv6 loopback; the [::1] side listener cannot bind here");
    return;
  }
  const squatter = createServer((_req, res) => res.end("squatter"));
  await listenOn(squatter, "::1", 0);
  t.after(() => closeServer2(squatter));
  const squattedPort = squatter.address().port;

  const root = await makeTemporaryRoot(t, "pinterest-ipv6-taken-");
  const userDataDir = join(root, "user-data");
  await mkdir(userDataDir, { recursive: true });
  const runtime = await startMosaRuntime({
    ...runtimeOptions(root),
    port: squattedPort,
    actualUserData: userDataDir,
  });
  t.after(() => runtime.stop());

  assert.equal(runtime.port, squattedPort, "the main listener still binds 127.0.0.1 on the port");
  assert.equal(getIpv6LoopbackState(), "taken");
  const health = await httpGet("127.0.0.1", runtime.port, "/api/health");
  assert.equal(health.status, 200, "the runtime is otherwise up");

  const connect = await fetch(`http://127.0.0.1:${runtime.port}/api/pinterest/connect`, {
    method: "POST",
    headers: { "x-mosa-client-token": runtime.clientToken },
  });
  assert.equal(connect.status, 409);
  assert.deepEqual(await connect.json(), { code: "PINTEREST_PORT_MISMATCH" });
});
