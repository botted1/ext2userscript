// Extension files at runtime (spec §3.6): runtime.getURL hands out a blob: URL per bundled file, made on first use and
// cached. CSS from content groups carries placeholders for its url() targets, which become those blob URLs here.
import type { Logger } from "./chrome.ts";
import type { AssetTable } from "./config.ts";

/** The converter writes `url("x2u-asset:<encoded path>")` into CSS; css() swaps each one for the file's blob URL. */
export const ASSET_PREFIX = "x2u-asset:";
const PLACEHOLDER = /x2u-asset:([^"')\s]+)/g;

/** getURL's argument as a path in the asset table: leading slashes, ./ and any query or fragment are dropped. */
const toPath = (url: string) => url.replace(/[?#].*$/, "").split("/").filter((part) => part !== "" && part !== ".").join("/");

const decode = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

export function createAssets(table: AssetTable, id: string, getMessage: (name: string) => string, log: Logger) {
  const urls = new Map<string, string>();
  const paths = new Map<string, string>();

  const missing = (path: string) => log.once(`asset:${path}`, `${path} isn't in the userscript (missing from the extension, or excluded with --ignore-assets)`);

  const url = (input: string): string => {
    const path = toPath(String(input));
    const entry = table[path];
    if (!entry) {
      missing(path);
      return `chrome-extension://${id}/${path}`;
    }
    let blobUrl = urls.get(path);
    if (blobUrl === undefined) {
      blobUrl = URL.createObjectURL(new Blob([decode(entry[1])], { type: entry[0] }));
      urls.set(path, blobUrl);
      paths.set(blobUrl, path);
    }
    return blobUrl;
  };

  const placeholders = (text: string) => text.replace(PLACEHOLDER, (_whole, encoded: string) => url(decodeURIComponent(encoded)));

  return {
    url,
    /** The asset path behind a blob URL this table handed out. */
    pathOf: (blobUrl: string) => paths.get(blobUrl),
    text: (path: string) => (table[path] ? new TextDecoder().decode(decode(table[path][1])) : undefined),
    /** A file's type and bytes, for the network shim to answer a request for it in this page. */
    file: (input: string) => {
      const path = toPath(String(input));
      const entry = table[path];
      if (!entry) return void missing(path);
      return { type: entry[0], bytes: decode(entry[1]) };
    },
    /** The file as a data: URL, for a consumer outside the page that can't load its blob: URLs (a manager's notification). */
    dataUrl: (path: string) => {
      const entry = table[toPath(path)];
      return entry ? `data:${entry[0]};base64,${entry[1]}` : undefined;
    },
    /** Resolves asset placeholders and __MSG_name__ in extension CSS, as Chrome does. */
    css: (text: string) => placeholders(text).replace(/__MSG_([\w@]+)__/g, (_whole, name: string) => getMessage(name)),
    /** Resolves asset placeholders: in an extension page's attributes (src, srcset, style). */
    placeholders,
  };
}

export type Assets = ReturnType<typeof createAssets>;
