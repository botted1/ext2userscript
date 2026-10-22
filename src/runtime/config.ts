// Types shared by the converter (src/convert) and the runtime it embeds in every userscript (src/runtime).

export type RunAt = "document_start" | "document_end" | "document_idle";
export type World = "ISOLATED" | "MAIN";

/** name: the message's name as messages.json writes it, when that isn't lower case (for code that reads the file). */
export type Message = { name?: string; message: string; placeholders?: Record<string, { content: string }> };
/** One locale's messages.json. Message and placeholder names are lower-cased, because Chrome ignores their case. */
export type Messages = Record<string, Message>;

/** Text the converter deflated because that made it smaller: raw DEFLATE, then base64 (see src/runtime/assets.ts). */
export type Deflated = { deflated: string };

/** Which URLs a content-script group runs on (Chrome's matches, exclude_matches, include_globs, exclude_globs). */
export type UrlFilter = { matches: string[]; excludeMatches: string[]; includeGlobs: string[]; excludeGlobs: string[] };

export type GroupConfig = UrlFilter & {
  runAt: RunAt;
  allFrames: boolean;
  world: World;
  /** The group's CSS files, in order, with asset URLs replaced by placeholders (see src/runtime/assets.ts). */
  css: Array<string | Deflated>;
};

/** Extension files the runtime can hand out as blob: URLs, by path: [MIME type, base64 bytes, 1 if the bytes are deflated]. */
export type AssetTable = Record<string, [mime: string, base64: string, deflated?: 1]>;

export type RuntimeConfig = {
  /** The extension's name, for log prefixes. */
  name: string;
  /** Namespace for GM value keys (x2u:<ns>:…). */
  ns: string;
  /** chrome.runtime.id. */
  id: string;
  /** manifest.json as parsed, for chrome.runtime.getManifest(). */
  manifest: unknown;
  groups: GroupConfig[];
  assets: AssetTable;
  /** Every locale's messages, keyed by the _locales folder name. */
  locales: Record<string, Messages | Deflated>;
  defaultLocale?: string;
  /** Set by --locale: i18n uses this locale instead of the browser's languages. */
  locale?: string;
  /** The background, if the extension has one: whether it is a service worker, and its entry file (for import.meta.url). */
  background?: { worker: boolean; entry: string };
  /**
   * The manifest's permissions: API names and host match patterns, required and optional. chrome.permissions answers
   * from them, and the network shim sends requests for these hosts through gm.xmlHttpRequest.
   */
  permissions?: { api: string[]; optionalApi: string[]; origins: string[]; optionalOrigins: string[] };
  /** Keyboard shortcuts by command name: the suggested key per platform ("default", "mac", …) and the description. */
  commands?: Record<string, { description?: string; keys: Record<string, string> }>;
  /** The toolbar button (action, browser_action or page_action), if the manifest has one, and whether it has a popup. */
  action?: { key: string; title?: string; popup: boolean };
  /** The popup and options pages (spec §6), each built in a modal when opened. */
  pages?: Partial<Record<PageKind, PageConfig>>;
};

export type PageKind = "popup" | "options";
/** A page's DOM as the runtime builds it: text as a string, an element as [name, attributes, children]. */
export type PageNode = string | [name: string, attributes: Array<[string, string]>, children: PageNode[]];
export type PageConfig = {
  /** The page's file, for location-like answers (getURL, sender.url). */
  path: string;
  title?: string;
  htmlAttributes: Array<[string, string]>;
  bodyAttributes: Array<[string, string]>;
  head: PageNode[];
  body: PageNode[];
  /** The page's style sheets in document order, with asset placeholders. */
  css: Array<string | Deflated>;
};

/**
 * The background's code as a factory, called once on the leader tab. Its parameters shadow the globals a background
 * reaches (spec §3.3); __x2uImportMeta stands in for import.meta in a module background.
 */
export type BackgroundCode = (
  chrome: unknown,
  browser: unknown,
  self: unknown,
  globalThis: unknown,
  window: unknown,
  document: unknown,
  importScripts: unknown,
  localStorage: unknown,
  fetch: unknown,
  XMLHttpRequest: unknown,
  /** The background's own URL: its service worker's script, its page, or _generated_background_page.html. */
  location: unknown,
  /** import.meta for a module background; for a background page, exports hands over its top-level declarations. */
  __x2uImportMeta: { url: string; exports?: () => object },
) => () => void;

/**
 * A popup or options page's code as a factory, called each time the page opens. Its parameters shadow the globals an
 * extension page reaches (spec §3.3): the window, document, location and history of the modal's iframe, its timers (so
 * they stop when the page closes) and its DOMParser (so Trusted Types sees the frame's policy).
 */
export type PageCode = (
  chrome: unknown,
  browser: unknown,
  window: unknown,
  self: unknown,
  globalThis: unknown,
  document: unknown,
  location: unknown,
  history: unknown,
  localStorage: unknown,
  fetch: unknown,
  XMLHttpRequest: unknown,
  setTimeout: unknown,
  setInterval: unknown,
  clearTimeout: unknown,
  clearInterval: unknown,
  DOMParser: unknown,
  /** The extension's root URL, chrome-extension://<id>/, for each module script's import.meta.url. */
  __x2uBase: string,
) => () => void;

/**
 * One entry per content group, in manifest order: isolated-world code as a factory that takes the chrome and browser
 * objects and the network shim's fetch and XMLHttpRequest and returns the code to run, MAIN-world code as source text
 * (or as the asset-table files it is made of, when they are all there), or null for a group without JS.
 */
export type GroupCode = ((chrome: unknown, browser: unknown, fetch: unknown, XMLHttpRequest: unknown) => () => void) | string | { assets: string[] } | null;

/** Extension files the background may inject with scripting.executeScript({ files }), by path, as content-script factories. */
export type InjectableCode = Record<string, (chrome: unknown, browser: unknown, fetch: unknown, XMLHttpRequest: unknown) => () => void>;
