// The popup and options pages (spec §6), prepared at build time: the HTML becomes a tree the runtime builds with
// createElement, the style sheets become CSS text, and the scripts become one piece of code.
// - Classic <script src> files are concatenated, as a page runs them in one shared scope; module scripts are bundled by
//   esbuild into an IIFE, as for a module background. The order is Chrome's: parser-blocking scripts first, then
//   deferred and module scripts, each in document order.
// - An inline <script> is dropped with a warning: an extension page's CSP refuses inline scripts, so it never ran. A
//   data block (a non-JavaScript type) stays in the tree for the code to read.
// - Inline handlers (onclick="…") are dropped for the same reason, and <link>s other than style sheets do nothing in a
//   modal.
// - Asset URLs in src, srcset, poster and inline style become placeholders the runtime resolves.
import type { PageConfig, PageKind, PageNode } from "../runtime/config.ts";
import { assetPlaceholder, extensionPath, rewriteCssUrls } from "./assets.ts";
import { bundleModule, type EsbuildApi } from "./esbuild.ts";
import { decodeText, mimeOf } from "./files.ts";
import { parseHtml, type HtmlAttribute, type HtmlNode } from "./html.ts";
import type { Model } from "./manifest.ts";
import type { ExtensionFiles } from "./unpack.ts";

export type PageBundle = { kind: PageKind; config: PageConfig; code: string; assets: string[]; remoteImports: string[] };

/** Elements that belong in <head> when a page has no <head> of its own. */
const HEAD = new Set(["meta", "title", "link", "style", "script", "base"]);
const CSS_URL = /url\(\s*(["']?)([^"')]*?)\1\s*\)/g;

export async function bundlePages(model: Model, files: ExtensionFiles, esbuild?: EsbuildApi): Promise<{ pages: PageBundle[]; warnings: string[] }> {
  const warnings: string[] = [];
  const pages: PageBundle[] = [];
  for (const [kind, page] of [["popup", model.popup], ["options", model.options]] as const) {
    if (!page) continue;
    const bytes = files.get(page.page);
    if (!bytes) {
      warnings.push(`manifest.${page.key}: ${page.page} isn't in the extension, so the ${kind} was left out`);
      continue;
    }
    const bundle = await bundlePage(kind, page.page, decodeText(bytes), files, esbuild, warnings);
    // Measured: Tampermonkey doesn't load the modal's blob: images where the site's CSP limits img-src (spec §6).
    if (bundle.assets.some((path) => /^(image|font)\//.test(mimeOf(path)))) {
      warnings.push(`${page.page}: its images and fonts may not show under Tampermonkey on sites whose CSP limits img-src or font-src`);
    }
    pages.push(bundle);
  }
  return { pages, warnings };
}

async function bundlePage(kind: PageKind, path: string, html: string, files: ExtensionFiles, esbuild: EsbuildApi | undefined, warnings: string[]): Promise<PageBundle> {
  const assets = new Set<string>();
  const remoteImports: string[] = [];
  const css: string[] = [];
  // Chrome runs classic scripts as the parser meets them, then deferred and module scripts in document order.
  const code: string[] = [];
  const deferred: string[] = [];
  const asset = (target: string, from: string) => {
    const file = extensionPath(target, from);
    if (file === undefined || !files.has(file)) return undefined;
    assets.add(file);
    return assetPlaceholder(file);
  };
  const keep = (file: string) => files.has(file) && (assets.add(file), true);

  /** A node as the runtime builds it, or null for one that becomes CSS or code instead. */
  const visit = async (node: HtmlNode): Promise<PageNode | null> => {
    if (node.type === "text") return node.text;
    const attr = (name: string) => node.attributes.find(([key]) => key === name)?.[1];
    if (node.name === "script") {
      const src = attr("src");
      const type = (attr("type") ?? "").trim().toLowerCase();
      // A data block (type="text/template", "application/json", …) isn't code: it stays, for the code to read.
      if (src === undefined && type !== "" && type !== "module" && !/^(text|application)\/(x-)?(java|ecma)script$/.test(type)) return [node.name, node.attributes, node.children.map((child) => (child.type === "text" ? child.text : ""))];
      if (src === undefined) {
        warnings.push(`${path}: an inline <script> was left out, as an extension page's CSP never runs one`);
        return null;
      }
      const file = extensionPath(src, path);
      if (file === undefined || !files.has(file)) {
        warnings.push(`${path} loads ${src}, which isn't in the extension, so it was left out`);
        return null;
      }
      if (type === "module") {
        if (!esbuild) throw new Error(`convert: ${path} has a module script, which needs the esbuild option`);
        const bundle = await bundleModule(esbuild, files, file, { format: "iife", define: { "import.meta": "__x2uImportMeta" } });
        remoteImports.push(...bundle.remoteImports);
        // Each module script's import.meta.url is its own file's URL, under the extension's root (__x2uBase).
        deferred.push(`(function (__x2uImportMeta) {\n${bundle.code}\n})({ url: __x2uBase + ${JSON.stringify(file)} });`);
      } else {
        (attr("defer") !== undefined || attr("async") !== undefined ? deferred : code).push(decodeText(files.get(file) as Uint8Array));
      }
      return null;
    }
    if (node.name === "style") {
      css.push(rewriteCssUrls(node.children.map((child) => (child.type === "text" ? child.text : "")).join(""), path, keep));
      return null;
    }
    if (node.name === "link") {
      // A style sheet becomes CSS; any other link (an icon, a preload) does nothing in the modal.
      if (!/\bstylesheet\b/i.test(attr("rel") ?? "")) return null;
      const file = extensionPath(attr("href") ?? "", path);
      if (file === undefined || !files.has(file)) warnings.push(`${path} links ${attr("href")}, which isn't in the extension, so it was left out`);
      else css.push(rewriteCssUrls(decodeText(files.get(file) as Uint8Array), file, keep));
      return null;
    }
    // An extension page's CSP never runs inline handlers (onclick="…"), so they are left out.
    const attributes = node.attributes.filter(([name]) => !name.startsWith("on")).map(([name, value]): HtmlAttribute => {
      if (name === "src" || name === "poster") return [name, asset(value, path) ?? value];
      if (name === "srcset") return [name, value.replace(/([^\s,]+)(\s+[^,]+)?/g, (whole, url: string, size = "") => (asset(url, path) ?? url) + size)];
      if (name === "style") return [name, value.replace(CSS_URL, (whole, _quote, url: string) => { const placeholder = asset(url, path); return placeholder ? `url("${placeholder}")` : whole; })];
      return [name, value];
    });
    return [node.name, attributes, await visitAll(node.children)];
  };
  const visitAll = async (nodes: HtmlNode[]) => {
    const out: PageNode[] = [];
    for (const node of nodes) {
      const kept = await visit(node);
      if (kept !== null) out.push(kept);
    }
    return out;
  };

  const top = parseHtml(html);
  const element = (nodes: HtmlNode[], name: string) => nodes.find((node): node is Extract<HtmlNode, { type: "element" }> => node.type === "element" && node.name === name);
  const root = element(top, "html");
  const inside = root ? root.children : top;
  const head = element(inside, "head");
  const body = element(inside, "body");
  // Without <head> or <body>, head-only elements before the first other element go to the head, the rest to the body.
  const rest = inside.filter((node) => node !== head && node !== body);
  const firstBody = rest.findIndex((node) => node.type === "element" ? !HEAD.has(node.name) : node.text.trim() !== "");
  const headNodes = head ? head.children : rest.slice(0, firstBody === -1 ? rest.length : firstBody);
  const bodyNodes = body ? body.children : firstBody === -1 ? [] : rest.slice(firstBody);
  const title = headNodes.find((node): node is Extract<HtmlNode, { type: "element" }> => node.type === "element" && node.name === "title");
  const config: PageConfig = {
    path,
    ...(title ? { title: title.children.map((child) => (child.type === "text" ? child.text : "")).join("").trim() } : {}),
    htmlAttributes: root?.attributes ?? [],
    bodyAttributes: body?.attributes ?? [],
    head: await visitAll(headNodes),
    body: await visitAll(bodyNodes),
    css,
  };
  // A newline after each file ends a trailing // comment; the semicolon ends a statement left open (no ASI across files).
  return { kind, config, code: [...code, ...deferred].join("\n;\n"), assets: [...assets], remoteImports };
}
