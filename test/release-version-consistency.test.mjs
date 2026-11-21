import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Task 437: every mechanical version spot bumped by release:prepare must
// already agree in a checkout. App version lives in package.json; extension
// version lives in the capture manifest; everything else follows.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(join(REPO_ROOT, relative), "utf8");

test("app version spots agree with package.json", async () => {
  const appVersion = JSON.parse(await read("package.json")).version;

  const lock = await read("package-lock.json");
  const lockSpots = [...lock.matchAll(/"name": "mosa",\n( *)"version": "([^"]+)",/g)];
  assert.equal(
    lockSpots.length,
    2,
    `package-lock.json: expected exactly 2 "mosa" version blocks, found ${lockSpots.length}`,
  );
  for (const spot of lockSpots) {
    assert.equal(spot[2], appVersion, `package-lock.json: expected version ${appVersion}, found ${spot[2]}`);
  }

  const mcpVersion = JSON.parse(await read("packages/gravityport-mcp/package.json")).version;
  assert.equal(
    mcpVersion,
    appVersion,
    `packages/gravityport-mcp/package.json: expected version ${appVersion}, found ${mcpVersion}`,
  );

  const bugTemplate = await read(".github/ISSUE_TEMPLATE/bug_report.yml");
  assert.ok(
    bugTemplate.includes(`placeholder: ${appVersion} or commit SHA`),
    `.github/ISSUE_TEMPLATE/bug_report.yml: expected "placeholder: ${appVersion} or commit SHA", found none`,
  );

  const notes = JSON.parse(await read("release-notes.json"));
  const latest = Array.isArray(notes.releases) && notes.releases.length > 0 ? notes.releases[0] : null;
  assert.ok(
    latest,
    "release-notes.json: expected at least one entry under releases",
  );
  assert.equal(
    latest.version,
    appVersion,
    `release-notes.json: expected latest release ${appVersion}, found ${latest.version}`,
  );

  const updateTest = await read("test/update-service.test.mjs");
  assert.ok(
    updateTest.includes(`compareVersions("${appVersion}",`),
    `test/update-service.test.mjs: expected a compareVersions("${appVersion}", ...) assertion, found none`,
  );
});

test("extension version spots agree with manifest.json", async () => {
  const extVersion = JSON.parse(await read("extensions/chatgpt-web-capture/manifest.json")).version;

  const readme = await read("extensions/chatgpt-web-capture/README.md");
  assert.ok(
    readme.includes(`GravityPort Web Capture（${extVersion}）`),
    `extensions/chatgpt-web-capture/README.md: expected title version （${extVersion}）, found none`,
  );

  for (const relative of ["test/chatgpt-web-capture-hook.test.mjs", "test/web-capture-jimeng-midjourney.test.mjs"]) {
    const text = await read(relative);
    const asserted = [...text.matchAll(/manifest\.version, "([^"]+)"/g)].map((match) => match[1]);
    assert.ok(
      asserted.length > 0,
      `${relative}: expected at least one manifest.version assertion, found none`,
    );
    for (const found of asserted) {
      assert.equal(found, extVersion, `${relative}: expected manifest.version ${extVersion}, found ${found}`);
    }
  }

  const jimengTest = await read("test/web-capture-jimeng-midjourney.test.mjs");
  const titleMatch = jimengTest.match(/manifest declares the two new sites, their CDNs, and (\d+\.\d+\.\d+)"/);
  assert.ok(
    titleMatch,
    "test/web-capture-jimeng-midjourney.test.mjs: expected the manifest test title to carry a version",
  );
  assert.equal(
    titleMatch[1],
    extVersion,
    `test/web-capture-jimeng-midjourney.test.mjs: expected test title version ${extVersion}, found ${titleMatch[1]}`,
  );
});
