// Types shared by the converter (src/convert) and the runtime it embeds in every userscript (src/runtime).

export type RunAt = "document_start" | "document_end" | "document_idle";
export type World = "ISOLATED" | "MAIN";

export type Message = { message: string; placeholders?: Record<string, { content: string }> };
/** One locale's messages.json. Message and placeholder names are lower-cased, because Chrome ignores their case. */
export type Messages = Record<string, Message>;

/** Which URLs a content-script group runs on (Chrome's matches, exclude_matches, include_globs, exclude_globs). */
export type UrlFilter = { matches: string[]; excludeMatches: string[]; includeGlobs: string[]; excludeGlobs: string[] };

export type GroupConfig = UrlFilter & {
  runAt: RunAt;
  allFrames: boolean;
  world: World;
  /** The group's CSS files, in order, with asset URLs replaced by placeholders (see src/runtime/assets.ts). */
  css: string[];
};

/** Extension files the runtime can hand out as blob: URLs, by path: [MIME type, base64 bytes]. */
export type AssetTable = Record<string, [mime: string, base64: string]>;

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
  locales: Record<string, Messages>;
  defaultLocale?: string;
  /** Set by --locale: i18n uses this locale instead of the browser's languages. */
  locale?: string;
  /** The background, if the extension has one: whether it is a service worker, and its entry file (for import.meta.url). */
  background?: { worker: boolean; entry: string };
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
  __x2uImportMeta: { url: string },
) => () => void;

/**
 * One entry per content group, in manifest order: isolated-world code as a factory that takes the chrome and browser
 * objects and returns the code to run, MAIN-world code as source text, or null for a group without JS.
 */
export type GroupCode = ((chrome: unknown, browser: unknown) => () => void) | string | null;
