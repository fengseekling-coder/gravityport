#!/usr/bin/env node

// Weekly usage report for the maintainer, read from the website's nginx access
// logs. It answers "how many people really use GravityPort?" with four counts
// per week (Monday to Sunday, UTC):
//
// - site visitors: distinct IPs that opened a page of the website in a browser;
// - downloads: distinct IPs that downloaded an install package in a desktop
//   browser (macOS .dmg, Windows win32 .zip). The range requests of one
//   download, bots, link previews and the app's own update downloads do not
//   count. Downloads on phones, which cannot install the app, are counted
//   apart;
// - first launches: installations that sent first_launch;
// - weekly active: installations that sent any usage signal that week.
//
// Over the whole log it also says where visitors came from (the referring
// site's host name only), counts downloads per campaign label for download
// links the website tags with ?ref=... (see PRIVACY.md), and lists the
// versions installations first launched and run now.
//
// Usage signals are the bodyless requests packaged apps send to the release
// manifest (desktop/update-service.mjs). Every address a version has used
// counts: /releases/gravityport/latest.json (0.3.1 and later, on both
// hostnames) and the pre-rename /releases/latest.json. Update checks request
// the same address without an installation id and are ignored.
//
// The report prints counts only: no IP address or installation id leaves it.
// The logs must use nginx's default "combined" format; plain and .gz files
// both work, so `access.log*` covers rotated logs. The script has no
// dependencies, so it can be copied to the server on its own.
//
//   node scripts/usage-report.mjs [--exclude <file or ids>] [--json] <access.log> [...]
//
// --exclude takes a file with one installation id per line, or ids separated by
// commas, so your own machines do not count. A machine's id is the
// installationId in anonymous-usage.json in the app's data folder (macOS:
// ~/Library/Application Support/mosa, Windows: %APPDATA%\mosa). The report
// says when it last saw an excluded machine and on which version, which also
// shows whether the log covers the address that version reports to.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";

const USAGE = "Usage: usage-report.mjs [--exclude <file or comma-separated ids>] [--json] <access.log> [<access.log.1> <access.log.2.gz> ...]";

const MANIFEST_PATHS = new Set(["/releases/gravityport/latest.json", "/releases/latest.json"]);
const USAGE_EVENTS = new Set(["first_launch", "daily_active"]);
const PLATFORMS = ["macos", "windows", "other"];
const DOWNLOAD_PLATFORMS = ["macos", "windows"];
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,48}$/;
const REF_PATTERN = /^[0-9A-Za-z._-]{1,64}$/;
// Browsers say "Mozilla/"; so do many robots, which name themselves further on.
// "electron" keeps the app's own requests out even if one ever carries a
// Chromium user agent: people download installers in a browser, not in the app.
const BOT_PATTERN = /bot|crawl|spider|slurp|preview|scan|headless|lighthouse|facebookexternalhit|embedly|curl|wget|python|go-http|okhttp|java\/|httpclient|libwww|axios|undici|node-fetch|electron/i;
// Phones and Android tablets cannot install the desktop app. iPads send a Mac
// user agent and count as Macs.
const MOBILE_PATTERN = /iPhone|iPod|Android|Mobile/i;
// A referrer from the website itself is a visitor moving between its pages.
const OWN_HOSTS = new Set(["gravityport.azhuilab.com", "mosa.azhuilab.com"]);
const HOST_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DIRECT_SOURCE = "";
const OTHER_SOURCE = "other";
const TOP_SOURCES = 8;
// $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"
const COMBINED_LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) \S+ "([^"]*)" "([^"]*)"/;
const TIME_LOCAL = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60 * 1000;

function parseTimeLocal(value) {
  const match = TIME_LOCAL.exec(value);
  if (!match) return NaN;
  const [, day, monthName, year, hours, minutes, seconds, sign, offsetHours, offsetMinutes] = match;
  const month = MONTHS.indexOf(monthName);
  if (month < 0) return NaN;
  const offsetMs = (Number(offsetHours) * 60 + Number(offsetMinutes)) * 60 * 1000;
  const utc = Date.UTC(Number(year), month, Number(day), Number(hours), Number(minutes), Number(seconds));
  return sign === "+" ? utc - offsetMs : utc + offsetMs;
}

// A line in the right format whose request is not for a path is noise from
// scanners (a TLS handshake sent to the HTTP port, "-", a proxy probe such as
// "CONNECT host:443"), not a sign that the log uses another format.
function parseLine(line) {
  const match = COMBINED_LINE.exec(line);
  if (!match) return { problem: "format" };
  const [, ip, timeLocal, request, status, referrer, userAgent] = match;
  const time = parseTimeLocal(timeLocal);
  if (!Number.isFinite(time)) return { problem: "format" };
  const [method, target] = request.split(" ");
  if (!method || !target?.startsWith("/")) return { problem: "noise" };
  const queryStart = target.indexOf("?");
  return {
    entry: {
      ip,
      time,
      method,
      path: queryStart < 0 ? target : target.slice(0, queryStart),
      query: queryStart < 0 ? "" : target.slice(queryStart + 1),
      status: Number(status),
      referrer,
      userAgent,
    },
  };
}

/** Parses one "combined" log line, or returns null when it is not a request for a path. */
export function parseAccessLogLine(line) {
  return parseLine(line).entry || null;
}

function isBrowser(userAgent) {
  return userAgent.includes("Mozilla/") && !BOT_PATTERN.test(userAgent);
}

/**
 * Where a page view came from: the referring site's host name, "" when the
 * browser sent no referrer (a typed address, a bookmark, an app, or a site
 * that hides it), "other" when it cannot be read, or null for the website's
 * own pages. Only the host name is kept, never the path or query.
 */
function referrerSource(referrer) {
  if (!referrer || referrer === "-") return DIRECT_SOURCE;
  let host;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return OTHER_SOURCE;
  }
  if (OWN_HOSTS.has(host)) return null;
  if (host.length > 64 || !HOST_PATTERN.test(host) || IPV4_PATTERN.test(host)) return OTHER_SOURCE;
  return host.replace(/^www\./, "");
}

function downloadPlatform(path) {
  const file = path.slice("/downloads/".length);
  if (!path.startsWith("/downloads/") || !file || file.includes("/")) return null;
  const name = file.toLowerCase();
  if (name.endsWith(".dmg")) return "macos";
  if (name.endsWith(".zip") && name.includes("win32")) return "windows";
  return null;
}

function isPage(path) {
  if (path.startsWith("/api/") || path.startsWith("/releases/") || path.startsWith("/downloads/")) return false;
  return path.endsWith("/") || path.endsWith(".html");
}

/**
 * Sorts a parsed line into the one thing the report counts, if any:
 * a usage signal, a package download, or a page view.
 */
export function classifyRequest(entry) {
  if (!entry) return null;
  if (MANIFEST_PATHS.has(entry.path) && (entry.method === "HEAD" || entry.method === "GET")) {
    const params = new URLSearchParams(entry.query);
    const installationId = (params.get("install_id") || "").toLowerCase();
    const event = params.get("event") || "";
    if (!INSTALLATION_ID_PATTERN.test(installationId) || !USAGE_EVENTS.has(event)) return null;
    const platform = PLATFORMS.includes(params.get("platform")) ? params.get("platform") : "other";
    const version = VERSION_PATTERN.test(params.get("version") || "") ? params.get("version") : "unknown";
    return { kind: "usage", event, installationId, platform, version };
  }
  if (entry.method !== "GET" || !isBrowser(entry.userAgent)) return null;
  const mobile = MOBILE_PATTERN.test(entry.userAgent);
  const platform = downloadPlatform(entry.path);
  if (platform) {
    if (entry.status !== 200 && entry.status !== 206) return null;
    // The website can tag download links with a campaign label (?ref=reddit_codex).
    const ref = new URLSearchParams(entry.query).get("ref") || "";
    return { kind: "download", platform, ref: REF_PATTERN.test(ref) ? ref : "", mobile };
  }
  if (isPage(entry.path) && (entry.status === 200 || entry.status === 304)) {
    return { kind: "page", mobile, source: referrerSource(entry.referrer) };
  }
  return null;
}

/** Monday (UTC) of the week a timestamp falls in, as YYYY-MM-DD. */
export function weekStartOf(time) {
  const date = new Date(time);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday))
    .toISOString()
    .slice(0, 10);
}

function emptyWeek() {
  return {
    visitors: new Set(),
    downloads: { macos: new Set(), windows: new Set() },
    firstLaunches: { macos: new Set(), windows: new Set(), other: new Set() },
    active: { macos: new Set(), windows: new Set(), other: new Set() },
  };
}

/** Collects log lines and turns them into the report's counts. */
export function createUsageReport({ excludeIds = [] } = {}) {
  const excluded = new Set(excludeIds.map((id) => String(id).toLowerCase()));
  const weeks = new Map();
  const installs = new Map();
  const excludedSeen = new Map();
  const visitors = new Set();
  const mobileVisitors = new Set();
  const sourceVisitors = new Map();
  const downloaders = { macos: new Set(), windows: new Set() };
  const mobileDownloaders = new Set();
  const refDownloaders = new Map();
  const counts = { lines: 0, unparsed: 0, noise: 0, excludedSignals: 0 };
  let firstTime = Infinity;
  let lastTime = -Infinity;

  function week(time) {
    const key = weekStartOf(time);
    if (!weeks.has(key)) weeks.set(key, emptyWeek());
    return weeks.get(key);
  }

  function addVisitor(entry, request) {
    week(entry.time).visitors.add(entry.ip);
    visitors.add(entry.ip);
    if (request.mobile) mobileVisitors.add(entry.ip);
    if (request.source === null) return;
    if (!sourceVisitors.has(request.source)) sourceVisitors.set(request.source, new Set());
    sourceVisitors.get(request.source).add(entry.ip);
  }

  function addDownload(entry, request) {
    if (request.mobile) {
      mobileDownloaders.add(entry.ip);
      return;
    }
    week(entry.time).downloads[request.platform].add(entry.ip);
    downloaders[request.platform].add(entry.ip);
    if (!refDownloaders.has(request.ref)) refDownloaders.set(request.ref, new Set());
    refDownloaders.get(request.ref).add(`${request.platform} ${entry.ip}`);
  }

  function addExcludedSignal(entry, request) {
    counts.excludedSignals += 1;
    const seen = excludedSeen.get(request.installationId);
    if (!seen || entry.time >= seen.lastSeen) {
      excludedSeen.set(request.installationId, { lastSeen: entry.time, version: request.version });
    }
  }

  function addUsageSignal(entry, request) {
    const current = week(entry.time);
    const firstLaunch = request.event === "first_launch";
    current.active[request.platform].add(request.installationId);
    if (firstLaunch) current.firstLaunches[request.platform].add(request.installationId);
    const known = installs.get(request.installationId);
    if (!known || entry.time >= known.lastSeen) {
      installs.set(request.installationId, {
        platform: request.platform,
        version: request.version,
        lastSeen: entry.time,
        // null until the installation's first_launch shows up.
        firstLaunchVersion: firstLaunch ? request.version : known?.firstLaunchVersion ?? null,
      });
    } else if (firstLaunch) {
      known.firstLaunchVersion = request.version;
    }
  }

  return {
    add(line) {
      if (!line.trim()) return;
      counts.lines += 1;
      const { entry, problem } = parseLine(line);
      if (!entry) {
        if (problem === "noise") counts.noise += 1;
        else counts.unparsed += 1;
        return;
      }
      firstTime = Math.min(firstTime, entry.time);
      lastTime = Math.max(lastTime, entry.time);
      const request = classifyRequest(entry);
      if (!request) return;
      if (request.kind === "page") addVisitor(entry, request);
      else if (request.kind === "download") addDownload(entry, request);
      else if (excluded.has(request.installationId)) addExcludedSignal(entry, request);
      else addUsageSignal(entry, request);
    },

    finish() {
      const byPlatform = (sets) => Object.fromEntries(Object.entries(sets).map(([platform, set]) => [platform, set.size]));
      const recentSince = lastTime - 7 * DAY_MS;
      const recent = { macos: 0, windows: 0, other: 0 };
      const recentVersions = new Map();
      const firstLaunches = { macos: 0, windows: 0, other: 0 };
      const firstLaunchVersions = new Map();
      for (const install of installs.values()) {
        if (install.firstLaunchVersion !== null) {
          firstLaunches[install.platform] += 1;
          addTo(firstLaunchVersions, install.firstLaunchVersion);
        }
        if (install.lastSeen <= recentSince) continue;
        recent[install.platform] += 1;
        addTo(recentVersions, install.version);
      }
      let excludedLast = null;
      for (const seen of excludedSeen.values()) {
        if (!excludedLast || seen.lastSeen > excludedLast.lastSeen) excludedLast = seen;
      }
      const downloads = byPlatform(downloaders);
      return {
        from: Number.isFinite(firstTime) ? new Date(firstTime).toISOString() : null,
        to: Number.isFinite(lastTime) ? new Date(lastTime).toISOString() : null,
        lines: counts.lines,
        unparsedLines: counts.unparsed,
        noiseLines: counts.noise,
        excludedIds: excluded.size,
        excludedSeen: excludedSeen.size,
        excludedSignals: counts.excludedSignals,
        excludedLastSeen: excludedLast ? new Date(excludedLast.lastSeen).toISOString() : null,
        excludedLastVersion: excludedLast ? excludedLast.version : null,
        weeks: [...weeks.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([weekStart, data]) => ({
            weekStart,
            visitors: data.visitors.size,
            downloads: byPlatform(data.downloads),
            firstLaunches: byPlatform(data.firstLaunches),
            active: byPlatform(data.active),
          })),
        totals: {
          visitors: visitors.size,
          mobileVisitors: mobileVisitors.size,
          visitorsBySource: topSources(sourceVisitors),
          downloads,
          mobileDownloads: mobileDownloaders.size,
          firstLaunches,
          firstLaunchVersions: sortedCounts(firstLaunchVersions),
          openedShare: Object.fromEntries(DOWNLOAD_PLATFORMS.map((platform) => [
            platform,
            downloads[platform] ? Math.round((firstLaunches[platform] / downloads[platform]) * 100) / 100 : null,
          ])),
          activeLast7Days: recent,
          installsSeen: installs.size,
          versionsLast7Days: sortedCounts(recentVersions),
          // Downloads per campaign label; "" collects downloads without one.
          downloadsByRef: sortedCounts(new Map([...refDownloaders.entries()].map(([ref, set]) => [ref, set.size]))),
        },
      };
    },
  };
}

function addTo(counts, key) {
  counts.set(key, (counts.get(key) || 0) + 1);
}

function sortedCounts(counts) {
  return Object.fromEntries([...counts.entries()].sort(([, a], [, b]) => b - a));
}

// Visitors per referring site, busiest first: the top sites by name, the rest
// under "other", then visitors that came without a referrer under "".
function topSources(sourceVisitors) {
  const sites = [...sourceVisitors.entries()]
    .filter(([source]) => source !== DIRECT_SOURCE && source !== OTHER_SOURCE)
    .sort(([, a], [, b]) => b.size - a.size);
  const rest = new Set(sourceVisitors.get(OTHER_SOURCE));
  for (const [, ips] of sites.slice(TOP_SOURCES)) for (const ip of ips) rest.add(ip);
  const direct = sourceVisitors.get(DIRECT_SOURCE)?.size || 0;
  return Object.fromEntries([
    ...sites.slice(0, TOP_SOURCES).map(([source, ips]) => [source, ips.size]),
    ...(rest.size ? [[OTHER_SOURCE, rest.size]] : []),
    ...(direct ? [[DIRECT_SOURCE, direct]] : []),
  ]);
}

const sum = (counts) => Object.values(counts).reduce((total, count) => total + count, 0);
const percent = (share) => (share === null ? "无下载" : `${Math.round(share * 100)}%`);
const listCounts = (counts) => Object.entries(counts).map(([name, count]) => `${name} × ${count}`).join("，");
const SOURCE_NAMES = { [OTHER_SOURCE]: "其他网站", [DIRECT_SOURCE]: "直接打开或来源不明" };

// Says whether the excluded machines showed up at all. A machine that runs the
// current version and was seen recently proves the log covers the address the
// current version reports to.
function excludedLine(report) {
  if (!report.excludedSeen) {
    const machines = report.excludedIds === 1 ? "这台电脑" : "这些电脑";
    return `已排除你自己的 ${report.excludedIds} 个安装，但日志里一次也没见到。可能是 ID 填错了，也可能${machines}的统计信号没进这份日志。`;
  }
  const seen = report.excludedIds === 1 ? "它" : `其中 ${report.excludedSeen} 个`;
  return `已排除你自己的 ${report.excludedIds} 个安装。日志里见到了${seen}，最近一次是 ${report.excludedLastSeen.slice(0, 10)}，版本 ${report.excludedLastVersion}。`;
}

/** The report as plain Chinese text for the maintainer. */
export function formatUsageReport(report) {
  if (!report.from) return "日志里没有可以识别的记录。确认日志是 nginx 默认的 combined 格式。";
  const lines = [
    `GravityPort 使用情况（日志覆盖 ${report.from.slice(0, 10)} 到 ${report.to.slice(0, 10)}，按周统计，每周从周一开始，UTC 时间）`,
  ];
  if (report.excludedIds) lines.push(excludedLine(report));
  lines.push("");
  for (const week of report.weeks) {
    lines.push(
      `${week.weekStart} 起的一周：官网访客 ${week.visitors}`
      + ` · 下载 Mac ${week.downloads.macos} / Windows ${week.downloads.windows}`
      + ` · 首次启动 Mac ${week.firstLaunches.macos} / Windows ${week.firstLaunches.windows}`
      + ` · 周活 ${sum(week.active)}（Mac ${week.active.macos} / Windows ${week.active.windows}）`,
    );
  }
  const { totals } = report;
  lines.push("", "整个日志期间：", `- 官网访客：${totals.visitors}，其中用手机的 ${totals.mobileVisitors}`);
  const sources = Object.entries(totals.visitorsBySource);
  if (sources.length) {
    lines.push(`- 访客从哪来：${sources.map(([source, count]) => `${SOURCE_NAMES[source] ?? source} ${count}`).join(" · ")}`);
  }
  const launchVersions = listCounts(totals.firstLaunchVersions);
  lines.push(
    `- 下载人数：Mac ${totals.downloads.macos}，Windows ${totals.downloads.windows}`
      + (totals.mobileDownloads ? `；另有 ${totals.mobileDownloads} 人在手机上点了下载，手机装不了，没算进去` : ""),
    `- 首次启动：Mac ${totals.firstLaunches.macos}，Windows ${totals.firstLaunches.windows}${launchVersions ? `（版本：${launchVersions}）` : ""}`,
    `- 下载后打开过的大约比例：Mac ${percent(totals.openedShare.macos)}，Windows ${percent(totals.openedShare.windows)}`,
    `- 最近 7 天打开过的安装：${sum(totals.activeLast7Days)}（Mac ${totals.activeLast7Days.macos} / Windows ${totals.activeLast7Days.windows}）`,
    `- 见过的安装总数：${totals.installsSeen}`,
  );
  const versions = listCounts(totals.versionsLast7Days);
  if (versions) lines.push(`- 最近 7 天活跃安装的版本：${versions}`);
  const refs = Object.entries(totals.downloadsByRef);
  if (refs.some(([ref]) => ref)) {
    lines.push(`- 下载来自哪个链接标签（ref）：${refs.map(([ref, count]) => `${ref || "没带标签"} ${count}`).join("，")}`);
  }
  lines.push(
    "",
    "说明：同一个 IP 下载同一平台的安装包只算一次；下载只算电脑浏览器里的；访问和下载都不算爬虫、链接预览和 App 自己下载更新包。",
  );
  if (report.unparsedLines) lines.push(`有 ${report.unparsedLines} 行不是 combined 格式，已跳过。`);
  if (report.noiseLines) lines.push(`有 ${report.noiseLines} 条请求不是正常网址（多半是扫描器发的），已忽略。`);
  return lines.join("\n");
}

async function readExcludeIds(value) {
  if (!value) return [];
  let text = value;
  try {
    if ((await stat(value)).isFile()) text = await readFile(value, "utf8");
  } catch {
    // Not a file: treat the value itself as a list of ids.
  }
  return text.split(/[\s,]+/).filter((id) => INSTALLATION_ID_PATTERN.test(id));
}

async function addLogFile(report, path) {
  const source = createReadStream(path);
  const input = path.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) report.add(line);
}

export async function main(argv = process.argv.slice(2), { log = (text) => console.log(text) } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      exclude: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    log(USAGE);
    return values.help ? 0 : 1;
  }
  const report = createUsageReport({ excludeIds: await readExcludeIds(values.exclude) });
  for (const path of positionals) await addLogFile(report, path);
  const result = report.finish();
  log(values.json ? JSON.stringify(result, null, 2) : formatUsageReport(result));
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
