// The analyzer (spec §3.4): report entries for the chrome.* APIs the content scripts use and for manifest features,
// plus the gm methods those need for @grant (spec §5.1).
import type { GmMethod } from "../runtime/gm.ts";
import type { Model } from "./manifest.ts";
import type { Context, ReportEntry, Status } from "./report.ts";
import type { ScanResult } from "./scan.ts";
import { CONTENT_APIS, CONTENT_NAMESPACES, STORAGE_AREA_MEMBERS, STORAGE_AREAS, UNSUPPORTED_MANIFEST_KEYS } from "./support.ts";

/** An extension page: getURL or web_accessible_resources naming an .html or .htm file. */
const PAGE = /\.html?(?:$|[?#])/i;

/**
 * scans has one entry per content group, in manifest order: the group's scanned code, or undefined for a group without
 * JS or a MAIN-world group (code in the page's world has no chrome.* APIs, in Chrome as here).
 */
export function analyze(model: Model, scans: ReadonlyArray<ScanResult | undefined>): { entries: ReportEntry[]; methods: Set<GmMethod> } {
  const entries = new Map<string, ReportEntry>();
  const methods = new Set<GmMethod>();
  const add = (subject: string, status: Status, reason: string | undefined, context: Context) => {
    const entry = entries.get(subject) ?? { subject, status, ...(reason ? { reason } : {}), contexts: [] };
    if (!entry.contexts.includes(context)) entry.contexts.push(context);
    entries.set(subject, entry);
  };

  for (const scan of scans) {
    if (!scan) continue;
    for (const chain of scan.chains) {
      const [, namespace, member, areaMember] = chain.split(".");
      if (member === undefined || !CONTENT_NAMESPACES.has(namespace)) continue;
      if (namespace === "storage" && STORAGE_AREAS.has(member) && areaMember !== undefined && !STORAGE_AREA_MEMBERS.has(areaMember)) {
        add(`chrome.storage.${member}.${areaMember}`, "unsupported", "not implemented yet", "content");
        continue;
      }
      const support = CONTENT_APIS[`${namespace}.${member}`];
      if (!support) continue;
      add(`chrome.${namespace}.${member}`, support.status, support.reason, "content");
      for (const method of support.methods ?? []) methods.add(method);
    }
    if (scan.dynamicImport) add("import()", "partial", "dynamic import() isn't bundled in content scripts", "content");
  }

  // A page served from a blob: URL has no chrome object and its relative URLs break, so it is not "supported".
  const pages = [...new Set([...scans.flatMap((scan) => scan?.urls ?? []), ...model.webAccessibleResources].filter((path) => PAGE.test(path)))];
  if (pages.length > 0) add("extension pages", "unsupported", `extension pages (${pages.join(", ")}) aren't converted yet`, "page");

  const groups = model.contentScripts;
  if (groups.some((group) => group.runAt === "document_start")) {
    add("manifest.content_scripts.run_at", "partial", "document_start is best-effort: the script may run after the page's earliest scripts", "content");
  }
  if (groups.some((group) => group.matchAboutBlank)) {
    add("manifest.content_scripts.match_about_blank", "partial", "content scripts don't run in about:blank frames", "content");
  }
  if (model.background) add("manifest.background", "unsupported", "background scripts aren't converted yet", "background");
  if (model.popup) add(`manifest.${model.popup.key}.default_popup`, "unsupported", "the popup isn't converted yet", "popup");
  if (model.options) add(`manifest.${model.options.key}`, "unsupported", "the options page isn't converted yet", "options");
  for (const [key, { reason, context }] of Object.entries(UNSUPPORTED_MANIFEST_KEYS)) {
    if (model.raw[key] !== undefined) add(`manifest.${key}`, "unsupported", reason, context);
  }
  return { entries: [...entries.values()], methods };
}
