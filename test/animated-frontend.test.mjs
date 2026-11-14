import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

// Task 412: the web app derives `animated` through assetIsAnimated — the real
// mosa-api.ts compiled with the project's own tsc (same pattern as
// asset-shape-contract.test.mjs), never a copied implementation.

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

const tempRoot = await mkdtemp(join(tmpdir(), "mosa-anim-frontend-"));
after(() => rm(tempRoot, { recursive: true, force: true }));

const module = await (async () => {
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "mosa-api.ts"), "--outDir", tempRoot, "--module", "esnext",
    "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  return import(join(tempRoot, "mosa-api.js"));
})();

const { assetIsAnimated, normalizeAsset } = module;

test("assetIsAnimated reads business_fields.animated as the authority", () => {
  assert.equal(assetIsAnimated({ animated: true }, "/library/default/images/a.webp"), true, "flagged true wins over the extension");
  assert.equal(assetIsAnimated({ animated: false }, "/library/default/images/a.gif"), false, "flagged false wins over the .gif fallback");
});

test("without the flag, .gif counts as animated and other extensions stay still", () => {
  assert.equal(assetIsAnimated({}, "/library/default/images/a.gif"), true);
  assert.equal(assetIsAnimated(undefined, "/library/default/images/b.GIF"), true, "the extension check is case-insensitive");
  assert.equal(assetIsAnimated({}, "/library/default/images/a.webp"), false);
  assert.equal(assetIsAnimated(null, "/library/default/images/a.png"), false);
  assert.equal(assetIsAnimated({}, ""), false);
  assert.equal(assetIsAnimated({ animated: "true" }, "/library/default/images/a.webp"), false, "only the boolean true counts as the flag (no .gif fallback here)");
});

test("normalizeAsset fills MosaAsset.animated through the same rule", () => {
  const base = { id: "a1", image_path: "/library/default/images/x.gif", image_url: "/library/default/images/x.gif" };
  assert.equal(normalizeAsset({ ...base, business_fields: { animated: true } }).animated, true);
  assert.equal(normalizeAsset({ ...base, business_fields: { animated: false } }).animated, false);
  assert.equal(normalizeAsset({ ...base, business_fields: {} }).animated, true, "unflagged .gif plays safe as animated");
  const webp = normalizeAsset({ id: "a2", image_path: "/library/default/images/y.webp", image_url: "/library/default/images/y.webp", business_fields: {} });
  assert.equal(webp.animated, false);
});
