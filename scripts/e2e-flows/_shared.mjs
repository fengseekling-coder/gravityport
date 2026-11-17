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

const DEFAULT_APP_SHELL_EXPRESSION = "Boolean(document.querySelector('.app'))";
let reloadTokenSeq = 0;

function resolveCdpEvaluator(cdp, customEvaluate) {
  if (typeof customEvaluate === "function") return customEvaluate;
  if (typeof cdp.evaluate === "function") return (expression) => cdp.evaluate(expression);
  return async (expression) => {
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response?.exceptionDetails) {
      throw new Error(
        "evaluate failed: "
          + (response.exceptionDetails.exception?.description || response.exceptionDetails.text),
      );
    }
    return response?.result?.value;
  };
}

/**
 * Poll a CDP Runtime.evaluate expression until `match(value)` holds, treating
 * single stalled or detached-context evaluations as transient retries until
 * the total deadline expires.
 */
export async function waitForCdpExpression(cdp, expression, label, optionsOrTimeoutMs = 20000) {
  const options = typeof optionsOrTimeoutMs === "number"
    ? { timeoutMs: optionsOrTimeoutMs }
    : (optionsOrTimeoutMs || {});
  const {
    timeoutMs = 20000,
    pollIntervalMs = 200,
    evaluateTimeoutMs = 1500,
    evaluate: customEvaluate,
    match = (value) => value === true,
  } = options;
  const evaluate = resolveCdpEvaluator(cdp, customEvaluate);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const attemptTimeoutMs = Math.min(evaluateTimeoutMs, Math.max(200, remainingMs));
    let timer = null;
    try {
      const value = await Promise.race([
        Promise.resolve(evaluate(expression)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("evaluate stalled")), attemptTimeoutMs);
        }),
      ]);
      if (match(value)) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    const waitMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

/**
 * Arm Page/Runtime CDP navigation listeners and an old-window marker before
 * calling `location.reload()`, so `waitForApp()` cannot match the pre-reload DOM
 * and `trigger()` can be followed by intermediate main-process steps before
 * awaiting the new app shell.
 */
export async function prepareCdpReload(cdp, options = {}) {
  const evaluate = resolveCdpEvaluator(cdp, options.evaluate);
  const markerKey = "__e2eReloadMarker";
  const markerValue = `reload-${Date.now()}-${++reloadTokenSeq}`;

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await evaluate(`window[${JSON.stringify(markerKey)}] = ${JSON.stringify(markerValue)}`);

  let triggered = false;
  let contextsCleared = false;
  let defaultContextCreated = false;
  let loadEventFired = false;
  let settleNewContext = null;

  const isNewContextReady = () => (contextsCleared && defaultContextCreated) || loadEventFired;

  const unsubscribe = cdp.onEvent((message) => {
    if (!triggered) return;
    if (message.method === "Runtime.executionContextsCleared") {
      contextsCleared = true;
      defaultContextCreated = false;
    } else if (
      message.method === "Runtime.executionContextCreated"
      && contextsCleared
      && message.params?.context?.auxData?.isDefault === true
    ) {
      defaultContextCreated = true;
    } else if (message.method === "Page.loadEventFired") {
      loadEventFired = true;
    }
    if (settleNewContext && isNewContextReady()) {
      const resolve = settleNewContext;
      settleNewContext = null;
      resolve();
    }
  });

  const cancel = () => {
    unsubscribe();
    if (settleNewContext) {
      const resolve = settleNewContext;
      settleNewContext = null;
      resolve();
    }
  };

  const trigger = () => {
    // In Launch Services QA mode CDP Page.reload can terminate the renderer, so
    // fire location.reload() without awaiting its stranded evaluate response.
    contextsCleared = false;
    defaultContextCreated = false;
    loadEventFired = false;
    triggered = true;
    Promise.resolve(evaluate("location.reload()")).catch(() => {});
  };

  const waitForApp = async (waitOptions = {}) => {
    const {
      expression = DEFAULT_APP_SHELL_EXPRESSION,
      label = "app shell after reload",
      timeoutMs = 20000,
      pollIntervalMs = 200,
      evaluateTimeoutMs = 1500,
      match = (value) => value === true,
    } = waitOptions;
    if (!triggered) {
      cancel();
      throw new Error("prepareCdpReload.waitForApp() called before trigger()");
    }
    const deadline = Date.now() + timeoutMs;
    try {
      if (!isNewContextReady()) {
        const remainingForNav = deadline - Date.now();
        if (remainingForNav <= 0) {
          throw new Error(`timed out waiting for reload navigation (${label})`);
        }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (settleNewContext) settleNewContext = null;
            reject(new Error(`timed out waiting for reload navigation (${label})`));
          }, remainingForNav);
          settleNewContext = () => {
            clearTimeout(timer);
            resolve();
          };
          if (isNewContextReady()) {
            clearTimeout(timer);
            settleNewContext = null;
            resolve();
          }
        });
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`timed out waiting for ${label}`);
      }
      const markerGuard = `window[${JSON.stringify(markerKey)}] !== ${JSON.stringify(markerValue)}`;
      return await waitForCdpExpression(
        cdp,
        `${markerGuard} && (${expression})`,
        label,
        {
          timeoutMs: remainingMs,
          pollIntervalMs,
          evaluateTimeoutMs,
          evaluate,
          match,
        },
      );
    } finally {
      cancel();
    }
  };

  return { trigger, waitForApp, cancel };
}

/**
 * Reload the active CDP target with `location.reload()` and wait until the new
 * execution context / load event arrives and `expression` holds.
 */
export async function reloadCdpAndWaitForApp(cdp, options = {}) {
  const {
    expression = DEFAULT_APP_SHELL_EXPRESSION,
    label = "app shell after reload",
    timeoutMs = 20000,
    pollIntervalMs = 200,
    evaluateTimeoutMs = 1500,
    evaluate,
    match = (value) => value === true,
  } = options;
  const reload = await prepareCdpReload(cdp, { evaluate });
  reload.trigger();
  return reload.waitForApp({
    expression,
    label,
    timeoutMs,
    pollIntervalMs,
    evaluateTimeoutMs,
    match,
  });
}
