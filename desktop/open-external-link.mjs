/**
 * 任务 147:URL gate for the open-external-link IPC channel.
 *
 * Kept in its own module so tests can import the validation without
 * booting Electron (desktop/main.mjs has window lifecycle side effects).
 * Only http: and https: URLs from the main window are allowed out; the
 * renderer never gets a generic shell capability.
 */

export function openExternalLinkOutcome(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
    return { ok: false };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false };
  }
  return { ok: true };
}

/**
 * 审查 3-6 甲（任务 318）:destination policy on top of openExternalLinkOutcome.
 *
 * - "open": destinations GravityPort itself sends users to (Pinterest Pin
 *   pages, the official site, the usage guide on GitHub). Exact host match —
 *   no subdomains, so evil.pinterest.com.example can never ride the allowlist.
 * - "confirm": any other http/https URL, including plain http to an
 *   allowlisted host. The main process asks before handing it to the OS.
 * - "deny": protocol/length rejected by openExternalLinkOutcome, or the URL
 *   embeds credentials (user:pass@), which must never leave the app.
 *
 * href is always the normalized URL; host is the punycode hostname, so
 * internationalized domains surface as xn--… exactly as the browser would
 * send them.
 */
const EXTERNAL_LINK_ALLOWLIST = [
  {
    // Pinterest Pin pages and their landing pages opened from the Pinterest view.
    hosts: ["www.pinterest.com", "pinterest.com"],
  },
  {
    // The official GravityPort site (download page, release notes).
    hosts: ["gravityport.azhuilab.com"],
  },
  {
    // The usage guide repository on GitHub, and nothing else on github.com.
    hosts: ["github.com"],
    pathPrefix: "/fengseekling-coder/gravityport",
  },
  {
    // 任务 351:the single Discord invite linked from the About settings page —
    // the pathPrefix keeps every other invite code on the confirm dialog.
    hosts: ["discord.gg"],
    pathPrefix: "/rArXAShSkQ",
  },
];

function allowlistMatch(parsed) {
  return EXTERNAL_LINK_ALLOWLIST.some((entry) => {
    if (!entry.hosts.includes(parsed.hostname)) return false;
    if (!entry.pathPrefix) return true;
    const path = parsed.pathname;
    return path === entry.pathPrefix || path.startsWith(`${entry.pathPrefix}/`);
  });
}

export function externalLinkDecision(url) {
  if (!openExternalLinkOutcome(url).ok) return { action: "deny" };
  const parsed = new URL(url);
  if (parsed.username !== "" || parsed.password !== "") return { action: "deny" };
  const httpsNoExplicitPort = parsed.protocol === "https:" && (parsed.port === "" || parsed.port === "443");
  if (httpsNoExplicitPort && allowlistMatch(parsed)) {
    return { action: "open", href: parsed.href };
  }
  return { action: "confirm", href: parsed.href, host: parsed.hostname };
}

// The confirm dialog shows the destination; anything longer than this would
// be unreadable (and could be a smuggling attempt), so it is cut off.
const EXTERNAL_LINK_DIALOG_URL_LIMIT = 300;

export function truncateExternalLinkForDialog(url) {
  return url.length > EXTERNAL_LINK_DIALOG_URL_LIMIT
    ? `${url.slice(0, EXTERNAL_LINK_DIALOG_URL_LIMIT)}…`
    : url;
}

/**
 * The open-external-link handler with the dialog and shell injected, so the
 * confirm/cancel contract is testable without Electron. `dialogText` is the
 * main process's placeholder formatter (updateDialogText), `confirmDialog`
 * resolves to { response } like dialog.showMessageBox, `openExternal` wraps
 * shell.openExternal.
 *
 * A user cancellation is NOT a failure: it resolves { ok: true, opened: false }
 * so the Pinterest view never shows「无法打开链接」for a declined link.
 */
export async function openExternalLinkByPolicy({
  url,
  dialogText,
  confirmDialog,
  openExternal,
  warn = () => {},
}) {
  const decision = externalLinkDecision(url);
  if (decision.action === "deny") return { ok: false };
  try {
    if (decision.action === "confirm") {
      const { response } = await confirmDialog({
        type: "warning",
        message: dialogText("externalLinkConfirmTitle", { host: decision.host }),
        detail: dialogText("externalLinkConfirmBody", { url: truncateExternalLinkForDialog(decision.href) }),
        buttons: [
          dialogText("externalLinkConfirmOpen", {}),
          dialogText("externalLinkConfirmCancel", {}),
        ],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) return { ok: true, opened: false };
    }
    await openExternal(decision.href);
    return { ok: true };
  } catch (error) {
    warn(`[MOSA] unable to open external link: ${error?.message || error}`);
    return { ok: false };
  }
}
