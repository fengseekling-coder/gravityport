// GravityPort masonry span geometry: landscape cards spanning 2–3 columns,
// column-count persistence, and the larger <img sizes> tier hint. The modules
// ship as TypeScript inside web/gravityport, so they are compiled to a
// temporary ESM module with the project's own tsc before import (same
// approach as gravityport-interaction.test.mjs). The pre-span implementation
// is compiled from a frozen copy of the pre-span source (3eac855, kept as
// test/fixtures/gallery-window.pre-span.ts.txt — CI clones are shallow, so
// git history cannot be relied on) alongside the current one so the default
// (spanWide: false) geometry can be proven unchanged bit for bit.
import { execFileSync } from "node:child_process";
import { readFile, rm, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");
const PRE_SPAN_SOURCE = join(repositoryRoot, "test", "fixtures", "gallery-window.pre-span.ts.txt");

let masonry, columns, legacy;
let tempRoot;
before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-masonry-span-"));
  const newDir = join(tempRoot, "new");
  const legacySrc = join(tempRoot, "legacy-src");
  const legacyDir = join(tempRoot, "legacy");
  await mkdir(newDir, { recursive: true });
  await mkdir(legacySrc, { recursive: true });
  const compile = (sources, outDir) => execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    ...sources, "--outDir", outDir, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  compile(["gallery-window.ts", "gallery-columns.ts"].map(name => join(uiRoot, "src", name)), newDir);
  await writeFile(join(legacySrc, "gallery-window.ts"), await readFile(PRE_SPAN_SOURCE, "utf8"));
  compile([join(legacySrc, "gallery-window.ts")], legacyDir);
  masonry = await import(join(newDir, "gallery-window.js"));
  columns = await import(join(newDir, "gallery-columns.js"));
  legacy = await import(join(legacyDir, "gallery-window.js"));
});
after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** Evaluates the subset of calc() the masonry CSS emits: numbers, + - * /,
 * parentheses and px/100cqw units, at a concrete container width. */
function evalCalc(expression, containerPx) {
  const trimmed = expression.trim();
  const body = trimmed.startsWith("calc(") ? trimmed.slice(5, -1) : trimmed;
  const source = body.replaceAll("100cqw", `(${containerPx})`)
    .replaceAll("px", "").replace(/\s+/g, "");
  let pos = 0;
  const parseSum = () => {
    let value = parseProduct();
    while (source[pos] === "+" || source[pos] === "-") {
      const operator = source[pos++];
      const right = parseProduct();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };
  const parseProduct = () => {
    let value = parseAtom();
    while (source[pos] === "*" || source[pos] === "/") {
      const operator = source[pos++];
      const right = parseAtom();
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  };
  const parseAtom = () => {
    if (source[pos] === "(") {
      pos += 1;
      const value = parseSum();
      if (source[pos] !== ")") throw new Error(`expected ) at ${pos} in ${source}`);
      pos += 1;
      return value;
    }
    const match = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?/.exec(source.slice(pos));
    if (!match) throw new Error(`bad number at ${pos} in ${source}`);
    pos += match[0].length;
    return Number(match[0]);
  };
  const value = parseSum();
  if (pos !== source.length) throw new Error(`trailing input "${source.slice(pos)}" in ${source}`);
  return value;
}

function evalExtentCss(expression, containerPx) {
  assert.ok(expression.startsWith("max(") && expression.endsWith(")"), `not an extent: ${expression}`);
  return Math.max(...expression.slice(4, -1).split(",").map(part => evalCalc(part, containerPx)));
}

const geometryOf = place => ({
  left: place.left, top: place.top, width: place.width, height: place.height,
  column: place.column, ratio: place.ratio,
});

/** Rectangles must not share interior area; edge adjacency is fine. */
function assertNoPairwiseOverlap(placements, gap) {
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      const a = placements[i];
      const b = placements[j];
      const overlaps = a.left < b.left + b.width && b.left < a.left + a.width
        && a.top < b.top + b.height && b.top < a.top + a.height;
      assert.ok(!overlaps, `cards ${i} and ${j} overlap: ${
        JSON.stringify(a)} vs ${JSON.stringify(b)} (gap ${gap})`);
    }
  }
}

/** Cards whose x-ranges overlap share the same vertical stacking invariant:
 * a later card must start at or below the earlier card's bottom + gap. */
function assertColumnStackingInOrder(placements, gap) {
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      const a = placements[i];
      const b = placements[j];
      const sharesX = a.left < b.left + b.width && b.left < a.left + a.width;
      if (!sharesX) continue;
      assert.ok(
        a.top + a.height + gap <= b.top + 1e-9,
        `card ${j} (top ${b.top}) intrudes on card ${i} (bottom ${a.top + a.height})`,
      );
    }
  }
}

describe("masonrySpanFor", () => {
  let masonrySpanFor;
  before(() => { ({ masonrySpanFor } = masonry); });
  it("maps aspect-ratio thresholds to 1/2/3 columns", () => {
    assert.equal(masonrySpanFor(1, 5), 1, "1:1 stays single-column");
    assert.equal(masonrySpanFor(1 / 1.59, 5), 1, "1.59:1 is just under the 2-column cut");
    assert.equal(masonrySpanFor(1 / 1.6, 5), 2, "1.6:1 spans 2 columns");
    assert.equal(masonrySpanFor(1 / 2.59, 5), 2, "2.59:1 is just under the 3-column cut");
    assert.equal(masonrySpanFor(1 / 2.6, 5), 3, "2.6:1 spans 3 columns");
    assert.equal(masonrySpanFor(1 / 5, 5), 3, "5:1 spans 3 columns");
    assert.equal(masonrySpanFor(1.5, 5), 1, "portrait stays single-column");
  });
  it("caps the span at the available columns", () => {
    assert.equal(masonrySpanFor(1 / 5, 1), 1);
    assert.equal(masonrySpanFor(1 / 2.6, 2), 2);
    assert.equal(masonrySpanFor(1 / 1.6, 1), 1);
  });
  it("falls back to a single column for non-positive or non-finite ratios", () => {
    assert.equal(masonrySpanFor(0, 5), 1);
    assert.equal(masonrySpanFor(-2, 5), 1);
    assert.equal(masonrySpanFor(Number.NaN, 5), 1);
    assert.equal(masonrySpanFor(Number.POSITIVE_INFINITY, 5), 1);
  });
});

describe("spanWide: false keeps the pre-span geometry", () => {
  // The three inputs of the existing production-masonry tests plus the exact
  // arguments they pass.
  const cases = [
    { name: "shortest-column mix", ratios: [2, 0.5, 1, 0.8, 3], columns: 2, columnWidth: 100, gap: 4 },
    {
      name: "nine-card three-column mix",
      ratios: [1.8, 0.5, 1, 2.3, 0.6, 0.75, 1.5, 0.4, 1.9], columns: 3, columnWidth: 240, gap: 5,
    },
    {
      name: "4249-card production scale",
      ratios: Array.from({ length: 4249 }, (_, i) => 0.5 + (i % 7) / 3),
      columns: 5, columnWidth: 200, gap: 4,
    },
  ];

  it("matches the pre-span placements and totalHeight field for field", () => {
    for (const { name, ratios, columns: cols, columnWidth, gap } of cases) {
      const model = masonry.buildMasonryModel(ratios, cols, columnWidth, gap);
      const oldModel = legacy.buildMasonryModel(ratios, cols, columnWidth, gap);
      assert.equal(model.placements.length, oldModel.placements.length, name);
      for (let index = 0; index < model.placements.length; index += 1) {
        assert.deepEqual(
          geometryOf(model.placements[index]),
          geometryOf(oldModel.placements[index]),
          `${name}: placement ${index}`,
        );
        assert.equal(model.placements[index].topUnits, oldModel.placements[index].precedingRatio,
          `${name}: placement ${index} topUnits`);
        assert.equal(model.placements[index].topGaps, oldModel.placements[index].precedingCount,
          `${name}: placement ${index} topGaps`);
        assert.equal(model.placements[index].span, 1, `${name}: placement ${index} span`);
      }
      assert.equal(model.totalHeight, oldModel.totalHeight, name);
      assert.equal(model.columns, oldModel.columns, name);
      assert.equal(model.columnWidth, oldModel.columnWidth, name);
      assert.equal(model.gap, oldModel.gap, name);
      assert.equal(model.spanWide, false, name);
    }
  });

  it("renders identical CSS values at a concrete container width", () => {
    // 5 columns of 196.8px + 4px gaps = the 1000px container substituted for 100cqw.
    const ratios = [2, 0.5, 1, 0.8, 3, 1.2, 0.9, 0.7, 2.4];
    const model = masonry.buildMasonryModel(ratios, 5, 196.8, 4);
    const oldModel = legacy.buildMasonryModel(ratios, 5, 196.8, 4);
    for (let index = 0; index < model.placements.length; index += 1) {
      const css = masonry.masonryCardCss(model, index);
      const oldCss = legacy.masonryCardCss(oldModel, index);
      for (const edge of ["left", "top", "width", "height"]) {
        const value = evalCalc(css[edge], 1000);
        const oldValue = evalCalc(oldCss[edge], 1000);
        assert.ok(
          Math.abs(value - oldValue) < 1e-6,
          `${edge}: ${value} vs pre-span ${oldValue} (${css[edge]} / ${oldCss[edge]})`,
        );
      }
    }
    const extent = evalExtentCss(masonry.masonryExtentCss(model), 1000);
    const oldExtent = evalExtentCss(legacy.masonryExtentCss(oldModel), 1000);
    assert.ok(Math.abs(extent - oldExtent) < 1e-6, `extent ${extent} vs pre-span ${oldExtent}`);
  });

  it("defaults to the non-spanning flow when options are omitted", () => {
    const ratios = [0.25, 0.5, 1 / 1.6];
    const model = masonry.buildMasonryModel(ratios, 5, 100, 4);
    assert.equal(model.spanWide, false);
    assert.ok(model.placements.every(place => place.span === 1),
      "landscape ratios must stay single-column without the opt-in");
  });
});

describe("spanWide: true layout", () => {
  let buildMasonryModel;
  before(() => { ({ buildMasonryModel } = masonry); });
  // 竖、竖、4:1 横幅、竖、2:1 横图 in 5 columns; heights below trace the
  // shortest-span-window rule by hand (columnWidth 100, gap 10).
  const bannerRatios = [1.2, 1.4, 0.25, 1.1, 0.5];

  it("spans landscape cards across the shortest adjacent columns", () => {
    const model = buildMasonryModel(bannerRatios, 5, 100, 10, { spanWide: true });
    // 100 × 1.1 carries float dust by construction; the model keeps it.
    const portraitHeight = 100 * 1.1;
    assert.deepEqual(model.placements.map(place => place.span), [1, 1, 3, 1, 2]);
    assert.deepEqual(model.placements.map(place => place.column), [0, 1, 2, 2, 3]);
    assert.deepEqual(model.placements.map(place => place.top), [0, 0, 0, 90, 90]);
    assert.deepEqual(model.placements.map(place => place.height),
      [120, 140, 80, portraitHeight, 210 * 0.5]);
    assert.equal(model.totalHeight, 90 + (portraitHeight + 10) - 10,
      "the lowest bottom edge (card 3: 90 + height)");
    assert.equal(model.spanWide, true);
  });

  it("keeps every pair of cards from overlapping and columns stacked in order", () => {
    const model = buildMasonryModel(bannerRatios, 5, 100, 10, { spanWide: true });
    assertNoPairwiseOverlap(model.placements, model.gap);
    assertColumnStackingInOrder(model.placements, model.gap);
  });

  it("resolves a tie between equally short windows to the leftmost start", () => {
    // All columns empty: the 3-span banner must start at column 0.
    const model = buildMasonryModel([0.25], 5, 100, 10, { spanWide: true });
    assert.equal(model.placements[0].column, 0);
    assert.equal(model.placements[0].span, 3);
  });

  it("clears the tallest column a window covers, not just its start column", () => {
    // Column bottoms dip at column 1 (140) then climb to 200/205: the 3-span
    // banner must start at column 1 but rest on the 200px crest it covers —
    // starting at the 140px start-column bottom would bury two cards.
    const model = buildMasonryModel([2.0, 1.3, 1.4, 1.9, 1.95, 0.25], 5, 100, 10, { spanWide: true });
    assertNoPairwiseOverlap(model.placements, model.gap);
    const banner = model.placements[5];
    assert.deepEqual([banner.column, banner.span, banner.top], [1, 3, 200]);
    assertColumnStackingInOrder(model.placements, model.gap);
  });

  it("measures the window starting at column 0 by its tallest column too", () => {
    // Column 1 holds a 300px card while column 0 is only 100px tall: a 2-span
    // banner starting at column 0 must rest on the 310 crest, not on column 0's
    // 110 bottom, and its CSS offsets must be built from the column that sets
    // the crest so every later card still lines up with the pixel placements.
    const model = buildMasonryModel([1, 3, 1, 0.4, 0.4, 1.2, 0.35], 3, 100, 10, { spanWide: true });
    assertNoPairwiseOverlap(model.placements, model.gap);
    assert.deepEqual(
      [model.placements[3].column, model.placements[3].span, model.placements[3].top],
      [0, 2, 310],
    );
    for (let index = 0; index < model.placements.length; index += 1) {
      const css = masonry.masonryCardCss(model, index);
      for (const edge of ["left", "top", "width", "height"]) {
        const value = evalCalc(css[edge], 320);
        assert.ok(Math.abs(value - model.placements[index][edge]) < 0.01,
          `card ${index} ${edge}: css ${value} vs placement ${model.placements[index][edge]}`);
      }
    }
    const extent = evalExtentCss(masonry.masonryExtentCss(model), 320);
    assert.ok(Math.abs(extent - model.totalHeight) < 0.01, `extent ${extent} vs ${model.totalHeight}`);
  });

  it("renders CSS positions that match the pixel placements", () => {
    // 5 columns of 192px + 10px gaps = the 1000px container substituted for 100cqw.
    const model = buildMasonryModel(bannerRatios, 5, 192, 10, { spanWide: true });
    for (let index = 0; index < model.placements.length; index += 1) {
      const css = masonry.masonryCardCss(model, index);
      const place = model.placements[index];
      for (const edge of ["left", "top", "width", "height"]) {
        const value = evalCalc(css[edge], 1000);
        assert.ok(
          Math.abs(value - place[edge]) < 0.01,
          `card ${index} ${edge}: css ${value} vs placement ${place[edge]} (${css[edge]})`,
        );
      }
    }
    const extent = evalExtentCss(masonry.masonryExtentCss(model), 1000);
    assert.ok(Math.abs(extent - model.totalHeight) < 0.01,
      `extent ${extent} should equal totalHeight ${model.totalHeight}`);
  });

  it("stacks later cards at or below a spanned card's bottom + gap", () => {
    // A 3-span banner (320×80 at columnWidth 100) fills columns 0–2; every
    // later card that covers any of those columns must rest on the shared
    // crest (90), never inside the banner's band.
    const model = buildMasonryModel([0.25, 1.0, 1.0, 1.0, 1.0, 1.0], 5, 100, 10, { spanWide: true });
    const banner = model.placements[0];
    assert.deepEqual([banner.column, banner.span, banner.top, banner.height], [0, 3, 0, 80]);
    let covered = 0;
    for (const place of model.placements.slice(1)) {
      const intersects = place.column < banner.column + banner.span
        && place.column + place.span > banner.column;
      if (!intersects) continue;
      covered += 1;
      assert.ok(place.top >= banner.top + banner.height + model.gap - 1e-9,
        `card at column ${place.column} sits inside the banner's band (top ${place.top})`);
    }
    assert.ok(covered > 0, "the scenario must actually exercise banner-column stacking");
    assertNoPairwiseOverlap(model.placements, model.gap);
    assertColumnStackingInOrder(model.placements, model.gap);
  });
});

describe("spanWide: true virtual windows", () => {
  it("retains viewport cards in bounded 4249-item windows with ~15% landscape", () => {
    const { buildMasonryModel, locateMasonryWindow } = masonry;
    const ratios = Array.from({ length: 4249 }, (_, i) => (
      i % 20 < 3 ? 1 / (2 + (i % 3)) : 0.5 + (i % 7) / 3
    ));
    const model = buildMasonryModel(ratios, 5, 200, 4, { spanWide: true });
    const spanned = model.placements.filter(place => place.span > 1);
    assert.ok(spanned.length > 500, `landscape cards must span (got ${spanned.length})`);
    for (const scroll of [0, 1500, 12000, model.totalHeight - 900]) {
      const ids = locateMasonryWindow(model, scroll, 900, 1200, 380);
      assert.ok(ids.length > 0 && ids.length <= 380);
      const visible = model.placements.flatMap((p, i) => p.top < scroll + 900 && p.top + p.height > scroll ? [i] : []);
      for (const id of visible) assert.ok(ids.includes(id), `missing visible card ${id}`);
    }
  });
});

describe("column count resolution", () => {
  let columnOptions, GALLERY_COLUMNS_STORAGE_KEY, resolveInitialColumns, readStoredColumns, writeStoredColumns;
  before(() => { ({
    columnOptions, GALLERY_COLUMNS_STORAGE_KEY, resolveInitialColumns,
    readStoredColumns, writeStoredColumns,
  } = columns); });

  it("offers 2/3/4/5/6/8 columns", () => {
    assert.deepEqual(columnOptions, [2, 3, 4, 5, 6, 8]);
    assert.equal(GALLERY_COLUMNS_STORAGE_KEY, "gravityport.galleryColumns");
  });

  it("prefers a stored choice from the slider options", () => {
    assert.equal(resolveInitialColumns("3", 1920), 3, "the new 3-column option");
    assert.equal(resolveInitialColumns("2", 1920), 2);
    assert.equal(resolveInitialColumns("8", 800), 8);
  });

  it("falls back to the viewport default for absent or invalid stored values", () => {
    assert.equal(resolveInitialColumns("7", 1920), 4, "7 is not an option");
    assert.equal(resolveInitialColumns("abc", 1920), 4);
    assert.equal(resolveInitialColumns(null, 1920), 4);
    assert.equal(resolveInitialColumns("", 1920), 4);
  });

  it("derives the default from the viewport width tiers", () => {
    assert.equal(resolveInitialColumns(null, 1400), 4);
    assert.equal(resolveInitialColumns(null, 1399), 3);
    assert.equal(resolveInitialColumns(null, 900), 3);
    assert.equal(resolveInitialColumns(null, 899), 2);
    assert.equal(resolveInitialColumns(null, 500), 2);
  });

  it("treats a non-finite or non-positive viewport as the wide default", () => {
    assert.equal(resolveInitialColumns(null, Number.NaN), 4);
    assert.equal(resolveInitialColumns(null, 0), 4);
    assert.equal(resolveInitialColumns(null, -100), 4);
    assert.equal(resolveInitialColumns(null, Number.POSITIVE_INFINITY), 4);
    assert.equal(resolveInitialColumns("3", Number.NaN), 3, "a valid stored choice still wins");
  });

  const memoryStorage = () => {
    const map = new Map();
    return {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)); },
    };
  };

  it("round-trips the stored choice", () => {
    const storage = memoryStorage();
    assert.equal(readStoredColumns(storage), null);
    writeStoredColumns(storage, 3);
    assert.equal(readStoredColumns(storage), "3");
    writeStoredColumns(storage, 6);
    assert.equal(readStoredColumns(storage), "6");
  });

  it("swallows storage failures", () => {
    assert.equal(readStoredColumns({ getItem() { throw new Error("denied"); }, setItem() {} }), null);
    const rejecting = {
      getItem: () => null,
      setItem() { throw new Error("quota exceeded"); },
    };
    assert.doesNotThrow(() => writeStoredColumns(rejecting, 5));
  });

  it("refuses to persist values outside the slider options", () => {
    const storage = memoryStorage();
    writeStoredColumns(storage, 7);
    assert.equal(readStoredColumns(storage), null, "7 must not be stored");
    writeStoredColumns(storage, Number.NaN);
    assert.equal(readStoredColumns(storage), null);
    writeStoredColumns(storage, 5);
    assert.equal(readStoredColumns(storage), "5", "a valid value still persists after refusals");
  });
});

describe("galleryImageSizes", () => {
  let galleryImageSizes;
  before(() => { ({ galleryImageSizes } = masonry); });
  it("requests 1.5× the rendered card width, rounded", () => {
    assert.equal(galleryImageSizes(100), "150px");
    assert.equal(galleryImageSizes(196.8), "295px");
    assert.equal(galleryImageSizes(333), "500px");
  });
  it("never asks for less than 1px", () => {
    assert.equal(galleryImageSizes(0.1), "1px");
    assert.equal(galleryImageSizes(0.5), "1px");
  });
  it("falls back to the 240px tier for degenerate widths", () => {
    assert.equal(galleryImageSizes(0), "240px");
    assert.equal(galleryImageSizes(-50), "240px");
    assert.equal(galleryImageSizes(Number.NaN), "240px");
    assert.equal(galleryImageSizes(Number.POSITIVE_INFINITY), "240px");
  });
});
