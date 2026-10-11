import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Inflate, strToU8, zipSync } from "fflate";
import { unpack } from "../../src/convert/unpack.ts";

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));

/** Overwrites a little-endian field of the first central-directory header; `field` is its offset from that header. */
function patchCentral(zipBytes: Uint8Array, field: number, value: number, bytes: 2 | 4 = 4): Uint8Array {
  const out = zipBytes.slice();
  const header = out.findIndex((_, i) => out[i] === 0x50 && out[i + 1] === 0x4b && out[i + 2] === 0x01 && out[i + 3] === 0x02);
  const view = new DataView(out.buffer);
  if (bytes === 2) view.setUint16(header + field, value, true);
  else view.setUint32(header + field, value, true);
  return out;
}

/** fflate writes no archive comment, so the end-of-central-directory record is the last 22 bytes. */
function patchEnd(zipBytes: Uint8Array, field: number, value: number): Uint8Array {
  const out = zipBytes.slice();
  new DataView(out.buffer).setUint16(out.length - 22 + field, value, true);
  return out;
}

/** Rewrites a zip's end records the zip64 way: the classic record says "see zip64", and a zip64 record holds the numbers. */
function toZip64(zipBytes: Uint8Array, count?: bigint): Uint8Array {
  const eocd = zipBytes.length - 22;
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const entries = BigInt(view.getUint16(eocd + 10, true));
  const out = new Uint8Array(zipBytes.length + 56 + 20);
  out.set(zipBytes.subarray(0, eocd));
  const o = new DataView(out.buffer);
  o.setUint32(eocd, 0x06064b50, true);
  o.setBigUint64(eocd + 4, 44n, true);
  o.setBigUint64(eocd + 24, count ?? entries, true);
  o.setBigUint64(eocd + 32, count ?? entries, true);
  o.setBigUint64(eocd + 40, BigInt(view.getUint32(eocd + 12, true)), true);
  o.setBigUint64(eocd + 48, BigInt(view.getUint32(eocd + 16, true)), true);
  const locator = eocd + 56;
  o.setUint32(locator, 0x07064b50, true);
  o.setBigUint64(locator + 8, BigInt(eocd), true);
  o.setUint32(locator + 16, 1, true);
  const end = locator + 20;
  out.set(zipBytes.subarray(eocd), end);
  o.setUint16(end + 8, 0xffff, true);
  o.setUint16(end + 10, 0xffff, true);
  o.setUint32(end + 12, 0xffffffff, true);
  o.setUint32(end + 16, 0xffffffff, true);
  return out;
}

const body = "x".repeat(300); // long enough that fflate deflates it

describe("unpack hardening", () => {
  it("rejects a path that appears twice after normalising", () => {
    assert.throws(() => unpack(zip({ "manifest.json": "{}", "a.js": "1", "./a.js": "2" })), /Ambiguous archive: a\.js appears more than once/);
  });

  it("rejects a name that is both a file and a folder", () => {
    assert.throws(() => unpack(zip({ "manifest.json": "{}", a: "1", "a/b.js": "2" })), /Ambiguous archive: a is both a file and a folder/);
  });

  it("refuses an archive that claims too many entries, before reading them", () => {
    assert.throws(() => unpack(patchEnd(patchEnd(zip({ "manifest.json": "{}" }), 8, 60_000), 10, 60_000)), /too many files to unpack \(60000; limit 50000\)/);
  });

  it("reads a zip64 end record", () => {
    const files = unpack(toZip64(zip({ "manifest.json": "{}", "a.js": body })));
    assert.equal(new TextDecoder().decode(files.get("a.js")), body);
  });

  it("refuses a zip64 record that claims billions of entries", () => {
    assert.throws(() => unpack(toZip64(zip({ "manifest.json": "{}" }), 2n ** 40n)), /too many files to unpack/);
  });

  it("rejects an entry whose CRC doesn't match", () => {
    assert.throws(() => unpack(patchCentral(zip({ "manifest.json": body }), 16, 0x12345678)), /Corrupt or truncated archive \(manifest\.json fails its CRC check\)/);
  });

  it("rejects an entry whose declared size is smaller than its data", () => {
    assert.throws(() => unpack(patchCentral(zip({ "manifest.json": body }), 24, 3)), /manifest\.json inflates to more than its declared size/);
  });

  it("rejects an entry whose declared size is larger than its data", () => {
    assert.throws(() => unpack(patchCentral(zip({ "manifest.json": body }), 24, 400)), /manifest\.json fails its CRC check/);
  });

  it("stops inflating an entry as soon as it outgrows its declared size", (t) => {
    // 64 MiB of zeros deflates to about 64 KiB; declaring 10 bytes must not cost 64 MiB of inflating.
    // The work is measured as deflate input fed to the inflater, not wall-clock time, so machine load can't fail it.
    const archive = patchCentral(zipSync({ "big.bin": new Uint8Array(64 * 1024 * 1024), "manifest.json": strToU8("{}") }), 24, 10);
    const push = t.mock.method(Inflate.prototype, "push");
    assert.throws(() => unpack(archive), /Corrupt or truncated archive \(big\.bin inflates to more than its declared size\)/);
    const fed = push.mock.calls.reduce((total, call) => total + call.arguments[0].length, 0);
    assert.ok(fed < archive.length / 2, `fed ${fed} of ${archive.length} archive bytes to the inflater`);
  });

  it("rejects encrypted entries", () => {
    assert.throws(() => unpack(patchCentral(zip({ "manifest.json": body }), 8, 1, 2)), /Encrypted archive entries aren't supported: manifest\.json/);
  });

  it("rejects a stored entry whose sizes disagree", () => {
    const stored = zipSync({ "manifest.json": strToU8("{}") }, { level: 0 });
    assert.throws(() => unpack(patchCentral(stored, 24, 1)), /manifest\.json has inconsistent sizes/);
  });

  it("rejects an entry whose data runs past the end of the archive", () => {
    assert.throws(() => unpack(patchCentral(zip({ "manifest.json": body }), 20, 0x100000)), /manifest\.json is cut short/);
  });

  it("treats a backslash-terminated name as a folder", () => {
    assert.deepEqual([...unpack(zip({ "manifest.json": "{}", "icons\\": "", "icons/a.png": "x" })).keys()].sort(), ["icons/a.png", "manifest.json"]);
  });
});
