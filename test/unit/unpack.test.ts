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

/** Overwrites a 32-bit little-endian field of the first central-directory header; `field` is its offset from that header. */
function patchCentral(zipBytes: Uint8Array, field: number, value: number): Uint8Array {
  const out = zipBytes.slice();
  const header = out.findIndex((_, i) => out[i] === 0x50 && out[i + 1] === 0x4b && out[i + 2] === 0x01 && out[i + 3] === 0x02);
  new DataView(out.buffer).setUint32(header + field, value, true);
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

  it("rejects a colon in any path segment", () => {
    assert.throws(() => unpack(zip({ "manifest.json": "{}", "C:evil.js": "" })), /Unsafe path in archive/);
    assert.throws(() => unpack(zip({ "manifest.json": "{}", "a/C:evil.js": "" })), /Unsafe path in archive/);
  });

  it("rejects backslash traversal", () => {
    assert.throws(() => unpack(zip({ "manifest.json": "{}", "a\\..\\..\\evil.js": "" })), /Unsafe path in archive/);
  });

  it("wraps a truncated archive as corrupt", () => {
    assert.throws(() => unpack(extension.subarray(0, extension.length - 10)), /Corrupt or truncated archive/);
  });

  it("refuses a declared size over the cap before inflating", () => {
    assert.throws(() => unpack(patchCentral(zip({ "manifest.json": "{}" }), 24, 0x40000000)), /too large to unpack/);
  });

  it("counts stored entries by their compressed size", () => {
    const stored = zipSync({ "manifest.json": strToU8("{}") }, { level: 0 });
    assert.throws(() => unpack(patchCentral(patchCentral(stored, 20, 0x40000000), 24, 0)), /too large to unpack/);
  });
});
