// The userscript header (spec §4). Grants come from gm.ts's grant table; nothing here names a GM function.
import type { RunAt } from "../runtime/config.ts";
import { mimeOf, toBase64 } from "./files.ts";
import type { Model } from "./manifest.ts";
import type { ExtensionFiles } from "./unpack.ts";

const RUN_AT_ORDER: readonly RunAt[] = ["document_start", "document_end", "document_idle"];

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "extension";
}

/** The namespace for @namespace and for GM value keys: the Firefox add-on ID when there is one, otherwise the name. */
export function namespaceOf(model: Model): string {
  return model.geckoId ?? `x2u-${slugify(model.name)}`;
}

export function renderMetadata(model: Model, files: ExtensionFiles, ns: string, grants: readonly string[]): string {
  // Every value goes through oneLine: a line break in any of them would start a header line of its own.
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const lines: Array<[key: string, value: string]> = [["name", model.name], ["namespace", ns], ["version", model.version]];
  if (model.description) lines.push(["description", model.description]);
  const icon = iconDataUrl(model, files);
  if (icon) lines.push(["icon", icon]);

  const groups = model.contentScripts;
  const matches = groups.length === 0 ? ["*://*/*"] : [...new Set(groups.flatMap((group) => group.matches.map((p) => (p === "<all_urls>" ? "*://*/*" : p))))];
  for (const pattern of matches) lines.push(["match", pattern]);
  // The header is the union of the groups, so it can only exclude what every group excludes; the runtime does the rest.
  const excludedByAll = groups.length === 0 ? [] : groups[0].excludeMatches.filter((pattern) => groups.every((group) => group.excludeMatches.includes(pattern)));
  for (const pattern of excludedByAll) lines.push(["exclude-match", pattern]);
  const runAt = RUN_AT_ORDER.find((value) => groups.some((group) => group.runAt === value)) ?? "document_idle";
  lines.push(["run-at", runAt.replace("_", "-")]);
  if (!groups.some((group) => group.allFrames)) lines.push(["noframes", ""]);
  lines.push(["sandbox", "DOM"], ["inject-into", "content"]);
  for (const grant of grants) lines.push(["grant", grant]);
  return ["// ==UserScript==", ...lines.map(([key, value]) => `// @${key.padEnd(12)} ${oneLine(value)}`.trimEnd()), "// ==/UserScript=="].join("\n");
}

/** The smallest icon of at least 32px, or the largest one when all are smaller, as a data: URL. */
function iconDataUrl(model: Model, files: ExtensionFiles): string | undefined {
  const sizes = Object.keys(model.icons).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const size = sizes.find((value) => value >= 32) ?? sizes[sizes.length - 1];
  if (size === undefined) return undefined;
  const path = model.icons[String(size)];
  const bytes = files.get(path);
  return bytes ? `data:${mimeOf(path)};base64,${toBase64(bytes)}` : undefined;
}
