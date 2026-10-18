// GravityPort React UI flow (task 177): in-app viewer fullscreen.
//
// 「全屏」collapses the sidebar, toolbar and Inspector so the viewer fills the
// window and the image grows — deliberately NOT the OS fullscreen: a fake
// window.electronAPI records every setWindowFullScreen call and the flow
// fails if the button ever makes one, and document.fullscreenElement must
// stay empty. Esc leaves the fullscreen first; only a second Esc closes the
// viewer. The fullscreen state is never remembered: a reopened viewer starts
// windowed.
export const name = "viewer-fullscreen";
export const description = "全屏 collapses chrome -> viewer fills window and image grows -> arrows page inside fullscreen -> Esc exits fullscreen only, second Esc closes viewer -> 退出全屏 button restores -> English Full screen / Exit full screen -> zero OS fullscreen calls";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    // A large fixture keeps the fit scale below 1, so entering fullscreen must
    // actually grow the image instead of staying at the 1:1 cap.
    const fixturePath = await ctx.makePng("fs-fixture.png", [74, 127, 181], { width: 1600, height: 900 });
    const created = [];
    for (const prompt of ["viewer fullscreen a", "viewer fullscreen b"]) {
      const body = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: fixturePath, prompt,
      });
      created.push(body.asset);
    }
    // Fresh assets sit at a 1x1 placeholder until the derivative worker
    // backfills the real dimensions (~2s after listen). The hidden e2e window
    // short-circuits live SSE, so the page must only load after the backfill:
    // its asset-detail fetch is the channel that carries the real size. The
    // dims live in business_fields — the detail payload has no top-level width.
    const hasRealDims = async (id) => {
      const detail = await ctx.api(server.origin, "GET", `/api/assets/default/${id}`);
      const fields = detail?.asset?.business_fields || {};
      return Number(fields.width) > 100 && Number(fields.height) > 100;
    };
    const backfillDeadline = Date.now() + 30000;
    while (!(await hasRealDims(created[0].id)) || !(await hasRealDims(created[1].id))) {
      if (Date.now() > backfillDeadline) throw new Error("asset dimensions were never backfilled — derivative worker did not run");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const result = await ctx.runInPage(server, fullscreenSource());
    if (result?.__pageError) throw new Error(`viewer-fullscreen page error: ${result.__pageError}`);
    const problems = [];
    if (result?.opened !== true) problems.push("viewer opened with 全屏 button unpressed");
    if (result?.entered !== true) problems.push("fullscreen entered (chrome hidden, viewer fills window, arrows/controls kept)");
    if (!(result?.afterFs > result?.before)) problems.push(`image grew in fullscreen (${result?.before} -> ${result?.afterFs})`);
    if (result?.zoomKeepsSize !== true) problems.push(`1:1 keeps the full 1600x900 image box (${JSON.stringify(result?.zoomSize)})`);
    if (result?.pageKeptFullscreen !== true) problems.push("arrow navigation stayed inside fullscreen");
    if (result?.escExitedFullscreenOnly !== true) problems.push("first Esc left fullscreen but kept the viewer");
    if (result?.secondEscClosedViewer !== true) problems.push("second Esc closed the viewer");
    if (result?.reopenWindowed !== true) problems.push("reopened viewer starts windowed");
    if (result?.buttonExitRestores !== true) problems.push("退出全屏 button restored the chrome");
    if (result?.controlsAutoHide !== true) problems.push("viewer stage reaches the bottom edge and the zoom bar fades out and back");
    if (result?.englishLabels !== true) problems.push("English labels Full screen / Exit full screen");
    if (result?.osCalls !== 0) problems.push(`fake setWindowFullScreen called ${result?.osCalls} times`);
    if (result?.fullscreenElement !== null) problems.push("document.fullscreenElement not null");
    if (problems.length) throw new Error(`viewer-fullscreen result: ${problems.join("; ")} — ${JSON.stringify(result)}`);
    return { ok: true, osCalls: result.osCalls };
  } finally {
    await server.stop();
  }
}

function fullscreenSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try { last = check(); } catch (error) { last = String(error); }
        if (last) return last;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | last=' + String(last));
    }
    // Fake desktop bridge, injected after load like the update flow: handlers
    // read desktopAPI() at call time, so this records every OS-fullscreen
    // request the UI makes. The feature must make none.
    window.__fsCalls = 0;
    window.electronAPI = {
      setWindowFullScreen: async (flag) => { window.__fsCalls += 1; window.__fsLastFlag = flag; },
    };
    const visible = (selector) => {
      const node = document.querySelector(selector);
      return Boolean(node) && getComputedStyle(node).display !== 'none' && node.offsetWidth > 0;
    };
    const hidden = (selector) => {
      const node = document.querySelector(selector);
      return Boolean(node) && getComputedStyle(node).display === 'none';
    };
    const app = () => document.querySelector('.app');
    const isFullscreenClass = () => Boolean(app()) && app().className.includes('viewer-fullscreen');
    const controlsButtons = () => Array.from(document.querySelectorAll('.viewer-controls button'));
    const fsButton = (title) => controlsButtons().find((b) => b.title === title);
    const imageRect = () => document.querySelector('img.viewer-image').getBoundingClientRect();
    const viewerRect = () => document.querySelector('.image-viewer').getBoundingClientRect();
    const cardCount = () => document.querySelectorAll('.asset-card').length;
    const openViewer = async () => {
      const card = Array.from(document.querySelectorAll('.asset-card')).find((node) => !node.querySelector('.stack-mark'));
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await waitFor(() => document.querySelector('img.viewer-image')?.complete === true, 'viewer image decoded');
      // Fresh creations render as 1x1 placeholders until the dimension worker
      // backfills (and SSEs) the real size — wait it out or the fit math stays
      // 1:1 and "fullscreen grows the image" can never hold.
      await waitFor(() => document.querySelector('img.viewer-image')?.getBoundingClientRect().width > 10, 'real asset dimensions backfilled', 30000);
    };

    await waitFor(() => document.querySelector('.app') && cardCount() === 2, 'two seeded cards');
    await openViewer();
    const opened = visible('.sidebar') && visible('.toolbar') && visible('.details')
      && visible('.image-viewer')
      && fsButton('全屏')?.getAttribute('aria-pressed') === 'false';
    const before = imageRect().width;

    // Enter fullscreen through the controls button. The backfill wait above
    // has settled the last re-render, so this query is the live node.
    if (!fsButton('全屏')) throw new Error('全屏 button missing: ' + controlsButtons().map((b) => b.title || b.textContent.trim()).join('|'));
    const img = document.querySelector('img.viewer-image');
    const stage = document.querySelector('.viewer-stage');
    const diag = () => ' | class=' + app().className
      + ' | pressed=' + (controlsButtons().map((b) => b.getAttribute('aria-pressed')).join(','))
      + ' | imgW=' + Math.round(imageRect().width) + ' | before=' + Math.round(before)
      + ' | imgStyle=' + (img?.getAttribute('style') || 'none').slice(0, 120)
      + ' | stageRect=' + JSON.stringify([Math.round(stage?.getBoundingClientRect().width || -1), Math.round(stage?.getBoundingClientRect().height || -1)])
      + ' | natural=' + img?.naturalWidth + 'x' + img?.naturalHeight
      + ' | zoom=' + (document.querySelector('.viewer-controls output')?.textContent || '?')
      + ' | sidebar=' + getComputedStyle(document.querySelector('.sidebar')).display
      + ' | gridCols=' + getComputedStyle(app()).gridTemplateColumns;
    fsButton('全屏').click();
    await waitFor(() => isFullscreenClass() && imageRect().width > before + 10, 'fullscreen entered and image grew' + diag());
    const afterFs = imageRect().width;
    const entered =
      hidden('.sidebar') && hidden('.toolbar') && hidden('.details')
      && Math.abs(viewerRect().width - window.innerWidth) <= 1
      && Math.abs(viewerRect().height - window.innerHeight) <= 1
      && visible('.viewer-previous') && visible('.viewer-next') && visible('.viewer-controls')
      && fsButton('退出全屏')?.getAttribute('aria-pressed') === 'true';

    // 1:1 inside fullscreen: the 1600x900 fixture is wider than the window, so
    // the image box must keep its full 1600x900 size and overflow the stage.
    // Tailwind's preflight caps img/video at max-width: 100%, which squeezed
    // the box to the stage width while its height kept growing, so the picture
    // shrank inside a tall box with black bands (task 179).
    controlsButtons().find((b) => b.textContent.trim() === '1:1').click();
    await waitFor(() => (document.querySelector('.viewer-controls output')?.textContent || '') === '100%', 'zoomed to 1:1');
    await sleep(100);
    const zoomRect = imageRect();
    const zoomKeepsSize = Math.abs(zoomRect.width - 1600) <= 2 && Math.abs(zoomRect.height - 900) <= 2;
    const zoomSize = [Math.round(zoomRect.width), Math.round(zoomRect.height)];
    controlsButtons().find((b) => b.textContent.trim() === '适合窗口').click();
    await waitFor(() => (document.querySelector('.viewer-controls output')?.textContent || '') !== '100%', 'back to fit');

    // Paging inside fullscreen stays fullscreen (the toolbar title is display:
    // none but still in the DOM, so its text is readable).
    const titleBefore = document.querySelector('.viewer-title span')?.textContent || '';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await waitFor(() => (document.querySelector('.viewer-title span')?.textContent || '') !== titleBefore, 'arrow navigation inside fullscreen');
    const pageKeptFullscreen = isFullscreenClass() && hidden('.sidebar') && visible('.viewer-controls');

    // First Esc: out of fullscreen, viewer stays open.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await waitFor(() => !isFullscreenClass() && visible('.sidebar') && visible('.toolbar') && visible('.details'), 'Esc restored the chrome');
    const escExitedFullscreenOnly = Boolean(document.querySelector('.image-viewer'))
      && fsButton('全屏')?.getAttribute('aria-pressed') === 'false';

    // Second Esc: back to the gallery.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await waitFor(() => !document.querySelector('.image-viewer'), 'second Esc closed the viewer');
    const secondEscClosedViewer = cardCount() === 2;

    // A reopened viewer starts windowed: the state is never remembered.
    await openViewer();
    const reopenWindowed = !isFullscreenClass()
      && fsButton('全屏')?.getAttribute('aria-pressed') === 'false';

    // Button round trip: enter, then leave via 退出全屏.
    fsButton('全屏').click();
    await waitFor(() => isFullscreenClass(), 'fullscreen re-entered');
    fsButton('退出全屏').click();
    await waitFor(() => !isFullscreenClass() && visible('.sidebar') && visible('.toolbar') && visible('.details'), '退出全屏 restored the chrome');
    const buttonExitRestores = Boolean(document.querySelector('.image-viewer'));

    // The zoom bar floats over the picture (the stage runs to the viewer's
    // bottom edge), fades out once the pointer rests for 2s, and comes back on
    // the next pointer movement.
    const stageRect = document.querySelector('.viewer-stage').getBoundingClientRect();
    const stageFillsViewer = Math.abs(stageRect.bottom - viewerRect().bottom) <= 1;
    const controls = () => document.querySelector('.viewer-controls');
    await waitFor(() => controls()?.classList.contains('is-idle') && getComputedStyle(controls()).opacity === '0', 'zoom bar faded after the pointer rested', 6000);
    document.querySelector('.image-viewer').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 200, clientY: 200 }));
    await waitFor(() => !controls()?.classList.contains('is-idle'), 'zoom bar back on pointer movement');
    const controlsAutoHide = stageFillsViewer;

    // English labels: switch the interface language in Settings while the
    // viewer stays open behind the dialog.
    document.querySelector('.user-button').click();
    await waitFor(() => document.querySelector('.settings-modal'), 'settings open');
    Array.from(document.querySelectorAll('.settings-nav button')).find((b) => b.textContent.trim() === '常规').click();
    await waitFor(() => Array.from(document.querySelectorAll('.settings-content .segmented button')).find((b) => b.textContent.trim() === 'English'), 'English language button');
    Array.from(document.querySelectorAll('.settings-content .segmented button')).find((b) => b.textContent.trim() === 'English').click();
    await sleep(300);
    (document.querySelector('[aria-label="关闭设置"]') || document.querySelector('[aria-label="Close settings"]')).click();
    await waitFor(() => !document.querySelector('.settings-modal'), 'settings closed');
    const enButton = () => controlsButtons().find((b) => b.title === 'Full screen' || b.title === 'Exit full screen');
    await waitFor(() => enButton()?.title === 'Full screen', 'English label applied');
    enButton().click();
    await waitFor(() => isFullscreenClass() && enButton()?.title === 'Exit full screen' && enButton().getAttribute('aria-pressed') === 'true', 'English fullscreen entered');
    enButton().click();
    await waitFor(() => !isFullscreenClass() && enButton()?.title === 'Full screen' && enButton().getAttribute('aria-pressed') === 'false', 'English exit restored');
    const englishLabels = enButton()?.title === 'Full screen' && enButton().getAttribute('aria-pressed') === 'false';

    return {
      opened, entered, pageKeptFullscreen, escExitedFullscreenOnly, secondEscClosedViewer,
      reopenWindowed, buttonExitRestores, controlsAutoHide, englishLabels,
      osCalls: window.__fsCalls, fullscreenElement: document.fullscreenElement,
      before, afterFs, zoomKeepsSize, zoomSize,
    };
  })()
  `;
}
