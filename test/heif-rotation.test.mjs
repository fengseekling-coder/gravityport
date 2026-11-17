// Task 424: heifPrimaryRotation reads the primary item's irot angle straight
// out of HEIF box bytes, so the sips dimension fallback can return the upright
// ratio for files whose rotation is not in EXIF. The fixtures below are
// hand-assembled input bytes (never a copy of the parser); the tests import
// the real lib module, so they run on every platform without sips.
import assert from "node:assert/strict";
import { test } from "node:test";

import { heifPrimaryRotation } from "../lib/sips-image-support.mjs";

function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
}

function fullBox(type, version, flags, payload) {
  const header = Buffer.alloc(4);
  header.writeUInt8(version, 0);
  header.writeUIntBE(flags, 1, 3);
  return box(type, Buffer.concat([header, payload]));
}

function itemId(id, version) {
  const bytes = Buffer.alloc(version === 0 ? 2 : 4);
  bytes.writeUIntBE(id, 0, bytes.length);
  return bytes;
}

function ispeBox(width, height) {
  const payload = Buffer.alloc(12);
  payload.writeUInt32BE(width, 4);
  payload.writeUInt32BE(height, 8);
  return box("ispe", payload);
}

function irotBox(angle) {
  return box("irot", Buffer.from([angle & 0x03]));
}

const FTYP = box("ftyp", Buffer.concat([Buffer.from("heic", "latin1"), Buffer.alloc(4)]));

/**
 * ftyp + meta(pitm → iprp(ipco, ipma)) laid out the way ImageIO writes still
 * images: item ids and association widths follow the version/flags rules of
 * ISO/IEC 14496-12. `entries` are the ipma rows, `indices` the 1-based ipco
 * property numbers — with the essential high bit set per association width:
 * 0x80 | n in the 1-byte form, 0x8000 | n in the 2-byte form.
 */
function makeHeifBytes({ primaryVersion = 0, primaryId = 1, properties, ipmaVersion = 0, ipmaFlags = 0, entries }) {
  const ipco = box("ipco", Buffer.concat(properties));
  const associationWidth = (ipmaFlags & 1) === 1 ? 2 : 1;
  const entryBuffers = entries.map((entry) => {
    const associations = Buffer.alloc(entry.indices.length * associationWidth);
    entry.indices.forEach((index, position) => {
      if (associationWidth === 2) associations.writeUIntBE(index, position * 2, 2);
      else associations.writeUInt8(index, position);
    });
    return Buffer.concat([itemId(entry.id, ipmaVersion), Buffer.from([entry.indices.length]), associations]);
  });
  const entryCount = Buffer.alloc(4);
  entryCount.writeUInt32BE(entries.length, 0);
  const ipma = fullBox("ipma", ipmaVersion, ipmaFlags, Buffer.concat([entryCount, ...entryBuffers]));
  const iprp = box("iprp", Buffer.concat([ipco, ipma]));
  const pitm = fullBox("pitm", primaryVersion, 0, itemId(primaryId, primaryVersion));
  const meta = fullBox("meta", 0, 0, Buffer.concat([pitm, iprp]));
  return Buffer.concat([FTYP, meta]);
}

test("the primary item's irot angle comes back as-is", () => {
  const base = { properties: [ispeBox(600, 400), irotBox(3)], entries: [{ id: 1, indices: [1, 0x80 | 2] }] };
  assert.equal(heifPrimaryRotation(makeHeifBytes(base)), 3);
  assert.equal(heifPrimaryRotation(makeHeifBytes({ ...base, properties: [ispeBox(600, 400), irotBox(1)] })), 1);
  assert.equal(heifPrimaryRotation(makeHeifBytes({ ...base, properties: [ispeBox(600, 400), irotBox(2)] })), 2);
});

test("no irot in ipco, or none associated with the primary item, reads as 0", () => {
  // ipco holds only an ispe and the primary item associates just that.
  assert.equal(heifPrimaryRotation(makeHeifBytes({
    properties: [ispeBox(600, 400)],
    entries: [{ id: 1, indices: [1] }],
  })), 0);
  // The irot is associated with item 2 while the primary item is item 1.
  assert.equal(heifPrimaryRotation(makeHeifBytes({
    properties: [ispeBox(600, 400), irotBox(3)],
    entries: [{ id: 2, indices: [1, 0x80 | 2] }],
  })), 0);
});

test("version 1 item ids and 2-byte associations parse the same way", () => {
  assert.equal(heifPrimaryRotation(makeHeifBytes({
    primaryVersion: 1,
    properties: [ispeBox(600, 400), irotBox(3)],
    ipmaVersion: 1,
    ipmaFlags: 1,
    entries: [{ id: 1, indices: [1, 0x8000 | 2] }],
  })), 3);
});

test("unparseable bytes return null without throwing", () => {
  const parseable = makeHeifBytes({
    properties: [ispeBox(600, 400), irotBox(3)],
    entries: [{ id: 1, indices: [1, 0x80 | 2] }],
  });
  // Cut inside the meta box's children.
  assert.equal(heifPrimaryRotation(parseable.subarray(0, FTYP.length + 30)), null, "truncated mid-meta");
  assert.equal(heifPrimaryRotation(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])), null, "PNG header");
  assert.equal(heifPrimaryRotation(Buffer.alloc(64)), null, "all zeros");
  assert.equal(heifPrimaryRotation(Buffer.alloc(0)), null, "empty buffer");
  // A meta box size pointing past the end of the data.
  const oversized = Buffer.from(parseable);
  oversized.writeUInt32BE(0xffff, FTYP.length);
  assert.equal(heifPrimaryRotation(oversized), null, "meta size beyond the data");
});
