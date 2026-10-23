// Shared page-script fragments for e2e flows. Flows interpolate these strings
// into the script they hand to ctx.runInPage, so the text below must stay
// free of backticks and dollar-brace sequences. The flow's own waitFor
// (a hoisted function declaration in the same IIFE scope) is reused; nothing
// else about the flow is assumed.
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
`;

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
