// 任务 458：AI 花费台账（userData 里的 ai-usage.json）。
//
// 按本机日历月记三块（analysis / brain / image）各花了多少美元。任务 458 时
// 没有调用方；任务 463 起学习的每次花钱调用记 slot "analysis"。金额一律美元。
//
// 任务 463（F 节）：recordAiUsage 存「不四舍五入」的金额（保留到 1e-9）——
// 一张图 $0.0007 四舍五入到分记进去就是 $0，一千张就丢了 $0.7；读
// （monthTotals、返回值里的 total）的时候再四舍五入到分。同一个目录的读改
// 写排队（模块里按目录一条 Promise 链），并发的记账一笔不丢。

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AI_SLOTS } from "../../lib/ai/model-catalog.mjs";

const USAGE_FILE_NAME = "ai-usage.json";

/** 本机日历月的键（不是 UTC）：2026-11-22 23:30 本地时间归 2026-11。 */
export function aiUsageMonthKey(date) {
  const source = date instanceof Date ? date : new Date(date);
  const year = source.getFullYear();
  const month = String(source.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** 存储精度：1e-9 美元（远小于任何 token 单价的最小步长，只压浮点尾差）。 */
function round9(value) {
  return Math.round(Number(value) * 1e9) / 1e9;
}

async function readUsageFile(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.months !== "object" || parsed.months === null) {
      return { version: 1, months: {} };
    }
    return parsed;
  } catch {
    return { version: 1, months: {} };
  }
}

async function writeUsageFile(path, data) {
  await mkdir(join(path, ".."), { recursive: true });
  const tempPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(tempPath, 0o600); // Ensure mode on all platforms.
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

// 每个目录一条 Promise 链：recordAiUsage 的读改写串行，并发的记账一笔不丢。
const writeQueues = new Map();

function enqueueForDir(dir, task) {
  const key = resolve(dir);
  const previous = writeQueues.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  // 链上失败不能卡死后面的记账；错误由调用方的 task 自己抛。
  writeQueues.set(key, next.catch(() => {}));
  return next;
}

/**
 * 记一笔花费。slot 必须是三块之一，costUsd 必须是 ≥ 0 的有限数（调用方是
 * 自己的主进程代码，参数错了直接抛）。存储不四舍五入（1e-9）；返回的 total
 * 照读时的规则四舍五入到分。
 */
export async function recordAiUsage(dir, { slot, costUsd, at } = {}) {
  if (!AI_SLOTS.includes(slot)) throw new TypeError(`unknown ai slot: ${String(slot)}`);
  const cost = Number(costUsd);
  if (!Number.isFinite(cost) || cost < 0) throw new TypeError(`invalid ai usage cost: ${String(costUsd)}`);
  const when = at === undefined ? new Date() : new Date(at);
  if (Number.isNaN(when.getTime())) throw new TypeError(`invalid ai usage timestamp: ${String(at)}`);
  const key = aiUsageMonthKey(when);
  return enqueueForDir(dir, async () => {
    const filePath = join(dir, USAGE_FILE_NAME);
    const data = await readUsageFile(filePath);
    if (!data.months[key] || typeof data.months[key] !== "object") data.months[key] = { analysis: 0, brain: 0, image: 0 };
    data.months[key][slot] = round9(data.months[key][slot] + cost);
    await writeUsageFile(filePath, data);
    return { ok: true, month: key, total: round2(data.months[key][slot]) };
  });
}

/** 当月（now 的本机日历月）三块各花了多少；上月的数字不出现。读时四舍五入到分。 */
export async function monthTotals(dir, now = new Date()) {
  const data = await readUsageFile(join(dir, USAGE_FILE_NAME));
  const month = data.months[aiUsageMonthKey(now)] || {};
  return {
    analysis: round2(month.analysis || 0),
    brain: round2(month.brain || 0),
    image: round2(month.image || 0),
  };
}
