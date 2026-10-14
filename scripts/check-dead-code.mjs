// Dead-code gate: fails on tracked modules no other tracked file references,
// exported symbols no other file consumes (and the defining file does not use
// outside its own export statement), and CSS classes no tracked markup or
// script emits. Text-based and deliberately conservative: if a name appears
// anywhere in tracked text it counts as used, so the gate may miss dead code
// but must not raise false positives on dynamic class construction
// (`version-depth-${depth}`) or prose references.
//
// There is a single UI source tree (`web/gravityport/src/`), shared by the
// browser and the Electron shell (which ships its build output). Files
// outside it consume it normally.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const SOURCE_DIRS = ["lib", "web/gravityport/src", "desktop", "mcp", "scripts"];
const UI_TREE = "web/gravityport/src";
const SOURCE_EXTENSIONS = new Set([".mjs", ".ts", ".tsx", ".js", ".jsx", ".cjs"]);
const TEXT_EXTENSIONS = new Set([
  ".mjs", ".ts", ".tsx", ".js", ".jsx", ".cjs", ".json", ".md", ".html", ".css", ".yml", ".yaml", ".svg", ".sh",
]);
const MIN_SYMBOL_LENGTH = 3;

// Paths whose text can vouch for a file's liveness: everything except the
// file itself. (Before the UI trees were unified this also excluded the twin
// tree; with a single tree there is no twin left to exclude.)
function consumerPathsFor(path, allPaths) {
  return allPaths.filter((other) => other !== path);
}

// Intentionally retained items the scanners cannot attribute to a consumer.
// Each entry needs a justification comment next to it.
const DEAD_FILE_EXCEPTIONS = new Set([
  // Ambient TypeScript declarations: consumed by tsc, never imported.
  "web/gravityport/src/vite-env.d.ts",
]);
// Pluggable e2e flows are entry points: scripts/e2e-critical-flows.mjs loads
// every scripts/e2e-flows/*.mjs through readdir(), so no file names them.
// Shared helpers there ("_"-prefixed) are imported by name and stay checked.
const DEAD_FILE_EXCEPTION_PATTERNS = [/^scripts\/e2e-flows\/[^_/][^/]*\.mjs$/];
const DEAD_EXPORT_EXCEPTIONS = new Set();
const DEAD_CSS_EXCEPTIONS = new Set();
// Classes whose numeric suffix is built through an intermediate variable
// (web/app/inspector-markup.mjs: `const depthClass = `generation-depth-${...}``),
// which the class-attribute interpolation check cannot see.
const DEAD_CSS_EXCEPTION_PREFIXES = [];

const DECLARATION_EXPORT_RE = /export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|(?:abstract\s+)?class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const LIST_EXPORT_RE = /export\s*\{([^}]*)\}/g;
const DESTRUCTURED_EXPORT_RE = /export\s+(?:const|let|var)\s*\{([^}]*)\}/g;
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const CSS_CLASS_RE = /\.([a-zA-Z_][\w-]*)/g;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

export function extractExports(source) {
  const names = [];
  const stripped = source.split("");
  const blank = (start, end) => {
    for (let i = start; i < end; i += 1) {
      if (stripped[i] !== "\n") stripped[i] = " ";
    }
  };
  for (const match of source.matchAll(DECLARATION_EXPORT_RE)) {
    names.push(match[1]);
    blank(match.index, match.index + match[0].length);
  }
  for (const match of source.matchAll(DESTRUCTURED_EXPORT_RE)) {
    for (const part of match[1].split(",")) {
      const name = part.split("=")[0].split(":").pop().trim();
      if (IDENTIFIER_RE.test(name)) names.push(name);
    }
    blank(match.index, match.index + match[0].length);
  }
  for (const match of source.matchAll(LIST_EXPORT_RE)) {
    for (const part of match[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith("type ")) continue;
      const name = trimmed.split(/\s+as\s+/).pop().trim();
      if (IDENTIFIER_RE.test(name)) names.push(name);
    }
    blank(match.index, match.index + match[0].length);
  }
  return { names, strippedSource: stripped.join("") };
}

export function tokenize(source) {
  return new Set(source.split(/[^\w$]+/).filter(Boolean));
}

function stripCssComments(css) {
  return css.replace(CSS_COMMENT_RE, (match) => match.replace(/[^\n]/g, " "));
}

function hasDynamicClassSuffix(corpus, name) {
  let hyphen = name.length;
  while ((hyphen = name.lastIndexOf("-", hyphen - 1)) > 0) {
    const escaped = name.slice(0, hyphen + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // HTML string classes (`class="a ${b}"`) and JSX template classes
    // (`className={`a ${b}`}`) both count as dynamic construction.
    if (new RegExp(`(?:class|className)=\\{?["'\`][^"'\`]*${escaped}\\$\\{`).test(corpus)) return true;
  }
  return false;
}

export function extractCssClasses(css) {
  return new Set([...stripCssComments(css).matchAll(CSS_CLASS_RE)].map((match) => match[1]));
}

export function analyzeDeadCode({ files, sourceDirs = SOURCE_DIRS, cssFiles = null }) {
  const sourcePaths = [...files.keys()].filter((path) => {
    if (!SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf(".")))) return false;
    return sourceDirs.some((dir) => path.startsWith(`${dir}/`));
  });

  const tokenSets = new Map([...files].map(([path, text]) => [path, tokenize(text)]));
  const allPaths = [...files.keys()];
  const exportInfo = new Map();
  for (const path of sourcePaths) {
    exportInfo.set(path, extractExports(files.get(path)));
  }

  // A file is dead when its stem appears in no consumer's tracked text, so
  // documented maintenance scripts referenced only from docs/ stay alive.
  const deadFiles = [];
  for (const path of sourcePaths) {
    const stem = basename(path).replace(/\.[^.]+$/, "");
    const consumers = consumerPathsFor(path, allPaths);
    const referenced = consumers.some((other) => files.get(other).includes(stem));
    if (referenced || DEAD_FILE_EXCEPTIONS.has(path)) continue;
    if (DEAD_FILE_EXCEPTION_PATTERNS.some((pattern) => pattern.test(path))) continue;
    deadFiles.push(path);
  }

  // Only names with no consumer anywhere — including the defining file with
  // its export statements blanked — are dead. Exports used solely inside the
  // defining file are a style choice, not a gate failure.
  const deadExports = [];
  for (const [path, { names, strippedSource }] of exportInfo) {
    const ownTokens = tokenize(strippedSource);
    const consumers = consumerPathsFor(path, allPaths);
    for (const name of new Set(names)) {
      if (name.length < MIN_SYMBOL_LENGTH) continue;
      const usedElsewhere = consumers.some((other) => tokenSets.get(other).has(name));
      if (usedElsewhere || ownTokens.has(name)) continue;
      if (DEAD_EXPORT_EXCEPTIONS.has(`${path}::${name}`)) continue;
      deadExports.push({ file: path, name });
    }
  }

  // Every tracked stylesheet in the UI tree is scanned — derived from the
  // file list, so adding a stylesheet to the tree cannot slip past the gate.
  // The React tree keeps its single stylesheet at index.css; a tree that
  // ships stylesheets but none of them is a broken tree.
  const UI_STYLESHEETS = [`${UI_TREE}/index.css`];
  const cssPaths = cssFiles
    ? cssFiles.filter((path) => files.has(path))
    : (() => {
        const treeFiles = allPaths.filter((path) => path.startsWith(`${UI_TREE}/`) && path.endsWith(".css"));
        if (treeFiles.length > 0 && !treeFiles.some((path) => UI_STYLESHEETS.includes(path))) {
          throw new Error(`${UI_TREE} has stylesheets but is missing ${UI_STYLESHEETS.join(" or ")}.`);
        }
        return treeFiles;
      })();
  const nonCssCorpus = [...files.entries()]
    .filter(([path]) => !cssPaths.includes(path))
    .map(([, text]) => text)
    .join("\n");
  const deadCssClasses = [];
  for (const path of cssPaths) {
    for (const name of extractCssClasses(files.get(path))) {
      if (nonCssCorpus.includes(name) || hasDynamicClassSuffix(nonCssCorpus, name)) continue;
      if (DEAD_CSS_EXCEPTIONS.has(`${path}::${name}`)) continue;
      if (DEAD_CSS_EXCEPTION_PREFIXES.some((prefix) => `${path}::${name}`.startsWith(prefix))) continue;
      deadCssClasses.push({ file: path, name });
    }
  }

  return {
    deadFiles,
    deadExports,
    deadCssClasses,
    counts: {
      modules: sourcePaths.length,
      exports: [...exportInfo.values()].reduce((total, { names }) => total + names.length, 0),
      cssClasses: cssPaths.reduce((total, path) => total + extractCssClasses(files.get(path)).size, 0),
    },
  };
}

async function main() {
  // UI tree files must be tracked or ignored. An untracked stylesheet or
  // module in web/gravityport/src is invisible to this gate, the build
  // identity, and a fresh clone — exactly how a referenced-but-untracked UI
  // file ships broken. Fail closed on any untracked entry (`??`); staged or
  // modified files are already visible to the scanners below.
  const { stdout: untrackedOutput } = await execFileAsync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", "web/gravityport/src"],
    { cwd: root },
  );
  const untrackedEntries = untrackedOutput.split("\n").filter((line) => line.startsWith("??"));
  if (untrackedEntries.length > 0) {
    throw new Error(
      "UI tree files must be tracked or ignored — untracked entries are invisible to the dead-code gate and to fresh clones:\n"
      + untrackedEntries.map((line) => `  ${line}`).join("\n"),
    );
  }

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

  const { deadFiles, deadExports, deadCssClasses, counts } = analyzeDeadCode({ files });
  if (deadFiles.length === 0 && deadExports.length === 0 && deadCssClasses.length === 0) {
    console.log(`Dead-code check passed: ${counts.modules} modules, ${counts.exports} exports, ${counts.cssClasses} CSS classes.`);
    return;
  }

  const sections = [];
  if (deadFiles.length > 0) {
    sections.push(`Unreferenced modules (no other tracked file mentions them):\n${deadFiles.map((path) => `  ${path}`).join("\n")}`);
  }
  if (deadExports.length > 0) {
    sections.push(`Exported symbols with no consumer anywhere:\n${deadExports.map(({ file, name }) => `  ${file}: ${name}`).join("\n")}`);
  }
  if (deadCssClasses.length > 0) {
    sections.push(`CSS classes never emitted by tracked markup or scripts:\n${deadCssClasses.map(({ file, name }) => `  ${file}: .${name}`).join("\n")}`);
  }
  throw new Error(`Dead code detected — remove it or add a justified exception in scripts/check-dead-code.mjs:\n\n${sections.join("\n\n")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
