// Extension files at runtime (spec §3.6): runtime.getURL hands out a blob: URL per bundled file, made on first use and
// cached. CSS from content groups carries placeholders for its url() targets, which become those blob URLs here.
import { inflateSync } from "fflate";
import type { Logger } from "./chrome.ts";
import type { AssetTable, Deflated, Messages } from "./config.ts";

/** The converter writes `url("x2u-asset:<encoded path>")` into CSS; css() swaps each one for the file's blob URL. */
export const ASSET_PREFIX = "x2u-asset:";
const PLACEHOLDER = /x2u-asset:([^"')\s]+)/g;

/** getURL's argument as a path in the asset table: leading slashes, ./ and any query or fragment are dropped. */
const toPath = (url: string) => url.replace(/[?#].*$/, "").split("/").filter((part) => part !== "" && part !== ".").join("/");

/** Types whose URLs code extends with a fragment of its own. */
const FRAGMENT_ADDRESSED = /^(?:image\/svg\+xml|audio\/|video\/|application\/pdf)/;

// A plain loop: Uint8Array.from with a callback per character is 30 times slower, and this runs on page loads.
const decode = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
const inflate = (base64: string) => inflateSync(decode(base64)) as Uint8Array<ArrayBuffer>;
const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const isDeflated = (value: unknown): value is Deflated => typeof (value as Partial<Deflated> | null)?.deflated === "string";
/** Text the converter may have deflated (CSS), as text. */
export const textOf = (value: string | Deflated): string => (typeof value === "string" ? value : new TextDecoder().decode(inflate(value.deflated)));
const inflatedMessages = new WeakMap<Deflated, Messages>();
/** A locale's messages, inflated once if the converter deflated them. A message is an object, so it is never a Deflated. */
export function messagesOf(value: Messages | Deflated): Messages {
  if (!isDeflated(value)) return value;
  let messages = inflatedMessages.get(value);
  if (!messages) inflatedMessages.set(value, (messages = JSON.parse(textOf(value)) as Messages));
  return messages;
}

export function createAssets(table: AssetTable, id: string, getMessage: (name: string) => string, log: Logger, locales: Record<string, Messages | Deflated> = {}) {
  const urls = new Map<string, string>();
  const paths = new Map<string, string>();

  /**
   * A file's type and bytes: from the table, or a _locales/<locale>/messages.json, which the runtime config holds
   * already (as parsed messages), for code that reads its own (Improve YouTube! fetches one, and loops until it loads).
   */
  const lookup = (path: string): { type: string; bytes: Uint8Array<ArrayBuffer> } | undefined => {
    const entry = Object.hasOwn(table, path) ? table[path] : undefined;
    if (entry) return { type: entry[0], bytes: entry[2] ? inflate(entry[1]) : decode(entry[1]) };
    const locale = /^_locales\/([^/]+)\/messages\.json$/.exec(path)?.[1] ?? "";
    if (!Object.hasOwn(locales, locale)) return undefined;
    const messages = messagesOf(locales[locale]);
    const json = Object.fromEntries(Object.entries(messages).map(([key, { name, ...message }]) => [name ?? key, message]));
    return { type: "application/json", bytes: new TextEncoder().encode(JSON.stringify(json)) };
  };

  const missing = (path: string) => log.once(`asset:${path}`, `${path} isn't in the userscript (missing from the extension, or excluded with --ignore-assets)`);

  const url = (input: string): string => {
    const path = toPath(String(input));
    let assetUrl = urls.get(path);
    if (assetUrl === undefined) {
      const file = lookup(path);
      if (!file) {
        missing(path);
        return `chrome-extension://${id}/${path}`;
      }
      const blobUrl = URL.createObjectURL(new Blob([file.bytes], { type: file.type }));
      // The file's path rides along as the fragment, which loading ignores: code that reads the URL's text (does it
      // end in .css?) sees the path there, as it would in Chrome's chrome-extension://<id>/<path>. Not for the files a
      // fragment addresses (an SVG sprite's #icon, a video's #t=10, a PDF's #page=2): their code adds its own.
      assetUrl = FRAGMENT_ADDRESSED.test(file.type) ? blobUrl : `${blobUrl}#${encodeURI(path)}`;
      urls.set(path, assetUrl);
      paths.set(blobUrl, path);
    }
    return assetUrl;
  };

  const placeholders = (text: string) => text.replace(PLACEHOLDER, (_whole, encoded: string) => url(decodeURIComponent(encoded)));

  return {
    url,
    /** The asset path behind a URL this table handed out, with or without its fragment. */
    pathOf: (url: string) => paths.get(url.replace(/#.*$/, "")),
    text: (path: string) => {
      const file = lookup(path);
      return file ? new TextDecoder().decode(file.bytes) : undefined;
    },
    /** A file's type and bytes, for the network shim to answer a request for it in this page. */
    file: (input: string) => {
      const path = toPath(String(input));
      return lookup(path) ?? void missing(path);
    },
    /** The file as a data: URL, for a consumer outside the page that can't load its blob: URLs (a manager's notification). */
    dataUrl: (path: string) => {
      const entry = Object.hasOwn(table, toPath(path)) ? table[toPath(path)] : undefined;
      return entry ? `data:${entry[0]};base64,${entry[2] ? toBase64(inflate(entry[1])) : entry[1]}` : undefined;
    },
    /** Resolves asset placeholders and __MSG_name__ in extension CSS, as Chrome does. */
    css: (text: string | Deflated) => placeholders(textOf(text)).replace(/__MSG_([\w@]+)__/g, (_whole, name: string) => getMessage(name)),
    /** Resolves asset placeholders: in an extension page's attributes (src, srcset, style). */
    placeholders,
  };
}

export type Assets = ReturnType<typeof createAssets>;
