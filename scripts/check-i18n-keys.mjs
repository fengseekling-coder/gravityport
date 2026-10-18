// i18n key gate: fails on `english` map keys in web/gravityport/src/i18n.ts
// that no product source file references. The map's keys are the Chinese
// source strings that `translate()` looks up at runtime; a key nothing looks up
// can never reach the UI (English users would see the Chinese fallback instead
// of dead English text, so the rot is invisible). Text-based and deliberately
// conservative, like the dead-code gate: a key counts as referenced when it
// appears anywhere in tracked product source outside the i18n file itself —
// including lib/, desktop/, and server.mjs, because the UI translates Chinese
// strings returned by the server. Tests, e2e flows, and Markdown documents are
// not product source: a label mentioned in the guide, used as fixture data, or
// asserted absent by a test does not keep its key alive. Substring matching may
// keep a truly dead key alive when it is contained in a longer literal, but
// must not raise false positives.
//
// Keys that are built at runtime and therefore cannot be found statically go
// in DYNAMIC_KEY_EXCEPTIONS with a comment naming the construction site.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const I18N_PATH = "web/gravityport/src/i18n.ts";
const TEXT_EXTENSIONS = new Set([
  ".mjs", ".ts", ".tsx", ".js", ".jsx", ".cjs", ".json", ".md", ".html", ".css", ".yml", ".yaml", ".svg", ".sh",
]);
const NON_PRODUCT_PREFIXES = ["test/", "scripts/e2e-flows/", "docs/"];

// Whether a tracked path is product source that can look a key up at runtime.
export function isProductSourcePath(path) {
  if (path.endsWith(".md")) return false;
  return !NON_PRODUCT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// Keys assembled at runtime, invisible to the static search. Every entry
// needs a comment saying where the key is built before the lookup. The keys
// are built with join() on purpose: a contiguous literal here would put the
// key into this checker's own corpus and vouch for itself.
const DOT = " · ";
const DYNAMIC_KEY_EXCEPTIONS = new Set([
  // Inspector header line "kind · source · date": App.tsx inspectorHeaderLine()
  // interpolates the kind word into the template — `${kind} · {source} · {date}`
  // with kind = "图片" | "视频" — and looks the template up in the english map.
  ["图片", "{source}", "{date}"].join(DOT),
  ["视频", "{source}", "{date}"].join(DOT),
  ["图片", "{source}"].join(DOT),
  ["视频", "{source}"].join(DOT),
]);

const ENGLISH_PAIR_RE = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

// Extracts the keys of the `english` map from i18n.ts source. Pairs must be
// full `"key": "value"` literals (the map is Record<string, string>), so
// prose in comments cannot masquerade as entries.
export function extractI18nKeys(source) {
  const start = source.indexOf("const english");
  if (start === -1) throw new Error("i18n source has no `const english` map");
  const blockEnd = source.indexOf("\n}", start);
  if (blockEnd === -1) throw new Error("i18n source has no closing brace for the `english` map");
  const block = source.slice(start, blockEnd);

  const keys = [];
  const seen = new Set();
  for (const match of block.matchAll(ENGLISH_PAIR_RE)) {
    const raw = match[1];
    const key = JSON.parse(`"${raw}"`);
    if (seen.has(key)) throw new Error(`duplicate i18n key: ${key}`);
    seen.add(key);
    keys.push({ key, raw });
  }
  if (keys.length === 0) throw new Error("i18n source yielded no keys — parser or file format drift");
  return keys;
}

export function analyzeI18nKeys({ files, i18nPath = I18N_PATH, exceptions = DYNAMIC_KEY_EXCEPTIONS }) {
  const i18nSource = files.get(i18nPath);
  if (i18nSource === undefined) throw new Error(`missing i18n source file: ${i18nPath}`);
  const keys = extractI18nKeys(i18nSource);

  // The defining file is excluded from the corpus: every key trivially
  // appears there, which is exactly the reference the gate must ignore.
  const corpus = [...files.entries()]
    .filter(([path]) => path !== i18nPath && isProductSourcePath(path))
    .map(([, text]) => text)
    .join("\n");

  const unusedKeys = [];
  for (const { key, raw } of keys) {
    if (exceptions.has(key)) continue;
    if (corpus.includes(raw) || corpus.includes(key)) continue;
    unusedKeys.push(key);
  }
  return { unusedKeys, checked: keys.length };
}

async function main() {
  const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: root });
  // Tracked files whose working-tree copy is already deleted (pending commit)
  // have no content to scan; the index lags the tree until then.
  const { stdout: deletedStdout } = await execFileAsync("git", ["ls-files", "--deleted"], { cwd: root });
  const deletedPaths = new Set(deletedStdout.split("\n").filter(Boolean));
  const files = new Map();
  for (const path of stdout.split("\n").filter(Boolean)) {
    if (deletedPaths.has(path)) continue;
    if (!TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf(".")))) continue;
    files.set(path, await readFile(join(root, path), "utf8"));
  }

  const { unusedKeys, checked } = analyzeI18nKeys({ files });
  if (unusedKeys.length === 0) {
    console.log(`i18n key check passed: ${checked} keys, all referenced.`);
    return;
  }
  throw new Error(
    `Unused i18n keys detected — remove them from ${I18N_PATH} or add a justified exception in scripts/check-i18n-keys.mjs:\n`
    + unusedKeys.map((key) => `  "${key}"`).join("\n"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
