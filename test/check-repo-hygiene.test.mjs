import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOW_FILE,
  MAX_FILE_BYTES,
  MEDIA_ALLOWED_PATHS,
  checkPath,
  collectFindings,
  parseAllowList,
  scanText,
} from "../scripts/check-repo-hygiene.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/check-repo-hygiene.mjs", import.meta.url));

// A hook or CI runner may export GIT_* variables that would point the temp repos below at the wrong index.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

// Every secret-looking or path-looking value is assembled here from pieces, so this
// file never contains a literal that the hygiene check would flag in itself.
const REAL_NAME = "dana-r";
const posixHome = (name) => ["", "Users", name, "project"].join("/");
const windowsHome = (name, separator = "\\") => ["C:", "Users", name, "project"].join(separator);
const githubToken = () => ["ghp", "_", "aB3dE5fG7h".repeat(4)].join("");
const githubFineGrainedToken = () => ["github", "_pat_", "11AB3dE5f0".repeat(3)].join("");
const awsKeyId = () => ["AKIA", "ABCDEFGH12345678"].join("");
const slackToken = () => ["xox", "b-", "1234567890-abcdefghij"].join("");
const openAiKey = () => ["sk", "-", "proj-aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY"].join("");
const privateKeyHeader = () => ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].join("");
const randomLiteral = () => "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW";
const assignment = (name, value) => `${name} = "${value}"`;

const rules = (findings) => [...new Set(findings.map((finding) => finding.rule))];
const imageDirectory = MEDIA_ALLOWED_PATHS.find((entry) => entry.endsWith("/"));

test("secrets: each common format and long literal assignments are flagged", () => {
  const samples = [
    githubToken(),
    githubFineGrainedToken(),
    awsKeyId(),
    slackToken(),
    openAiKey(),
    privateKeyHeader(),
    assignment("api_key", randomLiteral()),
    assignment("clientSecret", randomLiteral()),
    `{"password": "${randomLiteral()}"}`,
    `TOKEN: '${randomLiteral()}'`,
  ];
  for (const sample of samples) {
    const findings = scanText(`first line\nconst x = ${sample};\n`);
    assert.deepEqual(rules(findings), ["secret"], `expected a secret hit for sample ${samples.indexOf(sample)}`);
    assert.equal(findings[0].line, 2);
  }
});

test("secrets: findings never carry the matched value", () => {
  const findings = scanText([githubToken(), assignment("token", randomLiteral()), posixHome(REAL_NAME)].join("\n"));
  assert.equal(findings.length, 3);
  const printed = JSON.stringify(findings);
  for (const value of [githubToken(), randomLiteral(), REAL_NAME]) assert.ok(!printed.includes(value));
});

test("secrets: placeholders, short values and made-up names pass", () => {
  const clean = [
    `token = "<your-token>"`,
    `const token = process.env.GRAVITYPORT_TOKEN;`,
    `password: "hunter2"`,
    assignment("api_key", "x".repeat(32)),
    assignment("secret", "your-secret-goes-here-0123456789"),
    assignment("CLIENT_TOKEN", "mosa_e2e_client_token_abcdefghijklmnop"),
    `Authorization: "Bearer ${"${token}"}"`,
    `// sk-some-long-feature-name-without-any-digits-at-all`,
    "AKIA is the prefix of an AWS access key id",
    "-----BEGIN PUBLIC KEY-----",
  ];
  for (const line of clean) assert.deepEqual(scanText(line), [], line);
});

test("private paths: a real user name is flagged on both platforms", () => {
  const lines = [
    `open("${posixHome(REAL_NAME)}")`,
    `file://${posixHome(REAL_NAME)}`,
    windowsHome(REAL_NAME),
    windowsHome(REAL_NAME, "/"),
    windowsHome(REAL_NAME, "\\\\"),
    windowsHome(REAL_NAME).toLowerCase(),
  ];
  for (const line of lines) assert.deepEqual(rules(scanText(line)), ["private-path"], line);
});

test("private paths: placeholder spellings pass", () => {
  const clean = [
    "/Users/<name>/project",
    "/Users/${USER}/project",
    "$HOME/project",
    "~/project",
    posixHome("example"),
    posixHome("Alice"),
    posixHome("Shared"),
    posixHome("a"),
    windowsHome("<name>"),
    windowsHome("Example"),
    windowsHome("Public"),
    `https://api.example.com${posixHome(REAL_NAME)}`,
    "/Users/ is the macOS home folder",
  ];
  for (const line of clean) assert.deepEqual(scanText(line), [], line);
});

test("working documents: handover, task, promo, env and log paths are flagged", () => {
  const flagged = [
    "交接/2026-11-03.md",
    "docs/任务单-349.md",
    "docs/任务书.md",
    "tasks/349.md",
    "docs/tasks/349.md",
    "宣传/稿子.md",
    ".env",
    "server/.env.local",
    "prod.env",
    "debug.log",
    "logs/Run.LOG",
  ];
  for (const path of flagged) assert.deepEqual(rules(checkPath(path)), ["work-doc"], path);
});

test("working documents: ordinary source, env templates and look-alike names pass", () => {
  const clean = [
    "lib/tasks.mjs",
    "src/subtasks/list.mjs",
    "docs/environment.md",
    "config/.env.example",
    ".env.sample",
    "docs/operations.md",
    "README.md",
    "catalog.js",
  ];
  for (const path of clean) assert.deepEqual(checkPath(path), [], path);
});

test("big files: only files above the limit are flagged", () => {
  assert.equal(MAX_FILE_BYTES, 5 * 1024 * 1024);
  assert.deepEqual(rules(checkPath("data/blob.bin", MAX_FILE_BYTES + 1)), ["big-file"]);
  assert.deepEqual(checkPath("data/blob.bin", MAX_FILE_BYTES), []);
  assert.deepEqual(checkPath("data/blob.bin", 1024), []);
});

test("media: images and video outside the allowed folders are flagged", () => {
  for (const path of ["src/shot.png", "a/b/photo.JPG", "clip.mov", "x/y.webp", "anim.gif", "movie.mp4", "photo.jpeg"]) {
    assert.deepEqual(rules(checkPath(path)), ["media"], path);
  }
  for (const entry of MEDIA_ALLOWED_PATHS) {
    const inside = entry.endsWith("/") ? `${entry}nested/shot.png` : entry;
    assert.deepEqual(checkPath(inside), [], inside);
  }
  assert.deepEqual(checkPath("src/logo.svg"), []);
  assert.deepEqual(checkPath("src/notes.png.md"), []);
});

test("allow list: path and reason forms parse, bad lines are rejected", () => {
  const entries = parseAllowList([
    "# comment",
    "",
    "a/b.txt | fixture data",
    "dir/ | secret, private-path | made-up values for a parser test",
    "c.txt | * | everything, with a | in the reason",
  ].join("\n"));
  assert.deepEqual(entries, [
    { path: "a/b.txt", rules: ["*"], reason: "fixture data" },
    { path: "dir/", rules: ["secret", "private-path"], reason: "made-up values for a parser test" },
    { path: "c.txt", rules: ["*"], reason: "everything, with a | in the reason" },
  ]);
  assert.throws(() => parseAllowList("a/b.txt"), /expected "path \| reason"/);
  assert.throws(() => parseAllowList("a/b.txt |  "), /needs a reason/);
  assert.throws(() => parseAllowList("a/b.txt | secret | "), /needs a reason/);
  assert.throws(() => parseAllowList("a/b.txt | passwords | why"), /unknown rule passwords/);
});

function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "repo-hygiene-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFiles(root, files);
  return root;
}

function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function stage(root, ...paths) {
  execFileSync("git", ["add", "--", ...paths], { cwd: root });
}

function withRepo(files, body) {
  const root = makeRepo(files);
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const describeFindings = (findings) => findings.map(({ path, line, rule }) => `${path}:${line}:${rule}`);

test("repository scan: every rule fires on tracked files, clean files stay quiet", () => {
  withRepo({
    "src/ok.mjs": "export const ok = 1;\n",
    "src/key.mjs": `const line = 1;\nconst value = "${githubToken()}";\n`,
    "src/home.mjs": `const dir = "${posixHome(REAL_NAME)}";\n`,
    "交接/notes.md": "plain text\n",
    "src/big.bin": Buffer.alloc(MAX_FILE_BYTES + 1, 0x61),
    "src/shot.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    [`${imageDirectory}shot.png`]: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  }, (root) => {
    stage(root, ".");
    assert.deepEqual(describeFindings(collectFindings({ root })), [
      "src/big.bin:0:big-file",
      "src/home.mjs:1:private-path",
      "src/key.mjs:2:secret",
      "src/shot.png:0:media",
      "交接/notes.md:0:work-doc",
    ]);
  });
});

test("repository scan: --staged looks only at staged files, not unstaged or untracked ones", () => {
  withRepo({
    "src/ok.mjs": "export const ok = 1;\n",
    "src/staged.mjs": `const dir = "${posixHome(REAL_NAME)}";\n`,
    "src/unstaged.mjs": "export const fine = 1;\n",
  }, (root) => {
    stage(root, "src/ok.mjs", "src/staged.mjs", "src/unstaged.mjs");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base", "--no-verify"], { cwd: root });
    writeFiles(root, {
      "src/unstaged.mjs": `const dir = "${posixHome(REAL_NAME)}";\n`,
      "src/untracked.mjs": `const dir = "${posixHome(REAL_NAME)}";\n`,
      "src/ok.mjs": "export const ok = 2;\n",
    });
    stage(root, "src/ok.mjs");
    assert.deepEqual(collectFindings({ root, staged: true }), []);

    writeFiles(root, { "src/ok.mjs": `export const ok = "${githubToken()}";\n` });
    stage(root, "src/ok.mjs");
    assert.deepEqual(describeFindings(collectFindings({ root, staged: true })), ["src/ok.mjs:1:secret"]);
    // The full scan reads what git tracks, which now includes the committed bad file too.
    assert.deepEqual(describeFindings(collectFindings({ root })), ["src/ok.mjs:1:secret", "src/staged.mjs:1:private-path"]);
  });
});

test("repository scan: the allow list silences only the named path and rule", () => {
  withRepo({
    "fixtures/fake.txt": `${privateKeyHeader()}\n${posixHome(REAL_NAME)}\n`,
    "fixtures/other.txt": `${privateKeyHeader()}\n`,
    "logs/debug.log": "line\n",
    [ALLOW_FILE]: [
      "fixtures/fake.txt | secret | fake key used by a parser test",
      "logs/ | everything under logs is a test fixture",
    ].join("\n"),
  }, (root) => {
    stage(root, ".");
    assert.deepEqual(describeFindings(collectFindings({ root })), [
      "fixtures/fake.txt:2:private-path",
      "fixtures/other.txt:1:secret",
    ]);
  });
});

test("repository scan: binary files are not scanned as text", () => {
  withRepo({
    "data/blob.dat": Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(githubToken())]),
  }, (root) => {
    stage(root, ".");
    assert.deepEqual(collectFindings({ root }), []);
  });
});

function runScript(cwd, ...args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("command line: exits 1 with file and line but without the secret, then 0 once it is fixed", () => {
  withRepo({
    "src/key.mjs": `const a = 1;\nconst value = "${githubToken()}";\n`,
    "src/home.mjs": `const dir = "${posixHome(REAL_NAME)}";\n`,
  }, (root) => {
    stage(root, ".");
    const blocked = runScript(root, "--staged");
    assert.equal(blocked.status, 1);
    assert.match(blocked.output, /src\/key\.mjs:2 {2}\[secret\]/);
    assert.match(blocked.output, /src\/home\.mjs:1 {2}\[private-path\]/);
    assert.match(blocked.output, /How to fix/);
    for (const value of [githubToken(), REAL_NAME]) assert.ok(!blocked.output.includes(value));

    assert.equal(runScript(root).status, 1);

    writeFiles(root, { "src/key.mjs": "const value = process.env.TOKEN;\n", "src/home.mjs": "const dir = \"~/project\";\n" });
    stage(root, ".");
    const clean = runScript(root, "--staged");
    assert.equal(clean.status, 0);
    assert.match(clean.output, /passed/);
  });
});

test("command line: a staged 6 MB file and a staged private path are both blocked", () => {
  withRepo({
    "note.txt": `${posixHome(REAL_NAME)}\n`,
    "big.bin": Buffer.alloc(6 * 1024 * 1024, 0x61),
  }, (root) => {
    stage(root, ".");
    const blocked = runScript(root, "--staged");
    assert.equal(blocked.status, 1);
    assert.match(blocked.output, /big\.bin {2}\[big-file\]/);
    assert.match(blocked.output, /note\.txt:1 {2}\[private-path\]/);
  });
});

test("command line: bad arguments and non-git folders exit 2", () => {
  const folder = mkdtempSync(join(tmpdir(), "repo-hygiene-plain-"));
  try {
    assert.equal(runScript(folder, "--nonsense").status, 2);
    const outside = runScript(folder, "--staged");
    assert.equal(outside.status, 2);
    assert.match(outside.output, /could not run/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
