// GravityPort React UI flow (task 333): the browser extension pairing
// confirmation. The Node side of this flow plays the extension; the App side
// runs in the QA Electron window.
//
// Round 1 — approval: POST /pair (with the extension's Origin and version)
// answers 202 with a pending request id; the authorization dialog appears in
// the App with the versioned source line and the initial focus on 不允许;
// clicking 允许连接 closes the dialog with the toast; the extension's next
// poll collects the token exactly once (a replayed poll 404s).
//
// Round 2 — denial: a second POST opens a fresh request (the one-shot
// approval is spent); Escape denies it, the dialog closes, and the poll
// answers status "denied" with no token.
export const name = "web-capture-pairing-confirm";
export const description = "POST /pair -> 202 pending -> App dialog (focus on 不允许, versioned source) -> 允许连接 -> poll returns the token once; second POST -> Escape denies -> poll returns denied";

const CAPTURE_TOKEN = "mosa_e2e_pair_confirm_token";
const DEVELOPMENT_ORIGIN = "chrome-extension://hjcildpmialbefmcdpdooenlojecjpli";
const STORE_ORIGIN = "chrome-extension://bhjibabaiccjjfcdbimeeaoaikhcfncc";
const EXTENSION_VERSION = "0.15.45";

async function postPair(origin, body) {
  const response = await fetch(`${origin}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: DEVELOPMENT_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function pollPair(origin, requestId) {
  const response = await fetch(`${origin}/api/web-capture/pair/${encodeURIComponent(requestId)}`, {
    headers: { origin: DEVELOPMENT_ORIGIN },
  });
  return { status: response.status, body: await response.json() };
}

function pageSource({ phase }) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    await waitFor(() => document.querySelector('.app'), 'app shell');
    await waitFor(() => document.querySelector('.authorization-modal'), 'authorization dialog');
    const modal = document.querySelector('.authorization-modal');
    const title = modal.querySelector('h3')?.textContent.trim() || '';
    const sourceLine = modal.querySelector('.authorization-source')?.textContent.trim() || '';
    const consequence = modal.querySelector('p')?.textContent.trim() || '';
    const focusedText = document.activeElement?.textContent.trim() || '';
    const focusedIsDeny = document.activeElement?.textContent.trim() === '不允许';
    const buttons = Array.from(modal.querySelectorAll('button')).map((b) => b.textContent.trim());
    if ('${phase}' === 'approve') {
      const allow = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent.trim() === '允许连接');
      if (!allow) throw new Error('允许连接 button missing: ' + buttons.join('|'));
      allow.click();
      await waitFor(() => !document.querySelector('.authorization-modal'), 'dialog closes after 允许连接');
      await sleep(200);
      const toast = document.querySelector('.toast')?.textContent.trim() || '';
      return { title, sourceLine, consequence, focusedIsDeny, focusedText, buttons, toast, dialogClosed: !document.querySelector('.authorization-modal') };
    }
    // phase === 'deny': Escape counts as 不允许 (DESIGN.md).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('.authorization-modal'), 'dialog closes after Escape');
    await sleep(200);
    const toast = document.querySelector('.toast')?.textContent.trim() || '';
    return { title, sourceLine, consequence, focusedIsDeny, focusedText, buttons, toast, dialogClosed: !document.querySelector('.authorization-modal') };
  })()`;
}

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer({
    env: {
      MOSA_WEB_CAPTURE_TOKEN: CAPTURE_TOKEN,
      MOSA_WEB_CAPTURE_ORIGINS: `${DEVELOPMENT_ORIGIN},${STORE_ORIGIN}`,
      MOSA_WEB_CAPTURE_PAIR: "auto",
    },
  });
  try {
    // ── Round 1: the extension asks, the user allows. ──
    const asked = await postPair(server.origin, { extensionVersion: EXTENSION_VERSION });
    if (asked.status !== 202) throw new Error(`POST /pair expected 202, got ${asked.status}: ${JSON.stringify(asked.body)}`);
    if (asked.body?.product !== "mosa" || asked.body?.status !== "pending" || !asked.body.requestId) {
      throw new Error(`unexpected 202 body: ${JSON.stringify(asked.body)}`);
    }
    if (JSON.stringify(asked.body).includes(CAPTURE_TOKEN)) throw new Error("the pending answer leaked the token");

    const approval = await ctx.runInPage(server, pageSource({ phase: "approve" }));
    const problems = [];
    if (approval.title !== "允许这个浏览器扩展连接 GravityPort 吗？") problems.push(`title ${JSON.stringify(approval.title)}`);
    if (approval.consequence !== "允许后，这个扩展可以把网页上生成的图和视频存进素材库。") problems.push(`consequence ${JSON.stringify(approval.consequence)}`);
    if (approval.sourceLine !== `来自：GravityPort Web Capture ${EXTENSION_VERSION}`) problems.push(`source line ${JSON.stringify(approval.sourceLine)}`);
    if (approval.focusedIsDeny !== true) problems.push(`initial focus on ${JSON.stringify(approval.focusedText)}`);
    if (!approval.dialogClosed) problems.push("dialog still open after 允许连接");
    if (approval.toast !== "已允许浏览器扩展连接") problems.push(`toast ${JSON.stringify(approval.toast)}`);
    if (problems.length) throw new Error(`pairing approval round: ${problems.join("; ")}`);

    const granted = await pollPair(server.origin, asked.body.requestId);
    if (granted.status !== 200 || granted.body?.status !== "approved" || granted.body?.product !== "mosa") {
      throw new Error(`poll after approval expected 200 approved, got ${granted.status}: ${JSON.stringify(granted.body)}`);
    }
    if (granted.body.token !== CAPTURE_TOKEN) throw new Error("the polled token does not match the service token");
    const replayed = await pollPair(server.origin, asked.body.requestId);
    if (replayed.status !== 404) throw new Error(`a replayed poll must 404, got ${replayed.status}: ${JSON.stringify(replayed.body)}`);

    // ── Round 2: the spent grant, then a fresh request denied by Escape. ──
    // decide() granted a one-shot 5-minute approval for pre-polling
    // extensions, so the very next POST collects the token without a dialog
    // (by design, task 333) — and consumes the grant.
    const legacyRetry = await postPair(server.origin, {});
    if (legacyRetry.status !== 200 || legacyRetry.body?.token !== CAPTURE_TOKEN) {
      throw new Error(`the one-shot legacy retry expected 200 with the token, got ${legacyRetry.status}: ${JSON.stringify(legacyRetry.body)}`);
    }
    const askedAgain = await postPair(server.origin, {});
    if (askedAgain.status !== 202) throw new Error(`post-grant POST /pair expected 202, got ${askedAgain.status}: ${JSON.stringify(askedAgain.body)}`);
    if (askedAgain.body.requestId === asked.body.requestId) throw new Error("the spent approval must not merge into a new request");

    const denial = await ctx.runInPage(server, pageSource({ phase: "deny" }));
    const denialProblems = [];
    if (denial.focusedIsDeny !== true) denialProblems.push(`initial focus on ${JSON.stringify(denial.focusedText)}`);
    if (!denial.dialogClosed) denialProblems.push("dialog still open after Escape");
    if (denialProblems.length) throw new Error(`pairing denial round: ${denialProblems.join("; ")}`);

    const refused = await pollPair(server.origin, askedAgain.body.requestId);
    if (refused.status !== 200 || refused.body?.status !== "denied") {
      throw new Error(`poll after Escape expected 200 denied, got ${refused.status}: ${JSON.stringify(refused.body)}`);
    }
    if (JSON.stringify(refused.body).includes(CAPTURE_TOKEN)) throw new Error("a denial must never carry the token");

    // The denied origin is in its 60-second cooldown: a retry is refused
    // without opening a new request.
    const retried = await postPair(server.origin, {});
    if (retried.status !== 403 || retried.body?.code !== "WEB_CAPTURE_PAIRING_DENIED") {
      throw new Error(`retry after denial expected 403 DENIED, got ${retried.status}: ${JSON.stringify(retried.body)}`);
    }

    return {
      approval: { requestId: asked.body.requestId, tokenDeliveredOnce: true, toast: approval.toast },
      denial: { requestId: askedAgain.body.requestId, deniedStatus: refused.body.status },
    };
  } finally {
    await server.stop();
  }
}
