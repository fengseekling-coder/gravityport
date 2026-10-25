import assert from "node:assert/strict";
import { test } from "node:test";

import { clipboardImportable, MEDIA_IMPORT_EXTENSIONS, parseMacFilenamesPlist } from "../desktop/clipboard-importable.mjs";
import { SUPPORTED_MEDIA_EXTENSIONS } from "../lib/asset-store.mjs";
import { macFilenamesPlist } from "../desktop/clipboard-files.mjs";

// Fake Electron clipboard: only the four methods the real module may call.
const fakeClipboard = ({
  formats = [],
  plist = "",
  fileUrl = "",
  imageEmpty = true,
  throwOn = {},
} = {}) => ({
  read: (format) => {
    if (throwOn.read) throw new Error("read failed");
    if (format === "NSFilenamesPboardType") return plist;
    if (format === "public.file-url") return fileUrl;
    return "";
  },
  readImage: () => {
    if (throwOn.readImage) throw new Error("readImage failed");
    return { isEmpty: () => imageEmpty };
  },
  availableFormats: () => {
    if (throwOn.availableFormats) throw new Error("availableFormats failed");
    return formats;
  },
  has: (format) => formats.includes(format),
});

test("extensions mirror lib/asset-store.mjs exactly", () => {
  assert.deepEqual([...MEDIA_IMPORT_EXTENSIONS].sort(), SUPPORTED_MEDIA_EXTENSIONS);
});

test("macOS plist round-trips Finder-style paths (&, spaces, CJK)", () => {
  const paths = ["/lib/链接 & 测试.webloc", "/tmp/a b&<c>.png"];
  assert.deepEqual(parseMacFilenamesPlist(macFilenamesPlist(paths)), paths);
});

test("macOS plist unescapes XML entities without re-decoding", () => {
  // "&amp;lt;" is the literal text "&lt;": one pass, not a double decode.
  const xml = '<plist version="1.0"><array><string>/lib/a&amp;lt;b &#x4E2D;文.png</string></array></plist>';
  assert.deepEqual(parseMacFilenamesPlist(xml), ["/lib/a&lt;b 中文.png"]);
});

test("malformed plist data yields an empty list, never a throw", () => {
  assert.deepEqual(parseMacFilenamesPlist(""), []);
  assert.deepEqual(parseMacFilenamesPlist(null), []);
  assert.deepEqual(parseMacFilenamesPlist("<plist><array><string>unclosed"), []);
});

const weblocOnly = { plist: macFilenamesPlist(["/tmp/链接 & 测试.webloc"]), imageEmpty: true };
const notesOnly = { plist: macFilenamesPlist(["/tmp/notes.txt"]), imageEmpty: true };
const folderOnly = { plist: macFilenamesPlist(["/tmp/Some Folder"]), imageEmpty: true };

test("macOS non-media files are not importable", () => {
  assert.equal(clipboardImportable({ platform: "darwin", clipboard: fakeClipboard(weblocOnly) }), false);
  assert.equal(clipboardImportable({ platform: "darwin", clipboard: fakeClipboard(notesOnly) }), false);
  assert.equal(clipboardImportable({ platform: "darwin", clipboard: fakeClipboard(folderOnly) }), false);
});

test("macOS file copies with an icon TIFF still judge by extension, not readImage", () => {
  // Finder puts the file's icon on the clipboard: readImage() is non-empty
  // for every file copy and must not flip the decision.
  const withIcon = (base) => ({ ...base, imageEmpty: false });
  assert.equal(clipboardImportable({ platform: "darwin", clipboard: fakeClipboard(withIcon(weblocOnly)) }), false);
  assert.equal(clipboardImportable({ platform: "darwin", clipboard: fakeClipboard(withIcon(notesOnly)) }), false);
  assert.equal(clipboardImportable({ platform: "darwin", clipboard: fakeClipboard(withIcon(folderOnly)) }), false);
});

test("macOS mixed copy is importable when one file is media (case-insensitive)", () => {
  const clipboard = fakeClipboard({
    plist: macFilenamesPlist(["/tmp/notes.txt", "/tmp/b.PNG", "/tmp/c.mov"]),
    imageEmpty: false,
  });
  assert.equal(clipboardImportable({ platform: "darwin", clipboard }), true);
});

test("macOS falls back to public.file-url when the plist is unreadable", () => {
  const base = { plist: "", imageEmpty: true };
  assert.equal(
    clipboardImportable({ platform: "darwin", clipboard: fakeClipboard({ ...base, fileUrl: "file:///tmp/x.png" }) }),
    true,
  );
  assert.equal(
    clipboardImportable({ platform: "darwin", clipboard: fakeClipboard({ ...base, fileUrl: "file:///tmp/x.webloc" }) }),
    false,
  );
  assert.equal(
    clipboardImportable({ platform: "darwin", clipboard: fakeClipboard({ ...base, fileUrl: "file:///tmp/some%20folder/x.PNG" }) }),
    true,
  );
  // A non-file URL is no file list: fall through to the image check.
  assert.equal(
    clipboardImportable({ platform: "darwin", clipboard: fakeClipboard({ ...base, fileUrl: "https://example.com/x.png" }) }),
    false,
  );
});

test("macOS raw image data stays importable without files", () => {
  assert.equal(clipboardImportable({ platform: "darwin", clipboard: fakeClipboard({ imageEmpty: false }) }), true);
});

test("macOS text, HTML and copied links offer no paste", () => {
  const clipboard = fakeClipboard({
    formats: ["text/plain", "text/html", "public.url"],
    fileUrl: "",
    imageEmpty: true,
  });
  assert.equal(clipboardImportable({ platform: "darwin", clipboard }), false);
});

test("clipboard read failures mean not importable", () => {
  assert.equal(
    clipboardImportable({ platform: "darwin", clipboard: fakeClipboard({ throwOn: { readImage: true }, imageEmpty: false }) }),
    false,
  );
  assert.equal(
    clipboardImportable({ platform: "darwin", clipboard: fakeClipboard({ throwOn: { read: true }, imageEmpty: false }) }),
    false,
  );
});

test("Windows keeps the pre-245 behavior", () => {
  // First-file-only exposure: formats and FileNameW decide, never extensions.
  assert.equal(
    clipboardImportable({ platform: "win32", clipboard: fakeClipboard({ formats: ["FileNameW"], imageEmpty: true }) }),
    true,
  );
  assert.equal(
    clipboardImportable({ platform: "win32", clipboard: fakeClipboard({ formats: [], imageEmpty: false }) }),
    true,
  );
  assert.equal(
    clipboardImportable({ platform: "win32", clipboard: fakeClipboard({ formats: ["text/uri-list"], imageEmpty: true }) }),
    true,
  );
  // CF_HDROP arrives only through has() on some shells.
  assert.equal(
    clipboardImportable({
      platform: "win32",
      clipboard: { ...fakeClipboard({ formats: [], imageEmpty: true }), has: (format) => format === "FileNameW" },
    }),
    true,
  );
  assert.equal(
    clipboardImportable({ platform: "win32", clipboard: fakeClipboard({ formats: [], imageEmpty: true }) }),
    false,
  );
  assert.equal(
    clipboardImportable({ platform: "win32", clipboard: fakeClipboard({ throwOn: { availableFormats: true }, imageEmpty: true }) }),
    false,
  );
});
