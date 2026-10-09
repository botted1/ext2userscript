// Unpacks extension archives in memory (spec §3.1). Runs in Node and in the browser.
import { unzipSync } from "fflate";

/** An unpacked extension: relative POSIX path → file bytes. */
export type ExtensionFiles = Map<string, Uint8Array>;

/** Unpacks a .zip, .xpi or .crx (v2 or v3). Throws a readable Error for anything else. */
export function unpack(bytes: Uint8Array): ExtensionFiles {
  const files: ExtensionFiles = new Map();
  for (const [name, data] of Object.entries(unzipSync(zipPayload(bytes)))) {
    if (name.endsWith("/")) continue; // directory entry
    files.set(safePath(name), data);
  }
  if (!files.has("manifest.json")) throw new Error("Not an extension: manifest.json is missing from the archive");
  return files;
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
  if (parts.length === 0 || parts.includes("..") || /^[a-z]:$/i.test(parts[0])) {
    throw new Error(`Unsafe path in archive: ${name}`);
  }
  return parts.join("/");
}
