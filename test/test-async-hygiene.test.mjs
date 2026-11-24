// Task 471: guard against two async test pitfalls that pass on fast machines
// and fail on slow CI runners:
//   A.1 Arm one-shot listeners before triggering/awaiting (PR #357 run 4, ba57ab8).
//   A.2 Verify quietness in the options page harness under async jitter (PR #357 run 1, 79bdd20).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const testDir = join(rootDir, "test");

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "case", "throw", "in", "of", "typeof", "void", "delete", "new", "await", "yield", "else", "do",
]);

/**
 * Replace comments, string literals, template text, and regex literals with
 * spaces while keeping every newline at its original offset so line numbers
 * remain exact. Expressions inside `${...}` template interpolations stay
 * visible to the scanner.
 */
function maskNonCode(source) {
  const out = new Array(source.length);
  let i = 0;
  let lastToken = "";
  const templateBraceDepths = [];

  const blankRange = (start, end) => {
    for (let k = start; k < end; k += 1) {
      out[k] = source[k] === "\n" ? "\n" : " ";
    }
  };

  const canStartRegex = () => (
    lastToken === ""
    || /^[\(\[\{,;:=!?&|+\-*%^~<>]$/.test(lastToken)
    || lastToken === "=>"
    || REGEX_PRECEDING_KEYWORDS.has(lastToken)
  );

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // Line comment
    if (ch === "/" && next === "/") {
      const start = i;
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      blankRange(start, i);
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i = Math.min(source.length, i + 2);
      blankRange(start, i);
      continue;
    }

    // Single- or double-quoted string
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i += 2;
        else i += 1;
      }
      if (i < source.length) i += 1;
      blankRange(start, i);
      lastToken = "STR";
      continue;
    }

    // Template literal start
    if (ch === "`") {
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "`") {
          i += 1;
          blankRange(start, i);
          lastToken = "STR";
          break;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          blankRange(start, i + 2);
          i += 2;
          templateBraceDepths.push(0);
          lastToken = "{";
          break;
        }
        i += 1;
      }
      if (i >= source.length && out[start] === undefined) {
        blankRange(start, source.length);
      }
      continue;
    }

    // Closing brace of a `${...}` template interpolation resumes template scanning
    if (ch === "}" && templateBraceDepths.length > 0 && templateBraceDepths[templateBraceDepths.length - 1] === 0) {
      templateBraceDepths.pop();
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "`") {
          i += 1;
          blankRange(start, i);
          lastToken = "STR";
          break;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          blankRange(start, i + 2);
          i += 2;
          templateBraceDepths.push(0);
          lastToken = "{";
          break;
        }
        i += 1;
      }
      if (i >= source.length && out[start] === undefined) {
        blankRange(start, source.length);
      }
      continue;
    }

    // Regex literal
    if (ch === "/" && canStartRegex()) {
      const start = i;
      i += 1;
      let inClass = false;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          i += 1;
          while (i < source.length && /[a-z]/i.test(source[i])) i += 1;
          break;
        } else if (c === "\n") {
          break;
        }
        i += 1;
      }
      blankRange(start, i);
      lastToken = "REGEX";
      continue;
    }

    // Track brace nesting inside template interpolations
    if (templateBraceDepths.length > 0) {
      if (ch === "{") templateBraceDepths[templateBraceDepths.length - 1] += 1;
      else if (ch === "}") templateBraceDepths[templateBraceDepths.length - 1] -= 1;
    }

    out[i] = ch;
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && /[\w$]/.test(source[i])) {
        out[i] = source[i];
        i += 1;
      }
      lastToken = source.slice(start, i);
      continue;
    }
    if (ch === "=" && next === ">") {
      out[i + 1] = next;
      lastToken = "=>";
      i += 2;
      continue;
    }
    if (!/\s/.test(ch)) lastToken = ch;
    i += 1;
  }

  return out.join("");
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function findMatchingDelimiter(text, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === openChar) depth += 1;
    else if (text[i] === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelStatements(blockInner) {
  const statements = [];
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let start = 0;
  for (let i = 0; i < blockInner.length; i += 1) {
    const ch = blockInner[i];
    if (ch === "(") paren += 1;
    else if (ch === ")") paren -= 1;
    else if (ch === "{") brace += 1;
    else if (ch === "}") brace -= 1;
    else if (ch === "[") bracket += 1;
    else if (ch === "]") bracket -= 1;
    else if (ch === ";" && paren === 0 && brace === 0 && bracket === 0) {
      const piece = blockInner.slice(start, i).trim();
      if (piece) statements.push(piece);
      start = i + 1;
    }
  }
  const tail = blockInner.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function isPureOnceRegistration(expr) {
  const trimmed = expr.replace(/^return\s+/, "").trim();
  return /^(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*)?once\s*\([\s\S]*\)$/.test(trimmed);
}

/**
 * Scan masked JS source for direct `await once(...)`, `await events.once(...)`,
 * and `await new Promise(...)` wrappers whose executor immediately registers
 * `.once(...)` (within 3 lines) without triggering the event inside the executor.
 */
export function scanDirectOnceAwaits(source, displayPath = "<fixture>") {
  const masked = maskNonCode(source);
  const rawLines = source.split("\n");
  const hits = [];

  // 1. Direct `await once(` or `await <expr>.once(`
  const directRe = /\bawait\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*once\s*\(/g;
  for (const match of masked.matchAll(directRe)) {
    const line = lineNumberAt(masked, match.index);
    hits.push({
      file: displayPath,
      line,
      kind: "await-once",
      snippet: rawLines[line - 1].trim(),
    });
  }

  // 2. `await new Promise(...)` immediately wrapping `.once(...)` within 3 lines
  const promiseRe = /\bawait\s+new\s+Promise\s*\(/g;
  for (const match of masked.matchAll(promiseRe)) {
    const openParen = masked.indexOf("(", match.index);
    const closeParen = findMatchingDelimiter(masked, openParen, "(", ")");
    if (closeParen < 0) continue;

    const promiseLine = lineNumberAt(masked, match.index);
    const innerOffset = openParen + 1;
    const inner = masked.slice(innerOffset, closeParen);

    // Find executor body: either `(...) => <body>` / `ident => <body>` or `function (...) { <body> }`
    let bodyStart = -1;
    const arrowMatch = inner.match(/^\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/);
    const fnMatch = !arrowMatch && inner.match(/^\s*(?:async\s+)?function\b[^{]*\{/);
    if (arrowMatch) {
      bodyStart = innerOffset + arrowMatch[0].length;
    } else if (fnMatch) {
      bodyStart = innerOffset + fnMatch[0].length - 1;
    } else {
      continue;
    }

    const firstChar = masked[bodyStart];
    if (firstChar === "{") {
      const closeBrace = findMatchingDelimiter(masked, bodyStart, "{", "}");
      if (closeBrace < 0 || closeBrace > closeParen) continue;
      const blockInner = masked.slice(bodyStart + 1, closeBrace);
      const onceRel = blockInner.search(/(?:\.\s*|\b)once\s*\(/);
      if (onceRel < 0) continue;
      const onceLine = lineNumberAt(masked, bodyStart + 1 + onceRel);
      if (onceLine - promiseLine > 3) continue;
      const statements = splitTopLevelStatements(blockInner);
      if (statements.length > 0 && statements.every(isPureOnceRegistration)) {
        hits.push({
          file: displayPath,
          line: promiseLine,
          kind: "await-new-promise-once",
          snippet: rawLines[promiseLine - 1].trim(),
        });
      }
    } else {
      const expr = masked.slice(bodyStart, closeParen).trim();
      const onceRel = expr.search(/(?:\.\s*|\b)once\s*\(/);
      if (onceRel < 0) continue;
      const onceLine = lineNumberAt(masked, bodyStart + onceRel);
      if (onceLine - promiseLine > 3) continue;
      if (isPureOnceRegistration(expr)) {
        hits.push({
          file: displayPath,
          line: promiseLine,
          kind: "await-new-promise-once",
          snippet: rawLines[promiseLine - 1].trim(),
        });
      }
    }
  }

  return hits.sort((a, b) => a.line - b.line);
}

function collectTestMjsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "fixtures") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestMjsFiles(full));
    } else if (entry.name.endsWith(".mjs")) {
      files.push(full);
    }
  }
  return files.sort();
}

test("A.1 scanner catches direct await once / events.once / await new Promise(.once) and ignores armed-first or comments", () => {
  const badDirect = `
    worker.postMessage("release");
    await released;
    await once(worker, "exit");
  `;
  assert.deepEqual(
    scanDirectOnceAwaits(badDirect, "bad-direct.mjs").map(({ line, kind }) => ({ line, kind })),
    [{ line: 4, kind: "await-once" }],
  );

  const badEventsOnce = `
    server.kill("SIGTERM");
    await events.once(server, "exit");
  `;
  assert.deepEqual(
    scanDirectOnceAwaits(badEventsOnce, "bad-events.mjs").map(({ line, kind }) => ({ line, kind })),
    [{ line: 3, kind: "await-once" }],
  );

  const badInlinePromise = `
    const exit = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  `;
  assert.deepEqual(
    scanDirectOnceAwaits(badInlinePromise, "bad-inline-promise.mjs").map(({ line, kind }) => ({ line, kind })),
    [{ line: 2, kind: "await-new-promise-once" }],
  );

  const badMultilinePromise = `
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
  `;
  assert.deepEqual(
    scanDirectOnceAwaits(badMultilinePromise, "bad-multiline-promise.mjs").map(({ line, kind }) => ({ line, kind })),
    [{ line: 2, kind: "await-new-promise-once" }],
  );

  const goodArmedAndComments = `
    // Never write await once(worker, "exit") after await released!
    /* await events.once(server, "exit")
       await new Promise((r) => child.once("exit", r)) */
    const msg = "await once(worker, 'exit')";
    const exited = once(worker, "exit");
    worker.postMessage("release");
    await released;
    await exited;

    const childDone = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await childDone;

    // Trigger is inside the Promise executor, after the error listener is armed:
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  `;
  assert.deepEqual(scanDirectOnceAwaits(goodArmedAndComments, "good.mjs"), []);
});

test("A.1 every test/**/*.mjs arms one-shot listeners before awaiting (no direct await once)", () => {
  const violations = [];
  for (const file of collectTestMjsFiles(testDir)) {
    const source = readFileSync(file, "utf8");
    const displayPath = relative(rootDir, file);
    violations.push(...scanDirectOnceAwaits(source, displayPath));
  }
  assert.deepEqual(
    violations,
    [],
    [
      "Found direct await on a one-shot event listener (late arming can miss the event on slow runners; see commit ba57ab8):",
      ...violations.map((v) => `  - ${v.file}:${v.line} [${v.kind}] ${v.snippet}`),
      "Fix: arm the listener BEFORE triggering the action and before any other await:",
      '  const exited = once(worker, "exit");',
      '  worker.postMessage("release");',
      "  await released;",
      "  await exited;",
    ].join("\n"),
  );
});

test("A.2 options page suite passes with MOSA_TEST_ASYNC_JITTER_MS=30 and settle() quiet verification", async () => {
  const childEnv = { ...process.env, MOSA_TEST_ASYNC_JITTER_MS: "30" };
  delete childEnv.NODE_TEST_CONTEXT;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--test", "--import", "./test/clean-test-env.mjs", "test/web-capture-options-page.test.mjs"],
    {
      cwd: rootDir,
      env: childEnv,
      timeout: 60_000,
    },
  );
  assert.match(stdout, /# pass 10\b|ℹ pass 10\b/, `expected all 10 options-page tests to pass under jitter:\n${stdout}\n${stderr}`);
  assert.match(stdout, /# fail 0\b|ℹ fail 0\b/, `expected 0 failures under jitter:\n${stdout}\n${stderr}`);
});
