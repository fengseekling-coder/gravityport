// 任务 240：lib/api/pinterest-routes.mjs 路由层测试。
// 底层逻辑（配额、429 重试、state 过期、分页）在 pinterest-flows/pinterest-core 里测过，
// 这里只测路由本身：各种请求进来，状态码、JSON 和 HTML 页面对不对。
// 不起服务器：req 只给 method，res 用假对象记录 writeHead/setHeader/end，
// context.pinterest 用假对象按用例返回结果或抛带 code 的错误。
import assert from "node:assert/strict";
import test from "node:test";
import { handlePinterestRoute } from "../lib/api/pinterest-routes.mjs";

const PORT = 43517;

// sendJson 走 res.statusCode + res.setHeader + res.end；
// callback 页面走 res.writeHead(status, headers) + res.end。两条路都记下来。
function makeRes() {
  return {
    statusCode: undefined,
    headers: {},
    endBody: undefined,
    endCount: 0,
    headCount: 0,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers) {
      this.headCount++;
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.endCount++;
      this.endBody = body;
    },
  };
}

function header(res, name) {
  const key = Object.keys(res.headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : res.headers[key];
}

// 每个方法记录调用参数；错误用例在 overrides 里换成同步抛错的版本。
// beginConnect 在真 client 里是同步抛错（路由不 await 它），假对象也必须同步 throw。
function makePinterest(overrides = {}) {
  const calls = {
    beginConnect: [],
    completeConnect: [],
    disconnectCount: 0,
    listBoards: [],
    listBoardPins: [],
  };
  const pinterest = {
    calls,
    async status() {
      return { connected: false, username: null };
    },
    beginConnect(args) {
      calls.beginConnect.push(args);
      return { authorizeUrl: "https://www.pinterest.com/oauth/?state=abc" };
    },
    async completeConnect(args) {
      calls.completeConnect.push(args);
    },
    async disconnect() {
      calls.disconnectCount++;
    },
    async listBoards(args) {
      calls.listBoards.push(args);
      return { items: [{ id: "bd1" }], bookmark: "next" };
    },
    async listBoardPins(id, args) {
      calls.listBoardPins.push([id, args]);
      return { items: [{ id: "pin1" }], bookmark: "" };
    },
    ...overrides,
  };
  return pinterest;
}

function codedError(code, message = "pinterest failed") {
  return Object.assign(new Error(message), { code });
}

async function call(method, path, { pinterest, port = PORT } = {}) {
  const res = makeRes();
  const handled = await handlePinterestRoute({
    req: { method },
    res,
    url: new URL(`http://127.0.0.1${path}`),
    context: { pinterest, port },
  });
  return { handled, res };
}

// callback 各分支共用：状态码、html 头、no-store、<title> 和 <h1> 一致且含期望文字。
function assertCallbackPage(res, status, titleText) {
  assert.equal(res.statusCode, status);
  assert.match(String(header(res, "Content-Type")), /^text\/html/);
  assert.equal(header(res, "Cache-Control"), "no-store");
  const title = /<title>([\s\S]*?)<\/title>/.exec(res.endBody)?.[1];
  const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(res.endBody)?.[1];
  assert.ok(title, "page has a <title>");
  assert.equal(title, h1, "<title> and <h1> carry the same text");
  assert.ok(title.includes(titleText), `title includes ${JSON.stringify(titleText)}: ${title}`);
}

// ── 不匹配的路径/方法：返回 false，完全不写响应 ─────────────────────────────

test("a non-pinterest path returns false and writes nothing", async () => {
  const pinterest = makePinterest();
  const { handled, res } = await call("GET", "/api/assets", { pinterest });
  assert.equal(handled, false);
  assert.equal(res.endCount, 0);
  assert.equal(res.headCount, 0);
  assert.equal(res.statusCode, undefined);
});

test("an unknown pinterest route returns false and writes nothing", async () => {
  const { handled, res } = await call("GET", "/api/pinterest/unknown", { pinterest: makePinterest() });
  assert.equal(handled, false);
  assert.equal(res.endCount, 0);
  assert.equal(res.statusCode, undefined);
});

test("DELETE /api/pinterest/status returns false and writes nothing", async () => {
  const { handled, res } = await call("DELETE", "/api/pinterest/status", { pinterest: makePinterest() });
  assert.equal(handled, false);
  assert.equal(res.endCount, 0);
  assert.equal(res.statusCode, undefined);
});

// ── context.pinterest 缺失：每个路由 503 ────────────────────────────────────

test("without pinterest every JSON route answers 503 PINTEREST_UNAVAILABLE", async () => {
  const routes = [
    ["GET", "/api/pinterest/status"],
    ["POST", "/api/pinterest/connect"],
    ["POST", "/api/pinterest/disconnect"],
    ["GET", "/api/pinterest/boards"],
    ["GET", "/api/pinterest/boards/some-board/pins"],
  ];
  for (const [method, path] of routes) {
    const { handled, res } = await call(method, path);
    assert.equal(handled, true, `${method} ${path}`);
    assert.equal(res.statusCode, 503, `${method} ${path}`);
    assert.deepEqual(JSON.parse(res.endBody), { code: "PINTEREST_UNAVAILABLE" }, `${method} ${path}`);
    assert.match(String(header(res, "Content-Type")), /^application\/json/, `${method} ${path}`);
  }
});

test("without pinterest the callback answers a 503 HTML page", async () => {
  const { handled, res } = await call("GET", "/api/pinterest/callback");
  assert.equal(handled, true);
  assertCallbackPage(res, 503, "Service Unavailable");
});

// ── GET /status ──────────────────────────────────────────────────────────────

test("GET /status returns pinterest.status() as-is with 200", async () => {
  const pinterest = makePinterest({
    async status() {
      return { connected: true, username: "maker", scopes: ["boards:read"] };
    },
  });
  const { handled, res } = await call("GET", "/api/pinterest/status", { pinterest });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.endBody), { connected: true, username: "maker", scopes: ["boards:read"] });
});

// ── POST /connect ────────────────────────────────────────────────────────────

test("POST /connect passes context.port to beginConnect and returns its result", async () => {
  const beginConnectArgs = [];
  const pinterest = makePinterest({
    beginConnect(args) {
      beginConnectArgs.push(args);
      return { authorizeUrl: "https://www.pinterest.com/oauth/?state=xyz" };
    },
  });
  const { handled, res } = await call("POST", "/api/pinterest/connect", { pinterest });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.endBody), { authorizeUrl: "https://www.pinterest.com/oauth/?state=xyz" });
  assert.deepEqual(beginConnectArgs, [{ port: PORT }]);
});

test("POST /connect answers 409 on PINTEREST_PORT_MISMATCH", async () => {
  const pinterest = makePinterest({
    beginConnect() {
      throw codedError("PINTEREST_PORT_MISMATCH", "Pinterest callback requires port 43517");
    },
  });
  const { handled, res } = await call("POST", "/api/pinterest/connect", { pinterest });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(JSON.parse(res.endBody), { code: "PINTEREST_PORT_MISMATCH" });
});

test("POST /connect answers 500 without the error text on other errors", async () => {
  const pinterest = makePinterest({
    beginConnect() {
      throw codedError("PINTEREST_STATE_INVALID", "state manager exploded");
    },
  });
  const { handled, res } = await call("POST", "/api/pinterest/connect", { pinterest });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.endBody), { error: "Internal error" });
  assert.ok(!res.endBody.includes("state manager exploded"), "error message must not leak");
});

// ── GET /callback ────────────────────────────────────────────────────────────

test("GET /callback answers 400 when Pinterest reports access_denied", async () => {
  const pinterest = makePinterest();
  const { handled, res } = await call("GET", "/api/pinterest/callback?error=access_denied&state=st1", { pinterest });
  assert.equal(handled, true);
  assertCallbackPage(res, 400, "Access Denied");
  assert.deepEqual(pinterest.calls.completeConnect, [], "completeConnect must not run");
});

test("GET /callback answers 400 when code is missing", async () => {
  const { handled, res } = await call("GET", "/api/pinterest/callback?state=st1", { pinterest: makePinterest() });
  assert.equal(handled, true);
  assertCallbackPage(res, 400, "Bad Request");
});

test("GET /callback answers 400 when state is missing", async () => {
  const { handled, res } = await call("GET", "/api/pinterest/callback?code=authcode", { pinterest: makePinterest() });
  assert.equal(handled, true);
  assertCallbackPage(res, 400, "Bad Request");
});

test("GET /callback hands code and state to completeConnect and answers 200", async () => {
  const pinterest = makePinterest();
  const { handled, res } = await call("GET", "/api/pinterest/callback?code=authcode&state=st123", { pinterest });
  assert.equal(handled, true);
  assertCallbackPage(res, 200, "Connected");
  assert.deepEqual(pinterest.calls.completeConnect, [{ code: "authcode", state: "st123" }]);
});

test("GET /callback answers 400 on PINTEREST_STATE_INVALID", async () => {
  const pinterest = makePinterest({
    async completeConnect() {
      throw codedError("PINTEREST_STATE_INVALID");
    },
  });
  const { handled, res } = await call("GET", "/api/pinterest/callback?code=authcode&state=stale", { pinterest });
  assert.equal(handled, true);
  assertCallbackPage(res, 400, "Invalid State");
});

test("GET /callback answers 500 without the error text on other errors", async () => {
  const pinterest = makePinterest({
    async completeConnect() {
      throw new Error("token exchange failed upstream");
    },
  });
  const { handled, res } = await call("GET", "/api/pinterest/callback?code=authcode&state=st1", { pinterest });
  assert.equal(handled, true);
  assertCallbackPage(res, 500, "Error");
  assert.ok(!res.endBody.includes("token exchange failed upstream"), "error message must not leak");
});

// ── POST /disconnect ─────────────────────────────────────────────────────────

test("POST /disconnect calls disconnect once and answers 200 ok", async () => {
  const pinterest = makePinterest();
  const { handled, res } = await call("POST", "/api/pinterest/disconnect", { pinterest });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.endBody), { ok: true });
  assert.equal(pinterest.calls.disconnectCount, 1);
});

// ── GET /boards ──────────────────────────────────────────────────────────────

test("GET /boards forwards the bookmark as-is and returns the result", async () => {
  const pinterest = makePinterest();
  const { handled, res } = await call("GET", "/api/pinterest/boards?bookmark=abc123", { pinterest });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.endBody), { items: [{ id: "bd1" }], bookmark: "next" });
  assert.deepEqual(pinterest.calls.listBoards, [{ bookmark: "abc123" }]);
});

test("GET /boards passes an empty bookmark when the parameter is absent", async () => {
  const pinterest = makePinterest();
  await call("GET", "/api/pinterest/boards", { pinterest });
  assert.deepEqual(pinterest.calls.listBoards, [{ bookmark: "" }]);
});

// ── GET /boards/:id/pins ─────────────────────────────────────────────────────

test("GET /boards/:id/pins decodes the board id and forwards the bookmark", async () => {
  const pinterest = makePinterest();
  const { handled, res } = await call("GET", "/api/pinterest/boards/board%20one/pins?bookmark=nxt", { pinterest });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(pinterest.calls.listBoardPins, [["board one", { bookmark: "nxt" }]]);
});

test("GET /boards/:id/pins passes an empty bookmark when the parameter is absent", async () => {
  const pinterest = makePinterest();
  await call("GET", "/api/pinterest/boards/bd1/pins", { pinterest });
  assert.deepEqual(pinterest.calls.listBoardPins, [["bd1", { bookmark: "" }]]);
});

test("GET /boards/:id/pins answers 400 PINTEREST_BAD_ID on a malformed percent-encoding", async () => {
  const pinterest = makePinterest();
  const { handled, res } = await call("GET", "/api/pinterest/boards/%E0%A4%A/pins", { pinterest });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.endBody), { code: "PINTEREST_BAD_ID" });
  assert.deepEqual(pinterest.calls.listBoardPins, [], "listBoardPins must not run");
});

// ── boards / board pins 共用的错误码映射 ─────────────────────────────────────

const ERROR_MAP = [
  ["PINTEREST_NOT_CONNECTED", 401],
  ["PINTEREST_RECONNECT_REQUIRED", 401],
  ["PINTEREST_QUOTA_LOW", 429],
  ["PINTEREST_RATE_LIMITED", 429],
  ["PINTEREST_BAD_ID", 400],
  ["PINTEREST_UNREACHABLE", 504],
  [null, 500],
];

for (const [method, path, routeName] of [
  ["GET", "/api/pinterest/boards", "boards"],
  ["GET", "/api/pinterest/boards/bd1/pins", "board pins"],
]) {
  for (const [code, expectedStatus] of ERROR_MAP) {
    test(`${routeName}: ${code ?? "error without code"} maps to ${expectedStatus}`, async () => {
      const error = code === null ? new Error("pinterest exploded") : codedError(code);
      const overrides =
        routeName === "boards"
          ? { listBoards() { throw error; } }
          : { listBoardPins() { throw error; } };
      const { handled, res } = await call(method, path, { pinterest: makePinterest(overrides) });
      assert.equal(handled, true);
      assert.equal(res.statusCode, expectedStatus);
      if (code === null) {
        assert.deepEqual(JSON.parse(res.endBody), { error: "Internal error" });
        assert.ok(!res.endBody.includes("pinterest exploded"), "error message must not leak");
      } else {
        assert.deepEqual(JSON.parse(res.endBody), { code });
      }
    });
  }
}
