// The API support table (spec §5.2): the single source of truth for what the runtime implements. The analyzer reads it
// for the report, and metadata.ts reads the gm methods a row needs for @grant (spec §5.1). It grows with the runtime:
// this version converts content scripts and the background's core: messaging, tabs, storage, i18n and lifecycle.
import type { GmMethod } from "../runtime/gm.ts";
import type { Context, Status } from "./report.ts";

export type Support = { status: Status; reason?: string; methods?: readonly GmMethod[] };

/** The namespaces Chrome gives content scripts. Other chrome.* names don't exist there, so the analyzer skips them. */
export const CONTENT_NAMESPACES: ReadonlySet<string> = new Set(["runtime", "storage", "i18n", "extension", "dom"]);

/** Storage areas, and the members src/runtime/storage.ts implements on them. Any other member is reported unsupported. */
export const STORAGE_AREAS: ReadonlySet<string> = new Set(["local", "sync", "session"]);
export const STORAGE_AREA_MEMBERS: ReadonlySet<string> = new Set(["get", "set", "remove", "clear", "onChanged", "setAccessLevel"]);

const OLD_MESSAGING = "the MV2 extension.sendRequest messaging isn't converted";

/** Rows content scripts and the background share. */
const SHARED: Readonly<Record<string, Support>> = {
  "runtime.getURL": { status: "supported" },
  "runtime.getManifest": { status: "supported" },
  "runtime.id": { status: "supported" },
  "runtime.lastError": { status: "supported" },
  "runtime.onMessage": { status: "supported" },
  "runtime.onConnect": { status: "supported" },
  "storage.local": { status: "supported" },
  "storage.sync": { status: "supported" },
  "storage.session": { status: "supported" },
  "storage.onChanged": { status: "supported" },
  "storage.AccessLevel": { status: "supported" },
  "storage.managed": { status: "unsupported", reason: "userscripts have no managed storage" },
  "i18n.getMessage": { status: "supported" },
  "i18n.getUILanguage": { status: "supported" },
  "i18n.getAcceptLanguages": { status: "supported" },
  "i18n.detectLanguage": { status: "unsupported", reason: "language detection isn't available in userscripts" },
  "extension.getURL": { status: "supported" },
  "extension.inIncognitoContext": { status: "supported" },
  "extension.sendRequest": { status: "unsupported", reason: OLD_MESSAGING },
  "extension.onRequest": { status: "unsupported", reason: OLD_MESSAGING },
};

/**
 * Content-script APIs by "<namespace>.<member>". A member not listed doesn't exist in Chrome's content scripts either,
 * so the analyzer ignores it rather than reporting code that can't run there.
 */
export const CONTENT_APIS: Readonly<Record<string, Support>> = {
  ...SHARED,
  "runtime.sendMessage": { status: "supported" },
  "runtime.connect": { status: "supported" },
  "dom.openOrClosedShadowRoot": { status: "unsupported", reason: "a userscript can't reach closed shadow roots" },
};

const NO_PAGES = "it reaches extension pages, and popups and options pages aren't converted yet";

/**
 * Background APIs by "<namespace>.<member>". Chrome gives the background every API its manifest asks for, so anything
 * not listed here is reported: unsupported, as "isn't converted yet" or, for OUT_OF_SCOPE namespaces, as unavailable.
 */
export const BACKGROUND_APIS: Readonly<Record<string, Support>> = {
  ...SHARED,
  "runtime.sendMessage": { status: "partial", reason: NO_PAGES },
  "runtime.connect": { status: "partial", reason: NO_PAGES },
  "runtime.onInstalled": { status: "supported" },
  "runtime.onStartup": { status: "supported" },
  "runtime.getPlatformInfo": { status: "supported" },
  "runtime.OnInstalledReason": { status: "supported" },
  "runtime.OnRestartRequiredReason": { status: "supported" },
  "runtime.PlatformOs": { status: "supported" },
  "runtime.PlatformArch": { status: "supported" },
  "runtime.PlatformNaclArch": { status: "supported" },
  "runtime.onSuspend": { status: "partial", reason: "never fires: the background runs while its tab is open" },
  "runtime.setUninstallURL": { status: "partial", reason: "does nothing: a userscript can't tell when it is removed" },
  "tabs.query": { status: "supported" },
  "tabs.get": { status: "supported" },
  "tabs.getCurrent": { status: "supported" },
  "tabs.sendMessage": { status: "supported" },
  "tabs.connect": { status: "supported" },
  "tabs.reload": { status: "supported" },
  "tabs.create": { status: "partial", reason: "the new tab's id is known only if the userscript runs on its page" },
  "tabs.update": { status: "partial", reason: "only url is applied" },
  "tabs.remove": { status: "partial", reason: "a tab the extension didn't open may refuse to close" },
  "tabs.onCreated": { status: "supported" },
  "tabs.onRemoved": { status: "supported" },
  "tabs.onUpdated": { status: "supported" },
  "tabs.onActivated": { status: "supported" },
  "tabs.TAB_ID_NONE": { status: "supported" },
};

/** APIs a userscript can never provide (spec §1, out of scope). */
export const OUT_OF_SCOPE: ReadonlySet<string> = new Set([
  "webRequest", "declarativeNetRequest", "proxy", "identity", "offscreen", "sidePanel", "devtools", "debugger", "tabCapture", "downloads",
]);

/** Manifest keys for browser features a userscript can't provide. The extension relies on them like on its background. */
export const UNSUPPORTED_MANIFEST_KEYS: Readonly<Record<string, { reason: string; context: Context }>> = {
  chrome_url_overrides: { reason: "a userscript can't replace browser pages", context: "background" },
  devtools_page: { reason: "a userscript can't add developer tools panels", context: "background" },
  side_panel: { reason: "a userscript can't open the side panel", context: "background" },
  sidebar_action: { reason: "a userscript can't open the sidebar", context: "background" },
  declarative_net_request: { reason: "a userscript can't block or change network requests", context: "background" },
  omnibox: { reason: "a userscript can't add address-bar keywords", context: "background" },
};
