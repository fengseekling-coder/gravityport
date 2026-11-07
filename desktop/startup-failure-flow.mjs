// Task 359 rework 1: the "library is newer than this app" dialog used to be
// fired with `void` and the process kept straight into shutdown, so the
// 「前往官网下载 / 取消」buttons disappeared before anyone could click them.
// The dialog → (optional) download page → shutdown sequence lives here so
// tests can drive it with injected fakes, the same way startup-shutdown.mjs
// injects its steps.

/**
 * Shows the schema-newer dialog and only invokes `shutdown` once the user has
 * answered (or the dialog itself failed). The first button additionally opens
 * the download page and waits for it — an open failure is logged, never fatal.
 * A messageBox rejection means no answer will ever arrive, so shutdown still
 * runs: the process must not linger behind a dialog that never appeared.
 * Resolves after `shutdown` has been called.
 */
export async function showLibrarySchemaNewerDialogThenShutdown({
  messageBox,
  openExternal,
  shutdown,
  owner = null,
  dialogOptions,
  downloadUrl,
  log = console,
}) {
  try {
    const { response } = await messageBox(owner, dialogOptions);
    if (response === 0) {
      try {
        await openExternal(downloadUrl);
      } catch (error) {
        log.warn(`[MOSA] could not open the download page: ${error?.message || error}`);
      }
    }
  } catch (error) {
    log.warn(`[MOSA] schema-newer dialog failed: ${error?.message || error}`);
  }
  shutdown();
}

/**
 * 任务 367：`window-all-closed` 是否交给平台的退出处理。启动失败框弹着的
 * 期间（showLibrarySchemaNewerDialogThenShutdown 调用前到它调 shutdown 为
 * 止）不退出——否则 Windows 用户关掉启动窗口会连框一起带走；框关掉后照原
 * 流程走。runtime 恢复中不退出是既有行为（内部重建窗口不算用户退出），
 * 一并收进这个纯函数便于测试。
 */
export function shouldHandleWindowAllClosed({
  runtimeRecoveryInProgress = false,
  startupFailureDialogOpen = false,
} = {}) {
  return !runtimeRecoveryInProgress && !startupFailureDialogOpen;
}
