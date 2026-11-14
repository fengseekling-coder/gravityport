// Task 416 (audit 低12 ②): a full disk during an import is a named outcome.
// The staging layer maps raw ENOSPC to the ImportStagingError code DISK_FULL,
// the import routes answer 507 with that code (staging route) or report it per
// item (import-batch), and a failed write never leaves a partial staging file.
// The fs failures are injected through the node:fs / node:fs/promises DEFAULT
// export objects — lib/import-staging.mjs calls through those (property lookup
// at call time), the same convention lib/reference-attachment-store.ts uses.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { handleAssetRoute } from "../lib/api/asset-routes.mjs";
import { importStagingDir, stageFileForImport, stageReadableForImport, writeStagedPng } from "../lib/import-staging.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

function enospcError() {
  const error = new Error("no space left on device (simulated)");
  error.code = "ENOSPC";
  return error;
}

async function makeWorkspace(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  return dir;
}

async function assertStagingRootEmpty(stagingRoot) {
  assert.deepEqual(await readdir(stagingRoot), [], "a failed staging write must not leave a partial file");
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    writableEnded: false,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(body) { this.body = body; this.writableEnded = true; },
  };
}

function fakeStoreFor(assetsRoot) {
  const enospc = enospcError();
  return {
    assetsRoot,
    createAsset: async () => { throw enospc; },
  };
}

async function callRoute(urlPath, { method = "POST", req, context }) {
  req.method = req.method || method;
  const res = fakeRes();
  const handled = await handleAssetRoute({
    req,
    res,
    url: new URL(`http://127.0.0.1${urlPath}`),
    context: { derivativeWorker: { wake() {} }, ...context },
  });
  assert.equal(handled, true, `route ${urlPath} must handle the request`);
  return res;
}

// ── staging layer: ENOSPC becomes DISK_FULL and leaves no partial file ────────

test("staging a file onto a full disk rejects with DISK_FULL and cleans up", async (t) => {
  const dir = await makeWorkspace(t, "mosa-diskfull-copy-");
  const stagingRoot = importStagingDir(join(dir, "userData"));
  const sourcePath = join(dir, "original.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);

  const brokenCopy = t.mock.method(fsPromises, "copyFile", async () => { throw enospcError(); });
  await assert.rejects(
    () => stageFileForImport({ sourcePath, stagingRoot }),
    (error) => {
      assert.equal(error.code, "DISK_FULL");
      assert.equal(error.name, "ImportStagingError");
      return true;
    },
  );
  assert.equal(brokenCopy.mock.callCount(), 1, "the simulated ENOSPC copy was actually used");
  await assertStagingRootEmpty(stagingRoot);
});

test("streaming an upload onto a full disk rejects with DISK_FULL and cleans up", async (t) => {
  const dir = await makeWorkspace(t, "mosa-diskfull-stream-");
  const stagingRoot = importStagingDir(join(dir, "userData"));

  const failingStream = () => new Writable({
    write(_chunk, _encoding, callback) { callback(enospcError()); },
  });
  const brokenStream = t.mock.method(fs, "createWriteStream", failingStream);
  await assert.rejects(
    () => stageReadableForImport({ readable: Readable.from([ONE_PIXEL_PNG]), fileName: "picked.png", stagingRoot }),
    (error) => {
      assert.equal(error.code, "DISK_FULL");
      assert.equal(error.name, "ImportStagingError");
      return true;
    },
  );
  assert.equal(brokenStream.mock.callCount(), 1, "the simulated ENOSPC stream was actually used");
  await assertStagingRootEmpty(stagingRoot);
});

test("a pasted image onto a full disk rejects with DISK_FULL and cleans up", async (t) => {
  const dir = await makeWorkspace(t, "mosa-diskfull-paste-");
  const stagingRoot = importStagingDir(join(dir, "userData"));

  const brokenWrite = t.mock.method(fsPromises, "writeFile", async () => { throw enospcError(); });
  await assert.rejects(
    () => writeStagedPng(stagingRoot, ONE_PIXEL_PNG),
    (error) => {
      assert.equal(error.code, "DISK_FULL");
      assert.equal(error.name, "ImportStagingError");
      return true;
    },
  );
  assert.equal(brokenWrite.mock.callCount(), 1, "the simulated ENOSPC write was actually used");
  await assertStagingRootEmpty(stagingRoot);
});

// ── route layer: 507 + code for staging, per-item code for import-batch ──────

test("the staging route answers 507 DISK_FULL when the disk is full", async (t) => {
  const dir = await makeWorkspace(t, "mosa-diskfull-route-");
  const stagingRoot = importStagingDir(join(dir, "assets"));

  t.mock.method(fs, "createWriteStream", () => new Writable({
    write(_chunk, _encoding, callback) { callback(enospcError()); },
  }));
  const req = Readable.from([ONE_PIXEL_PNG]);
  req.headers = { "x-mosa-file-name": "picked.png" };
  const res = await callRoute("/api/import/stage", { req, context: { store: fakeStoreFor(join(dir, "assets")) } });
  assert.equal(res.statusCode, 507);
  const body = JSON.parse(res.body);
  assert.equal(body.code, "DISK_FULL");
  assert.match(body.error, /disk is full/);
  await assertStagingRootEmpty(stagingRoot);
});

test("import-batch reports DISK_FULL per item when the library copy hits a full disk", async (t) => {
  const dir = await makeWorkspace(t, "mosa-diskfull-batch-");
  const res = await callRoute("/api/assets/import-batch", {
    req: Readable.from([Buffer.from(JSON.stringify({
      projectId: "default",
      items: [{ imagePath: join(dir, "staged.png"), fileName: "staged.png" }],
    }))]),
    context: { store: fakeStoreFor(join(dir, "assets")) },
  });
  assert.equal(res.statusCode, 200, "the batch envelope keeps its contract");
  const body = JSON.parse(res.body);
  assert.equal(body.failed, 1);
  assert.equal(body.results[0].code, "DISK_FULL");
});

test("the single create route answers 507 DISK_FULL when the library copy hits a full disk", async (t) => {
  const dir = await makeWorkspace(t, "mosa-diskfull-create-");
  // The create route throws the HttpError; the runtime's top-level boundary
  // (mosa-runtime.mjs) turns statusCode + code into the 507 JSON response —
  // here the thrown shape itself is the contract.
  await assert.rejects(
    () => callRoute("/api/assets/create", {
      req: Readable.from([Buffer.from(JSON.stringify({ projectId: "default", imagePath: join(dir, "staged.png") }))]),
      context: { store: fakeStoreFor(join(dir, "assets")) },
    }),
    (error) => {
      assert.equal(error.statusCode, 507);
      assert.equal(error.code, "DISK_FULL");
      return true;
    },
  );
});
