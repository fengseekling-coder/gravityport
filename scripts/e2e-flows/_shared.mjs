// Shared page-script fragments for e2e flows. Flows interpolate these strings
// into the script they hand to ctx.runInPage, so the text below must stay
// free of backticks and dollar-brace sequences. The flow's own waitFor
// (a hoisted function declaration in the same IIFE scope) is reused; nothing
// else about the flow is assumed.
//
// Why a shared chooseProject: ToolbarSelect closes its menu on ANY scroll
// event (a window capture listener, web/gravityport/src/ToolbarSelect.tsx —
// reasonable overlay behavior for users). On a loaded CI renderer a late
// scroll can land inside the ~250ms between opening the project menu and the
// option wait's second stable tick, closing the menu under the flow, which
// then burns its whole flow timeout (mosa task 221). The shared version
// reopens the menu and retries, then still demands the real selection and
// the menu closing — every downstream assertion keeps its original strength.

export const CHOOSE_PROJECT_SOURCE = `
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
    function e2eTimeoutReport(label, waitedMs) {
      const report = {
        label: String(label),
        waitedMs: Math.round(waitedMs),
        visibility: document.visibilityState,
        openMenus: document.querySelectorAll('.toolbar-select-menu').length,
        now: Math.round(performance.now()),
        recentScrolls: (window.__e2eScrollLog || []).slice(-10),
      };
      console.log('[e2e-timeout] ' + JSON.stringify(report));
    }
    // Select a project in the sidebar switcher. Reopens the menu and retries
    // (max 4 rounds) when a stray scroll closes it mid-wait; on success the
    // selection and the menu closing are still hard requirements.
    async function chooseProject(name) {
      const switcher = () => document.querySelector('.sidebar-project .toolbar-select') || null;
      const menuOpen = () => Boolean(document.querySelector('.toolbar-select-menu'));
      const optionFor = () => Array.from(document.querySelectorAll('.toolbar-select-menu [role="option"]'))
        .find((node) => node.textContent.trim() === name) || null;
      await waitFor(switcher, 'project switcher');
      let lastFailure = null;
      for (let round = 1; round <= 4; round += 1) {
        // Reopen only when actually closed: clicking an open trigger toggles
        // the menu shut, and a missing option is not cured by closing it.
        if (!menuOpen()) switcher().click();
        try {
          const option = await waitFor(optionFor, 'project option ' + name, 2500);
          option.click();
        } catch (error) {
          lastFailure = error;
          continue;
        }
        await waitFor(() => !menuOpen(), 'project menu closes');
        return;
      }
      e2eTimeoutReport('project option ' + name + ' still missing after 4 rounds', 4 * 2500);
      throw lastFailure || new Error('Timed out waiting for project option ' + name);
    }
`;
