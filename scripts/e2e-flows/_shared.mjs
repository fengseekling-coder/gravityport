// Shared page-script fragments for e2e flows (runInPage). Node-side CDP
// helpers live in ./_cdp.mjs; this file holds ONLY page-script fragments.
//
// Flows interpolate these strings into the script they hand to ctx.runInPage
// (executed via webContents.executeJavaScript, classic non-strict script), so
// the text below must stay free of backticks and dollar-brace sequences.
//
// Safe composition: PAGE_WAIT_SOURCE, TOOLBAR_SELECT_SOURCE, and
// CHOOSE_PROJECT_SOURCE all include SCENE_REPORT_SOURCE. To ensure combining
// them in the same page script never causes a duplicate-declaration SyntaxError
// (in either strict or non-strict mode), SCENE_REPORT_SOURCE guards its scroll
// listener on window.__e2eScrollLog and binds e2eTimeoutReport via `var` backed
// by window.__e2eTimeoutReport.
//
// Why a shared ToolbarSelect chooser: ToolbarSelect closes its menu on ANY
// scroll event (a window capture listener, web/gravityport/src/
// ToolbarSelect.tsx — reasonable overlay behavior for users). On a loaded CI
// renderer a late scroll can land inside the ~250ms between opening a menu
// and the option wait's second stable tick, closing the menu under the flow,
// which then burns its whole flow timeout (mosa task 221). The shared chooser
// reopens the menu and retries, then still demands the real selection and
// the menu closing — every downstream assertion keeps its original strength.
// CHOOSE_PROJECT_SOURCE is the project-switcher wrapper over the same
// chooser (behavior and wait labels unchanged from the pre-generic version).

const SCENE_REPORT_SOURCE = `
    // Rolling log of the last scroll-event timestamps (performance.now, ms
    // since page load), registered capture-phase so any element's scroll
    // counts. ToolbarSelect's close-on-scroll makes a recent scroll the
    // first suspect whenever a menu wait times out.
    if (!window.__e2eScrollLog) {
      window.__e2eScrollLog = [];
      window.addEventListener('scroll', () => {
        window.__e2eScrollLog.push(Math.round(performance.now()));
        if (window.__e2eScrollLog.length > 10) window.__e2eScrollLog.shift();
      }, true);
    }
    // One-line scene report on the timeout path. The page — and every piece
    // of state in it — is destroyed right after a page-script timeout, so
    // this console line is the only way the scene survives into the run log:
    // the driver forwards [e2e-timeout] messages to stdout and the runner
    // attaches driver stdout to its failure.
    var e2eTimeoutReport = window.__e2eTimeoutReport || (window.__e2eTimeoutReport = function e2eTimeoutReport(label, waitedMs) {
      const report = {
        label: String(label),
        waitedMs: Math.round(waitedMs),
        visibility: document.visibilityState,
        openMenus: document.querySelectorAll('.toolbar-select-menu').length,
        now: Math.round(performance.now()),
        recentScrolls: (window.__e2eScrollLog || []).slice(-10),
      };
      console.log('[e2e-timeout] ' + JSON.stringify(report));
    });
`;

// Shared page-script wait & visibility-checked click fragment (task 469):
// provides sleep, waitFor (treats thrown checks as retryable, records last
// value, logs [e2e-timeout] scene on timeout), and clickVisible (verifies the
// element is visible, in-viewport, and uncovered at its center before calling
// el.click()).
//
// pageWaitSource(ms) sets waitFor's default timeout. Flows whose own waitFor
// defaulted above 20s (poster decoding, derivative generation, a 30s dialog
// self-timeout) pass their old default so the move does not shorten what a
// slow CI runner gets; PAGE_WAIT_SOURCE is the 20s default for everyone else.
export function pageWaitSource(defaultTimeoutMs = 20000) {
  const ms = Number(defaultTimeoutMs);
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`pageWaitSource: timeout must be a positive integer, got ${defaultTimeoutMs}`);
  return PAGE_WAIT_BODY.replace("timeoutMs = 20000", `timeoutMs = ${ms}`);
}

const PAGE_WAIT_BODY = SCENE_REPORT_SOURCE + `
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try { last = await check(); } catch (error) { last = String(error); }
        if (last) return last;
        await sleep(100);
      }
      e2eTimeoutReport(label, timeoutMs);
      throw new Error('Timed out waiting for ' + label + ' | last=' + String(last));
    }
    function clickVisible(el, label) {
      const targetLabel = label || 'element';
      if (!el) throw new Error('element not clickable: ' + targetLabel + '; reason=not-found');
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      const r = el.getBoundingClientRect();
      const rect = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      const viewport = [window.innerWidth, window.innerHeight];
      if (!(r.width > 0 && r.height > 0)) {
        throw new Error('element not clickable: ' + targetLabel + '; reason=zero-size; rect=' + JSON.stringify(rect) + '; viewport=' + JSON.stringify(viewport));
      }
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.visibility === 'collapse') {
        throw new Error('element not clickable: ' + targetLabel + '; reason=hidden; rect=' + JSON.stringify(rect) + '; viewport=' + JSON.stringify(viewport));
      }
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
        throw new Error('element not clickable: ' + targetLabel + '; reason=outside-viewport; rect=' + JSON.stringify(rect) + '; viewport=' + JSON.stringify(viewport));
      }
      const hit = document.elementFromPoint(x, y);
      if (!hit || (hit !== el && !el.contains(hit))) {
        const describe = (node) => {
          if (!node || !node.tagName) return 'null';
          const tag = node.tagName.toLowerCase();
          const rawClass = typeof node.className === 'string' ? node.className : (node.getAttribute ? (node.getAttribute('class') || '') : '');
          const classes = rawClass.trim().split(/\\s+/).filter(Boolean).slice(0, 3);
          const text = (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
          return tag + (classes.length ? '.' + classes.join('.') : '') + (text ? ' "' + text + '"' : '');
        };
        throw new Error('element not clickable: ' + targetLabel + '; reason=covered; rect=' + JSON.stringify(rect) + '; viewport=' + JSON.stringify(viewport) + '; hit=' + describe(hit));
      }
      el.click();
    }
`;

export const PAGE_WAIT_SOURCE = pageWaitSource();

// Open any ToolbarSelect menu and pick one option. Reopens the menu and
// retries (max 4 rounds) when a stray scroll closes it mid-wait; on success
// the option click and the menu closing are still hard requirements.
// triggerFinder/optionFinder are functions defined in the flow's own script;
// the labels land in timeout errors and the [e2e-timeout] report.
export const TOOLBAR_SELECT_SOURCE = SCENE_REPORT_SOURCE + `
    async function chooseToolbarSelect(triggerFinder, optionFinder, optionLabel, triggerLabel, menuCloseLabel) {
      const menuOpen = () => Boolean(document.querySelector('.toolbar-select-menu'));
      await waitFor(triggerFinder, triggerLabel || optionLabel + ' trigger');
      let lastFailure = null;
      for (let round = 1; round <= 4; round += 1) {
        // Reopen only when actually closed: clicking an open trigger toggles
        // the menu shut, and a missing option is not cured by closing it.
        if (!menuOpen()) triggerFinder().click();
        try {
          const option = await waitFor(optionFinder, optionLabel, 2500);
          option.click();
        } catch (error) {
          lastFailure = error;
          continue;
        }
        await waitFor(() => !menuOpen(), menuCloseLabel || optionLabel + ' menu closes');
        return;
      }
      e2eTimeoutReport(optionLabel + ' still missing after 4 rounds', 4 * 2500);
      throw lastFailure || new Error('Timed out waiting for ' + optionLabel);
    }
`;

// Select a project in the sidebar switcher: the generic chooser with the
// switcher's trigger and the exact-text option match the flows always used.
export const CHOOSE_PROJECT_SOURCE = TOOLBAR_SELECT_SOURCE + `
    async function chooseProject(name) {
      const switcher = () => document.querySelector('.sidebar-project .toolbar-select') || null;
      const optionFor = () => Array.from(document.querySelectorAll('.toolbar-select-menu [role="option"]'))
        .find((node) => node.textContent.trim() === name) || null;
      await chooseToolbarSelect(switcher, optionFor, 'project option ' + name, 'project switcher', 'project menu closes');
    }
`;
