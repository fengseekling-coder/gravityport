/**
 * Pinterest UI strings.
 *
 * Chinese text is written inline in the components; PINTEREST_EN carries the
 * English counterparts. pinterestText() looks up PINTEREST_EN first and falls
 * back to the shared i18n table — i18n.ts itself is not touched here.
 * 任务 359：文字照定稿（文案审查 SET-07 / MAIN-32 / EMPTY-13）。
 */

import { translate, type Language } from "./i18n.js";

export const PINTEREST_EN: Record<string, string> = {
  // Guide page / view states
  "连接 Pinterest": "Connect Pinterest",
  "连接后可在此浏览 Pinterest 账号中的画板和 Pin。内容仅在此电脑上实时显示，不会存入素材库，也不会上传。":
    "Connect a Pinterest account to browse its boards and Pins here. Content is shown live on this computer only. It isn’t saved to the library or uploaded.",
  "Pinterest 授权已失效": "Pinterest authorization expired",
  "重新连接": "Reconnect",
  "重试": "Retry",
  "正在加载…": "Loading…",
  "打开设置": "Open Settings",

  // Board grid / Pin grid
  "全部画板": "All boards",
  "{count} 个 Pin": "{count} Pins",
  "1 个 Pin": "1 Pin",
  "私密": "Private",
  "视频": "Video",
  "Pinterest 账号中没有画板。在 Pinterest 创建画板后将显示在此处。":
    "No boards in this Pinterest account. Boards created on Pinterest appear here.",
  "此画板中没有 Pin。在 Pinterest 保存 Pin 后将显示在此处。":
    "No Pins in this board. Pins saved to it on Pinterest appear here.",
  "正在加载更多…": "Loading more…",

  // Pin detail
  "来自 Pinterest": "From Pinterest",
  "在 Pinterest 打开": "Open in Pinterest",
  "无法打开链接": "Couldn’t open link",

  // Connection card
  "未连接": "Not connected",
  "已连接": "Connected",
  "已连接 {username}": "Connected as {username}",
  "在侧栏浏览 Pinterest 账号中的画板和 Pin。内容仅在此电脑上实时显示，不会存入素材库，也不会上传。":
    "Browse boards and Pins from a Pinterest account in the sidebar. Content is shown live on this computer only. It isn’t saved to the library or uploaded.",
  "需要重新连接": "Needs reconnection",
  "今天已用 {used} / {limit} 次": "{used} of {limit} requests used today",
  "断开 Pinterest？": "Disconnect Pinterest?",
  "此电脑上保存的 Pinterest 授权将被移除，需要时可重新连接。":
    "The Pinterest authorization saved on this computer will be removed. It can be reconnected at any time.",
  "断开": "Disconnect",
  "取消": "Cancel",
  "正在等待浏览器授权…": "Waiting for browser authorization…",

  // pinterestErrorMessage outcomes (keep in sync with pinterest-api.ts)
  "尚未连接 Pinterest": "Pinterest isn’t connected",
  "Pinterest 授权已失效。请重新连接。": "Pinterest authorization has expired. Reconnect to continue.",
  "今日 Pinterest 浏览额度即将用完，明天恢复。":
    "Today’s Pinterest browsing quota is almost used up. It resets tomorrow.",
  "Pinterest 请求过于频繁，请稍后重试。": "Too many Pinterest requests. Try again later.",
  "无法连接 Pinterest。本机服务所用的端口已被占用。":
    "Couldn’t connect to Pinterest. The port used by the local service is already in use.",
  "无法连接 Pinterest。连接服务暂不可用，请稍后重试。":
    "Couldn’t connect to Pinterest. The connection service is unavailable. Try again later.",
  "无法连接 Pinterest。请检查网络连接。": "Couldn’t reach Pinterest. Check the network connection.",
  "无法打开画板。画板链接无效。": "Couldn’t open board. The board link isn’t valid.",
  "无法打开 Pinterest 授权页面。": "Couldn’t open the Pinterest authorization page.",
  "Pinterest 授权超时，请重试。": "Pinterest authorization timed out. Try again.",
  "无法断开 Pinterest。请稍后重试。": "Couldn’t disconnect Pinterest. Try again later.",
  "无法加载 Pinterest 内容。": "Couldn’t load Pinterest content.",
};

export function pinterestText(text: string, language: Language): string {
  if (language !== "en") return text;
  if (Object.prototype.hasOwnProperty.call(PINTEREST_EN, text)) {
    return PINTEREST_EN[text];
  }
  return translate(text, language);
}

/** pinterestText + {placeholder} substitution for parameterized strings. */
export function pinterestFormat(
  text: string,
  params: Record<string, string | number>,
  language: Language
): string {
  const localized = pinterestText(text, language);
  return localized.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  );
}
