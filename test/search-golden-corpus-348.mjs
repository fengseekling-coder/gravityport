// Task 348 golden corpus + query runner.
//
// The fixture in test/fixtures/348-search-golden/results.json was captured on
// the pre-change code (batch/2026-11-01 e0e08c8, before the task-348 search
// index rework) with this exact builder: one deterministic 2000-asset corpus
// (mixed CJK/English prompts, tags, groups, archived, favorites, stacks, 5%
// trashed, 20 of those restored) and the fixed query list below, paged the way
// the App calls it (limit 100, so the store fetches LIMIT 101 per page).
// The task-348 test rebuilds the same corpus on the new code and asserts the
// results are identical row for row, total for total.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const GOLDEN_CORPUS_ASSET_COUNT = 2000;
export const GOLDEN_CORPUS_SEED = 348348;
const BASE_CREATED_AT = Date.parse("2026-01-01T00:00:00.000Z");

// mulberry32: tiny deterministic PRNG so the corpus never depends on Math.random.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==",
  "base64",
);

// Fixed phrase pools. Between them they must surface every fixture query's
// terms: 光 懵 色 鲸 城市 市夜(group 城市夜行志) 猫 霓虹 雨夜 8k 高清 e一 赛博朋克
// 3d ui 4k cat Cyber — singles and pairs, CJK and ASCII, mixed case.
const PROMPT_POOL = [
  "霓虹雨夜的赛博朋克城市街头",
  "海边光斑里的鲸鱼跃出水面",
  "懵懂的猫在色块构成里打盹",
  "慵懒的猫，蜷在窗台光斑里",
  "8k 高清壁纸雪山日出光",
  "Se一野色渐层抽象背景",
  "Cyber City Night, ui kit dashboard",
  "3d render of a cat astronaut, 4k",
  "雨夜便利店光晕胶片颗粒",
  "城市夜行电车窗外光轨",
  "赛博朋克机械鲸鱼游过霓虹深海",
  "水彩色块猫爪印记",
  "ui buttons set, 8k clean render",
  "4k cat close-up in warm light",
  "光之走廊尽头的鲸鱼骨架",
  "懵懂色铅笔少女速写",
  "赛博朋克 4k 全息广告牌",
];
const TAG_POOL = [
  "赛博朋克", "猫", "鲸", "光斑", "色块", "8k", "ui", "4k", "3d",
  "Cyber", "霓虹", "雨夜", "高清", "壁纸",
];
const GROUP_POOL = ["城市夜行志", "海边风光", "静物研究", "抽象构成", ""];
const STYLE_POOL = ["胶片", "水彩", "3d", "flat"];

function pick(random, pool) {
  return pool[Math.floor(random() * pool.length)];
}

export const GOLDEN_QUERIES = [
  { label: "单字光", query: "光" },
  { label: "罕见字懵", query: "懵" },
  { label: "单字色", query: "色" },
  { label: "单字鲸", query: "鲸" },
  { label: "双字城市", query: "城市" },
  { label: "跨词市夜", query: "市夜" },
  { label: "带逗号猫", query: "猫，" },
  { label: "双词霓虹雨夜", query: "霓虹 雨夜" },
  { label: "混合8k高清", query: "8k 高清" },
  { label: "字母汉字e一", query: "e一" },
  { label: "四字赛博朋克", query: "赛博朋克" },
  { label: "短英文3d", query: "3d" },
  { label: "短英文ui", query: "ui" },
  { label: "短英文4k", query: "4k" },
  { label: "三字cat", query: "cat" },
  { label: "大小写Cyber", query: "Cyber" },
  { label: "分组过滤城市", query: "城市", group: "城市夜行志" },
  { label: "收藏过滤光", query: "光", favorite: true },
];

const PAGE_SIZE = 100;

export async function buildGoldenCorpus(store, { projectRoot } = {}) {
  const imagesDir = join(projectRoot, "corpus-images");
  await mkdir(imagesDir, { recursive: true });
  const imagePath = join(imagesDir, "seed.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const random = mulberry32(GOLDEN_CORPUS_SEED);
  const trashIds = [];
  for (let index = 0; index < GOLDEN_CORPUS_ASSET_COUNT; index += 1) {
    const id = `golden-${String(index + 1).padStart(4, "0")}`;
    const prompt = `${pick(random, PROMPT_POOL)} variant${index}`;
    const tags = [...new Set([pick(random, TAG_POOL), pick(random, TAG_POOL)])];
    const group = pick(random, GROUP_POOL);
    await store.createAsset({
      assetId: id,
      imagePath,
      prompt,
      tags,
      group: group || undefined,
      style: pick(random, STYLE_POOL),
      favorite: index % 7 === 3,
      rating: index % 11 === 5 ? 4 : 0,
      archived: index % 13 === 9,
      created_at: new Date(BASE_CREATED_AT + index * 1000).toISOString(),
    });
    if (index % 20 === 4) trashIds.push(id);
  }
  // Two stacks over fixed member sets (still deterministic membership).
  const allIds = (offset, count) => Array.from(
    { length: count },
    (_, index) => `golden-${String(offset + index).padStart(4, "0")}`,
  );
  // Offsets avoid the archived (i%13==9) and trashed (i%20==4) patterns.
  const stackA = await store.createAssetStack("default", allIds(40, 6));
  const stackB = await store.createAssetStack("default", allIds(520, 4));
  // 5% into Trash, then restore 20 of them.
  for (const id of trashIds) await store.deleteAsset("default", id, { reason: "golden-cleanup" });
  for (const id of trashIds.slice(0, 20)) await store.restoreAsset("default", id);
  return { assetCount: GOLDEN_CORPUS_ASSET_COUNT, trashCount: trashIds.length, restoredCount: 20, stackA, stackB };
}

export async function runGoldenQueries(store) {
  const results = [];
  for (const spec of GOLDEN_QUERIES) {
    const filters = {
      projectId: "default",
      query: spec.query,
      limit: PAGE_SIZE,
      ...(spec.group ? { group: spec.group } : {}),
      ...(spec.favorite ? { favorite: true } : {}),
    };
    const pages = [];
    let cursor = null;
    for (let page = 0; page < 2; page += 1) {
      // listAssetPage with limit 100 = the App's LIMIT 101 paging contract.
      const { assets, page: pageInfo } = await store.listAssetPage({ ...filters, cursor: cursor || undefined });
      pages.push({ ids: assets.map((asset) => asset.id), total: pageInfo.total });
      cursor = pageInfo.nextCursor;
      if (!cursor) break;
    }
    results.push({ label: spec.label, query: spec.query, filters: { group: spec.group || null, favorite: Boolean(spec.favorite) }, pages });
  }
  return results;
}
