// Pinterest UI tests (task 147) — compile the real sources with tsc, then
// import the emitted JS. Output goes under web/gravityport/node_modules/.cache
// so `react`, `react/jsx-runtime` and `react-dom/server` resolve from the
// web/gravityport dependency tree; the directory is removed afterwards.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire, register } from "node:module";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");
const compileRoot = join(uiRoot, "node_modules", ".cache", "pinterest-ui-test");

let layout;
let strings;
let apiModule;
let connection;
let view;
let card;
let renderStatic;
let React;

const flush = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
const noop = () => {};

// ---------------------------------------------------------------------------
// Compilation of the real sources
// ---------------------------------------------------------------------------

before(async () => {
  await mkdir(join(compileRoot), { recursive: true });
  const sources = [
    join(uiRoot, "src", "vite-env.d.ts"),
    join(uiRoot, "src", "mosa-api.ts"),
    join(uiRoot, "src", "desktop.ts"),
    join(uiRoot, "src", "i18n.ts"),
    join(uiRoot, "src", "pinterest-api.ts"),
    join(uiRoot, "src", "pinterest-layout.ts"),
    join(uiRoot, "src", "pinterest-strings.ts"),
    join(uiRoot, "src", "use-pinterest-connection.ts"),
    join(uiRoot, "src", "PinterestView.tsx"),
    join(uiRoot, "src", "PinterestConnectionCard.tsx"),
  ];
  execFileSync(
    join(repositoryRoot, "node_modules", ".bin", "tsc"),
    [
      ...sources,
      "--outDir", compileRoot,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--jsx", "react-jsx",
      "--skipLibCheck",
    ],
    { stdio: "pipe" }
  );

  // The components do `import "./pinterest.css"`, which Vite handles in the
  // real build; short-circuit it for Node with a resolve hook (registered
  // before any component module is imported).
  await writeFile(
    join(compileRoot, "pinterest-css-hooks.mjs"),
    [
      "export async function resolve(specifier, context, next) {",
      '  if (specifier.endsWith(".css")) {',
      '    return { url: "data:text/javascript,export default null;", shortCircuit: true };',
      "  }",
      "  return next(specifier, context);",
      "}",
      "",
    ].join("\n")
  );
  register(pathToFileURL(join(compileRoot, "pinterest-css-hooks.mjs")).href);

  const uiRequire = createRequire(join(uiRoot, "package.json"));
  ({ renderToStaticMarkup: renderStatic } = await import(uiRequire.resolve("react-dom/server")));
  React = await import(uiRequire.resolve("react"));

  layout = await import(join(compileRoot, "pinterest-layout.js"));
  strings = await import(join(compileRoot, "pinterest-strings.js"));
  apiModule = await import(join(compileRoot, "pinterest-api.js"));
  connection = await import(join(compileRoot, "use-pinterest-connection.js"));
  view = await import(join(compileRoot, "PinterestView.js"));
  card = await import(join(compileRoot, "PinterestConnectionCard.js"));
});

after(async () => {
  await rm(join(uiRoot, "node_modules", ".cache", "pinterest-ui-test"), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePin(id, width = 100, height = 100, overrides = {}) {
  return {
    id,
    title: "",
    description: "",
    link: "",
    pin_url: `https://www.pinterest.com/pin/${id}/`,
    board_id: "1",
    created_at: "",
    media_type: "image",
    image: null,
    thumbnail: { url: `https://i.pinimg.com/600x/${id}.jpg`, width, height },
    video_cover_url: "",
    ...overrides,
  };
}

const zh = "zh";
const en = "en";

// ---------------------------------------------------------------------------
// layoutPinColumns
// ---------------------------------------------------------------------------

describe("layoutPinColumns — shortest column first", () => {
  it("places each pin into the currently shortest column", () => {
    // Ratios 1, 2, 2, 1, 1 walk the columns like this:
    //   p1 -> col0 [1,0,0]; p2 -> col1 [1,2,0]; p3 -> col2 [1,2,2];
    //   p4 -> col0 [2,2,2]; p5 -> col0 [3,2,2]
    const pins = [
      makePin("p1"),
      makePin("p2", 100, 200),
      makePin("p3", 100, 200),
      makePin("p4"),
      makePin("p5"),
    ];
    const columns = layout.layoutPinColumns(pins, 3);
    assert.deepEqual(
      columns.map((column) => column.map((item) => item.id)),
      [["p1", "p4", "p5"], ["p2"], ["p3"]]
    );
  });

  it("breaks ties by the lower column index", () => {
    const pins = ["a", "b", "c", "d", "e", "f"].map((id) => makePin(id));
    const columns = layout.layoutPinColumns(pins, 3);
    assert.deepEqual(
      columns.map((column) => column.map((item) => item.id)),
      [["a", "d"], ["b", "e"], ["c", "f"]]
    );
  });

  it("treats pins without dimensions as 1:1", () => {
    const pins = [makePin("n1", 0, 0, { thumbnail: null }), makePin("n2", 0, 0, { thumbnail: null })];
    const columns = layout.layoutPinColumns(pins, 2);
    assert.deepEqual(
      columns.map((column) => column.map((item) => item.id)),
      [["n1"], ["n2"]]
    );
  });

  it("degenerates to one column without throwing for 0, negative, NaN, or Infinity", () => {
    const pins = ["x1", "x2", "x3"].map((id) => makePin(id));
    for (const columnCount of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const columns = layout.layoutPinColumns(pins, columnCount);
      assert.equal(columns.length, 1, `columnCount ${columnCount} means 1 column`);
      assert.equal(columns[0].length, 3);
    }
  });

  it("keeps existing placements unchanged when a page is appended", () => {
    const page1 = ["a1", "a2", "a3", "a4", "a5"].map((id, index) =>
      makePin(id, 100, 100 + (index % 3) * 40)
    );
    const page2 = ["b1", "b2", "b3", "b4"].map((id, index) =>
      makePin(id, 100, 120 + (index % 2) * 60)
    );
    const first = layout.layoutPinColumns(page1, 3);
    const both = layout.layoutPinColumns([...page1, ...page2], 3);
    // Existing pins keep their exact column and position; new pins only join
    // the tails of the columns.
    first.forEach((column, index) => {
      assert.deepEqual(
        both[index].slice(0, column.length).map((item) => item.id),
        column.map((item) => item.id),
        `column ${index} prefix must stay unchanged`
      );
    });
    const appended = both.flat().map((item) => item.id);
    for (const id of page2.map((item) => item.id)) {
      assert.ok(appended.includes(id), `appended page pin ${id} still lands`);
    }
  });
});

// ---------------------------------------------------------------------------
// pinterestText / PINTEREST_EN
// ---------------------------------------------------------------------------

describe("pinterestText — table coverage", () => {
  it("resolves every PINTEREST_EN entry in English", () => {
    for (const [key, value] of Object.entries(strings.PINTEREST_EN)) {
      assert.equal(strings.pinterestText(key, en), value, `EN lookup failed for: ${key}`);
      assert.notEqual(value, key, `EN translation equals the Chinese source: ${key}`);
    }
  });

  it("returns Chinese text unchanged for zh", () => {
    for (const key of Object.keys(strings.PINTEREST_EN)) {
      assert.equal(strings.pinterestText(key, zh), key);
    }
  });

  it("covers every message pinterestErrorMessage can return", () => {
    // Read the compiled pinterest-api.js (the real source of truth, not a
    // hand-copied list) and require an English entry for each message.
    const apiSource = readFileSync(join(compileRoot, "pinterest-api.js"), "utf8");
    const messages = new Set(["加载 Pinterest 内容失败"]);
    for (const match of apiSource.matchAll(/PINTEREST_[A-Z_]+: "([^"]+)"/g)) {
      messages.add(match[1]);
    }
    assert.ok(messages.size > 5, "expected to find the error message table");
    for (const message of messages) {
      assert.notEqual(strings.pinterestText(message, en), message, `missing EN for: ${message}`);
    }
  });

  it("substitutes {placeholders} via pinterestFormat", () => {
    assert.equal(strings.pinterestFormat("{count} 个 Pin", { count: 3 }, zh), "3 个 Pin");
    assert.equal(strings.pinterestFormat("{count} 个 Pin", { count: 3 }, en), "3 Pins");
    assert.equal(
      strings.pinterestFormat("已连接 {username}", { username: "@ada" }, en),
      "Connected as @ada"
    );
  });
});

// ---------------------------------------------------------------------------
// Presentational components
// ---------------------------------------------------------------------------

const guideBase = {
  language: zh,
  needsReconnect: false,
  connecting: false,
  error: "",
  onConnect: noop,
  onCancel: noop,
};

const cardBase = {
  language: zh,
  status: null,
  connecting: false,
  connectionError: "",
  disconnecting: false,
  disconnectError: "",
  confirmOpen: false,
  onStart: noop,
  onCancel: noop,
  onRequestDisconnect: noop,
  onConfirmDisconnect: noop,
  onCancelDisconnect: noop,
};

describe("PinterestGuide", () => {
  it("offers Connect Pinterest when not connected", () => {
    const html = renderStatic(React.createElement(view.PinterestGuide, guideBase));
    assert.match(html, /连接 Pinterest/);
    assert.doesNotMatch(html, /重新连接/);
    assert.match(html, /连接后，可以在这里浏览你自己的画板和 Pin/);
  });

  it("switches to Reconnect copy when reconnection is required", () => {
    const html = renderStatic(
      React.createElement(view.PinterestGuide, { ...guideBase, needsReconnect: true })
    );
    assert.match(html, /Pinterest 授权已失效，请重新连接/);
    assert.match(html, /重新连接/);
  });

  it("never mentions MCP", () => {
    const connected = renderStatic(React.createElement(view.PinterestGuide, guideBase));
    const reconnect = renderStatic(
      React.createElement(view.PinterestGuide, { ...guideBase, needsReconnect: true })
    );
    assert.doesNotMatch(connected, /MCP/);
    assert.doesNotMatch(reconnect, /MCP/);
  });

  it("shows waiting + cancel while connecting", () => {
    const html = renderStatic(
      React.createElement(view.PinterestGuide, { ...guideBase, connecting: true })
    );
    assert.match(html, /等待浏览器授权…/);
    assert.match(html, /取消/);
  });
});

describe("PinterestBoardGrid", () => {
  const boardBase = {
    language: zh,
    loading: false,
    error: "",
    onOpenBoard: noop,
    onRetry: noop,
  };

  it("labels private boards and shows pin counts", () => {
    const boards = [
      { id: "1", name: "公开板", description: "", privacy: "PUBLIC", pin_count: 3, cover_url: "" },
      { id: "2", name: "秘密板", description: "", privacy: "SECRET", pin_count: 1, cover_url: "" },
      { id: "3", name: "保护板", description: "", privacy: "protected", pin_count: 0, cover_url: "" },
    ];
    const html = renderStatic(
      React.createElement(view.PinterestBoardGrid, { ...boardBase, boards })
    );
    assert.match(html, /3 个 Pin/);
    assert.match(html, /1 个 Pin/);
    assert.match(html, /私密/);
    const privateCells = html.split("pinterest-board-card").slice(1);
    assert.doesNotMatch(privateCells[0], /私密/);
    assert.match(privateCells[1], /私密/);
    assert.match(privateCells[2], /私密/);
  });

  it("shows the empty state for a board-less account", () => {
    const html = renderStatic(
      React.createElement(view.PinterestBoardGrid, { ...boardBase, boards: [] })
    );
    assert.match(html, /你的 Pinterest 账号里还没有画板/);
  });

  it("shows loading before the first page and an error with retry", () => {
    const loading = renderStatic(
      React.createElement(view.PinterestBoardGrid, { ...boardBase, boards: [], loading: true })
    );
    assert.match(loading, /加载中/);
    const failed = renderStatic(
      React.createElement(view.PinterestBoardGrid, { ...boardBase, boards: [], error: "暂时连不上 Pinterest，请检查网络。" })
    );
    assert.match(failed, /重试/);
  });
});

describe("PinterestPinDetail", () => {
  const pin = makePin("77", 800, 1200, {
    title: "标题",
    description: "第一行\n第二行",
    link: "https://example.com/shop/item",
    image: { url: "https://i.pinimg.com/1200x/77.jpg", width: 1200, height: 1800 },
    thumbnail: { url: "https://i.pinimg.com/600x/77.jpg", width: 600, height: 900 },
  });

  const renderDetail = (overrides = {}) =>
    renderStatic(
      React.createElement(view.PinterestPinDetail, {
        language: zh,
        pin,
        onOpen: async () => true,
        ...overrides,
      })
    );

  it("marks the source, offers Open in Pinterest, and uses the 1200x image", () => {
    const html = renderDetail();
    assert.match(html, /来自 Pinterest/);
    assert.match(html, /在 Pinterest 打开/);
    assert.match(html, /src="https:\/\/i\.pinimg\.com\/1200x\/77\.jpg"/);
    assert.match(html, /第一行\n第二行/);
  });

  it("shows the external link domain when present", () => {
    const html = renderDetail();
    assert.match(html, /example\.com/);
  });

  it("omits the external link row without a link", () => {
    const html = renderDetail({ pin: { ...pin, link: "" } });
    assert.doesNotMatch(html, /example\.com/);
    assert.match(html, /在 Pinterest 打开/);
  });
});

describe("PinterestPinGrid", () => {
  const gridBase = { language: zh, loading: false, error: "", onOpenPin: noop, onRetry: noop };

  it("renders video pins from video_cover_url with a video badge", () => {
    const videoPin = makePin("v1", 600, 600, {
      media_type: "video",
      video_cover_url: "https://i.pinimg.com/videos/v1.jpg",
    });
    const html = renderStatic(
      React.createElement(view.PinterestPinGrid, { ...gridBase, columns: [[videoPin]] })
    );
    assert.match(html, /视频/);
    assert.match(html, /src="https:\/\/i\.pinimg\.com\/videos\/v1\.jpg"/);
  });

  it("shows the empty state for a board without pins", () => {
    const html = renderStatic(
      React.createElement(view.PinterestPinGrid, { ...gridBase, columns: [[]] })
    );
    assert.match(html, /这个画板里还没有 Pin/);
  });

  it("shows pin titles below the card", () => {
    const titled = makePin("t1", 300, 500, { title: "晨光" });
    const html = renderStatic(
      React.createElement(view.PinterestPinGrid, { ...gridBase, columns: [[titled]] })
    );
    assert.match(html, /晨光/);
  });
});

describe("PinterestConnectionCardView", () => {
  it("shows Not connected + Connect Pinterest when disconnected", () => {
    const html = renderStatic(
      React.createElement(card.PinterestConnectionCardView, {
        ...cardBase,
        status: { connected: false },
      })
    );
    assert.match(html, /未连接/);
    assert.match(html, /连接 Pinterest/);
  });

  it("shows the username and quota when connected", () => {
    const html = renderStatic(
      React.createElement(card.PinterestConnectionCardView, {
        ...cardBase,
        status: {
          connected: true,
          username: "mika",
          quota: { usedToday: 12, limit: 100, softLimit: 90 },
        },
      })
    );
    assert.match(html, /已连接 @mika/);
    assert.match(html, /今天已用 12 \/ 100 次/);
    assert.match(html, /断开/);
  });

  it("shows Needs reconnection + Reconnect when stale", () => {
    const html = renderStatic(
      React.createElement(card.PinterestConnectionCardView, {
        ...cardBase,
        status: { connected: false, needsReconnect: true },
      })
    );
    assert.match(html, /需要重新连接/);
    assert.match(html, /重新连接/);
  });

  it("asks for confirmation before disconnecting", () => {
    const html = renderStatic(
      React.createElement(card.PinterestConnectionCardView, {
        ...cardBase,
        status: { connected: true, username: "mika" },
        confirmOpen: true,
      })
    );
    assert.match(html, /断开后，这台电脑上保存的 Pinterest 授权会被删除。/);
    assert.match(html, /取消/);
  });

  it("never mentions MCP in any state", () => {
    for (const status of [null, { connected: false }, { connected: true, username: "mika" }, { connected: false, needsReconnect: true }]) {
      const html = renderStatic(
        React.createElement(card.PinterestConnectionCardView, { ...cardBase, status })
      );
      assert.doesNotMatch(html, /MCP/);
    }
  });
});

describe("English rendering contains no Chinese characters", () => {
  it("renders the whole surface in English", () => {
    const enBoard = { id: "1", name: "Board", description: "", privacy: "SECRET", pin_count: 2, cover_url: "" };
    const enPin = makePin("e1", 300, 500, { title: "Morning", link: "https://example.com/x" });
    const pieces = [
      renderStatic(React.createElement(view.PinterestGuide, { ...guideBase, language: en })),
      renderStatic(React.createElement(view.PinterestGuide, { ...guideBase, language: en, needsReconnect: true })),
      renderStatic(
        React.createElement(view.PinterestBoardGrid, {
          language: en,
          boards: [enBoard],
          loading: false,
          error: "",
          onOpenBoard: noop,
          onRetry: noop,
        })
      ),
      renderStatic(
        React.createElement(view.PinterestBoardGrid, {
          language: en,
          boards: [],
          loading: false,
          error: "",
          onOpenBoard: noop,
          onRetry: noop,
        })
      ),
      renderStatic(
        React.createElement(view.PinterestPinGrid, {
          language: en,
          columns: [[enPin]],
          loading: false,
          error: "",
          onOpenPin: noop,
          onRetry: noop,
        })
      ),
      renderStatic(
        React.createElement(view.PinterestPinGrid, {
          language: en,
          columns: [[]],
          loading: false,
          error: "",
          onOpenPin: noop,
          onRetry: noop,
        })
      ),
      renderStatic(
        React.createElement(view.PinterestPinDetail, { language: en, pin: enPin, onOpen: async () => true })
      ),
      renderStatic(
        React.createElement(card.PinterestConnectionCardView, { ...cardBase, language: en })
      ),
      renderStatic(
        React.createElement(card.PinterestConnectionCardView, {
          ...cardBase,
          language: en,
          status: { connected: true, username: "ada", quota: { usedToday: 1, limit: 10, softLimit: 9 } },
        })
      ),
      renderStatic(
        React.createElement(card.PinterestConnectionCardView, {
          ...cardBase,
          language: en,
          status: { connected: false, needsReconnect: true },
        })
      ),
    ];
    const all = pieces.join("");
    assert.doesNotMatch(all, /[一-鿿]/, `Chinese leaked into EN render: ${all.slice(0, 400)}`);
    assert.match(all, /Connected as @ada/);
    assert.match(all, /From Pinterest/);
    assert.match(all, /Open in Pinterest/);
  });
});

// ---------------------------------------------------------------------------
// Connection flow (pure state machine behind the hook)
// ---------------------------------------------------------------------------

describe("createPinterestConnectionFlow", () => {
  function manualWaitFor() {
    const waits = [];
    return {
      waits,
      waitFor({ signal }) {
        return new Promise((resolvePromise, reject) => {
          waits.push({ signal, resolvePromise, reject });
        });
      },
    };
  }

  it("runs only one flow at a time; a second start fires no second request", async () => {
    let startCount = 0;
    const fake = manualWaitFor();
    const connected = [];
    const flow = connection.createPinterestConnectionFlow({
      startConnect: async () => {
        startCount++;
      },
      waitFor: fake.waitFor,
      onConnected: (status) => connected.push(status),
    });
    flow.start();
    flow.start();
    flow.start();
    assert.equal(startCount, 1);
    await flush();
    assert.equal(fake.waits.length, 1);
    fake.waits[0].resolvePromise({ connected: true, username: "u" });
    await flush();
    assert.equal(connected.length, 1);
    assert.equal(flow.isBusy(), false);
  });

  it("cancel aborts the wait and returns to idle without an error", async () => {
    const fake = manualWaitFor();
    const phases = [];
    let sawConnected = false;
    let sawError = false;
    const flow = connection.createPinterestConnectionFlow({
      startConnect: async () => {},
      waitFor: fake.waitFor,
      onPhase: (phase) => phases.push(phase),
      onConnected: () => {
        sawConnected = true;
      },
      onError: () => {
        sawError = true;
      },
    });
    flow.start();
    await flush();
    assert.deepEqual(phases, [{ kind: "connecting" }]);
    flow.cancel();
    assert.equal(fake.waits[0].signal.aborted, true);
    await flush();
    assert.equal(sawConnected, false);
    assert.equal(sawError, false);
    assert.equal(phases.at(-1).kind, "idle");
  });

  it("reports failures through pinterestErrorMessage", async () => {
    let message = "";
    let sawConnected = false;
    const flow = connection.createPinterestConnectionFlow({
      startConnect: async () => {},
      waitFor: async () => {
        const error = new Error("timeout");
        error.code = "PINTEREST_CONNECT_TIMEOUT";
        throw error;
      },
      onConnected: () => {
        sawConnected = true;
      },
      onError: (next) => {
        message = next;
      },
    });
    flow.start();
    await flush();
    await flush();
    assert.equal(message, apiModule.pinterestErrorMessage({ code: "PINTEREST_CONNECT_TIMEOUT" }));
    assert.match(message, /没等到 Pinterest 授权完成/);
    assert.equal(sawConnected, false);
  });

  it("a superseded flow that resolves after cancel must not connect", async () => {
    const fake = manualWaitFor();
    let sawConnected = false;
    const flow = connection.createPinterestConnectionFlow({
      startConnect: async () => {},
      waitFor: fake.waitFor,
      onConnected: () => {
        sawConnected = true;
      },
    });
    flow.start();
    await flush();
    flow.cancel();
    fake.waits[0].resolvePromise({ connected: true, username: "late" });
    await flush();
    await flush();
    assert.equal(sawConnected, false, "a late resolve after cancel must not fire onConnected");
  });
});

// ---------------------------------------------------------------------------
// open-external-link URL gate (imported directly, no Electron)
// ---------------------------------------------------------------------------

describe("openExternalLinkOutcome — URL gate", () => {
  let gate;
  before(async () => {
    gate = await import(pathToFileURL(join(repositoryRoot, "desktop", "open-external-link.mjs")).href);
  });

  it("accepts https and http pages", () => {
    assert.deepEqual(gate.openExternalLinkOutcome("https://www.pinterest.com/pin/1/"), { ok: true });
    assert.deepEqual(gate.openExternalLinkOutcome("http://example.com/a?b=c"), { ok: true });
  });

  it("rejects javascript:, file:, data:, empty, garbage, and non-string URLs", () => {
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hello",
      "ftp://example.com/x",
      "",
      "not a url",
      "  ",
      null,
      undefined,
      42,
    ]) {
      assert.deepEqual(
        gate.openExternalLinkOutcome(bad),
        { ok: false },
        `expected rejection for: ${String(bad)}`
      );
    }
  });
});
