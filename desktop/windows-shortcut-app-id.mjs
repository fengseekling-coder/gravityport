// 任务 389（中15）：Windows 只把系统通知投给「开始菜单快捷方式带同一
// AppUserModelID」的程序。安装器（scripts/windows-installer.nsi）建快捷方式
// 时不写身份号，桌面端在启动时读一遍、不一致就原样改写（"update" 只动指定
// 字段）。读写失败只记一行警告，不能让启动为此失败。身份号与 Mac 的
// bundle id 一致（desktop/forge.config.mjs：com.azhuilab.mosa）。

/**
 * Reconcile the AppUserModelID on existing Windows shortcuts.
 *
 * Returns a map of shortcut path → result status:
 * - "updated": the shortcut existed with a different identity and was rewritten
 * - "already": the shortcut already carries the expected identity
 * - "missing": readShortcutLink failed (Electron throws when the .lnk is absent)
 * - "failed": the rewrite itself threw
 * Never rejects; every read/write error is reported through console.warn.
 */
export async function ensureWindowsShortcutAppId({ platform, shell, shortcutPaths, appUserModelId } = {}) {
  if (platform !== "win32") return {};
  const results = {};
  for (const shortcutPath of Array.isArray(shortcutPaths) ? shortcutPaths : []) {
    let details;
    try {
      details = shell.readShortcutLink(shortcutPath);
    } catch (error) {
      results[shortcutPath] = "missing";
      console.warn(`[MOSA] shortcut not readable, skipping AppUserModelID check: ${shortcutPath} (${error?.message || error})`);
      continue;
    }
    if (details?.appUserModelId === appUserModelId) {
      results[shortcutPath] = "already";
      continue;
    }
    try {
      shell.writeShortcutLink(shortcutPath, "update", { appUserModelId });
      results[shortcutPath] = "updated";
    } catch (error) {
      results[shortcutPath] = "failed";
      console.warn(`[MOSA] shortcut AppUserModelID update failed: ${shortcutPath} (${error?.message || error})`);
    }
  }
  return results;
}
