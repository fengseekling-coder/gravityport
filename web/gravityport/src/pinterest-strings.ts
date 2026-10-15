/**
 * Pinterest UI strings.
 *
 * Chinese text is written inline in the components; PINTEREST_EN carries the
 * English counterparts. pinterestText() looks up PINTEREST_EN first and falls
 * back to the shared i18n table — i18n.ts itself is not touched here.
 */

import { translate, type Language } from "./i18n.js";

export const PINTEREST_EN: Record<string, string> = {
  // Guide page / view states
  "连接 Pinterest": "Connect Pinterest",
  "连接后，可以在这里浏览你自己的画板和 Pin。内容只在这台电脑上实时显示，不会存进素材库。":
    "Once connected, you can browse your own Pinterest boards and Pins here. Content is shown live on this computer only and is never saved to the library.",
  "Pinterest 授权已失效，请重新连接": "Pinterest authorization has expired. Reconnect to continue.",
  "重新连接": "Reconnect",
  "重试": "Retry",
  "正在连接 Pinterest…": "Connecting to Pinterest…",
  "打开设置": "Open Settings",

  // Board grid / Pin grid
  "全部画板": "All Boards",
  "{count} 个 Pin": "{count} Pins",
  "1 个 Pin": "1 Pin",
  "私密": "Private",
  "视频": "Video",
  "你的 Pinterest 账号里还没有画板": "Your Pinterest account has no boards yet",
  "这个画板里还没有 Pin": "This board has no Pins yet",
  "加载中": "Loading",
  "正在加载更多…": "Loading more…",

  // Pin detail
  "来自 Pinterest": "From Pinterest",
  "在 Pinterest 打开": "Open in Pinterest",
  "无法打开链接": "Unable to open link",

  // Connection card
  "未连接": "Not connected",
  "已连接": "Connected",
  "已连接 {username}": "Connected as {username}",
  "连接后，可以在侧栏浏览你自己的 Pinterest 画板和 Pin。内容只在这台电脑上实时显示，不会上传。":
    "Once connected, you can browse your own Pinterest boards and Pins from the sidebar. Content is shown live on this computer only and is never uploaded.",
  "需要重新连接": "Needs reconnection",
  "今天已用 {used} / {limit} 次": "{used} of {limit} used today",
  "断开": "Disconnect",
  "取消": "Cancel",
  "断开后，这台电脑上保存的 Pinterest 授权会被删除。":
    "Disconnecting deletes the Pinterest authorization saved on this computer.",
  "等待浏览器授权…": "Waiting for browser authorization…",

  // pinterestErrorMessage outcomes (keep in sync with pinterest-api.ts)
  "尚未连接 Pinterest": "Pinterest is not connected yet",
  "今天的 Pinterest 浏览额度快用完了，明天再来看看":
    "Today's Pinterest browsing quota is almost used up. Come back tomorrow.",
  "Pinterest 请求太频繁，请稍后再试": "Pinterest requests are too frequent. Try again later.",
  "本机服务端口被占用，暂时无法连接 Pinterest":
    "The local service port is busy, so Pinterest is temporarily unavailable.",
  "Pinterest 连接服务不可用": "The Pinterest connection service is unavailable.",
  "暂时连不上 Pinterest，请检查网络": "Cannot reach Pinterest right now. Check your network.",
  "画板地址无效": "The board address is invalid.",
  "无法打开 Pinterest 授权页": "Unable to open the Pinterest authorization page.",
  "没等到 Pinterest 授权完成，请重试": "Timed out waiting for Pinterest authorization. Try again.",
  "加载 Pinterest 内容失败": "Failed to load Pinterest content.",
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
