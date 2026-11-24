import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { LOVART_BASE_IMAGE_RESOLVER } from "../lib/generation-history.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");
const compileRoot = join(uiRoot, "node_modules", ".cache", "version-canvas-lovart-edge-test");
const tscOut = join(compileRoot, "tsc");

let canvasModel;

async function rewriteViteEnv(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteViteEnv(full);
    } else if (entry.name.endsWith(".js")) {
      const source = await readFile(full, "utf8");
      const rewritten = source
        .replaceAll("import.meta.env.DEV", "false")
        .replaceAll("import.meta.env.PROD", "true");
      if (rewritten !== source) {
        await writeFile(full, rewritten, "utf8");
      }
    }
  }
}

function makeAsset(id, name, importedAt) {
  return {
    id,
    name,
    width: 1024,
    height: 1024,
    size_bytes: 120000,
    mime_type: "image/png",
    media_type: "image",
    imported_at: importedAt,
    favorite: false,
    tags: [],
    group: "未分组",
    image_url: `/api/assets/default/${id}/image`,
    preview_url: `/api/assets/default/${id}/preview`,
    medium_url: `/api/assets/default/${id}/medium`,
    thumbnail_url: `/api/assets/default/${id}/thumb`,
  };
}

before(async () => {
  await rm(compileRoot, { recursive: true, force: true });
  await mkdir(tscOut, { recursive: true });
  execFileSync(
    join(repositoryRoot, "node_modules", ".bin", "tsc"),
    [
      join(uiRoot, "src", "vite-env.d.ts"),
      join(uiRoot, "src", "version-canvas-model.ts"),
      "--outDir", tscOut,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--skipLibCheck",
    ],
    { stdio: "pipe" },
  );
  await rewriteViteEnv(tscOut);
  await writeFile(
    join(compileRoot, "hooks.mjs"),
    [
      'import { existsSync } from "node:fs";',
      'import { dirname, resolve as resolvePath } from "node:path";',
      'import { fileURLToPath, pathToFileURL } from "node:url";',
      "export async function resolve(specifier, context, nextResolve) {",
      '  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {',
      "    const parentDir = dirname(fileURLToPath(context.parentURL));",
      '    if (!existsSync(resolvePath(parentDir, specifier)) && existsSync(resolvePath(parentDir, specifier + ".js"))) {',
      '      return { url: pathToFileURL(resolvePath(parentDir, specifier + ".js")).href, shortCircuit: true };',
      "    }",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  register(pathToFileURL(join(compileRoot, "hooks.mjs")).href);
  canvasModel = await import(pathToFileURL(join(tscOut, "version-canvas-model.js")).href);
});

after(async () => {
  await rm(compileRoot, { recursive: true, force: true });
});

describe("version-canvas-model Lovart base-image edges", () => {
  it("keeps LOVART_BASE_IMAGE_RESOLVER equal to lib/generation-history.mjs", () => {
    assert.equal(canvasModel.LOVART_BASE_IMAGE_RESOLVER, LOVART_BASE_IMAGE_RESOLVER);
    assert.equal(canvasModel.LOVART_BASE_IMAGE_RESOLVER, "lovart-base-image-v1");
  });

  it("draws a solid edited_from edge for observed lovart-base-image-v1 relations and ignores other observed/inferred relations", () => {
    const a1 = makeAsset("a1", "base.png", "2026-11-23T10:00:00.000Z");
    const a2 = makeAsset("a2", "edited.png", "2026-11-23T10:02:00.000Z");
    const a3 = makeAsset("a3", "plain-observed.png", "2026-11-23T10:03:00.000Z");
    const a4 = makeAsset("a4", "plain-inferred.png", "2026-11-23T10:04:00.000Z");
    const history = {
      asset_id: "a2",
      generation_ids: ["evt-2"],
      output_assets: [a1, a2, a3, a4],
      events: [
        {
          id: "evt-1",
          provider: "lovart",
          conversation_id: "conv-lovart",
          output_asset_id: "a1",
          effective_prompt: "base image",
          created_at: "2026-11-23T10:00:00.000Z",
          verification_level: "observed",
        },
        {
          id: "evt-2",
          provider: "lovart",
          conversation_id: "conv-lovart",
          output_asset_id: "a2",
          effective_prompt: "edited image",
          created_at: "2026-11-23T10:02:00.000Z",
          verification_level: "observed",
        },
        {
          id: "evt-3",
          provider: "lovart",
          conversation_id: "conv-lovart",
          output_asset_id: "a3",
          effective_prompt: "observed without resolver",
          created_at: "2026-11-23T10:03:00.000Z",
          verification_level: "observed",
        },
        {
          id: "evt-4",
          provider: "lovart",
          conversation_id: "conv-lovart",
          output_asset_id: "a4",
          effective_prompt: "inferred relation",
          created_at: "2026-11-23T10:04:00.000Z",
          verification_level: "observed",
        },
      ],
      context_events: [],
      relations: [
        {
          id: "rel-lovart",
          parent_generation_id: "evt-1",
          child_generation_id: "evt-2",
          relation_type: "edited_from",
          verification_level: "observed",
          evidence: {
            resolver: LOVART_BASE_IMAGE_RESOLVER,
            reference_provider_asset_id: "ref:Fake01ArtifactId",
            parent_provider_asset_id: "Fake01ArtifactId",
          },
          created_at: "2026-11-23T10:02:05.000Z",
        },
        {
          id: "rel-observed-no-resolver",
          parent_generation_id: "evt-1",
          child_generation_id: "evt-3",
          relation_type: "edited_from",
          verification_level: "observed",
          evidence: {},
          created_at: "2026-11-23T10:03:05.000Z",
        },
        {
          id: "rel-inferred",
          parent_generation_id: "evt-1",
          child_generation_id: "evt-4",
          relation_type: "derived_from",
          verification_level: "inferred",
          evidence: { resolver: LOVART_BASE_IMAGE_RESOLVER },
          created_at: "2026-11-23T10:04:05.000Z",
        },
      ],
      relation_candidates: [],
    };

    const model = canvasModel.canvasFromHistory(history, a2);
    assert.equal(model.edges.length, 1);
    assert.equal(model.edges[0].from, "a1");
    assert.equal(model.edges[0].to, "a2");
    assert.equal(model.edges[0].parentGenerationId, "evt-1");
    assert.equal(model.edges[0].childGenerationId, "evt-2");
    assert.equal(model.edges[0].type, "edited_from");
    assert.equal(model.edges[0].suggested, false);
    assert.equal(model.edges[0].evidence?.resolver, "lovart-base-image-v1");
  });
});
