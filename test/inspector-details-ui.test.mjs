// InspectorDetails UI contract test (task 420): compile the real TSX source
// with tsc and assert that the inspector close button renders the sidebar
// ("inspector") icon rather than the "close" X glyph.

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire, register } from "node:module";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");
const compileRoot = join(uiRoot, "node_modules", ".cache", "inspector-details-ui-test");

let React;
let renderToStaticMarkup;
let InspectorDetails;
let translate;

before(async () => {
  await mkdir(compileRoot, { recursive: true });
  const sources = [
    join(uiRoot, "src", "vite-env.d.ts"),
    join(uiRoot, "src", "mosa-api.ts"),
    join(uiRoot, "src", "error-messages.ts"),
    join(uiRoot, "src", "i18n.ts"),
    join(uiRoot, "src", "inspector-info.ts"),
    join(uiRoot, "src", "tag-display.ts"),
    join(uiRoot, "src", "prompt-edit.ts"),
    join(uiRoot, "src", "Icon.tsx"),
    join(uiRoot, "src", "ThumbMedia.tsx"),
    join(uiRoot, "src", "ReadingText.tsx"),
    join(uiRoot, "src", "InspectorDetails.tsx"),
  ];
  execFileSync(
    join(repositoryRoot, "node_modules", ".bin", "tsc"),
    [
      ...sources,
      "--outDir", compileRoot,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--jsx", "react-jsx",
      "--skipLibCheck",
    ],
    { stdio: "pipe" }
  );

  // InspectorDetails.tsx uses bundler extensionless relative imports; resolve
  // them to the tsc-emitted .js files in compileRoot for Node ESM.
  await writeFile(
    join(compileRoot, "resolve-hooks.mjs"),
    [
      "export async function resolve(specifier, context, next) {",
      '  if (specifier.startsWith("./") && !/\\.[a-z]+$/i.test(specifier)) {',
      '    return next(`${specifier}.js`, context);',
      "  }",
      "  return next(specifier, context);",
      "}",
    ].join("\n")
  );
  register(pathToFileURL(join(compileRoot, "resolve-hooks.mjs")).href);

  const uiRequire = createRequire(join(uiRoot, "package.json"));
  ({ renderToStaticMarkup } = await import(uiRequire.resolve("react-dom/server")));
  React = await import(uiRequire.resolve("react"));
  ({ InspectorDetails } = await import(join(compileRoot, "InspectorDetails.js")));
  ({ translate } = await import(join(compileRoot, "i18n.js")));
});

after(async () => {
  await rm(compileRoot, { recursive: true, force: true });
});

function renderInspector(language = "zh") {
  const tr = (text) => translate(text, language);
  const noop = () => {};
  const asyncNoop = async () => {};
  return renderToStaticMarkup(
    React.createElement(InspectorDetails, {
      asset: {
        id: "asset-420",
        project_id: "default",
        name: "sample.png",
        format: "PNG",
        width: 1024,
        height: 1024,
        size_bytes: 2048,
        mediaKind: "image",
        thumbnail_url: "",
        image_url: "",
        palette: [],
        tags: [],
        prompt: "",
        prompt2: "",
        user_instruction: "",
        introduction: "",
        favorite: false,
      },
      language,
      tr,
      fillNamed: (text) => text,
      notify: noop,
      project: "default",
      writeText: asyncNoop,
      headerLine: "图片 · 1024 × 1024",
      trashReasonInfo: null,
      sourceInfo: null,
      tagsRowRef: { current: null },
      tagsMeasureRef: { current: null },
      setDetail: noop,
      setPreview: noop,
      toggleFavorite: asyncNoop,
      setAssets: noop,
      expandedTags: false,
      setExpandedTags: noop,
      tagItems: [],
      collapsedTagCount: 0,
      tagVendor: null,
      currentTags: [],
      addingTag: false,
      setAddingTag: noop,
      tagDraft: "",
      setTagDraft: noop,
      tagError: "",
      setTagError: noop,
      promptVariant: 1,
      setPromptVariant: noop,
      promptEdit: null,
      setPromptEdit: noop,
      expandedPrompt: false,
      setExpandedPrompt: noop,
      shownPrompt: "",
      startPromptEdit: noop,
      savePrompt: noop,
      savingPromptId: null,
      promptNoticeInfo: null,
      expandedInstruction: false,
      setExpandedInstruction: noop,
      expandedIntro: false,
      setExpandedIntro: noop,
      recipeHistory: null,
      assets: [],
      inspectorFetchError: { versions: false, history: false, recipes: false },
    })
  );
}

describe("InspectorDetails close control", () => {
  it("renders the inspector sidebar glyph rather than the close X glyph", () => {
    const html = renderInspector("zh");
    const headingMatch = html.match(/<div class="detail-heading">([\s\S]*?)<\/div>/);
    assert.ok(headingMatch, "detail heading rendered");
    const closeBtnMatch = headingMatch[1].match(/<button aria-label="关闭素材详情">([\s\S]*?)<\/button>/);
    assert.ok(closeBtnMatch, "inspector close button rendered with aria-label");
    assert.match(
      closeBtnMatch[1],
      /<rect x="4" y="4" width="16" height="16" rx="2"><\/rect><path d="M14 4v16"><\/path>/,
      "close button uses the inspector icon glyph"
    );
    assert.doesNotMatch(
      closeBtnMatch[1],
      /m6\.5 6\.5 11 11M6\.5 17\.5l11-11/,
      "close button must not use the close X glyph"
    );
  });
});
