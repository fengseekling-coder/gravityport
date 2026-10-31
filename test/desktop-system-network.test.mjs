// Every request the desktop main process sends to our server (update check,
// update downloads, daily usage report) must go through Chromium's network
// stack. Node's fetch ignores the system proxy, so machines that only reach the
// server through one could neither update nor be counted (the usage report was
// left on Node's fetch until this test existed).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const mainSource = readFileSync(resolve(import.meta.dirname, "..", "desktop", "main.mjs"), "utf8");
const NETWORK_CALLS = ["checkForMosaUpdate", "downloadMacosUpdate", "downloadWindowsUpdate", "reportAnonymousUsage"];

// The argument text of each call: from "name({" to the first "})" after it.
function callArguments(name) {
  const calls = [];
  const pattern = new RegExp(`\\b${name}\\(\\{`, "g");
  for (const match of mainSource.matchAll(pattern)) {
    const end = mainSource.indexOf("})", match.index);
    calls.push(mainSource.slice(match.index, end === -1 ? undefined : end));
  }
  return calls;
}

test("systemNetworkFetch is Electron's net.fetch", () => {
  assert.match(mainSource, /function systemNetworkFetch\(url, init\) \{\s*return net\.fetch\(url, init\);\s*\}/);
});

for (const name of NETWORK_CALLS) {
  test(`every ${name} call in the main process uses the system network`, () => {
    const calls = callArguments(name);
    assert.ok(calls.length > 0, `${name} is called from desktop/main.mjs`);
    for (const call of calls) {
      assert.match(call, /fetchImpl: systemNetworkFetch\b/, `${name} call without fetchImpl: systemNetworkFetch:\n${call}`);
    }
  });
}
