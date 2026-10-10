// The API support table (spec §5.2): the single source of truth for what the runtime implements. The analyzer reads it
// for the report, and metadata.ts reads the gm methods a row needs for @grant (spec §5.1). It grows with the runtime:
// this version converts content scripts, so it lists the APIs Chrome gives content scripts.
import type { GmMethod } from "../runtime/gm.ts";
import type { Context, Status } from "./report.ts";

export type Support = { status: Status; reason?: string; methods?: readonly GmMethod[] };

/** The namespaces Chrome gives content scripts. Other chrome.* names don't exist there, so the analyzer skips them. */
export const CONTENT_NAMESPACES: ReadonlySet<string> = new Set(["runtime", "storage", "i18n", "extension", "dom"]);

/** Storage areas, and the members src/runtime/storage.ts implements on them. Any other member is reported unsupported. */
export const STORAGE_AREAS: ReadonlySet<string> = new Set(["local", "sync", "session"]);
export const STORAGE_AREA_MEMBERS: ReadonlySet<string> = new Set(["get", "set", "remove", "clear", "onChanged"]);

const NO_BACKGROUND = "messaging with the background isn't converted yet";

/**
 * Content-script APIs by "<namespace>.<member>". A member not listed doesn't exist in Chrome's content scripts either,
 * so the analyzer ignores it rather than reporting code that can't run there.
 */
export const CONTENT_APIS: Readonly<Record<string, Support>> = {
  "runtime.getURL": { status: "supported" },
  "runtime.getManifest": { status: "supported" },
  "runtime.id": { status: "supported" },
  "runtime.lastError": { status: "supported" },
  "runtime.sendMessage": { status: "unsupported", reason: NO_BACKGROUND },
  "runtime.connect": { status: "unsupported", reason: NO_BACKGROUND },
  "runtime.onMessage": { status: "unsupported", reason: NO_BACKGROUND },
  "runtime.onConnect": { status: "unsupported", reason: NO_BACKGROUND },
  "storage.local": { status: "supported" },
  "storage.sync": { status: "supported" },
  "storage.onChanged": { status: "supported" },
  "storage.session": { status: "partial", reason: "kept across browser restarts" },
  "storage.managed": { status: "unsupported", reason: "userscripts have no managed storage" },
  "i18n.getMessage": { status: "supported" },
  "i18n.getUILanguage": { status: "supported" },
  "i18n.getAcceptLanguages": { status: "supported" },
  "i18n.detectLanguage": { status: "unsupported", reason: "language detection isn't available in userscripts" },
  "extension.getURL": { status: "supported" },
  "extension.inIncognitoContext": { status: "supported" },
  "extension.sendRequest": { status: "unsupported", reason: NO_BACKGROUND },
  "extension.onRequest": { status: "unsupported", reason: NO_BACKGROUND },
  "dom.openOrClosedShadowRoot": { status: "unsupported", reason: "a userscript can't reach closed shadow roots" },
};

/** Manifest keys for browser features a userscript can't provide. The extension relies on them like on its background. */
export const UNSUPPORTED_MANIFEST_KEYS: Readonly<Record<string, { reason: string; context: Context }>> = {
  chrome_url_overrides: { reason: "a userscript can't replace browser pages", context: "background" },
  devtools_page: { reason: "a userscript can't add developer tools panels", context: "background" },
  side_panel: { reason: "a userscript can't open the side panel", context: "background" },
  sidebar_action: { reason: "a userscript can't open the sidebar", context: "background" },
  declarative_net_request: { reason: "a userscript can't block or change network requests", context: "background" },
  omnibox: { reason: "a userscript can't add address-bar keywords", context: "background" },
  commands: { reason: "keyboard shortcuts aren't converted yet", context: "background" },
};
