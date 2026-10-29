// GravityPort React UI flow (task 302, leftover of task 296): Settings → 关于
// "下载并更新" must handle every install result the main process RETURNS (not
// throws). Task 296 acceptance found the button stuck on "正在下载 N%" for any
// non-installing result until restart. A fake window.electronAPI.
// downloadAndInstallUpdate answers one configurable result per round; a
// MutationObserver toast recorder is required because toasts vanish after 2.6s.
// The already-dialogged preflight codes (PREFLIGHT_DISK_SPACE,
// UPDATE_FAILED_TWICE, cancelled) must come back WITHOUT a "更新失败" toast,
// the generic failures and IPC throws keep theirs, "installing" stays on the
// downloading state (the app quits next), and cancel returns the button.
export const name = "about-update-install-result";
export const description =
  "Settings → 关于: download-and-install results drive the button state and toasts -> error results return the button to clickable 下载并更新 (dialog-already-shown codes silently, generic failures + throws with a 更新失败 toast) -> installing stays on 正在下载 0%/取消下载 until cancel restores the button";

const FAKE_UPDATE = {
  status: "ok",
  updateAvailable: true,
  latestVersion: "9.9.9",
  publishedAt: "2026-10-16T12:00:00Z",
  canInstallInApp: true,
};

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const result = await ctx.runInPage(server, pageSource());
    if (result?.__pageError) throw new Error(`about-update-install-result page error: ${result.__pageError}`);
    assertOk(Array.isArray(result?.rounds) && result.rounds.length === 6, `six rounds recorded (got ${JSON.stringify(result?.rounds?.length)})`);

    assertEqual(result.calls, 6, "downloadAndInstallUpdate called six times");

    // Round 1: a generic failure — button back to clickable WITH the toast.
    const r1 = result.rounds[0];
    assertEqual(r1.label, "1", "round 1 label");
    assertOk(r1.backToDownloadButton, "round 1: button back to clickable 下载并更新 (MACOS_UPDATE_FAILED)");
    assertOk(r1.failToasts.some((t) => t.includes("更新失败，请稍后重试")), `round 1: 更新失败 toast shown (got ${JSON.stringify(r1.failToasts)})`);

    // Rounds 2–4: dialog-already-shown codes and cancel — back to clickable,
    // NO failure toast (the main process already raised its own dialog).
    for (const index of [1, 2, 3]) {
      const round = result.rounds[index];
      assertOk(round.backToDownloadButton, `round ${round.label}: button back to clickable 下载并更新`);
      assertEqual(round.failToasts, [], `round ${round.label}: no 更新失败 toast (got ${JSON.stringify(round.failToasts)})`);
    }

    // Round 5: a thrown IPC error keeps the existing behaviour — back to
    // clickable WITH the toast.
    const r5 = result.rounds[4];
    assertEqual(r5.label, "5", "round 5 label");
    assertOk(r5.backToDownloadButton, "round 5: button back to clickable 下载并更新 (thrown error)");
    assertOk(r5.failToasts.some((t) => t.includes("更新失败，请稍后重试")), `round 5: 更新失败 toast shown (got ${JSON.stringify(r5.failToasts)})`);

    // Round 6: installing — the app quits next, so the button stays on the
    // downloading state (primary disabled at 正在下载 0% + 取消下载) after 1s,
    // with no failure toast; cancelling restores the clickable button.
    const r6 = result.rounds[5];
    assertEqual(r6.label, "6", "round 6 label");
    assertOk(r6.downloadingHeld, `round 6: still 正在下载 0% + 取消下载 after 1000ms (got ${JSON.stringify(r6.heldState)})`);
    assertEqual(r6.failToasts, [], `round 6: no 更新失败 toast (got ${JSON.stringify(r6.failToasts)})`);
    assertOk(result.afterCancel.backToDownloadButton, "after 取消下载: button back to clickable 下载并更新");

    return { rounds: 6, calls: result.calls };
  } finally {
    await server.stop();
  }
}

function pageHelpers() {
  return `
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const navByTitle = (title) => Array.from(document.querySelectorAll('.settings-nav button'))
      .find((b) => b.textContent.trim() === title);
    async function openSettings() {
      await waitFor(() => document.querySelector('.app'), 'app shell');
      document.querySelector('.user-button').click();
      await waitFor(() => document.querySelector('.settings-modal'), 'settings open');
    }
    // The clickable 下载并更新 button (available phase). Null while checking,
    // downloading (div) or in any other phase.
    const downloadButton = () => {
      const button = document.querySelector('.settings-content button.about-update');
      return button && button.textContent.trim() === '下载并更新' && !button.disabled ? button : null;
    };
    const aboutSnapshot = () => {
      const el = document.querySelector('.settings-content .about-update');
      return el ? (el.tagName + ':' + el.textContent.trim() + (el.disabled === true ? ':disabled' : '')) : 'none';
    };
    const waitBackToDownloadButton = async (roundLabel) => {
      await waitFor(
        () => (downloadButton() ? true : null),
        'round ' + roundLabel + ': button back to clickable 下载并更新 (button now: ' + aboutSnapshot() + ')',
      );
    };
    // Toasts vanish after ~2.6s but React reuses the .toast element in place
    // when one toast replaces a still-visible one, so the recorder records a
    // toast whenever an element's text CHANGES (per element), never twice for
    // the same text and never for a toast from before the recorder started.
    const installToastRecorder = () => {
      window.__e2eToasts = [];
      const seenText = new WeakMap();
      const scan = () => {
        document.querySelectorAll('.toast').forEach((el) => {
          const text = el.textContent.trim();
          if (!text || seenText.get(el) === text) return;
          seenText.set(el, text);
          window.__e2eToasts.push(text);
        });
      };
      new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
      scan();
    };
    const clearToasts = () => { window.__e2eToasts.length = 0; };
    const failToasts = () => window.__e2eToasts.filter((t) => t.includes('更新失败'));
    // The downloading state: disabled primary at 正在下载 0% next to 取消下载.
    const downloadingState = () => {
      const actions = document.querySelector('.settings-content .about-update-actions');
      if (!actions) return null;
      const buttons = Array.from(actions.querySelectorAll('button'));
      const primary = buttons[0];
      const cancel = buttons.find((b) => b.textContent.trim() === '取消下载');
      return primary && primary.disabled && primary.textContent.trim() === '正在下载 0%' && cancel
        ? { primary: primary.textContent.trim(), cancel: cancel.textContent.trim() }
        : null;
    };
  `;
}

// The Electron runner only reports "script failed to execute" for a rejected
// page script, so the source catches its own errors and ships the stack back
// to the flow, which turns it into a real assertion message.
function pageSource() {
  return `(async () => {
    try {
      ${pageHelpers()}
      await openSettings();
      // Pin Chinese so the button labels below are deterministic (same lines as
      // the about-release-notes flow's fake-update round).
      (navByTitle('常规') || navByTitle('General')).click();
      await waitFor(() => Array.from(document.querySelectorAll('.settings-content .segmented button')).find((b) => b.textContent.trim() === '中文'), '中文 language button');
      Array.from(document.querySelectorAll('.settings-content .segmented button')).find((b) => b.textContent.trim() === '中文').click();
      await sleep(200);
      (navByTitle('关于') || navByTitle('About')).click();
      await waitFor(() => document.querySelector('.settings-content button.about-update'), 'about update button');
      // Injected after load: the click handlers read desktopAPI() at call time,
      // so this fake is exactly what a desktop install would answer.
      installToastRecorder();
      window.__e2eInstallCalls = 0;
      window.__e2eInstallNextResult = undefined;
      window.__e2eInstallThrowNext = false;
      window.electronAPI = {
        checkForUpdates: async () => (${JSON.stringify(FAKE_UPDATE)}),
        downloadAndInstallUpdate: async () => {
          window.__e2eInstallCalls += 1;
          if (window.__e2eInstallThrowNext) throw new Error('injected install failure');
          return window.__e2eInstallNextResult;
        },
      };
      document.querySelector('.settings-content .about-update').click();
      await waitBackToDownloadButton('setup');
      const rounds = [];
      // A toast lives ≤2.6s; before each round, wait until none is visible so
      // the round's own toast (if any) always inserts a fresh element instead
      // of being swapped into a still-visible one with the same text.
      const waitToastsGone = async (roundLabel) => {
        await waitFor(() => (document.querySelector('.toast') ? null : true), 'round ' + roundLabel + ': previous toast to disappear', 6000);
      };
      const runResultRound = async (label, nextResult) => {
        await waitToastsGone(label);
        clearToasts();
        window.__e2eInstallNextResult = nextResult;
        document.querySelector('.settings-content .about-update').click();
        await waitBackToDownloadButton(label);
        await sleep(1000);
        rounds.push({ label, backToDownloadButton: Boolean(downloadButton()), failToasts: failToasts() });
      };

      // Round 1: generic failure — toast expected.
      await runResultRound('1', { status: "error", code: "MACOS_UPDATE_FAILED" });
      // Rounds 2–4: dialog-already-shown codes and user cancel — silent.
      await runResultRound('2', { status: "error", code: "PREFLIGHT_DISK_SPACE" });
      await runResultRound('3', { status: "error", code: "UPDATE_FAILED_TWICE" });
      await runResultRound('4', { status: "cancelled" });
      // Round 5: a thrown IPC error keeps the old behaviour — toast expected.
      await waitToastsGone('5');
      clearToasts();
      window.__e2eInstallNextResult = undefined;
      window.__e2eInstallThrowNext = true;
      document.querySelector('.settings-content .about-update').click();
      await waitBackToDownloadButton('5');
      await sleep(1000);
      rounds.push({ label: '5', backToDownloadButton: Boolean(downloadButton()), failToasts: failToasts() });
      window.__e2eInstallThrowNext = false;
      // Round 6: installing — the button stays on the downloading state; the
      // promise resolving while the app quits means nothing else happens here.
      await waitToastsGone('6');
      clearToasts();
      window.__e2eInstallNextResult = { status: "installing" };
      document.querySelector('.settings-content .about-update').click();
      const held = await waitFor(() => downloadingState(), 'round 6: downloading state (正在下载 0% + 取消下载; button now: ' + aboutSnapshot() + ')');
      await sleep(1000);
      const heldLater = downloadingState();
      rounds.push({ label: '6', downloadingHeld: Boolean(heldLater), heldState: heldLater, failToasts: failToasts() });
      if (!held || !heldLater) throw new Error('round 6: downloading state not held (at wait: ' + JSON.stringify(held) + ', after 1000ms: ' + JSON.stringify(heldLater) + ', button now: ' + aboutSnapshot() + ')');
      // Cancelling the stuck-looking download returns the clickable button.
      clearToasts();
      const cancel = Array.from(document.querySelectorAll('.settings-content .about-update-actions button'))
        .find((b) => b.textContent.trim() === '取消下载');
      if (!cancel) throw new Error('round 6 cleanup: 取消下载 button missing (button now: ' + aboutSnapshot() + ')');
      cancel.click();
      await waitBackToDownloadButton('cancel');
      const afterCancel = { backToDownloadButton: Boolean(downloadButton()) };
      return { rounds, afterCancel, calls: window.__e2eInstallCalls };
    } catch (error) {
      return { __pageError: String((error && error.stack) || error) };
    }
  })()`;
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertOk(condition, label) {
  if (!condition) throw new Error(label);
}
