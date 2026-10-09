import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { unpack } from "../../src/convert/unpack.ts";

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));

function crx3(payload: Uint8Array, headerLength = 7): Uint8Array {
  const out = new Uint8Array(12 + headerLength + payload.length);
  out.set(strToU8("Cr24"));
  const view = new DataView(out.buffer);
  view.setUint32(4, 3, true);
  view.setUint32(8, headerLength, true);
  out.set(payload, 12 + headerLength);
  return out;
}

function crx2(payload: Uint8Array, keyLength = 5, signatureLength = 3): Uint8Array {
  const out = new Uint8Array(16 + keyLength + signatureLength + payload.length);
  out.set(strToU8("Cr24"));
  const view = new DataView(out.buffer);
  view.setUint32(4, 2, true);
  view.setUint32(8, keyLength, true);
  view.setUint32(12, signatureLength, true);
  out.set(payload, 16 + keyLength + signatureLength);
  return out;
}

const extension = zip({ "manifest.json": '{"manifest_version":3}', "js/content.js": "console.log(1)", "icons/": "" });

describe("unpack", () => {
  it("reads a zip or xpi and skips directory entries", () => {
    const files = unpack(extension);
    assert.deepEqual([...files.keys()].sort(), ["js/content.js", "manifest.json"]);
    assert.equal(new TextDecoder().decode(files.get("js/content.js")), "console.log(1)");
  });

  it("strips a CRX3 header", () => assert.ok(unpack(crx3(extension)).has("manifest.json")));

  it("strips a CRX2 header", () => assert.ok(unpack(crx2(extension)).has("manifest.json")));

  it("normalises ./ and leading slashes", () => {
    assert.deepEqual([...unpack(zip({ "./manifest.json": "{}", "/a/./b.js": "" })).keys()].sort(), ["a/b.js", "manifest.json"]);
  });

  it("rejects an archive without manifest.json", () => {
    assert.throws(() => unpack(zip({ "a.js": "" })), /manifest\.json is missing/);
  });

  it("rejects path traversal", () => {
    assert.throws(() => unpack(zip({ "manifest.json": "{}", "../evil.js": "" })), /Unsafe path in archive: \.\.\/evil\.js/);
  });

  it("rejects drive-letter paths", () => {
    assert.throws(() => unpack(zip({ "manifest.json": "{}", "C:/evil.js": "" })), /Unsafe path in archive/);
  });

  it("rejects bytes that are not an archive", () => {
    assert.throws(() => unpack(strToU8("<html>")), /Unrecognised archive/);
  });

  it("rejects an empty download", () => {
    assert.throws(() => unpack(new Uint8Array()), /empty/);
  });

  it("rejects a truncated CRX", () => {
    assert.throws(() => unpack(crx3(extension).subarray(0, 10)), /Truncated CRX/);
    assert.throws(() => unpack(crx3(new Uint8Array(), 50).subarray(0, 30)), /Truncated CRX/);
  });

  it("rejects unknown CRX versions", () => {
    const bad = crx3(extension);
    new DataView(bad.buffer).setUint32(4, 4, true);
    assert.throws(() => unpack(bad), /Unsupported CRX version 4/);
  });
});
