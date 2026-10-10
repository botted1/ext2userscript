// The conversion core (spec §3): convert(files, options) → { userscript, report }. Pure apart from esbuild (used here
// only for --minify), and the same in the CLI and the web app. inspect() builds the report without the userscript.
import type { RuntimeConfig } from "../runtime/config.ts";
import { grantsFor } from "../runtime/gm.ts";
import { analyze } from "./analyze.ts";
import { collectAssets } from "./assets.ts";
import { bundleContent, type ContentCode } from "./bundle.ts";
import { emit } from "./emit.ts";
import type { EsbuildApi } from "./esbuild.ts";
import { readManifest } from "./manifest.ts";
import { namespaceOf, renderMetadata } from "./metadata.ts";
import { sortEntries, verdictOf, type Report } from "./report.ts";
import { scan } from "./scan.ts";
import type { ExtensionFiles } from "./unpack.ts";

export type ConvertOptions = {
  /** The built runtime (src/convert/runtime-node.ts builds it in Node). */
  runtime: string;
  /** Needed only with minify. */
  esbuild?: EsbuildApi;
  /** --locale: the locale for the header and for chrome.i18n. */
  locale?: string;
  minify?: boolean;
  /** --ignore-assets: path globs to leave out of the asset table. */
  ignoreAssets?: readonly string[];
  /** The store's extension ID, when the source was a store; chrome.runtime.id uses it. */
  extensionId?: string;
};

export type InspectOptions = Omit<ConvertOptions, "runtime" | "esbuild" | "minify">;

export async function convert(files: ExtensionFiles, options: ConvertOptions): Promise<{ userscript: string; report: Report }> {
  const prepared = await prepare(files, options);
  let userscript = emit(prepared.header, options.runtime, prepared.config, prepared.code);
  if (options.minify) {
    if (!options.esbuild) throw new Error("convert: minify needs the esbuild option");
    const body = userscript.slice(prepared.header.length);
    userscript = `${prepared.header}\n${(await options.esbuild.transform(body, { minify: true, target: "es2020" })).code}`;
  }
  return { userscript, report: prepared.report };
}

export async function inspect(files: ExtensionFiles, options: InspectOptions = {}): Promise<Report> {
  return (await prepare(files, options)).report;
}

async function prepare(files: ExtensionFiles, options: InspectOptions): Promise<{ header: string; config: RuntimeConfig; code: ContentCode[]; report: Report }> {
  const { model, warnings: manifestWarnings } = readManifest(files, { locale: options.locale });
  const { code, warnings: bundleWarnings } = bundleContent(model, files);
  const scans = code.map((group) => (group?.world === "ISOLATED" ? scan(group.code) : undefined));
  const { entries, methods } = analyze(model, scans);
  const assets = collectAssets(model, files, scans.flatMap((result) => result?.urls ?? []), options.ignoreAssets);
  const id = options.extensionId ?? (model.key ? await chromeId(base64Bytes(model.key)) : undefined) ?? model.geckoId ?? (await chromeId(new TextEncoder().encode(model.name)));
  const ns = namespaceOf(model);
  const config: RuntimeConfig = {
    name: model.name,
    ns,
    id,
    manifest: model.raw,
    groups: model.contentScripts.map((group, i) => ({
      matches: group.matches,
      excludeMatches: group.excludeMatches,
      includeGlobs: group.includeGlobs,
      excludeGlobs: group.excludeGlobs,
      runAt: group.runAt,
      allFrames: group.allFrames,
      world: group.world,
      css: assets.css[i],
    })),
    assets: assets.table,
    locales: model.locales,
    defaultLocale: model.defaultLocale,
    locale: options.locale ? model.locale : undefined,
  };
  const report: Report = {
    extension: { name: model.name, version: model.version, manifestVersion: model.manifestVersion, id },
    verdict: verdictOf(entries),
    entries: sortEntries(entries),
    warnings: [...manifestWarnings, ...bundleWarnings, ...assets.warnings],
  };
  return { header: renderMetadata(model, files, ns, grantsFor(methods)), config, code, report };
}

const base64Bytes = (base64: string) => Uint8Array.from(atob(base64.replace(/\s+/g, "")), (char) => char.charCodeAt(0));

/** Chrome's extension ID scheme: the first 128 bits of a SHA-256, written with the letters a–p. */
async function chromeId(seed: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", seed));
  return [...hash.subarray(0, 16)].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
}
