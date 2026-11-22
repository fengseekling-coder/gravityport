// 任务 458：AI 花费台账（userData 里的 ai-usage.json）。
//
// 按本机日历月记三块（analysis / brain / image）各花了多少美元。这张单没有
// 调用方（还没有任何花钱的调用），只在测试里用；后面几张单的主进程调用
// recordAiUsage 记账、monthTotals 读当月合计。金额一律美元。

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * 记一笔花费。slot 必须是三块之一，costUsd 必须是 ≥ 0 的有限数（调用方是
 * 自己的主进程代码，参数错了直接抛）。
 */
export async function recordAiUsage(dir, { slot, costUsd, at } = {}) {
  if (!AI_SLOTS.includes(slot)) throw new TypeError(`unknown ai slot: ${String(slot)}`);
  const cost = Number(costUsd);
  if (!Number.isFinite(cost) || cost < 0) throw new TypeError(`invalid ai usage cost: ${String(costUsd)}`);
  const when = at === undefined ? new Date() : new Date(at);
  if (Number.isNaN(when.getTime())) throw new TypeError(`invalid ai usage timestamp: ${String(at)}`);
  const filePath = join(dir, USAGE_FILE_NAME);
  const data = await readUsageFile(filePath);
  const key = aiUsageMonthKey(when);
  if (!data.months[key] || typeof data.months[key] !== "object") data.months[key] = { analysis: 0, brain: 0, image: 0 };
  data.months[key][slot] = round2(data.months[key][slot] + cost);
  await writeUsageFile(filePath, data);
  return { ok: true, month: key, total: data.months[key][slot] };
}

/** 当月（now 的本机日历月）三块各花了多少；上月的数字不出现。 */
export async function monthTotals(dir, now = new Date()) {
  const data = await readUsageFile(join(dir, USAGE_FILE_NAME));
  const month = data.months[aiUsageMonthKey(now)] || {};
  return {
    analysis: round2(month.analysis || 0),
    brain: round2(month.brain || 0),
    image: round2(month.image || 0),
  };
}
