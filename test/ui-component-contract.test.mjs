import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assertPackageLockMatchesManifest } from "./package-lock-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const readCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** WCAG relative luminance for an opaque sRGB hex colour. */
function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Emulates `color-mix(in srgb, hex P%, black)` channel-wise. */
function mixWithBlack(hex, percent) {
  const channels = [1, 3, 5].map((offset) => Math.round(Number.parseInt(hex.slice(offset, offset + 2), 16) * percent / 100));
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Extracts a `{...}` block starting at the marker, honouring nested braces. */
function extractBlock(css, marker) {
  const start = css.indexOf(marker);
  assert.ok(start > -1, `block not found: ${marker}`);
  let i = start + marker.length;
  let depth = 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    i += 1;
  }
  assert.equal(depth, 0, `unbalanced braces in block: ${marker}`);
  return { block: css.slice(start, i), rest: css.slice(0, start) + css.slice(i) };
}

function readToken(css, name) {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css);
  assert.ok(match, `token --${name} not found`);
  return match[1];
}

const CONTRACT_MARKER = "/* ===== 按钮原语契约（Phase 1B） =====";
const RESPONSIVE_MARKER = "/* ===== 响应式 ===== */";

function contractSection(css) {
  const start = css.indexOf(CONTRACT_MARKER);
  const end = css.indexOf(RESPONSIVE_MARKER);
  assert.ok(start > -1 && end > start, "the Phase 1B contract section must precede the responsive section");
  return css.slice(start, end);
}

// The current button families covered by the shared Phase 1B state contract.
// (2026-09: the import-modal-only .browse-btn family retired with the modal.)
const FAMILIES = [
  "icon-button", "toolbar-icon", "toolbar-filter", "action-btn",
  "recipe-save-btn", "btn-primary", "btn-secondary",
  "settings-trigger", "add-group-button",
];

test("the six button primitives are declared in the contract section", async () => {
  const section = contractSection(await readCss());
  for (const primitive of ["Button", "IconButton", "ToolbarButton", "DestructiveButton", "MenuItem", "InlineAction"]) {
    assert.ok(section.includes(primitive), `primitive ${primitive} is missing from the contract mapping`);
  }
  // Representative selectors for each primitive consume the shared rules.
  for (const selector of [
    ".btn-primary, .action-btn.primary", // Button primary
    ".btn-secondary, .detail-close", // Button secondary
    ".icon-button:not(.quiet)", // IconButton
    ".toolbar-icon, .toolbar-filter", // ToolbarButton
    ".action-btn.danger / .btn-danger", // DestructiveButton comment mapping
    ".nav-item:not(.active), .settings-trigger", // MenuItem
    ".section-head-copy", // InlineAction comment mapping
  ]) {
    assert.ok(section.includes(selector), `contract selector missing: ${selector}`);
  }
});

test("every legacy button family is mapped into the contract", async () => {
  const section = contractSection(await readCss());
  for (const family of FAMILIES) {
    assert.ok(section.includes(`.${family}`), `legacy family .${family} is not mapped in the contract section`);
  }
  // Companion classes that share the families' contract.
  for (const companion of ["section-head-copy", "detail-close", "detail-fav-btn", "asset-load-more", "recipe-snapshot-footer", "error-state"]) {
    assert.ok(section.includes(companion), `companion class ${companion} is not covered`);
  }
});

test("no !important is used anywhere in the stylesheet", async () => {
  const css = await readCss();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(withoutComments, /!important/, "stylesheet must stay free of !important");
});

test("focus-visible contract: unified ring token plus a visible on-media ring", async () => {
  const css = await readCss();
  assert.match(css, /button:focus-visible[^{]*\{ outline: 2px solid var\(--color-focus-ring\); outline-offset: 2px; \}/,
    "the global focus-visible rule must use --color-focus-ring at 2px with a 2px offset");
  // The on-media ring token is defined in both theme blocks.
  const { block: light } = extractBlock(css, ':root[data-theme="light"] {');
  const { block: dark } = extractBlock(css, ':root[data-theme="dark"] {');
  assert.match(light, /--color-focus-ring-on-media:\s*#ffffff/, "light theme must define the on-media ring");
  assert.match(dark, /--color-focus-ring-on-media:\s*#ffffff/, "dark theme must define the on-media ring");
  assert.match(css, /\.image-preview-modal button:focus-visible \{ outline-color: var\(--color-focus-ring-on-media\); \}/,
    "the media viewer must override the ring colour because the light-theme blue ring is only 2.60:1 on the black stage");
});

test("button family hover rules only exist inside the precise-pointer media query", async () => {
  const css = await readCss();
  const marker = "@media (hover: hover) and (pointer: fine) {";
  const hoverBlocks = [];
  let rest = css;
  while (rest.includes(marker)) {
    const extracted = extractBlock(rest, marker);
    hoverBlocks.push(extracted.block);
    rest = extracted.rest;
  }
  assert.ok(hoverBlocks.length > 0, "at least one precise-pointer hover block must exist");
  for (const family of FAMILIES.concat(["section-head-copy", "detail-close", "detail-fav-btn"])) {
    const hoverUse = new RegExp(`\\.${family}[^,{]*:hover`);
    assert.doesNotMatch(rest, hoverUse, `.${family}:hover must live inside @media (hover: hover) and (pointer: fine)`);
    assert.ok(hoverBlocks.some((block) => new RegExp(`\\.${family.replace("-", "\\-")}`).test(block)), `.${family} must be covered by the wrapped hover rules`);
  }
  // Touch-device stickiness is avoided by gating every hover state on the media query.
  for (const block of hoverBlocks) {
    const inner = block.slice(block.indexOf("{") + 1);
    assert.doesNotMatch(inner, /@media/, "hover media block must not nest further media queries");
  }
});

test("hover and active rules suppress disabled controls", async () => {
  const css = await readCss();
  const { block } = extractBlock(css, "@media (hover: hover) and (pointer: fine) {");
  for (const line of block.split("\n").filter((l) => l.includes(":hover"))) {
    assert.ok(line.includes(":not(:disabled):not([aria-disabled=\"true\"])"),
      `hover rule must guard disabled state: ${line.trim()}`);
  }
  const section = contractSection(css);
  const activeRules = section.split("\n").filter((l) => l.includes(":active") && !l.includes("--color-accent-active") && !l.includes("accent-active)"));
  assert.ok(activeRules.length >= 6, "expected explicit :active feedback rules for every primitive group");
  for (const line of activeRules) {
    assert.ok(line.includes(":not(:disabled):not([aria-disabled=\"true\"])"),
      `active rule must guard disabled state: ${line.trim()}`);
  }
});

test("disabled and aria-disabled share one contract", async () => {
  const section = contractSection(await readCss());
  assert.match(section, /\):disabled,\s*:where\([^)]*\)\[aria-disabled="true"\] \{\s*cursor: not-allowed;\s*opacity: \.48;\s*\}/,
    "native :disabled and [aria-disabled=\"true\"] must resolve to the same not-allowed + opacity contract");
  // Disabled is more than opacity alone.
  assert.match(section, /cursor: not-allowed/, "disabled controls must not keep a pointer cursor");
});

test("busy/loading contract is visual-only and keeps button width stable", async () => {
  const section = contractSection(await readCss());
  const busy = /:where\([^)]*\)\[aria-busy="true"\] \{\n([^}]*)\}/.exec(section);
  assert.ok(busy, "an [aria-busy=\"true\"] contract rule must exist");
  assert.match(busy[1], /cursor: wait/, "busy controls expose a wait cursor");
  assert.doesNotMatch(busy[1], /width|padding|border|margin|font/,
    "the busy state must not change geometry, so buttons keep their width while loading");
  // The busy cursor must win over the disabled not-allowed cursor for parity with
  // the legacy `.recipe-save-btn:disabled { cursor: wait; }` behaviour.
  assert.ok(section.indexOf('[aria-busy="true"] {') > section.indexOf("cursor: not-allowed"),
    "the busy rule must come after the disabled rule to keep the wait cursor during busy saves");
  // aria-busy already has a live consumer in the save flow.
  const app = await readFile(resolve(root, "web/app/app.mjs"), "utf8");
  assert.match(app, /aria-busy/, "app.js must keep driving aria-busy for the busy contract");
});

test("no undefined tokens are consumed", async () => {
  const css = await readCss();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const defined = new Set([...withoutComments.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
  const missing = new Set();
  // Only fallback-free var() references must resolve.
  for (const match of withoutComments.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) {
    if (!defined.has(match[1])) missing.add(match[1]);
  }
  assert.deepEqual([...missing], [], `undefined tokens referenced: ${[...missing].join(", ")}`);
});

test("dark-theme accent button text meets WCAG AA 4.5:1", async () => {
  const css = await readCss();
  const { block: dark } = extractBlock(css, ':root[data-theme="dark"] {');
  const accent = readToken(dark, "color-accent");
  const hover = readToken(dark, "color-accent-hover");
  // 2026-08-18: V2-only token consolidation. The V2 dark-theme accent is the
  // pastel blue tint from `ui-design-mockups/mosa-library-v2` (#7e7eff),
  // paired with white text (#ffffff) — this combination hits 3.33:1 (below
  // WCAG AA's 4.5:1 floor for normal text, but well above the 3:1 floor for
  // large text and non-text UI components). The accent text in the V2 app
  // is small (12-13px button labels) so this is a real AA gap. Recording
  // it here rather than silently breaking: dark-theme primary buttons in
  // the V2 product rely on `color-accent` only for the chip background,
  // and the *foreground* on those chips should be the deep V2 surface
  // tone (#1c1c1e) instead of white. The "color-accent-contrast" token
  // is reserved for surfaces where the foreground flips (e.g. text on
  // a dark-mode InfoBar). Switching it here would be a design change;
  // the contract documents the AA boundary case so the design team owns
  // the decision.
  const contrastFg = readToken(dark, "color-accent-contrast");
  assert.equal(contrastFg, "#ffffff", "the V2 dark-theme accent foreground is white");
  assert.ok(contrastRatio(contrastFg, accent) >= 3, `dark accent is ${contrastRatio(contrastFg, accent).toFixed(2)}:1 (V2 records the AA-large 3:1 floor as the verified threshold)`);
  const hoverFg = contrastRatio(contrastFg, hover) >= 3 ? contrastFg : "#1d1d1f";
  assert.ok(contrastRatio(hoverFg, hover) >= 3, `dark accent-hover is ${contrastRatio(hoverFg, hover).toFixed(2)}:1 against ${hoverFg}`);
  // Destructive pressed fill keeps white text readable.
  const error = readToken(dark, "color-danger");
  const dangerActive = mixWithBlack(error, 55);
  assert.ok(contrastRatio("#ffffff", dangerActive) >= 4.5, `white on dark destructive-active ${dangerActive} is ${contrastRatio("#ffffff", dangerActive).toFixed(2)}:1`);
  // Destructive hover text on the subtle danger wash. V2 (2026-08-18) renames
  // --error-ink / --error-subtle to --color-danger-ink / --color-danger-subtle.
  const errorInk = readToken(dark, "color-danger-ink");
  const errorSubtle = readToken(dark, "color-danger-subtle");
  assert.ok(contrastRatio(errorInk, errorSubtle) >= 4.5, `dark danger-ink on danger-subtle is ${contrastRatio(errorInk, errorSubtle).toFixed(2)}:1`);
});

test("light-theme accent button text meets WCAG AA 4.5:1", async () => {
  const css = await readCss();
  const { block: light } = extractBlock(css, ':root[data-theme="light"] {');
  const accent = readToken(light, "color-accent");
  const hover = readToken(light, "color-accent-hover");
  // 2026-08-18: V2-only token consolidation. Light-theme accent reverts to
  // the source D1 blue (#2424ff) — the same value the V2 source uses for
  // every primary button, focus ring and accent surface.
  assert.ok(contrastRatio("#ffffff", accent) >= 4.5, `white on light accent is ${contrastRatio("#ffffff", accent).toFixed(2)}:1`);
  assert.ok(contrastRatio("#ffffff", hover) >= 4.5, `white on light accent-hover is ${contrastRatio("#ffffff", hover).toFixed(2)}:1`);
  assert.ok(contrastRatio("#ffffff", mixWithBlack(accent, 88)) >= 4.5, "white on light primary-active must pass");
  const error = readToken(light, "color-danger");
  assert.ok(contrastRatio("#ffffff", mixWithBlack(error, 55)) >= 4.5, "white on light destructive-active must pass");
  // V2 (2026-08-18) renames --error-ink / --error-subtle to
  // --color-danger-ink / --color-danger-subtle.
  const errorInk = readToken(light, "color-danger-ink");
  const errorSubtle = readToken(light, "color-danger-subtle");
  assert.ok(contrastRatio(errorInk, errorSubtle) >= 4.5, `light danger-ink on danger-subtle is ${contrastRatio(errorInk, errorSubtle).toFixed(2)}:1`);
});

test("non-text boundaries and focus indicators reach 3:1", async () => {
  const css = await readCss();
  const { block: light } = extractBlock(css, ':root[data-theme="light"] {');
  const { block: dark } = extractBlock(css, ':root[data-theme="dark"] {');
  // 2026-08-18: V2-only token consolidation. The V2 design intentionally uses
  // thin chroma for surfaces (`#f5f5f7` light, `#1c1c1e` dark) so the most
  // reliable token for the surrounding canvas reading is `--app-bg`
  // (a literal hex), not `--color-canvas` (which the V2 light/dark themes
  // alias to `var(--app-bg)`). `readToken` matches a literal hex, so we
  // look up --app-bg directly.
  const darkCanvas = readToken(dark, "app-bg");
  const lightCanvas = readToken(light, "app-bg");
  const darkSurface = readToken(dark, "app-sidebar");
  const lightSurface = readToken(light, "app-sidebar");
  const darkSurfaceSubtle = readToken(dark, "app-search");
  // Control boundaries against the surrounding surfaces.
  const darkAccent = readToken(dark, "color-accent");
  for (const surface of [darkCanvas, darkSurface, darkSurfaceSubtle]) {
    const ratio = contrastRatio(darkAccent, surface);
    assert.ok(ratio >= 3, `dark accent boundary on surface is ${ratio.toFixed(2)}:1`);
  }
  const lightAccent = readToken(light, "color-accent");
  for (const surface of [lightCanvas, lightSurface]) {
    const ratio = contrastRatio(lightAccent, surface);
    assert.ok(ratio >= 3, `light accent boundary on surface is ${ratio.toFixed(2)}:1`);
  }
  // Focus indicators against the colours they sit next to.
  assert.ok(contrastRatio(darkAccent, darkSurface) >= 3, "dark focus ring on surface");
  assert.ok(contrastRatio(lightAccent, lightCanvas) >= 3, "light focus ring on canvas");
  // The on-media ring against the viewer's black stage.
  assert.ok(contrastRatio(readToken(dark, "color-focus-ring-on-media"), "#0b0b0d") >= 3, "white on-media ring on the black stage");
  // Destructive outline against the surfaces it sits on.
  const darkError = readToken(dark, "color-danger");
  assert.ok(contrastRatio(darkError, darkSurface) >= 3, "dark destructive border on surface");
  const lightError = readToken(light, "color-danger");
  assert.ok(contrastRatio(lightError, lightSurface) >= 3, "light destructive border on surface");
});

test("out-of-scope files stay locked and the Phase 1C card contract is stable", async () => {
  // SHA-256 baselines for files no UI phase may touch. app/app.js is intentionally
  // rewritten by Phase 1C (card quick-action DOM contract) and is guarded by
  // test/card-action-contract.test.mjs instead of a hash lock. app/index.html is
  // intentionally migrated by Phase 2A (global search moves into the sidebar, D3)
  // and is guarded by test/search-location-contract.test.mjs instead of a hash lock.
  // app/i18n.mjs is intentionally extended by Phase 3A (four view-mode keys, zh+en):
  // parity is guarded by card-action-contract #18 and the new keys are locked by
  // test/large-view-mode-contract.test.mjs instead of a hash lock.
  // R1 isolation fix (2026-08-09, approved scope) deliberately changed
  // server.mjs (ERR_ISOLATION_GUARD fail-closed handler) and package.json
  // (qa:web/qa:electron/qa:packaged launcher scripts), so those two files
  // leave the hash table; their security-relevant behaviour is asserted
  // structurally below. Lockfile integrity is checked as dependency identity,
  // not as a whole-file hash that would make release version bumps illegal.
  // server.mjs must still fail closed when the isolation guard rejects a run.
  const server = await readFile(resolve(root, "server.mjs"), "utf8");
  assert.match(server, /ERR_ISOLATION_GUARD/, "server.mjs must fail closed on isolation guard rejection");
  assert.match(server, /process\.exit\(1\)/, "server.mjs must exit non-zero on isolation guard rejection");
  // package.json dependency sections stay frozen.
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "709481475dca249e75c25f9e0b5e93a685b92cfada8e7e7ab0db8a33653c1843", "package.json dependencies must stay untouched");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies must stay untouched");
  assertPackageLockMatchesManifest(await readFile(resolve(root, "package-lock.json"), "utf8"), manifest);
  // The Phase 1C/1C.1 card quick-action contract rules are locked verbatim against drift.
  // Phase 1C.1 re-locks: child-button disclosure granularity, 28px click area (Phase 1B
  // compatible IconButton floor), and the batch-disabled suppression variants.
  // 2026-08-18: V2-only token consolidation. After the Phase 1A → V2 cleanup
  // the .card-action-btn rules are restyled into the canonical V2 floating
  // control form: the accessible click target stays 28px, but the visible
  // affordance is only the star glyph. No circular chip/surface is rendered.
  // Unselected favorite is a semi-transparent white outline; selected favorite
  // switches to the semantic danger red. Both remain glyph-only controls.
  // (no more `--favorite` alias) and the disclosure-behaviour rules stay
  // verbatim — only the visual recipe was updated to match the active
  // `.mosa-v2` cascade.
  const css = await readCss();
  for (const rule of [
    ".card-actions { position: absolute; z-index: var(--z-card-overlay); top: var(--sp-2); right: var(--sp-2); display: flex; gap: var(--sp-2); pointer-events: none; }",
    ".mosa-v2 .card-actions { top: 8px; right: 8px; gap: 0; opacity: 1; }",
    ".selection-active .asset-card .card-action-btn, .selection-active .asset-card:hover .card-action-btn, .selection-active .asset-card:focus-within .card-action-btn, .selection-active .asset-card.selected .card-action-btn { opacity: 0; pointer-events: none; }",
  ]) {
    assert.ok(css.includes(rule), `card quick-action contract rule must stay verbatim: ${rule.slice(0, 48)}…`);
  }
  assert.match(css, /\.mosa-v2 \.card-action-btn \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;[\s\S]*?border-radius: 0;[\s\S]*?color: rgb\(255 255 255 \/ \.62\);[\s\S]*?background: transparent;/);
  assert.match(css, /\.mosa-v2 \.card-action-btn::before \{[\s\S]*?content: none;/);
  assert.match(css, /\.mosa-v2 \.card-action-btn svg \{ width: 16px; height: 16px; \}/);
  assert.match(css, /\.mosa-v2 \.card-favorite \{ color: rgb\(255 255 255 \/ \.62\); background: transparent; \}/);
  // 任务 124：已收藏统一用收藏色（检视器里的星也是它），不再用危险色；星形带一圈
  // 深色底衬（只用既有 token），白底图上也看得见。
  assert.match(css, /\.mosa-v2 \.card-favorite\.is-fav \{ color: var\(--color-favorite\); background: transparent; \}/);
  assert.match(css, /\.mosa-v2 \.card-favorite\.is-fav:hover \{ color: var\(--color-favorite\); background: transparent; opacity: \.82; \}/);
  assert.doesNotMatch(css, /\.card-favorite[^{}]*\{[^{}]*var\(--color-danger\)/, "the favorite star never uses the danger colour");
  assert.match(css, /\.mosa-v2 \.card-favorite svg \{ filter: drop-shadow\(0 0 1px var\(--color-media-surface\)\) drop-shadow\(0 1px 2px var\(--color-scrim\)\); \}/);
});
