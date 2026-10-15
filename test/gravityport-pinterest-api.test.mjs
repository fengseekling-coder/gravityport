// Pinterest API tests — mock-fetch unit tests.
//
// Module compilation follows gravityport-library-actions.test.mjs pattern.

import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

// Save the true native fetch once before any test can touch it.
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_WINDOW = globalThis.window;

// ---------------------------------------------------------------------------
// TypeScript compilation (shared across all tests)
// ---------------------------------------------------------------------------
let pinterestApi; // pinterest-api exports

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-gp-pin-"));
  const sources = [
    join(uiRoot, "src", "mosa-api.ts"),
    join(uiRoot, "src", "desktop.ts"),
    join(uiRoot, "src", "pinterest-api.ts"),
  ];
  execFileSync(
    join(repositoryRoot, "node_modules", ".bin", "tsc"),
    [
      ...sources,
      "--outDir", compileRoot,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--skipLibCheck",
    ],
    { stdio: "pipe" }
  );
  pinterestApi = await import(join(compileRoot, "pinterest-api.js"));
  after(async () => {
    await rm(compileRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockWindow(overrides = {}) {
  return { open: null, ...overrides };
}

function restoreGlobals() {
  globalThis.fetch = ORIGINAL_FETCH;
  globalThis.window = ORIGINAL_WINDOW;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchPinterestStatus — request method and address", () => {
  it("uses GET on /api/pinterest/status", async () => {
    const calls = [];
    globalThis.fetch = function (url, opts) {
      calls.push({ url, method: opts?.method || "GET" });
      return Promise.resolve(new Response(JSON.stringify({ connected: false }), { status: 200 }));
    };
    try {
      await pinterestApi.fetchPinterestStatus();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/pinterest/status");
      assert.equal(calls[0].method, "GET");
    } finally {
      restoreGlobals();
    }
  });
});

describe("disconnectPinterest — POST method", () => {
  it("uses POST on /api/pinterest/disconnect", async () => {
    const calls = [];
    globalThis.fetch = function (url, opts) {
      calls.push({ url, method: opts?.method });
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    };
    try {
      await pinterestApi.disconnectPinterest();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/pinterest/disconnect");
      assert.equal(calls[0].method, "POST");
    } finally {
      restoreGlobals();
    }
  });
});

describe("listPinterestBoards — request format", () => {
  it("omits bookmark param when empty", async () => {
    const calls = [];
    globalThis.fetch = function (url, opts) {
      calls.push({ url, method: opts?.method || "GET" });
      return Promise.resolve(new Response(JSON.stringify({ items: [], bookmark: "" }), { status: 200 }));
    };
    try {
      await pinterestApi.listPinterestBoards("");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/pinterest/boards");
    } finally {
      restoreGlobals();
    }
  });

  it("includes encoded bookmark when present", async () => {
    const calls = [];
    globalThis.fetch = function (url, opts) {
      calls.push({ url, method: opts?.method || "GET" });
      return Promise.resolve(new Response(JSON.stringify({ items: [], bookmark: "" }), { status: 200 }));
    };
    try {
      await pinterestApi.listPinterestBoards("abc/123&xyz");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/pinterest/boards?bookmark=abc%2F123%26xyz");
    } finally {
      restoreGlobals();
    }
  });
});

describe("listPinterestBoardPins — request format", () => {
  it("builds correct URL with board ID and bookmark", async () => {
    const calls = [];
    globalThis.fetch = function (url, opts) {
      calls.push({ url, method: opts?.method || "GET" });
      return Promise.resolve(new Response(JSON.stringify({ items: [], bookmark: "" }), { status: 200 }));
    };
    try {
      await pinterestApi.listPinterestBoardPins("12345", "bookmark/data");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/pinterest/boards/12345/pins?bookmark=bookmark%2Fdata");
    } finally {
      restoreGlobals();
    }
  });
});

describe("startPinterestConnect — POST method", () => {
  it("uses POST on /api/pinterest/connect", async () => {
    const calls = [];
    globalThis.fetch = function (url, opts) {
      calls.push({ url, method: opts?.method });
      return Promise.resolve(new Response(JSON.stringify({ authorizeUrl: "https://www.pinterest.com/oauth/" }), { status: 200 }));
    };
    globalThis.window = mockWindow({ open: () => ({}) });
    try {
      await pinterestApi.startPinterestConnect();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/pinterest/connect");
      assert.equal(calls[0].method, "POST");
    } finally {
      restoreGlobals();
    }
  });
});

describe("listPinterestBoardPins — bad boardId validation", () => {
  it("rejects non-numeric boardId", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = function () {
      fetchCallCount++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    try {
      await assert.rejects(
        () => pinterestApi.listPinterestBoardPins("abc"),
        (error) => error.code === "PINTEREST_BAD_ID"
      );
      assert.equal(fetchCallCount, 0);
    } finally {
      restoreGlobals();
    }
  });

  it("rejects boardId with slash", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = function () {
      fetchCallCount++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    try {
      await assert.rejects(
        () => pinterestApi.listPinterestBoardPins("1/2"),
        (error) => error.code === "PINTEREST_BAD_ID"
      );
      assert.equal(fetchCallCount, 0);
    } finally {
      restoreGlobals();
    }
  });

  it("rejects empty boardId", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = function () {
      fetchCallCount++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    try {
      await assert.rejects(
        () => pinterestApi.listPinterestBoardPins(""),
        (error) => error.code === "PINTEREST_BAD_ID"
      );
      assert.equal(fetchCallCount, 0);
    } finally {
      restoreGlobals();
    }
  });

  it("rejects 33-digit boardId", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = function () {
      fetchCallCount++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    try {
      await assert.rejects(
        () => pinterestApi.listPinterestBoardPins("123456789012345678901234567890123"),
        (error) => error.code === "PINTEREST_BAD_ID"
      );
      assert.equal(fetchCallCount, 0);
    } finally {
      restoreGlobals();
    }
  });
});

describe("listPinterestBoards — defensive normalization", () => {
  it("treats non-array items as empty array", async () => {
    globalThis.fetch = function () {
      return Promise.resolve(new Response(JSON.stringify({ items: "not-array", bookmark: "next" }), { status: 200 }));
    };
    try {
      const result = await pinterestApi.listPinterestBoards();
      assert.deepEqual(result.items, []);
      assert.equal(result.bookmark, "next");
    } finally {
      restoreGlobals();
    }
  });

  it("fills missing fields with defaults", async () => {
    globalThis.fetch = function () {
      return Promise.resolve(new Response(JSON.stringify({ items: [{ id: "123" }], bookmark: "" }), { status: 200 }));
    };
    try {
      const result = await pinterestApi.listPinterestBoards();
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].id, "123");
      assert.equal(result.items[0].name, "");
      assert.equal(result.items[0].pin_count, 0);
    } finally {
      restoreGlobals();
    }
  });

  it("treats null bookmark as empty string", async () => {
    globalThis.fetch = function () {
      return Promise.resolve(new Response(JSON.stringify({ items: [], bookmark: null }), { status: 200 }));
    };
    try {
      const result = await pinterestApi.listPinterestBoards();
      assert.equal(result.bookmark, "");
    } finally {
      restoreGlobals();
    }
  });
});

describe("listPinterestBoardPins — defensive normalization for Pin", () => {
  it("normalizes Pin with missing image/thumbnail as null", async () => {
    globalThis.fetch = function () {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [{ id: "pin1", title: "Test" }],
            bookmark: "",
          }),
          { status: 200 }
        )
      );
    };
    try {
      const result = await pinterestApi.listPinterestBoardPins("12345");
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].image, null);
      assert.equal(result.items[0].thumbnail, null);
    } finally {
      restoreGlobals();
    }
  });
});

describe("Error response handling", () => {
  it("throws error with code PINTEREST_NOT_CONNECTED", async () => {
    globalThis.fetch = function () {
      const error = new Error("Not connected");
      error.code = "PINTEREST_NOT_CONNECTED";
      return Promise.reject(error);
    };
    try {
      await assert.rejects(
        () => pinterestApi.listPinterestBoards(),
        (error) => error.code === "PINTEREST_NOT_CONNECTED"
      );
    } finally {
      restoreGlobals();
    }
  });
});

describe("pinterestErrorMessage — code mapping", () => {
  const testCases = [
    ["PINTEREST_NOT_CONNECTED", "尚未连接 Pinterest"],
    ["PINTEREST_RECONNECT_REQUIRED", "Pinterest 授权已失效，请重新连接"],
    ["PINTEREST_QUOTA_LOW", "今天的 Pinterest 浏览额度快用完了，明天再来看看"],
    ["PINTEREST_RATE_LIMITED", "Pinterest 请求太频繁，请稍后再试"],
    ["PINTEREST_PORT_MISMATCH", "本机服务端口被占用，暂时无法连接 Pinterest"],
    ["PINTEREST_UNAVAILABLE", "Pinterest 连接服务不可用"],
    ["PINTEREST_UNREACHABLE", "暂时连不上 Pinterest，请检查网络"],
    ["PINTEREST_BAD_ID", "画板地址无效"],
    ["PINTEREST_BAD_AUTHORIZE_URL", "无法打开 Pinterest 授权页"],
    ["PINTEREST_OPEN_FAILED", "无法打开 Pinterest 授权页"],
    ["PINTEREST_CONNECT_TIMEOUT", "没等到 Pinterest 授权完成，请重试"],
  ];

  testCases.forEach(([code, expected]) => {
    it(`returns "${expected}" for ${code}`, () => {
      const error = new Error("test");
      error.code = code;
      assert.equal(pinterestApi.pinterestErrorMessage(error), expected);
    });
  });

  it("returns generic message for unknown code", () => {
    const error = new Error("test");
    error.code = "UNKNOWN_CODE";
    assert.equal(pinterestApi.pinterestErrorMessage(error), "加载 Pinterest 内容失败");
  });

  it("returns generic message for non-Error", () => {
    assert.equal(pinterestApi.pinterestErrorMessage("not an error"), "加载 Pinterest 内容失败");
  });

  it("returns empty string for AbortError", () => {
    const error = new DOMException("Aborted", "AbortError");
    assert.equal(pinterestApi.pinterestErrorMessage(error), "");
  });
});

describe("startPinterestConnect — authorize URL validation", () => {
  it("rejects http:// URL", async () => {
    globalThis.fetch = function () {
      return Promise.resolve(new Response(JSON.stringify({ authorizeUrl: "http://www.pinterest.com/oauth/" }), { status: 200 }));
    };
    globalThis.window = mockWindow();
    try {
      await assert.rejects(
        () => pinterestApi.startPinterestConnect(),
        (error) => error.code === "PINTEREST_BAD_AUTHORIZE_URL"
      );
    } finally {
      restoreGlobals();
    }
  });

  it("rejects evil.com host", async () => {
    globalThis.fetch = function () {
      return Promise.resolve(new Response(JSON.stringify({ authorizeUrl: "https://evil.com/oauth/" }), { status: 200 }));
    };
    globalThis.window = mockWindow();
    try {
      await assert.rejects(
        () => pinterestApi.startPinterestConnect(),
        (error) => error.code === "PINTEREST_BAD_AUTHORIZE_URL"
      );
    } finally {
      restoreGlobals();
    }
  });

  it("rejects www.pinterest.com.evil.com host", async () => {
    globalThis.fetch = function () {
      return Promise.resolve(new Response(JSON.stringify({ authorizeUrl: "https://www.pinterest.com.evil.com/oauth/" }), { status: 200 }));
    };
    globalThis.window = mockWindow();
    try {
      await assert.rejects(
        () => pinterestApi.startPinterestConnect(),
        (error) => error.code === "PINTEREST_BAD_AUTHORIZE_URL"
      );
    } finally {
      restoreGlobals();
    }
  });

  it("rejects /oauth/x path", async () => {
    globalThis.fetch = function () {
      return Promise.resolve(new Response(JSON.stringify({ authorizeUrl: "https://www.pinterest.com/oauth/x" }), { status: 200 }));
    };
    globalThis.window = mockWindow();
    try {
      await assert.rejects(
        () => pinterestApi.startPinterestConnect(),
        (error) => error.code === "PINTEREST_BAD_AUTHORIZE_URL"
      );
    } finally {
      restoreGlobals();
    }
  });
});

describe("startPinterestConnect — desktop openPinterestAuthorize", () => {
  it("throws PINTEREST_OPEN_FAILED when desktop API returns ok: false", async () => {
    globalThis.fetch = function () {
      return Promise.resolve(new Response(JSON.stringify({ authorizeUrl: "https://www.pinterest.com/oauth/" }), { status: 200 }));
    };
    globalThis.window = mockWindow();
    globalThis.window.electronAPI = {
      openPinterestAuthorize: async () => ({ ok: false }),
    };
    try {
      await assert.rejects(
        () => pinterestApi.startPinterestConnect(),
        (error) => error.code === "PINTEREST_OPEN_FAILED"
      );
    } finally {
      delete globalThis.window?.electronAPI;
      restoreGlobals();
    }
  });
});

describe("startPinterestConnect — web window.open", () => {
  it("throws PINTEREST_OPEN_FAILED when window.open returns null", async () => {
    globalThis.fetch = function () {
      return Promise.resolve(new Response(JSON.stringify({ authorizeUrl: "https://www.pinterest.com/oauth/" }), { status: 200 }));
    };
    globalThis.window = mockWindow({ open: () => null });
    try {
      await assert.rejects(
        () => pinterestApi.startPinterestConnect(),
        (error) => error.code === "PINTEREST_OPEN_FAILED"
      );
    } finally {
      restoreGlobals();
    }
  });
});

describe("waitForPinterestConnection — third poll connects", () => {
  it("returns status after third poll", async () => {
    let callCount = 0;
    const fakeFetchStatus = async () => {
      callCount++;
      if (callCount === 3) return { connected: true, username: "testuser" };
      return { connected: false };
    };
    const fakeSleep = async () => {};
    const result = await pinterestApi.waitForPinterestConnection({
      fetchStatus: fakeFetchStatus,
      sleep: fakeSleep,
    });
    assert.equal(callCount, 3);
    assert.equal(result.connected, true);
  });
});

describe("waitForPinterestConnection — timeout", () => {
  it("throws PINTEREST_CONNECT_TIMEOUT when timeout reached", async () => {
    const fakeFetchStatus = async () => ({ connected: false });
    const fakeSleep = async () => {};
    await assert.rejects(
      () =>
        pinterestApi.waitForPinterestConnection({
          fetchStatus: fakeFetchStatus,
          sleep: fakeSleep,
          timeoutMs: 100,
          intervalMs: 50,
        }),
      (error) => error.code === "PINTEREST_CONNECT_TIMEOUT"
    );
  });
});

describe("waitForPinterestConnection — abort signal", () => {
  it("stops immediately when aborted and does not call fetchStatus again", async () => {
    let callCount = 0;
    const fakeFetchStatus = async () => {
      callCount++;
      return { connected: false };
    };
    const controller = new AbortController();
    const promise = pinterestApi.waitForPinterestConnection({
      fetchStatus: fakeFetchStatus,
      sleep: async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      },
      signal: controller.signal,
    });
    await assert.rejects(promise, (error) => error.name === "AbortError");
    const countAfter = callCount;
    // No more fetchStatus calls after abort
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(callCount, countAfter);
  });
});

describe("waitForPinterestConnection — poll error continues", () => {
  it("continues to next round when single poll throws", async () => {
    let callCount = 0;
    const fakeFetchStatus = async () => {
      callCount++;
      if (callCount === 1) throw new Error("poll error");
      if (callCount === 2) return { connected: true };
      return { connected: false };
    };
    const fakeSleep = async () => {};
    const result = await pinterestApi.waitForPinterestConnection({
      fetchStatus: fakeFetchStatus,
      sleep: fakeSleep,
    });
    assert.equal(callCount, 2);
    assert.equal(result.connected, true);
  });
});

describe("createPinterestPager — three pages to done", () => {
  it("loads three pages and stops when done", async () => {
    let pageIndex = 0;
    const fakeFetch = async (bookmark) => {
      pageIndex++;
      if (pageIndex === 1) return { items: [{ id: "a1" }], bookmark: "b1" };
      if (pageIndex === 2) return { items: [{ id: "a2" }], bookmark: "b2" };
      if (pageIndex === 3) return { items: [{ id: "a3" }], bookmark: "" };
      return { items: [], bookmark: "" };
    };

    const pager = pinterestApi.createPinterestPager(fakeFetch);
    await pager.loadMore();
    await pager.loadMore();
    await pager.loadMore();

    const state = pager.state();
    assert.equal(state.items.length, 3);
    assert.equal(state.done, true);
  });
});

describe("createPinterestPager — no request after done", () => {
  it("does not fetch again when already done", async () => {
    let fetchCount = 0;
    const fakeFetch = async () => {
      fetchCount++;
      return { items: [{ id: "a1" }], bookmark: "" };
    };

    const pager = pinterestApi.createPinterestPager(fakeFetch);
    await pager.loadMore();
    await pager.loadMore();

    assert.equal(fetchCount, 1);
  });
});

describe("createPinterestPager — single request when loading", () => {
  it("returns same promise when called twice while loading", async () => {
    const fakeFetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { items: [{ id: "a1" }], bookmark: "next" };
    };

    const pager = pinterestApi.createPinterestPager(fakeFetch);
    const promise1 = pager.loadMore();
    const promise2 = pager.loadMore();
    assert.equal(promise1, promise2);
    await promise1;
  });
});

describe("createPinterestPager — dedup across pages", () => {
  it("removes duplicate ids across pages", async () => {
    let pageIndex = 0;
    const fakeFetch = async () => {
      pageIndex++;
      if (pageIndex === 1) return { items: [{ id: "a1" }, { id: "a2" }], bookmark: "b1" };
      if (pageIndex === 2) return { items: [{ id: "a2" }, { id: "a3" }], bookmark: "" };
      return { items: [], bookmark: "" };
    };

    const pager = pinterestApi.createPinterestPager(fakeFetch);
    await pager.loadMore();
    await pager.loadMore();

    const state = pager.state();
    assert.equal(state.items.length, 3);
    assert.deepEqual(
      state.items.map((i) => i.id),
      ["a1", "a2", "a3"]
    );
  });
});

describe("createPinterestPager — stale response protection", () => {
  it("ignores stale response after loadFirst()", async () => {
    let resolveFirst;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let pageIndex = 0;

    const fakeFetch = async () => {
      pageIndex++;
      if (pageIndex === 1) {
        await firstPromise; // Block first request
        return { items: [{ id: "stale" }], bookmark: "" };
      }
      return { items: [{ id: "fresh" }], bookmark: "" };
    };

    const pager = pinterestApi.createPinterestPager(fakeFetch);
    const firstLoad = pager.loadMore(); // Start first request
    await new Promise((resolve) => setTimeout(resolve, 10));
    pager.loadFirst(); // Reset and start fresh
    await pager.loadMore();
    resolveFirst(); // Let stale request finish
    await firstLoad.catch(() => {}); // Consume rejection

    const state = pager.state();
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].id, "fresh");
  });
});

describe("createPinterestPager — error handling", () => {
  it("sets error and resets loading, can retry", async () => {
    let attemptCount = 0;
    const fakeFetch = async () => {
      attemptCount++;
      if (attemptCount === 1) throw new Error("network error");
      return { items: [{ id: "a1" }], bookmark: "" };
    };

    const pager = pinterestApi.createPinterestPager(fakeFetch);
    await pager.loadMore().catch(() => {});

    let state = pager.state();
    assert.equal(state.error?.message, "network error");
    assert.equal(state.loading, false);

    await pager.loadMore();
    state = pager.state();
    assert.equal(state.error, null);
    assert.equal(state.items.length, 1);
  });
});

describe("createPinterestPager — loadFirst fetches page one", () => {
  it("loadFirst() loads the first page from an empty bookmark", async () => {
    const bookmarks = [];
    const pager = pinterestApi.createPinterestPager(async (bookmark) => {
      bookmarks.push(bookmark);
      return { items: [{ id: "p1" }], bookmark: "next" };
    });
    await pager.loadFirst();
    assert.deepEqual(bookmarks, [""]);
    assert.deepEqual(pager.state().items.map((item) => item.id), ["p1"]);
    assert.equal(pager.state().done, false);
  });

  it("a superseded request that fails does not set error on the new list", async () => {
    let rejectFirst;
    let call = 0;
    const pager = pinterestApi.createPinterestPager(async () => {
      call++;
      if (call === 1) return new Promise((_, reject) => { rejectFirst = reject; });
      return { items: [{ id: "fresh" }], bookmark: "" };
    });
    const first = pager.loadMore();
    await pager.loadFirst();
    rejectFirst(new Error("old network error"));
    await first;
    assert.equal(pager.state().error, null);
    assert.deepEqual(pager.state().items.map((item) => item.id), ["fresh"]);
  });
});

describe("pinterestErrorMessage — non-Error inputs", () => {
  it("falls back instead of throwing for null, undefined and strings", () => {
    for (const value of [null, undefined, "boom", 42]) {
      assert.equal(pinterestApi.pinterestErrorMessage(value), "加载 Pinterest 内容失败");
    }
  });

  it("ignores inherited object keys as codes", () => {
    assert.equal(pinterestApi.pinterestErrorMessage({ code: "toString" }), "加载 Pinterest 内容失败");
  });
});
