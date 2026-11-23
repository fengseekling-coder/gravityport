// 任务 463：学习后台的纯数据整理（B 节）。服务和主进程都能 import，不碰密钥。
//
// 分析笔记和手册条目的 JSON schema 只用 type / properties / required /
// additionalProperties / enum / items —— 长度和个数上限结构化输出不一定支持，
// 由本文件的 normalize* 函数卡（超出截断、类型不对整体拒收）。

import { createHash } from "node:crypto";

export const LEARNING_ANALYSIS_VERSION = 1;

/** 手册的九个 section，顺序即界面（464）显示顺序。 */
export const LEARNING_GUIDE_SECTIONS = Object.freeze([
  "positioning",
  "palette",
  "composition",
  "lighting",
  "material",
  "subject",
  "mood",
  "prompting",
  "avoid",
]);

const PALETTE_ROLES = Object.freeze(["main", "secondary", "accent"]);
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

// structured-output schema：每张图一次分析要回的笔记形状。
export const ANALYSIS_NOTE_JSON_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    subject: { type: "string" },
    style_keywords: { type: "array", items: { type: "string" } },
    palette: {
      type: "array",
      items: {
        type: "object",
        properties: {
          hex: { type: "string" },
          role: { type: "string", enum: ["main", "secondary", "accent"] },
          name: { type: "string" },
        },
        required: ["hex", "role", "name"],
        additionalProperties: false,
      },
    },
    composition: { type: "string" },
    camera: { type: "string" },
    lighting: { type: "string" },
    material: { type: "string" },
    character: { type: "string" },
    mood_keywords: { type: "array", items: { type: "string" } },
    prompt_techniques: { type: "array", items: { type: "string" } },
    has_text: { type: "boolean" },
  },
  required: ["subject", "style_keywords", "palette", "composition", "camera", "lighting", "material", "character", "mood_keywords", "prompt_techniques", "has_text"],
  additionalProperties: false,
});

// structured-output schema：汇总一次要回的手册形状。
export const GUIDE_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          section: { type: "string", enum: [...LEARNING_GUIDE_SECTIONS] },
          text: { type: "string" },
          swatches: {
            type: "array",
            items: {
              type: "object",
              properties: { hex: { type: "string" }, name: { type: "string" } },
              required: ["hex", "name"],
              additionalProperties: false,
            },
          },
          sources: { type: "array", items: { type: "integer" } },
        },
        required: ["section", "text", "swatches", "sources"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
});

function trimText(value) {
  return typeof value === "string" ? value.trim() : null;
}

// Trim, then cap by code points (Array.from counts emoji as one character,
// matching how the UI counts 输入框 lengths).
function capText(value, max) {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join("") : value;
}

function capKeywordList(value, { maxItems, maxItemLength }) {
  if (!Array.isArray(value)) return null;
  const cleaned = [];
  for (const item of value) {
    const text = trimText(item);
    if (text === null) return null;
    if (!text) continue;
    cleaned.push(capText(text, maxItemLength));
    if (cleaned.length === maxItems) break;
  }
  return cleaned;
}

/**
 * 模型回的一份分析笔记 → 合格的笔记对象；缺字段或类型不对返回 null（调用方
 * 按 failed / bad-output 记）。字符串去首尾空白后按上限截断；palette 里
 * hex 不合格的色块整条丢掉，合格的大写。
 */
export function normalizeAnalysisNote(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const subject = trimText(raw.subject);
  if (subject === null) return null;
  const composition = trimText(raw.composition);
  const camera = trimText(raw.camera);
  const lighting = trimText(raw.lighting);
  const material = trimText(raw.material);
  const character = trimText(raw.character);
  if (composition === null || camera === null || lighting === null || material === null || character === null) return null;
  const styleKeywords = capKeywordList(raw.style_keywords, { maxItems: 8, maxItemLength: 40 });
  const moodKeywords = capKeywordList(raw.mood_keywords, { maxItems: 8, maxItemLength: 40 });
  const promptTechniques = capKeywordList(raw.prompt_techniques, { maxItems: 5, maxItemLength: 120 });
  if (!styleKeywords || !moodKeywords || !promptTechniques) return null;
  if (!Array.isArray(raw.palette)) return null;
  const palette = [];
  for (const entry of raw.palette) {
    if (palette.length === 5) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const hex = trimText(entry.hex);
    const role = trimText(entry.role);
    const name = trimText(entry.name);
    if (hex === null || role === null || name === null) return null;
    if (!HEX_RE.test(hex) || !PALETTE_ROLES.includes(role)) continue;
    palette.push({ hex: hex.toUpperCase(), role, name: capText(name, 40) });
  }
  if (typeof raw.has_text !== "boolean") return null;
  return {
    subject: capText(subject, 160),
    style_keywords: styleKeywords,
    palette,
    composition: capText(composition, 200),
    camera: capText(camera, 200),
    lighting: capText(lighting, 200),
    material: capText(material, 200),
    character: capText(character, 200),
    mood_keywords: moodKeywords,
    prompt_techniques: promptTechniques,
    has_text: raw.has_text,
  };
}

/**
 * 汇总回的手册条目 → { entries, droppedNoSource, droppedInvalid }。
 * - section 不在九个里、空的 text、超个数的 → droppedInvalid；
 * - text 去首尾空白后按上限截断（positioning 80、其余 240）；
 * - 每个 section 最多 3 条（positioning 1 条），按模型给的顺序保留前面的；
 * - swatches 只给 palette 留（≤6 个，hex 同上），别的 section 一律 []；
 * - sources 去重、只留 validRefs 里的整数、最多 12 个；一个不剩的条目整条
 *   丢掉并计入 droppedNoSource（每条手册必须有来源图）。
 */
export function normalizeGuideEntries(raw, { validRefs }) {
  const entries = [];
  let droppedNoSource = 0;
  let droppedInvalid = 0;
  const rawEntries = raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.entries) ? raw.entries : [];
  const allowed = validRefs instanceof Set ? validRefs : new Set(validRefs || []);
  const perSection = new Map();
  for (const item of rawEntries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { droppedInvalid += 1; continue; }
    const section = trimText(item.section);
    const text = trimText(item.text);
    if (!section || !LEARNING_GUIDE_SECTIONS.includes(section) || !text) { droppedInvalid += 1; continue; }
    const sectionLimit = section === "positioning" ? 1 : 3;
    const used = perSection.get(section) || 0;
    if (used >= sectionLimit) { droppedInvalid += 1; continue; }
    const swatches = [];
    if (section === "palette" && Array.isArray(item.swatches)) {
      for (const swatch of item.swatches) {
        if (swatches.length === 6) break;
        if (!swatch || typeof swatch !== "object" || Array.isArray(swatch)) { droppedInvalid += 1; continue; }
        const hex = trimText(swatch.hex);
        const name = trimText(swatch.name);
        if (hex === null || name === null) { droppedInvalid += 1; continue; }
        if (!HEX_RE.test(hex)) { droppedInvalid += 1; continue; }
        swatches.push({ hex: hex.toUpperCase(), name });
      }
    }
    const seen = new Set();
    const sources = [];
    if (Array.isArray(item.sources)) {
      for (const ref of item.sources) {
        if (!Number.isInteger(ref) || seen.has(ref) || !allowed.has(ref)) continue;
        seen.add(ref);
        sources.push(ref);
        if (sources.length === 12) break;
      }
    } else {
      droppedInvalid += 1;
    }
    if (!sources.length) { droppedNoSource += 1; continue; }
    perSection.set(section, used + 1);
    entries.push({
      section,
      text: capText(text, section === "positioning" ? 80 : 240),
      swatches,
      sources,
    });
  }
  return { entries, droppedNoSource, droppedInvalid };
}

/**
 * 一张图「该不该重新分析」的指纹：内容 hash + 三段提示词 + 笔记格式版本。
 * 模型名不进指纹 —— 换了模型不重学；要全部重学是以后的显式功能。
 */
export function learningAnalysisFingerprint({ contentSha256, prompt, userPrompt, negativePrompt }) {
  return createHash("sha256").update(JSON.stringify({
    v: LEARNING_ANALYSIS_VERSION,
    c: String(contentSha256 || ""),
    p: String(prompt || ""),
    u: String(userPrompt || ""),
    n: String(negativePrompt || ""),
  }), "utf8").digest("hex");
}
