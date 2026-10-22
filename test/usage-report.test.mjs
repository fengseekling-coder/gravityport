// usage-report.test.mjs — the maintainer's usage report (scripts/usage-report.mjs)
// counts what the desktop app really sends, and never prints who sent it.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";

import { ANONYMOUS_USAGE_TELEMETRY_VERSION } from "../desktop/anonymous-usage.mjs";
import { buildUpdateFeedUrl } from "../desktop/update-service.mjs";
import {
  classifyRequest,
  createUsageReport,
  formatUsageReport,
  main,
  parseAccessLogLine,
  weekStartOf,
} from "../scripts/usage-report.mjs";

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const NODE_FETCH = "node";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-9222-222222222222";
const ID_OWN = "33333333-3333-4333-a333-333333333333";

function logLine({ ip = "203.0.113.7", time = "20/Oct/2026:10:00:00 +0000", method = "GET", target = "/", status = 200, userAgent = BROWSER } = {}) {
  return `${ip} - - [${time}] "${method} ${target} HTTP/1.1" ${status} 512 "-" "${userAgent}"`;
}

function usageTarget({ event = "daily_active", installationId = ID_A, platform = "macos", version = "0.3.3", path } = {}) {
  const url = new URL(buildUpdateFeedUrl({
    event,
    telemetryVersion: ANONYMOUS_USAGE_TELEMETRY_VERSION,
    installationId,
    platform,
    arch: platform === "windows" ? "x64" : "arm64",
    version,
  }));
  return `${path || url.pathname}${url.search}`;
}

describe("parseAccessLogLine", () => {
  it("reads nginx's combined format and converts the time to UTC", () => {
    const entry = parseAccessLogLine(logLine({ time: "21/Oct/2026:08:30:00 +0800", target: "/downloads/a.dmg?x=1" }));
    assert.equal(entry.ip, "203.0.113.7");
    assert.equal(new Date(entry.time).toISOString(), "2026-10-21T00:30:00.000Z");
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/downloads/a.dmg");
    assert.equal(entry.query, "x=1");
    assert.equal(entry.status, 200);
    assert.equal(entry.userAgent, BROWSER);
  });

  it("skips lines that are not requests for a path", () => {
    assert.equal(parseAccessLogLine("not a log line"), null);
    assert.equal(parseAccessLogLine('203.0.113.7 - - [20/Oct/2026:10:00:00 +0000] "-" 400 0 "-" "-"'), null);
    assert.equal(parseAccessLogLine(logLine({ target: "http://example.com/" })), null);
  });
});

describe("classifyRequest", () => {
  const classify = (options) => classifyRequest(parseAccessLogLine(logLine(options)));

  it("reads the usage signal exactly as the desktop app builds it", () => {
    assert.deepEqual(classify({ method: "HEAD", target: usageTarget({ event: "first_launch", platform: "windows", version: "0.3.2" }), userAgent: NODE_FETCH }), {
      kind: "usage",
      event: "first_launch",
      installationId: ID_A,
      platform: "windows",
      version: "0.3.2",
    });
  });

  it("counts the pre-rename manifest address too", () => {
    assert.equal(classify({ method: "HEAD", target: usageTarget({ path: "/releases/latest.json" }), userAgent: NODE_FETCH })?.kind, "usage");
  });

  it("ignores update checks, which carry no installation id", () => {
    assert.equal(classify({ target: "/releases/gravityport/latest.json", userAgent: NODE_FETCH }), null);
    assert.equal(classify({ method: "HEAD", target: "/releases/gravityport/latest.json?event=daily_active&install_id=not-a-uuid" }), null);
  });

  it("counts browser downloads of install packages only", () => {
    assert.deepEqual(classify({ target: "/downloads/GravityPort-0.3.3-arm64.dmg" }), { kind: "download", platform: "macos", ref: "" });
    assert.deepEqual(classify({ target: "/downloads/GravityPort-win32-x64-0.3.3.zip", status: 206 }), { kind: "download", platform: "windows", ref: "" });
    assert.deepEqual(classify({ target: "/downloads/GravityPort-0.3.3-arm64.dmg?ref=reddit_codex" }), { kind: "download", platform: "macos", ref: "reddit_codex" });
    assert.equal(classify({ target: "/downloads/GravityPort-0.3.3-arm64.dmg?ref=%3Cscript%3E" })?.ref, "", "odd labels are dropped");
    assert.equal(classify({ target: "/downloads/GravityPort-darwin-arm64-0.3.3.zip" }), null, "macOS update ZIPs are not installers");
    assert.equal(classify({ target: "/downloads/GravityPort-win32-x64-0.3.3.zip", userAgent: NODE_FETCH }), null, "in-app update downloads");
    assert.equal(classify({ target: "/downloads/GravityPort-0.3.3-arm64.dmg", userAgent: GOOGLEBOT }), null);
    assert.equal(classify({ target: "/downloads/GravityPort-0.3.3-arm64.dmg", status: 404 }), null);
    assert.equal(classify({ method: "HEAD", target: "/downloads/GravityPort-0.3.3-arm64.dmg" }), null);
    assert.equal(classify({ target: "/downloads/visual-packs/pack.zip" }), null);
  });

  it("counts website pages but not the API", () => {
    assert.deepEqual(classify({ target: "/" }), { kind: "page" });
    assert.deepEqual(classify({ target: "/guide/", status: 304 }), { kind: "page" });
    assert.equal(classify({ target: "/api/feedback" }), null);
    assert.equal(classify({ target: "/", userAgent: GOOGLEBOT }), null);
  });
});

describe("weekStartOf", () => {
  it("starts weeks on Monday in UTC", () => {
    assert.equal(weekStartOf(Date.UTC(2026, 9, 19)), "2026-10-19"); // Monday
    assert.equal(weekStartOf(Date.UTC(2026, 9, 25, 23, 59)), "2026-10-19"); // Sunday
    assert.equal(weekStartOf(Date.UTC(2026, 9, 26)), "2026-10-26");
  });
});

describe("createUsageReport", () => {
  const lines = [
    // Week of 2026-10-12.
    logLine({ ip: "198.51.100.1", time: "14/Oct/2026:09:00:00 +0000", target: "/" }),
    logLine({ ip: "198.51.100.1", time: "14/Oct/2026:09:01:00 +0000", target: "/downloads/GravityPort-0.3.1-arm64.dmg", status: 206 }),
    logLine({ ip: "198.51.100.1", time: "14/Oct/2026:09:01:05 +0000", target: "/downloads/GravityPort-0.3.1-arm64.dmg", status: 206 }),
    logLine({ ip: "198.51.100.9", time: "14/Oct/2026:09:02:00 +0000", target: "/downloads/GravityPort-0.3.1-arm64.dmg", userAgent: GOOGLEBOT }),
    logLine({ time: "14/Oct/2026:09:10:00 +0000", method: "HEAD", target: usageTarget({ event: "first_launch", version: "0.3.1" }), userAgent: NODE_FETCH }),
    logLine({ time: "14/Oct/2026:12:00:00 +0000", method: "HEAD", target: usageTarget({ event: "first_launch", installationId: ID_OWN }), userAgent: NODE_FETCH }),
    // Week of 2026-10-19.
    logLine({ ip: "198.51.100.2", time: "20/Oct/2026:10:00:00 +0000", target: "/" }),
    logLine({ ip: "198.51.100.3", time: "20/Oct/2026:10:00:00 +0000", target: "/guide/" }),
    logLine({ ip: "198.51.100.3", time: "20/Oct/2026:10:05:00 +0000", target: "/downloads/GravityPort-win32-x64-0.3.2.zip?ref=reddit_codex" }),
    logLine({ time: "21/Oct/2026:10:00:00 +0000", method: "HEAD", target: usageTarget({ version: "0.3.3" }), userAgent: NODE_FETCH }),
    logLine({ time: "21/Oct/2026:10:00:00 +0000", target: "/releases/gravityport/latest.json", userAgent: NODE_FETCH }),
    logLine({ time: "22/Oct/2026:10:00:00 +0000", method: "HEAD", target: usageTarget({ installationId: ID_B, platform: "windows", version: "0.3.2", path: "/releases/latest.json" }), userAgent: NODE_FETCH }),
    "garbage that is not a log line",
  ];

  function build(order = lines) {
    const report = createUsageReport({ excludeIds: [ID_OWN.toUpperCase()] });
    for (const line of order) report.add(line);
    return report.finish();
  }

  it("counts each week's visitors, downloads, first launches and active installs", () => {
    const result = build();
    assert.deepEqual(result.weeks, [
      {
        weekStart: "2026-10-12",
        visitors: 1,
        downloads: { macos: 1, windows: 0 },
        firstLaunches: { macos: 1, windows: 0, other: 0 },
        active: { macos: 1, windows: 0, other: 0 },
      },
      {
        weekStart: "2026-10-19",
        visitors: 2,
        downloads: { macos: 0, windows: 1 },
        firstLaunches: { macos: 0, windows: 0, other: 0 },
        active: { macos: 1, windows: 1, other: 0 },
      },
    ]);
    assert.equal(result.unparsedLines, 1);
    assert.equal(result.excludedIds, 1);
    assert.equal(result.excludedSignals, 1);
  });

  it("sums the whole log and looks back seven days from its last line", () => {
    const { totals, from, to } = build();
    assert.equal(from, "2026-10-14T09:00:00.000Z");
    assert.equal(to, "2026-10-22T10:00:00.000Z");
    assert.deepEqual(totals.downloads, { macos: 1, windows: 1 });
    assert.deepEqual(totals.firstLaunches, { macos: 1, windows: 0, other: 0 });
    assert.deepEqual(totals.openedShare, { macos: 1, windows: 0 });
    assert.deepEqual(totals.activeLast7Days, { macos: 1, windows: 1, other: 0 });
    assert.equal(totals.installsSeen, 2);
    assert.deepEqual(totals.versionsLast7Days, { "0.3.3": 1, "0.3.2": 1 });
    assert.deepEqual(totals.downloadsByRef, { "": 1, reddit_codex: 1 });
  });

  it("names the campaign labels downloads came from", () => {
    const text = formatUsageReport(build());
    assert.match(text, /下载来自哪个链接标签（ref）：(没带标签 1，reddit_codex 1|reddit_codex 1，没带标签 1)/);
  });

  it("gives the same answer when older log files are read after newer ones", () => {
    const newerFirst = [...lines.slice(6), ...lines.slice(0, 6)];
    assert.deepEqual(build(newerFirst).totals, build().totals);
  });
});

describe("main", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "gravityport-usage-report-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function run(args) {
    const output = [];
    const code = await main(args, { log: (text) => output.push(text) });
    return { code, text: output.join("\n") };
  }

  it("reads plain and gzipped logs and prints counts only", async () => {
    const current = join(dir, "access.log");
    const rotated = join(dir, "access.log.2.gz");
    const exclude = join(dir, "mine.txt");
    await writeFile(current, `${logLine({ target: "/" })}\n${logLine({ time: "21/Oct/2026:10:00:00 +0000", method: "HEAD", target: usageTarget(), userAgent: NODE_FETCH })}\n`);
    await writeFile(rotated, gzipSync(`${logLine({ time: "13/Oct/2026:10:00:00 +0000", method: "HEAD", target: usageTarget({ event: "first_launch", installationId: ID_OWN }), userAgent: NODE_FETCH })}\n`));
    await writeFile(exclude, `${ID_OWN}\n`);

    const { code, text } = await run(["--exclude", exclude, current, rotated]);
    assert.equal(code, 0);
    assert.match(text, /已排除你自己的 1 个安装/);
    assert.match(text, /2026-10-19 起的一周：官网访客 1 · 下载 Mac 0 \/ Windows 0 · 首次启动 Mac 0 \/ Windows 0 · 周活 1（Mac 1 \/ Windows 0）/);
    assert.match(text, /最近 7 天打开过的安装：1/);

    const json = await run(["--json", "--exclude", ID_OWN, current, rotated]);
    const parsed = JSON.parse(json.text);
    assert.equal(parsed.totals.installsSeen, 1);
    for (const output of [text, json.text]) {
      assert.ok(!output.includes("203.0.113.7"), "no IP address in the report");
      assert.ok(!output.includes(ID_A) && !output.includes(ID_OWN), "no installation id in the report");
    }
  });

  it("explains itself when no log is given", async () => {
    const { code, text } = await run([]);
    assert.equal(code, 1);
    assert.match(text, /^Usage: usage-report\.mjs/);
  });

  it("says so when nothing in the log can be read", () => {
    assert.match(formatUsageReport(createUsageReport().finish()), /combined 格式/);
  });
});
