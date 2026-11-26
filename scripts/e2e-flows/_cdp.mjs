// Shared Node-side CDP helpers for desktop e2e flows (task 469).
//
// When to use which helper:
// - connectCdp / openCdpSession: attach to a QA desktop Electron target (or
//   Node main-process inspector via openCdpSession). All desktop flows must
//   connect through here so future CI-simulation hooks (task 470) have one
//   single entry point.
// - waitForRendererReady: wait until document.readyState === "complete", .app
//   is mounted, and any optional flow-specific `ready` expression holds.
// - waitFor: poll a boolean expression and dump a structured scene snapshot
//   (viewport, dialogs, toasts, menus, active element + optional flow scene)
//   when it times out.
// - pointOf / clickCenter / doubleClick / hover: trusted mouse input on an
//   element. Always verifies the target exists, scrolls into view, has >0 size,
//   is not visibility:hidden, sits inside the viewport, is hit-testable at its
//   center (not covered by another element), and stays still across two
//   consecutive 100ms readings (<= 1px drift) before clicking.
// - clickAndWait: clickCenter followed by waitFor; only retries once (after 3s,
//   logging [e2e-retry] with what sits under the point) when given an explicit
//   `retryOnce` reason string.
// - dispatchMouse: the ONLY low-level escape hatch for raw-coordinate mouse
//   events (drags, mouse wheel, blank-area right clicks, mouse side buttons,
//   shadow-DOM box-model hits). Always requires a non-empty `{ reason }`.
// - waitForCdpExpression / prepareCdpReload / reloadCdpAndWaitForApp: lower-
//   level CDP polling and reload synchronization (moved verbatim from _shared).
//
// Why clicks check visibility, coverage, and layout stability first (PR #357):
// 1. Windows CI run 1/2 (learning-guide): at 1008px width the sort dropdown
//    (button.toolbar-select) covered .learn-filter-clear; clicking blindly
//    landed on the dropdown and produced only a misleading gallery timeout
//    until hit-testing named the covering element.
// 2. macOS CI run 2 (learning-guide): clearing Emulation.setDeviceMetricsOverride
//    applies asynchronously, so measuring and clicking right away hit stale
//    coordinates before the layout settled.
// 3. macOS CI run 4 (settings-ai): clicking .user-button right after a reload
//    failed to open settings and left only a bare timeout with no hit/scene
//    context.

import { ciLikeConfig, getActiveCiLikeFlow } from "../e2e-ci-like.mjs";

const DEFAULT_APP_SHELL_EXPRESSION = "Boolean(document.querySelector('.app'))";
let reloadTokenSeq = 0;
const ciLikeSessions = new WeakMap();

async function applyCiLikeCpuThrottle(cdp) {
  const ciLike = ciLikeConfig(process.env, { platform: process.platform });
  if (!ciLike.enabled) return null;
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: ciLike.cpuThrottle });
  return ciLike;
}

async function probeDesktopViewport(cdp, { allowTransient = false } = {}) {
  let info = null;
  try {
    info = await cdp.evaluate(
      `(() => ({ width: window.innerWidth, height: window.innerHeight, isDesktopApp: Boolean(window.electronAPI) }))()`,
    );
  } catch (error) {
    if (allowTransient) return null;
    throw error;
  }
  if (!info || !Number.isFinite(info.width) || !Number.isFinite(info.height) || info.width <= 0 || info.height <= 0) {
    return null;
  }
  return info;
}

async function logCiLikeDesktopViewportOnce(cdp, ciLike, { allowTransient = true } = {}) {
  if (!ciLike?.enabled) return null;
  let state = ciLikeSessions.get(cdp);
  if (!state) {
    state = { viewportLogged: false, windowVerified: false };
    ciLikeSessions.set(cdp, state);
  }
  const info = await probeDesktopViewport(cdp, { allowTransient });
  if (!info) return null;
  if (!state.viewportLogged) {
    state.viewportLogged = true;
    if (info.isDesktopApp) {
      const active = getActiveCiLikeFlow();
      console.log(`[e2e] CI-like desktop viewport (${active.flowName || "desktop"}): ${info.width}x${info.height}`);
    }
  }
  return info;
}

async function verifyCiLikeDesktopWindowOnce(cdp, ciLike) {
  if (!ciLike?.enabled) return;
  let state = ciLikeSessions.get(cdp);
  if (!state) {
    state = { viewportLogged: false, windowVerified: false };
    ciLikeSessions.set(cdp, state);
  }
  if (state.windowVerified) return;
  const info = await logCiLikeDesktopViewportOnce(cdp, ciLike, { allowTransient: false });
  if (!info) {
    const active = getActiveCiLikeFlow();
    const [expectedW, expectedH] = ciLike.desktopWindow;
    throw new Error(
      `CI-like window not applied: got unknown viewport (expected ${expectedW}x${expectedH}, userData=${active.userDataDir || "unknown"})`,
    );
  }
  state.windowVerified = true;
  if (!info.isDesktopApp) return;
  const [expectedW, expectedH] = ciLike.desktopWindow;
  if (info.width !== expectedW || info.height !== expectedH) {
    const active = getActiveCiLikeFlow();
    throw new Error(
      `CI-like window not applied: got ${info.width}x${info.height} (expected ${expectedW}x${expectedH}, userData=${active.userDataDir || "unknown"})`,
    );
  }
}

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
    let matched = false;
    let matchedValue;
    try {
      const value = await Promise.race([
        Promise.resolve(evaluate(expression)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("evaluate stalled")), attemptTimeoutMs);
        }),
      ]);
      if (match(value)) {
        matched = true;
        matchedValue = value;
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    if (matched) {
      const state = ciLikeSessions.get(cdp);
      if (state && !state.viewportLogged) {
        const ciLike = ciLikeConfig(process.env, { platform: process.platform });
        if (ciLike.enabled) {
          await logCiLikeDesktopViewportOnce(cdp, ciLike, { allowTransient: true });
        }
      }
      return matchedValue;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open a CDP session to the given WebSocket debugger URL.
 * Resolves once the WebSocket is open and returns `{ send, evaluate, onEvent, close }`.
 */
export async function openCdpSession(wsUrl) {
  let idSeq = 0;
  const pending = new Map();
  const eventHandlers = new Set();
  const socket = new WebSocket(wsUrl);

  const rejectAllPending = (reason) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(reason);
    }
  };

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || "CDP command failed"));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of eventHandlers) handler(message);
    }
  });

  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("CDP socket failed")), { once: true });
  });

  socket.addEventListener("close", () => {
    rejectAllPending(new Error("CDP socket closed"));
  });
  socket.addEventListener("error", () => {
    rejectAllPending(new Error("CDP socket error"));
  });

  const send = (method, params = {}) => {
    const id = ++idSeq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };

  const evaluate = async (expression, options = {}) => {
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      ...options,
    });
    if (response?.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || "Renderer evaluation failed";
      throw new Error("evaluate failed: " + description);
    }
    return response?.result?.value;
  };

  const onEvent = (listener) => {
    eventHandlers.add(listener);
    return () => {
      eventHandlers.delete(listener);
    };
  };

  const close = () => {
    try { socket.close(); } catch {}
  };

  return { send, evaluate, onEvent, close };
}

/**
 * Poll the DevTools /json/list endpoint on `port` until a page target whose URL
 * starts with `expectedUrlPrefix` appears, then open and return a CDP session.
 */
export async function connectCdp(port, expectedUrlPrefix, optionsOrTimeoutMs = {}) {
  const { timeoutMs = 30000 } = typeof optionsOrTimeoutMs === "number"
    ? { timeoutMs: optionsOrTimeoutMs }
    : (optionsOrTimeoutMs || {});
  const deadline = Date.now() + timeoutMs;
  // A failed session open (the target navigated or its socket was not ready
  // yet) retries until the deadline, exactly as before 470; only the CI-like
  // throttling below runs once the session is open, and its failure throws.
  let cdp = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(
          (entry) => entry.type === "page" && String(entry.url || "").startsWith(expectedUrlPrefix),
        );
        if (target?.webSocketDebuggerUrl) {
          cdp = await openCdpSession(target.webSocketDebuggerUrl);
          break;
        }
      }
    } catch {}
    await sleep(150);
  }
  if (!cdp) {
    throw new Error(`no desktop CDP target on port ${port} matching ${expectedUrlPrefix}`);
  }
  const ciLike = await applyCiLikeCpuThrottle(cdp);
  if (ciLike) {
    ciLikeSessions.set(cdp, { viewportLogged: false, windowVerified: false });
    await logCiLikeDesktopViewportOnce(cdp, ciLike, { allowTransient: true });
  }
  return cdp;
}

/**
 * Wait until the renderer document is complete, `.app` is mounted, and any
 * optional `ready` JS expression evaluates truthy.
 */
export async function waitForRendererReady(cdp, { ready, timeoutMs = 30000 } = {}) {
  const readyClause = ready ? `&& Boolean(${ready})` : "";
  const expression = `(() => document.readyState === "complete" && Boolean(document.querySelector(".app")) ${readyClause})()`;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    let isReady = false;
    try {
      isReady = Boolean(await cdp.evaluate(expression));
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (isReady) {
      const ciLike = ciLikeConfig(process.env, { platform: process.platform });
      if (ciLike.enabled) {
        await verifyCiLikeDesktopWindowOnce(cdp, ciLike);
      }
      return;
    }
    await sleep(100);
  }
  throw new Error(`desktop renderer readiness timeout${lastError ? `: ${lastError.message}` : ""}`);
}

const DESCRIBE_ELEMENT_FN = `function __e2eDescribe(el) {
  if (!el || !el.tagName) return null;
  const tag = el.tagName.toLowerCase();
  const rawClass = typeof el.className === 'string'
    ? el.className
    : (el.getAttribute ? (el.getAttribute('class') || '') : '');
  const classes = rawClass.trim().split(/\\s+/).filter(Boolean).slice(0, 3);
  const clsPart = classes.length ? '.' + classes.join('.') : '';
  const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
  return text ? tag + clsPart + ' "' + text + '"' : tag + clsPart;
}`;

async function collectScene(cdp, extraSceneExpression) {
  const extraBlock = extraSceneExpression
    ? `let extra = null; try { extra = (${extraSceneExpression}); } catch (err) { extra = { sceneExtraError: String(err && err.message || err) }; }`
    : `const extra = null;`;
  const script = `(() => {
    ${DESCRIBE_ELEMENT_FN}
    const common = {
      path: (location.pathname + location.hash).slice(0, 80),
      viewport: [window.innerWidth, window.innerHeight],
      visibility: document.visibilityState,
      active: __e2eDescribe(document.activeElement),
      dialogs: Array.from(document.querySelectorAll('dialog[open], [role="dialog"], .settings-modal'))
        .slice(0, 3)
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)),
      toasts: Array.from(document.querySelectorAll('.toast'))
        .slice(0, 3)
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()),
      menus: document.querySelectorAll('.toolbar-select-menu').length,
    };
    ${extraBlock}
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      return Object.assign(common, extra);
    }
    if (extra !== null && extra !== undefined) {
      common.extra = extra;
    }
    return common;
  })()`;

  let timer = null;
  try {
    const data = await Promise.race([
      Promise.resolve(cdp.evaluate(script)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("scene collection timed out")), 2000);
      }),
    ]);
    return JSON.stringify(data);
  } catch (error) {
    return `unavailable: ${error?.message || String(error)}`;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Wait until `Boolean(expression)` is true in the renderer. On timeout, dumps
 * universal scene diagnostics plus any flow-supplied `scene` expression.
 */
export async function waitFor(cdp, expression, label, optionsOrTimeoutMs = {}) {
  const options = typeof optionsOrTimeoutMs === "number"
    ? { timeoutMs: optionsOrTimeoutMs }
    : (optionsOrTimeoutMs || {});
  const {
    timeoutMs = 20000,
    scene,
    pollIntervalMs = 150,
    evaluateTimeoutMs = 1500,
  } = options;
  try {
    await waitForCdpExpression(cdp, `Boolean(${expression})`, label, {
      timeoutMs,
      pollIntervalMs,
      evaluateTimeoutMs,
    });
  } catch (error) {
    const sceneText = await collectScene(cdp, scene);
    // Keep the last evaluation error (a typo'd expression, a detached
    // context): without it the scene alone cannot tell a slow UI from a
    // broken wait.
    const prefix = `timed out waiting for ${label}: `;
    const message = String(error?.message || error);
    const lastError = message.startsWith(prefix) ? `; lastError=${message.slice(prefix.length)}` : "";
    throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms; scene=${sceneText}${lastError}`, { cause: error });
  }
}

async function probeElementPoint(cdp, elementExpression) {
  const script = `(() => {
    ${DESCRIBE_ELEMENT_FN}
    function __e2eHitPath(el) {
      if (!el) return null;
      const parts = [];
      let cur = el;
      for (let i = 0; i < 4 && cur && cur.tagName; i += 1) {
        parts.push(__e2eDescribe(cur));
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    }
    const viewport = [window.innerWidth, window.innerHeight];
    const el = (${elementExpression});
    if (!el) {
      return { ok: false, reason: 'not-found', rect: null, viewport, hit: null, hitPath: null };
    }
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    const r = el.getBoundingClientRect();
    const rect = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    if (!(r.width > 0 && r.height > 0)) {
      return { ok: false, reason: 'zero-size', rect, viewport, hit: null, hitPath: null };
    }
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') {
      const hx = r.x + r.width / 2;
      const hy = r.y + r.height / 2;
      const hit = (hx >= 0 && hy >= 0 && hx < window.innerWidth && hy < window.innerHeight)
        ? document.elementFromPoint(hx, hy)
        : null;
      return { ok: false, reason: 'hidden', rect, viewport, hit: __e2eDescribe(hit), hitPath: __e2eHitPath(hit) };
    }
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
      return { ok: false, reason: 'outside-viewport', rect, viewport, hit: null, hitPath: null };
    }
    const hit = document.elementFromPoint(x, y);
    const hitDesc = __e2eDescribe(hit);
    const hitPath = __e2eHitPath(hit);
    if (!hit || (hit !== el && !el.contains(hit))) {
      return { ok: false, reason: 'covered', rect, viewport, hit: hitDesc, hitPath };
    }
    return { ok: true, x, y, rect, viewport, hit: hitDesc, hitPath };
  })()`;
  return cdp.evaluate(script);
}

/**
 * Wait until an element is found, visible, in the viewport, uncovered at its
 * center, and settled (two consecutive 100ms readings within 1px).
 */
export async function pointOf(cdp, elementExpression, { label, timeoutMs = 5000 } = {}) {
  const targetLabel = label || elementExpression;
  const deadline = Date.now() + timeoutMs;
  let prevPoint = null;
  let lastSample = null;
  let lastError = null;

  while (true) {
    try {
      const sample = await probeElementPoint(cdp, elementExpression);
      lastError = null;
      if (sample?.ok) {
        if (
          prevPoint
          && Math.abs(sample.x - prevPoint.x) <= 1
          && Math.abs(sample.y - prevPoint.y) <= 1
        ) {
          return { x: sample.x, y: sample.y };
        }
        prevPoint = { x: sample.x, y: sample.y };
        lastSample = { ...sample, reason: "moving" };
      } else {
        prevPoint = null;
        lastSample = sample || { reason: "not-found", rect: null, viewport: null, hit: null, hitPath: null };
      }
    } catch (error) {
      prevPoint = null;
      lastError = error;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(100, remaining));
  }

  const reason = lastSample?.reason || "not-found";
  const rect = lastSample?.rect ?? null;
  const viewport = lastSample?.viewport ?? null;
  const hit = lastSample?.hit ?? null;
  const hitPath = lastSample?.hitPath ?? null;
  const errSuffix = lastError ? `; error=${lastError.message}` : "";
  throw new Error(
    `element not clickable: ${targetLabel}; reason=${reason}; rect=${JSON.stringify(rect)}; viewport=${JSON.stringify(viewport)}; hit=${hit}; hitPath=${hitPath}${errSuffix}`,
  );
}

function buttonMask(button) {
  if (button === "right") return 2;
  if (button === "middle") return 4;
  if (button === "back") return 8;
  if (button === "forward") return 16;
  return 1;
}

/**
 * Verify target clickability via `pointOf`, then dispatch a trusted mouse
 * move + press + release at its center.
 */
export async function clickCenter(
  cdp,
  elementExpression,
  { button = "left", clickCount = 1, modifiers = 0, label, timeoutMs } = {},
) {
  const point = await pointOf(cdp, elementExpression, { label, timeoutMs });
  const mod = modifiers ? { modifiers } : {};
  const buttons = buttonMask(button);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    pointerType: "mouse",
    ...mod,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button,
    buttons,
    clickCount,
    pointerType: "mouse",
    ...mod,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button,
    buttons: 0,
    clickCount,
    pointerType: "mouse",
    ...mod,
  });
  return point;
}

/**
 * Verify target clickability via `pointOf`, then dispatch a trusted double
 * click (clickCount 1 pair followed by clickCount 2 pair).
 */
export async function doubleClick(cdp, elementExpression, { modifiers = 0, label, timeoutMs } = {}) {
  const point = await pointOf(cdp, elementExpression, { label, timeoutMs });
  const mod = modifiers ? { modifiers } : {};
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    pointerType: "mouse",
    ...mod,
  });
  for (const clickCount of [1, 2]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount,
      pointerType: "mouse",
      ...mod,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount,
      pointerType: "mouse",
      ...mod,
    });
  }
  return point;
}

/**
 * Verify target visibility/stability via `pointOf`, then dispatch `mouseMoved`
 * to its center.
 */
export async function hover(cdp, elementExpression, { label, timeoutMs } = {}) {
  const point = await pointOf(cdp, elementExpression, { label, timeoutMs });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    pointerType: "mouse",
  });
  return point;
}

/**
 * Click an element via `clickCenter` and wait for `untilExpression`.
 * Retries once after 3s ONLY when a non-empty `retryOnce` reason string is
 * provided; otherwise times out with the full `waitFor` scene report.
 */
export async function clickAndWait(
  cdp,
  elementExpression,
  untilExpression,
  label,
  { retryOnce, timeoutMs = 20000, scene, button = "left", modifiers = 0, clickTimeoutMs } = {},
) {
  if (retryOnce !== undefined && retryOnce !== null && (typeof retryOnce !== "string" || !retryOnce.trim())) {
    throw new Error("clickAndWait retryOnce must be a non-empty reason string");
  }
  await clickCenter(cdp, elementExpression, { button, modifiers, label, timeoutMs: clickTimeoutMs });
  if (!retryOnce) {
    await waitFor(cdp, untilExpression, label, { timeoutMs, scene });
    return;
  }

  const startedAt = Date.now();
  const firstWindowMs = Math.min(3000, timeoutMs);
  const firstDeadline = startedAt + firstWindowMs;
  while (Date.now() < firstDeadline) {
    try {
      if (await cdp.evaluate(`Boolean(${untilExpression})`)) return;
    } catch {}
    await sleep(150);
  }

  const probe = await probeElementPoint(cdp, elementExpression).catch(() => null);
  console.log(`[e2e-retry] ${label}: ${retryOnce.trim()}; hit=${probe?.hit ?? "null"}`);
  await clickCenter(cdp, elementExpression, { button, modifiers, label, timeoutMs: clickTimeoutMs });
  const remainingMs = Math.max(1000, timeoutMs - (Date.now() - startedAt));
  await waitFor(cdp, untilExpression, label, { timeoutMs: remainingMs, scene });
}

/**
 * Low-level raw-coordinate mouse dispatch for intentional non-element actions
 * (drags, mouse wheel, blank-area right-clicks, side buttons, UA shadow-DOM
 * controls). Requires a non-empty `{ reason }` string.
 */
export async function dispatchMouse(cdp, params, options) {
  const reason = typeof options?.reason === "string" ? options.reason.trim() : "";
  if (!reason) {
    throw new Error("dispatchMouse requires a non-empty { reason } explaining why raw coordinates are used");
  }
  return cdp.send("Input.dispatchMouseEvent", params);
}
