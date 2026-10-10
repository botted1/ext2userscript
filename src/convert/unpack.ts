// Unpacks extension archives in memory (spec §3.1). Runs in Node and in the browser.
import { unzipSync, type Unzipped } from "fflate";

/** An unpacked extension: relative POSIX path → file bytes. */
export type ExtensionFiles = Map<string, Uint8Array>;

const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

/** Unpacks a .zip, .xpi or .crx (v2 or v3). Throws a readable Error for anything else. */
export function unpack(bytes: Uint8Array): ExtensionFiles {
  const files: ExtensionFiles = new Map();
  for (const [name, data] of Object.entries(inflate(zipPayload(bytes)))) {
    if (name.endsWith("/")) continue; // directory entry
    files.set(safePath(name), data);
  }
  if (!files.has("manifest.json")) throw new Error("Not an extension: manifest.json is missing from the archive");
  return files;
}

/** Inflates the archive. The size cap runs in fflate's filter, so it refuses before each entry is allocated. */
function inflate(zip: Uint8Array): Unzipped {
  let declared = 0;
  const tooLarge = new Error("Archive is too large to unpack (limit 512 MiB)");
  try {
    return unzipSync(zip, {
      filter({ size, originalSize }) {
        // Stored entries are copied at `size`, deflated ones are allocated at `originalSize`, so count both.
        declared += size + originalSize;
        if (declared > MAX_UNPACKED_BYTES) throw tooLarge;
        return true;
      },
    });
  } catch (error) {
    if (error === tooLarge) throw error;
    throw new Error(`Corrupt or truncated archive (${(error as Error).message})`, { cause: error });
  }
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
