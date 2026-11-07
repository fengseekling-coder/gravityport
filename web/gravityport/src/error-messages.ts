import type { Language } from "./i18n.js"

// 任务 359：错误码文案改成中英双份，由 describeError(error, language) 在出口
// 一次翻好，不再靠 i18n 的整句键二次翻译。带 {占位符} 的句子在这里填好：
// HTTP_ERROR 用 error.status，IMPORT_DROP_TOO_LARGE 用 error.maxFiles（
// collect-dropped-files.ts 附上），分组类错误从服务端原文
// （"Group already exists: 名称"）里取名字。
type MessagePack = { zh: string; en: string }

const ERROR_CODE_MESSAGES: Record<string, MessagePack> = {
  ASSET_ALREADY_STACKED: {
    zh: "无法堆叠素材。素材已在其他堆叠中，列表已刷新，请重试。",
    en: "Couldn’t stack assets. An asset is already in another stack. The list was refreshed. Try again.",
  },
  STACK_NOT_FOUND: {
    zh: "无法完成操作。堆叠已不存在，列表已刷新。",
    en: "Couldn’t complete the action. The stack no longer exists. The list was refreshed.",
  },
  STACK_ASSET_ARCHIVED: {
    zh: "无法堆叠已归档的素材。",
    en: "Couldn’t stack archived assets.",
  },
  STACK_NEEDS_MULTIPLE_ASSETS: {
    zh: "无法创建堆叠。堆叠至少需要 2 个素材。",
    en: "Couldn’t create stack. A stack needs at least 2 assets.",
  },
  STACK_COVER_NOT_MEMBER: {
    zh: "无法设置封面。封面须为堆叠中的素材。",
    en: "Couldn’t set cover. The cover must be an asset in the stack.",
  },
  STACK_NAME_EMPTY: {
    zh: "无法重命名堆叠。名称不能为空。",
    en: "Couldn’t rename stack. The name can’t be empty.",
  },
  STACK_ORDER_MISMATCH: {
    zh: "无法更新堆叠。堆叠内容已变化，列表已刷新，请重试。",
    en: "Couldn’t update stack. The stack changed and the list was refreshed. Try again.",
  },
  STACK_MOVE_BATCH_SIZE_INVALID: {
    zh: "无法移动素材。单次最多移动 2000 个素材。",
    en: "Couldn’t move assets. Up to 2,000 assets can be moved at a time.",
  },
  ASSET_STACKS_UNAVAILABLE: {
    zh: "无法使用堆叠。当前素材库不支持堆叠。",
    en: "Couldn’t use stacks. This library doesn’t support stacks.",
  },
  ASSET_NOT_FOUND: {
    zh: "无法完成操作。素材已不存在，列表已刷新。",
    en: "Couldn’t complete the action. The asset no longer exists. The list was refreshed.",
  },
  // 客户端错误码（mosa-api.ts 在抛出时附上）：
  HTTP_ERROR: {
    zh: "无法连接本地服务（HTTP {status}）",
    en: "Couldn’t reach the local service (HTTP {status})",
  },
  SESSION_EXPIRED: {
    zh: "本地服务授权已过期。请重启 GravityPort。",
    en: "Authorization for the local service has expired. Restart GravityPort.",
  },
  BATCH_PARTIAL: {
    zh: "无法更新所选素材",
    en: "Couldn’t update the selected assets",
  },
  GROUP_EXPORT_CANCELLED: {
    zh: "已取消导出分组",
    en: "Group export canceled",
  },
  GROUP_EXPORT_FAILED: {
    zh: "无法导出分组。请重试。",
    en: "Couldn’t export group. Try again.",
  },
  IMPORT_FAILED: {
    zh: "无法导入",
    en: "Couldn’t import",
  },
  IMPORT_DROP_TOO_LARGE: {
    zh: "无法导入。单次最多拖入 {max} 个文件。",
    en: "Couldn’t import. Up to {max} files can be dropped at once.",
  },
  // 服务端 lib/asset-store.mjs 已有的分组错误码（mosa-api 会把 data.code 带上来）：
  GROUP_ALREADY_EXISTS: {
    zh: "已有名为「{group}」的分组。",
    en: "A group named “{group}” already exists.",
  },
  GROUP_NAME_REQUIRED: {
    zh: "无法完成操作。分组名称不能为空。",
    en: "Couldn’t complete the action. The group name can’t be empty.",
  },
  GROUP_NOT_FOUND: {
    zh: "无法完成操作。分组「{group}」已不存在。",
    en: "Couldn’t complete the action. Group “{group}” no longer exists.",
  },
  // 服务端已有的导入/素材文件错误码，任务 366 按审查表定稿接上（原文照抄）：
  STAGING_FILE_TOO_LARGE: {
    zh: "无法导入。文件过大。",
    en: "Couldn’t import. The file is too large.",
  },
  SOURCE_CHANGED_DURING_IMPORT: {
    zh: "无法导入。文件在导入过程中被修改。",
    en: "Couldn’t import. The file was modified during import.",
  },
  ASSET_FILE_BUSY: {
    zh: "无法完成操作。素材文件正在使用中，请关闭后重试。",
    en: "Couldn’t complete the action. The asset files are in use. Close them and try again.",
  },
  IMAGE_CONTENT_NOT_MEDIA: {
    zh: "无法导入。文件不是支持的图片或视频。",
    en: "Couldn’t import. The file isn’t a supported image or video.",
  },
};

const UNKNOWN_MESSAGE: MessagePack = {
  zh: "无法完成操作（{detail}）",
  en: "Couldn’t complete the action ({detail})",
};

/** "Group already exists: 风景" → "风景"；取不到就原样返回。 */
function groupNameFrom(raw: string): string {
  const index = raw.indexOf(":")
  const name = index >= 0 ? raw.slice(index + 1).trim() : ""
  return name || raw.trim()
}

export function messageForErrorCode(code: string, language: Language = "zh"): string {
  if (!code || typeof code !== "string") return "";
  const pack = ERROR_CODE_MESSAGES[code];
  if (!pack) return "";
  return language === "en" ? pack.en : pack.zh;
}

type ErrorWithFields = Error & { code?: string; status?: number; maxFiles?: number };

/**
 * The one place an error becomes user-facing text (task 322, reworked by task
 * 359): a recognized error code wins over the raw (often English) server
 * message, and every exit returns a full sentence in the requested language.
 * Unrecognized errors fall back to the ERR-UNKNOWN sentence with the raw
 * detail in parentheses (界面文案规范：技术信息放句末括号).
 */
export function describeError(error: unknown, language: Language = "zh"): string {
  const zh = language !== "en";
  const unknown = (detail: string) => UNKNOWN_MESSAGE[zh ? "zh" : "en"].replace("{detail}", detail);
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    const fields = error as ErrorWithFields;
    const code = fields.code || "";
    const pack = ERROR_CODE_MESSAGES[code];
    if (pack) {
      const template = zh ? pack.zh : pack.en;
      if (code === "HTTP_ERROR") {
        return template.replace("{status}", String(fields.status ?? ""));
      }
      if (code === "IMPORT_DROP_TOO_LARGE") {
        return template.replace("{max}", String(fields.maxFiles ?? ""));
      }
      if (code === "GROUP_ALREADY_EXISTS" || code === "GROUP_NOT_FOUND") {
        return template.replace("{group}", groupNameFrom(fields.message || ""));
      }
      return template;
    }
    return unknown(code);
  }
  if (error instanceof Error) return unknown(error.message || "");
  return unknown(String(error));
}
