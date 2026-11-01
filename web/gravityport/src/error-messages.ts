const ERROR_CODE_MESSAGES: Record<string, string> = {
  ASSET_ALREADY_STACKED: "素材已在其他堆叠里，列表已刷新，请重新拖动",
  STACK_NOT_FOUND: "这个堆叠已经不在了，列表已刷新",
  STACK_ASSET_ARCHIVED: "已归档的素材不能放进堆叠",
  STACK_NEEDS_MULTIPLE_ASSETS: "堆叠至少需要两项素材",
  STACK_COVER_NOT_MEMBER: "封面必须是堆叠里的素材",
  STACK_NAME_EMPTY: "堆叠名称不能为空",
  STACK_ORDER_MISMATCH: "堆叠内容已发生变化，列表已刷新，请重试",
  STACK_MOVE_BATCH_SIZE_INVALID: "一次最多移动 2000 项素材",
  ASSET_STACKS_UNAVAILABLE: "当前素材库不支持堆叠",
  ASSET_NOT_FOUND: "素材已经不在了，列表已刷新",
};

export function messageForErrorCode(code: string): string {
  if (!code || typeof code !== "string") return "";
  return ERROR_CODE_MESSAGES[code] || "";
}

/**
 * The one place an error becomes user-facing text (task 322): a recognized
 * error code wins over the raw (often English) server message. App.tsx and
 * mosa-api.ts both route through here, so the code lookup is covered once.
 */
export function describeError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    const message = messageForErrorCode((error as { code: string }).code);
    if (message) return message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
