// Unpacks extension archives in memory (spec §3.1). Runs in Node and in the browser.
// The zip's central directory is read here rather than by fflate's unzipSync, so every entry is checked before
// anything is inflated: the entry count, the total size, and that names are safe and unambiguous. Each entry's
// CRC-32 is checked after inflating, which catches an entry whose declared size is wrong.
import { inflateSync } from "fflate";

/** An unpacked extension: relative POSIX path → file bytes. */
export type ExtensionFiles = Map<string, Uint8Array>;

const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 50_000;

type Entry = { path: string; flags: number; method: number; crc: number; compressedSize: number; size: number; localOffset: number };

/** Unpacks a .zip, .xpi or .crx (v2 or v3). Throws a readable Error for anything else. */
export function unpack(bytes: Uint8Array): ExtensionFiles {
  const zip = zipPayload(bytes);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const files: ExtensionFiles = new Map();
  for (const entry of readEntries(zip, view)) files.set(entry.path, extract(zip, view, entry));
  if (!files.has("manifest.json")) throw new Error("Not an extension: manifest.json is missing from the archive");
  return files;
}

const corrupt = (detail: string, cause?: unknown) => new Error(`Corrupt or truncated archive (${detail})`, { cause });
const tooLarge = () => new Error(`Archive is too large to unpack (limit ${MAX_UNPACKED_BYTES / 1024 / 1024} MiB)`);

function readEntries(zip: Uint8Array, view: DataView): Entry[] {
  const eocd = findEndRecord(zip, view);
  let count = view.getUint16(eocd + 10, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) ({ count, cdSize, cdOffset } = readZip64(view, eocd));
  // Checked before the loop: a zip64 record can claim billions of entries in a few bytes.
  if (count > MAX_ENTRIES) throw new Error(`Archive has too many files to unpack (${count}; limit ${MAX_ENTRIES})`);
  const cdEnd = cdOffset + cdSize;
  if (cdEnd > eocd) throw corrupt("the central directory is out of bounds");
  const decoder = new TextDecoder();
  const entries: Entry[] = [];
  const paths = new Set<string>();
  let total = 0;
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > cdEnd || view.getUint32(at, true) !== 0x02014b50) throw corrupt("bad central directory entry");
    const nameLength = view.getUint16(at + 28, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    const entry = {
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    };
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (/[/\\]$/.test(name)) continue; // a directory entry
    total += entry.size;
    if (entry.size === 0xffffffff || total > MAX_UNPACKED_BYTES) throw tooLarge();
    const path = safePath(name);
    if (paths.has(path)) throw new Error(`Ambiguous archive: ${path} appears more than once`);
    paths.add(path);
    entries.push({ path, ...entry });
  }
  // A name that is both a file and a folder (a and a/b) can't be unpacked faithfully.
  for (const path of paths) {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      if (paths.has(path.slice(0, slash))) throw new Error(`Ambiguous archive: ${path.slice(0, slash)} is both a file and a folder`);
    }
  }
  return entries;
}

function findEndRecord(zip: Uint8Array, view: DataView): number {
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) return at;
  }
  throw corrupt("no end of central directory record");
}

function readZip64(view: DataView, eocd: number): { count: number; cdSize: number; cdOffset: number } {
  const locator = eocd - 20;
  if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) throw corrupt("missing zip64 locator");
  const record = Number(view.getBigUint64(locator + 8, true));
  if (record + 56 > locator || view.getUint32(record, true) !== 0x06064b50) throw corrupt("bad zip64 end record");
  return {
    count: Number(view.getBigUint64(record + 32, true)),
    cdSize: Number(view.getBigUint64(record + 40, true)),
    cdOffset: Number(view.getBigUint64(record + 48, true)),
  };
}

function extract(zip: Uint8Array, view: DataView, entry: Entry): Uint8Array {
  if (entry.flags & 1) throw new Error(`Encrypted archive entries aren't supported: ${entry.path}`);
  const at = entry.localOffset;
  if (at + 30 > zip.length || view.getUint32(at, true) !== 0x04034b50) throw corrupt(`bad local header for ${entry.path}`);
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw corrupt(`${entry.path} is cut short`);
  let out: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw corrupt(`${entry.path} has inconsistent sizes`);
    out = data.slice();
  } else if (entry.method === 8) {
    try {
      // A buffer of the declared size caps memory: inflating never grows it, and a wrong size fails the checks below.
      out = inflateSync(data, { out: new Uint8Array(entry.size) });
    } catch (error) {
      throw corrupt(`${entry.path}: ${(error as Error).message}`, error);
    }
  } else {
    throw new Error(`Unsupported compression method ${entry.method} for ${entry.path}`);
  }
  if (out.length !== entry.size || crc32(out) !== entry.crc) throw corrupt(`${entry.path} fails its CRC check`);
  return out;
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipPayload(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) throw new Error("The download is empty (the store returned no package)");
  if (!startsWith(bytes, "Cr24")) {
    if (!startsWith(bytes, "PK")) throw new Error("Unrecognised archive: expected a .crx, .xpi or .zip file");
    return bytes;
  }
  if (bytes.length < 12) throw new Error("Truncated CRX header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  let start: number;
  if (version === 3) {
    start = 12 + view.getUint32(8, true);
  } else if (version === 2) {
    if (bytes.length < 16) throw new Error("Truncated CRX header");
    start = 16 + view.getUint32(8, true) + view.getUint32(12, true);
  } else {
    throw new Error(`Unsupported CRX version ${version}`);
  }
  if (start >= bytes.length) throw new Error("Truncated CRX: the header is longer than the file");
  return bytes.subarray(start);
}

const startsWith = (bytes: Uint8Array, magic: string) => [...magic].every((char, i) => bytes[i] === char.charCodeAt(0));

/** Normalises an entry name and rejects anything that could escape the extension root. */
function safePath(name: string): string {
  const parts = name.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..") || parts.some((part) => part.includes(":"))) {
    throw new Error(`Unsafe path in archive: ${name}`);
  }
  return parts.join("/");
}
