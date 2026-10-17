// The analyzer (spec §3.4): report entries for the chrome.* APIs the content scripts, the background and the popup and
// options pages use and for manifest features, plus the gm methods those need for @grant (spec §5.1).
import type { GmMethod } from "../runtime/gm.ts";
import type { BackgroundResult } from "./bundle.ts";
import type { Model } from "./manifest.ts";
import type { Context, ReportEntry, Status } from "./report.ts";
import type { ScanResult } from "./scan.ts";
import { BACKGROUND_APIS, CONTENT_APIS, CONTENT_NAMESPACES, OUT_OF_SCOPE, PAGE_APIS, STORAGE_AREA_MEMBERS, STORAGE_AREAS, UNSUPPORTED_MANIFEST_KEYS, type Support } from "./support.ts";

/** An extension page: getURL or web_accessible_resources naming an .html or .htm file. */
const PAGE = /\.html?(?:$|[?#])/i;

/** What the analyzer knows about the background: its scanned code, and what bundling it found. */
export type BackgroundScan = { scan: ScanResult; bundle: Pick<BackgroundResult, "dynamicImportScripts" | "remoteImports"> };

/**
 * scans has one entry per content group, in manifest order: the group's scanned code, or undefined for a group without
 * JS or a MAIN-world group (code in the page's world has no chrome.* APIs, in Chrome as here). pages holds the popup's
 * and the options page's scanned code.
 */
export function analyze(
  model: Model,
  scans: ReadonlyArray<ScanResult | undefined>,
  background?: BackgroundScan,
  pages: ReadonlyArray<{ kind: "popup" | "options"; scan: ScanResult }> = [],
): { entries: ReportEntry[]; methods: Set<GmMethod> } {
  const entries = new Map<string, ReportEntry>();
  const methods = new Set<GmMethod>();
  const add = (subject: string, status: Status, reason: string | undefined, context: Context) => {
    const entry = entries.get(subject) ?? { subject, status, ...(reason ? { reason } : {}), contexts: [] };
    if (!entry.contexts.includes(context)) entry.contexts.push(context);
    entries.set(subject, entry);
  };
  const use = (subject: string, support: Support, context: Context) => {
    add(subject, support.status, support.reason, context);
    for (const method of support.methods ?? []) methods.add(method);
  };

  const chains = (scan: ScanResult, context: Context) => {
    for (const chain of scan.chains) {
      const [, namespace, member, areaMember] = chain.split(".");
      if (member === undefined) continue;
      if (context === "content" && !CONTENT_NAMESPACES.has(namespace)) continue;
      if (namespace === "storage" && STORAGE_AREAS.has(member) && areaMember !== undefined && !STORAGE_AREA_MEMBERS.has(areaMember)) {
        add(`chrome.storage.${member}.${areaMember}`, "unsupported", "not implemented yet", context);
        continue;
      }
      const api = `${namespace}.${member}`;
      const support = (context === "content" ? CONTENT_APIS : context === "background" ? BACKGROUND_APIS : PAGE_APIS)[api];
      if (support) use(`chrome.${api}`, support, context);
      // A member Chrome's content scripts don't have can't be relied on there; the background and pages have every API.
      else if (context !== "content") {
        add(`chrome.${api}`, "unsupported", OUT_OF_SCOPE.has(namespace) ? "not available in userscripts" : "isn't converted yet", context);
      }
    }
  };

  /** Globals the site owns: an extension page's or background's own in Chrome, the site's here (spec §5.1, §6). */
  const siteGlobals = (scan: ScanResult, context: Context) => {
    for (const name of scan.globals) {
      if (name === "customElements") add(name, "partial", "Violentmonkey runs userscripts where customElements is null, so custom elements can't be defined", context);
      else add(name, "partial", "the site's own here: what the extension keeps in it stays on each site, where the site can read it", context);
    }
  };

  for (const scan of scans) {
    if (!scan) continue;
    chains(scan, "content");
    if (scan.dynamicImport) add("import()", "partial", "dynamic import() isn't bundled in content scripts", "content");
  }
  if (background) {
    chains(background.scan, "background");
    siteGlobals(background.scan, "background");
    if (background.bundle.dynamicImportScripts) add("importScripts()", "partial", "importScripts with anything but string literals can't be inlined", "background");
    for (const url of background.bundle.remoteImports) add(`import ${url}`, "unsupported", "remote modules can't be bundled", "background");
  }

  // A page served from a blob: URL has no chrome object and its relative URLs break, so it is not "supported".
  const urls = [...scans.flatMap((scan) => scan?.urls ?? []), ...(background?.scan.urls ?? []), ...model.webAccessibleResources];
  const htmlPages = [...new Set(urls.filter((path) => PAGE.test(path)))];
  if (htmlPages.length > 0) add("extension pages", "unsupported", `extension pages (${htmlPages.join(", ")}) aren't converted yet`, "page");

  const groups = model.contentScripts;
  if (groups.some((group) => group.runAt === "document_start")) {
    add("manifest.content_scripts.run_at", "partial", "document_start is best-effort: the script may run after the page's earliest scripts", "content");
  }
  if (groups.some((group) => group.matchAboutBlank)) {
    add("manifest.content_scripts.match_about_blank", "partial", "content scripts don't run in about:blank frames", "content");
  }
  const raw = model.raw.background as { persistent?: unknown } | undefined;
  if (model.background?.kind === "page") add("manifest.background.page", "partial", "the page's scripts run, but its HTML isn't created", "background");
  if (raw?.persistent === true) add("manifest.background.persistent", "partial", "the background starts over whenever it moves to another tab", "background");
  if (Object.keys(model.commands).length > 0) add("manifest.commands", "partial", "shortcuts work only while a page the userscript runs on has focus", "background");
  // The network shim reaches these hosts through gm.xmlHttpRequest, in the background and in content scripts.
  if (model.hostPermissions.length + model.optionalHostPermissions.length > 0) {
    use("manifest.host_permissions", { status: "supported", methods: ["xmlHttpRequest"] }, model.background ? "background" : "content");
  }
  for (const page of pages) {
    chains(page.scan, page.kind);
    siteGlobals(page.scan, page.kind);
  }
  // The pages open from menu commands (spec §6).
  const opened: Support = { status: "supported", methods: ["registerMenuCommand", "unregisterMenuCommand"] };
  if (model.popup) use(`manifest.${model.popup.key}.default_popup`, opened, "popup");
  if (model.options) use(`manifest.${model.options.key}`, opened, "options");
  for (const [key, { reason, context }] of Object.entries(UNSUPPORTED_MANIFEST_KEYS)) {
    if (model.raw[key] !== undefined) add(`manifest.${key}`, "unsupported", reason, context);
  }
  return { entries: [...entries.values()], methods };
}
