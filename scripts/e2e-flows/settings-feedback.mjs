// GravityPort React UI flow (task 158): Settings → 反馈.
//
// A flow-owned fake collection service answers first with 503 (probe submit:
// proves the buffer capture, the status mapping, and — through the forwarded
// body — the re-redaction rules for home/library paths, tokens, and whole
// prompt-bearing lines), then 201 (the UI submit succeeds and clears the
// form), then 429 (the copy stays and the rate-limit text shows). Draft
// persistence is checked across settings close/reopen and across a full
// renderer restart, and the 720x464 window must not let the feedback page
// overflow horizontally or resize the modal.
import { createServer } from "node:http";
import { homedir } from "node:os";

export const name = "settings-feedback";
export const description = "Settings → 反馈: empty send disabled -> diagnostics preview leaks nothing -> submit hits the fake collector once (kind idea, diagnostics === preview) -> 429 keeps the copy -> draft survives close/reopen and restart -> 720x464 stays overflow-free";

const MESSAGE_ONE = "第一条反馈：画廊需要排序";
const MESSAGE_TWO = "第二条反馈：导出再快一点";
const CONTACT_ONE = "e2e@example.com";

export async function run(ctx) {
  await ctx.prepare();
  const stamp = Date.now().toString(36);
  const canary = `MOSA-E2E-FC-${stamp}`;
  const collector = await startFakeCollector();
  let server = null;
  try {
    server = await ctx.startServer({ env: { MOSA_FEEDBACK_URL: collector.url } });
    await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng("feedback-seed.png", [74, 127, 181]),
      prompt: `prompt ${canary}`,
    });

    // Probe submit while the collector answers 503: the forward still happens,
    // so the received body proves the route re-redacts before sending, and the
    // outcome line lands in the diagnostics buffer for the UI to preview.
    collector.mode = { status: 503, body: { code: "FEEDBACK_UNAVAILABLE" } };
    const probe = await fetch(`${server.origin}/api/feedback/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mosa-client-token": ctx.token },
      body: JSON.stringify({
        kind: "bug",
        message: "probe submission",
        locale: "zh",
        diagnostics: [
          `prompt: ${canary} wording`,
          `user_instruction: ${canary}-instruction`,
          `home file ${homedir()}/secret.txt`,
          `library file ${ctx.libraryDir}/assets/x.png`,
          `token=abcdef0123 and ${ctx.token}`,
        ].join("\n"),
      }),
    });
    assertEqual(probe.status, 503, "probe submit maps collector 503");
    assertEqual((await probe.json()).code, "FEEDBACK_UNAVAILABLE", "probe 503 code");
    assertEqual(collector.requests.length, 1, "probe reached the collector once");
    const probeBody = collector.requests[0].body;
    assertOk(!JSON.stringify(probeBody).includes(canary), "collector never receives the prompt canary");
    assertOk(probeBody.diagnostics.includes("<此行已省略：可能含素材文字>"), "prompt-bearing lines dropped whole");
    assertOk(probeBody.diagnostics.includes("token=<已隐藏>"), "probe token masked");
    assertOk(!probeBody.diagnostics.includes("abcdef0123"), "probe token value gone");
    assertOk(probeBody.diagnostics.includes("~") && !probeBody.diagnostics.includes(homedir()), "probe home path masked");
    assertOk(probeBody.diagnostics.includes("<素材库>") && !probeBody.diagnostics.includes(ctx.libraryDir), "probe library path masked");
    collector.requests.length = 0;

    // Round 1: the happy path.
    collector.mode = { status: 201, body: { ok: true, id: "fb-e2e-1" } };
    const round1 = await ctx.runInPage(server, mainSource({ canary, homeDir: homedir(), libraryDir: ctx.libraryDir }));
    assertEqual(round1.sendDisabledInitially, true, "send disabled while empty");
    assertEqual(round1.sendDisabledWhitespace, true, "send disabled for whitespace only");
    assertEqual(round1.kindIdeaPressed, true, "建议 option selected");
    assertEqual(round1.sendEnabledAfterInput, true, "send enabled once filled");
    assertOk(round1.shownLog.includes("反馈发送结果：503"), "preview shows the captured outcome line");
    assertEqual(round1.logLeaks.canary, false, "preview leaks no prompt canary");
    assertEqual(round1.logLeaks.homeDir, false, "preview leaks no home dir");
    assertEqual(round1.logLeaks.libraryDir, false, "preview leaks no library dir");
    assertEqual(round1.logLeaks.clientToken, false, "preview leaks no client token");
    assertEqual(round1.logLeaks.promptWord, false, "preview leaks no prompt wording");
    assertEqual(round1.modalResizedByLogViewer, false, "expanding the log must not resize the modal");
    assertEqual(round1.successShown, true, "success note shown");
    assertEqual(round1.messageAfterSuccess, "", "message cleared after success");
    assertEqual(round1.contactAfterSuccess, "", "contact cleared after success");
    assertEqual(round1.kindAfterSuccess, 0, "kind reset to 问题");
    assertEqual(round1.draftAfterSuccess, null, "draft removed after success");
    assertEqual(collector.requests.length, 1, "the collector received exactly one UI submission");
    const sent = collector.requests[0];
    assertEqual(sent.url, "/api/feedback", "collector path");
    assertEqual(sent.headers["x-gravityport-client"], "desktop", "collector client header");
    assertEqual(sent.body.schema, 1, "contract schema");
    assertEqual(sent.body.kind, "idea", "submitted kind");
    assertEqual(sent.body.message, MESSAGE_ONE, "submitted message");
    assertEqual(sent.body.contact, CONTACT_ONE, "submitted contact");
    assertEqual(sent.body.locale, "zh", "submitted locale");
    assertOk(!("gitSha" in sent.body.app) || sent.body.app.gitSha.length <= 40, "app.gitSha within contract");
    for (const key of Object.keys(sent.body)) {
      assertOk(["schema", "kind", "message", "contact", "locale", "app", "diagnostics"].includes(key), `contract field ${key}`);
    }
    assertEqual(sent.body.diagnostics, round1.shownLog, "forwarded diagnostics equal the previewed text");

    // Round 2: rate limited, copy kept, draft survives close/reopen.
    collector.mode = { status: 429, body: { code: "FEEDBACK_RATE_LIMITED" } };
    const round2 = await ctx.runInPage(server, rateLimitedSource());
    assertEqual(round2.errorText, "发送得太频繁了，请稍后再试。", "rate-limit copy shown");
    assertEqual(round2.messageKept, MESSAGE_TWO, "failed submit keeps the message");
    assertEqual(round2.draftAfterReopen, MESSAGE_TWO, "draft survives settings close/reopen");
    assertEqual(collector.requests.length, 2, "rate-limited round submitted once more");
    assertEqual(collector.requests[1].body.message, MESSAGE_TWO, "rate-limited round message");

    // Round 3: 720x464 window — no horizontal overflow, modal keeps the
    // CSS-governed size, and the draft survives a full renderer restart.
    const round3 = await ctx.runInPage(server, narrowSource(), { windowSize: [720, 464] });
    assertEqual(round3.innerWidth, 720, "narrow viewport width");
    assertEqual(round3.innerHeight, 464, "narrow viewport height");
    assertEqual(round3.modalWidth, 672, "modal width at 720x464 (min(736, 100vw-48))");
    assertEqual(round3.modalHeight, 416, "modal height at 720x464 (min(560, 100dvh-48))");
    assertOk(round3.pageScrollWidth <= round3.pageClientWidth, `feedback page must not overflow horizontally (${round3.pageScrollWidth} <= ${round3.pageClientWidth})`);
    assertOk(round3.modalRight <= round3.innerWidth, "modal stays inside the viewport");
    assertEqual(round3.draftAfterRestart, MESSAGE_TWO, "draft survives a renderer restart");
    assertEqual(collector.requests.length, 2, "the narrow round submits nothing");
    return { probe: true, submitted: 2, canary };
  } finally {
    if (server) await server.stop();
    await collector.close();
  }
}

function startFakeCollector() {
  const requests = [];
  let mode = { status: 201, body: { ok: true, id: "fb-e2e" } };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep raw */ }
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      res.writeHead(mode.status, { "content-type": "application/json" });
      res.end(JSON.stringify(mode.body));
    });
  });
  return new Promise((resolveCollector) => server.listen(0, "127.0.0.1", () => resolveCollector({
    requests,
    url: `http://127.0.0.1:${server.address().port}/api/feedback`,
    set mode(next) { mode = next; },
    close: () => new Promise((done) => server.close(() => done())),
  })));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertOk(condition, label) {
  if (!condition) throw new Error(label);
}

function pageHelpers() {
  return `
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
    const setInput = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    async function openFeedbackPage() {
      await waitFor(() => document.querySelector('.app'), 'app shell');
      document.querySelector('.user-button').click();
      await waitFor(() => document.querySelector('.settings-modal'), 'settings open');
      const nav = Array.from(document.querySelectorAll('.settings-nav button')).find((b) => b.textContent.trim() === '反馈');
      if (!nav) throw new Error('反馈 nav missing: ' + Array.from(document.querySelectorAll('.settings-nav button')).map((b) => b.textContent.trim()).join('|'));
      nav.click();
      await waitFor(() => document.querySelector('.feedback-section'), 'feedback page');
    }
    const feedbackState = () => ({
      message: document.querySelector('.feedback-message').value,
      contact: document.querySelector('.feedback-contact').value,
      kindIndex: Array.from(document.querySelectorAll('.feedback-kind-option')).findIndex((b) => b.getAttribute('aria-pressed') === 'true'),
      sendDisabled: document.querySelector('.feedback-send').disabled,
    });
  `;
}

function mainSource({ canary, homeDir, libraryDir }) {
  return `(async () => {
    ${pageHelpers()}
    await openFeedbackPage();

    const sendDisabledInitially = document.querySelector('.feedback-send').disabled;
    setInput(document.querySelector('.feedback-message'), '   ');
    await sleep(80);
    const sendDisabledWhitespace = document.querySelector('.feedback-send').disabled;

    const kindButtons = Array.from(document.querySelectorAll('.feedback-kind-option'));
    if (kindButtons.length !== 3) throw new Error('kind options: ' + kindButtons.length);
    kindButtons[1].click();
    await sleep(80);
    const kindIdeaPressed = kindButtons[1].getAttribute('aria-pressed') === 'true'
      && kindButtons[0].getAttribute('aria-pressed') === 'false';

    setInput(document.querySelector('.feedback-message'), ${JSON.stringify(MESSAGE_ONE)});
    setInput(document.querySelector('.feedback-contact'), ${JSON.stringify(CONTACT_ONE)});
    await sleep(80);
    const sendEnabledAfterInput = !document.querySelector('.feedback-send').disabled;

    const modal = document.querySelector('.settings-modal');
    const modalBefore = [modal.offsetWidth, modal.offsetHeight];

    const checkbox = document.querySelector('.feedback-log-toggle input[type="checkbox"]');
    if (checkbox.checked) throw new Error('diagnostics checkbox must default to unchecked');
    checkbox.click();
    await sleep(80);
    if (!checkbox.checked) throw new Error('diagnostics checkbox did not check');
    document.querySelector('.feedback-log-view-button').click();
    const logView = await waitFor(() => document.querySelector('.feedback-log-view'), 'log viewer opens');
    await waitFor(() => logView.textContent.trim() !== '' && logView.textContent !== '加载中', 'log content settles');
    const shownLog = logView.textContent;
    const modalResizedByLogViewer = modal.offsetWidth !== modalBefore[0] || modal.offsetHeight !== modalBefore[1];
    const logLeaks = {
      canary: shownLog.includes(${JSON.stringify(canary)}),
      homeDir: shownLog.includes(${JSON.stringify(homeDir)}),
      libraryDir: shownLog.includes(${JSON.stringify(libraryDir)}),
      clientToken: shownLog.includes('mosa_e2e_client_token'),
      promptWord: /prompt|提示词/i.test(shownLog),
    };

    document.querySelector('.feedback-send').click();
    await waitFor(() => document.querySelector('.feedback-success'), 'success note');
    await sleep(100);
    const after = feedbackState();
    return {
      sendDisabledInitially,
      sendDisabledWhitespace,
      kindIdeaPressed,
      sendEnabledAfterInput,
      shownLog,
      modalResizedByLogViewer,
      logLeaks,
      successShown: true,
      messageAfterSuccess: after.message,
      contactAfterSuccess: after.contact,
      kindAfterSuccess: after.kindIndex,
      draftAfterSuccess: localStorage.getItem('mosa.feedback-draft'),
    };
  })()
  `;
}

function rateLimitedSource() {
  return `(async () => {
    ${pageHelpers()}
    await openFeedbackPage();
    setInput(document.querySelector('.feedback-message'), ${JSON.stringify(MESSAGE_TWO)});
    await sleep(80);
    document.querySelector('.feedback-send').click();
    const errorNote = await waitFor(() => document.querySelector('.feedback-error'), 'error note');
    const messageKept = document.querySelector('.feedback-message').value;
    const errorText = errorNote.textContent;

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await waitFor(() => !document.querySelector('.settings-modal'), 'settings closed');
    document.querySelector('.user-button').click();
    await waitFor(() => document.querySelector('.settings-modal'), 'settings reopened');
    await waitFor(() => document.querySelector('.feedback-section'), 'still on the feedback page');
    const draftAfterReopen = document.querySelector('.feedback-message').value;
    return { errorText, messageKept, draftAfterReopen };
  })()
  `;
}

function narrowSource() {
  return `(async () => {
    ${pageHelpers()}
    await openFeedbackPage();
    const modal = document.querySelector('.settings-modal');
    const page = document.querySelector('.settings-page');
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      modalWidth: modal.offsetWidth,
      modalHeight: modal.offsetHeight,
      modalRight: Math.round(modal.getBoundingClientRect().right),
      pageScrollWidth: page.scrollWidth,
      pageClientWidth: page.clientWidth,
      draftAfterRestart: document.querySelector('.feedback-message').value,
    };
  })()
  `;
}
