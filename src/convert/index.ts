// The conversion core (spec §3): convert(files, options) → { userscript, report }. Pure apart from esbuild (used for
// module backgrounds and --minify), and the same in the CLI and the web app. inspect() builds the report without the
// userscript.
import type { RuntimeConfig } from "../runtime/config.ts";
import { grantsFor } from "../runtime/gm.ts";
import { analyze } from "./analyze.ts";
import { collectAssets } from "./assets.ts";
import { bundleBackground, bundleContent, type BackgroundBundle, type ContentCode } from "./bundle.ts";
import { emit } from "./emit.ts";
import { bundlePages, type PageBundle } from "./pages.ts";
import type { EsbuildApi } from "./esbuild.ts";
import { readManifest } from "./manifest.ts";
import { decodeText } from "./files.ts";
import { dirname, joinPath } from "./paths.ts";
import { namespaceOf, renderMetadata } from "./metadata.ts";
import { sortEntries, verdictOf, type Report } from "./report.ts";
import { scan } from "./scan.ts";
import type { ExtensionFiles } from "./unpack.ts";

export type ConvertOptions = {
  /** The built runtime (src/convert/runtime-node.ts builds it in Node). */
  runtime: string;
  /** Needed for an ES-module background and for minify. */
  esbuild?: EsbuildApi;
  /** --locale: the locale for the header and for chrome.i18n. */
  locale?: string;
  minify?: boolean;
  /** --ignore-assets: path globs to leave out of the asset table. */
  ignoreAssets?: readonly string[];
  /** The store's extension ID, when the source was a store; chrome.runtime.id uses it. */
  extensionId?: string;
};

export type InspectOptions = Omit<ConvertOptions, "runtime" | "minify">;

export async function convert(files: ExtensionFiles, options: ConvertOptions): Promise<{ userscript: string; report: Report }> {
  const prepared = await prepare(files, options);
  const pageCode = Object.fromEntries(prepared.pages.map((page) => [page.kind, page.code]));
  let userscript = emit(prepared.header, options.runtime, prepared.config, prepared.code, prepared.background, prepared.injectables, pageCode);
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

async function prepare(
  files: ExtensionFiles,
  options: InspectOptions,
): Promise<{ header: string; config: RuntimeConfig; code: ContentCode[]; background: BackgroundBundle | null; injectables: Record<string, string>; pages: PageBundle[]; report: Report }> {
  const { model, warnings: manifestWarnings } = readManifest(files, { locale: options.locale });
  const { code, warnings: bundleWarnings } = bundleContent(model, files);
  const scans = code.map((group) => (group?.world === "ISOLATED" ? scan(group.code) : undefined));
  const background = await bundleBackground(model, files, options.esbuild);
  const backgroundScan = background.background ? scan(background.background.code) : undefined;
  const { pages, warnings: pageWarnings } = await bundlePages(model, files, options.esbuild);
  const pageScans = pages.map((page) => scan(page.code));
  const { entries, methods } = analyze(model, scans, backgroundScan ? { scan: backgroundScan, bundle: background } : undefined);
  // Files the background names that it may inject: scripts are bundled like content scripts, style sheets go in the asset table.
  // "./js/a.js" and "/js/a.js" name the same file as "js/a.js", as in Chrome.
  const injectable = [...new Set((backgroundScan?.files ?? []).map((path) => path.split("/").filter((part) => part !== "" && part !== ".").join("/")))].filter((path) => files.has(path));
  const injectables = Object.fromEntries(injectable.filter((path) => path.endsWith(".js")).map((path) => [path, decodeText(files.get(path) as Uint8Array)]));
  const getUrls = [
    ...scans.flatMap((result) => result?.urls ?? []),
    ...(backgroundScan?.urls ?? []),
    ...backgroundFiles(backgroundScan?.fetches ?? [], background.background?.entry, files),
    ...injectable.filter((path) => path.endsWith(".css")),
    // What the pages show, and the files their code names or fetches by a URL relative to the page.
    ...pages.flatMap((page, i) => [...page.assets, ...pageScans[i].urls, ...backgroundFiles(pageScans[i].fetches, page.config.path, files)]),
  ];
  const assets = collectAssets(model, files, getUrls, options.ignoreAssets);
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
    ...(background.background ? { background: { worker: background.background.worker, entry: background.background.entry } } : {}),
    permissions: { api: model.permissions, optionalApi: model.optionalPermissions, origins: model.hostPermissions, optionalOrigins: model.optionalHostPermissions },
    commands: model.commands,
    ...(model.action ? { action: { ...model.action, popup: model.popup !== undefined } } : {}),
    ...(pages.length > 0 ? { pages: Object.fromEntries(pages.map((page) => [page.kind, page.config])) } : {}),
  };
  const report: Report = {
    extension: { name: model.name, version: model.version, manifestVersion: model.manifestVersion, id },
    verdict: verdictOf(entries),
    entries: sortEntries(entries),
    warnings: [...manifestWarnings, ...bundleWarnings, ...background.warnings, ...pageWarnings, ...assets.warnings],
  };
  return { header: renderMetadata(model, files, ns, grantsFor(methods)), config, code, background: background.background, injectables, pages, report };
}

/** The extension files a background fetches by relative URL, which resolve against its own file. Others are left out quietly. */
function backgroundFiles(urls: readonly string[], entry: string | undefined, files: ExtensionFiles): string[] {
  if (entry === undefined) return [];
  return urls.flatMap((url) => {
    if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(url)) return [];
    try {
      const path = joinPath(url.startsWith("/") ? "" : dirname(entry), url.split(/[?#]/)[0]);
      return files.has(path) ? [path] : [];
    } catch {
      return [];
    }
  });
}

const base64Bytes = (base64: string) => Uint8Array.from(atob(base64.replace(/\s+/g, "")), (char) => char.charCodeAt(0));

/** Chrome's extension ID scheme: the first 128 bits of a SHA-256, written with the letters a–p. */
async function chromeId(seed: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", seed));
  return [...hash.subarray(0, 16)].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
}
