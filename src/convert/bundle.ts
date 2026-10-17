// Extension code as the userscript runs it (spec §3.3).
// - Content scripts and classic backgrounds: files concatenated as text in manifest or page order, as a browser runs
//   classic scripts in one shared scope. Nothing is renamed or hoisted.
// - A classic service worker's importScripts("a.js", ...) with string literals is replaced by the files' contents.
// - ES modules (a module service worker, <script type="module"> in a background page) are bundled by esbuild into an
//   IIFE, with import.meta standing for an object the runtime passes in.
// emit.ts wraps the results.
import type { World } from "../runtime/config.ts";
import { bundleModule, type EsbuildApi } from "./esbuild.ts";
import { decodeText } from "./files.ts";
import type { Model } from "./manifest.ts";
import { dirname, joinPath } from "./paths.ts";
import { scan } from "./scan.ts";
import type { ExtensionFiles } from "./unpack.ts";

export type ContentCode = { world: World; code: string } | null;

/** The background's code, whether it is a service worker (no window or document), and its entry file. */
/** exports: a background page's top-level declarations, which getBackgroundPage hands out as its window's (spec §5.2). */
export type BackgroundBundle = { code: string; worker: boolean; entry: string; exports?: string[] };

/** One entry per content group: its concatenated JS, or null when it has none (a CSS-only group). */
export function bundleContent(model: Model, files: ExtensionFiles): { code: ContentCode[]; warnings: string[] } {
  const warnings: string[] = [];
  const code = model.contentScripts.map((group, i): ContentCode => {
    const parts = group.js.flatMap((path) => {
      const bytes = files.get(path);
      if (bytes) return [decodeText(bytes)];
      warnings.push(`content_scripts[${i}].js: ${path} isn't in the extension, so it was left out`);
      return [];
    });
    // A newline after each file ends a trailing // comment; the semicolon ends a statement left open (no ASI across files).
    return parts.length === 0 ? null : { world: group.world, code: parts.join("\n;\n") };
  });
  return { code, warnings };
}

const SCRIPT_TAG = /<script\b([^>]*)>/gi;
const attribute = (attributes: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attributes)?.slice(1).find((value) => value !== undefined);

export type BackgroundResult = {
  background: BackgroundBundle | null;
  warnings: string[];
  /** importScripts(...) calls whose arguments weren't all string literals, so they couldn't be inlined. */
  dynamicImportScripts: boolean;
  remoteImports: string[];
};

/**
 * An imported script's top-level declarations are globals, even when the call is inside a block
 * (try { importScripts(...) } catch {}). Inlined there, its let, const and class would stay in the block, so they become var.
 * ponytail: `var X = class X {...}` relies on ASI after the class body, so a next line starting with ( or [ would join it.
 */
function asGlobals(code: string): string {
  let out = code;
  for (const declaration of scan(code).lexical.sort((a, b) => b.start - a.start)) {
    const replacement = declaration.keyword === "class" ? `var ${declaration.name} = class` : "var";
    out = out.slice(0, declaration.start) + replacement + out.slice(declaration.start + declaration.keyword.length);
  }
  return out;
}

export async function bundleBackground(model: Model, files: ExtensionFiles, esbuild?: EsbuildApi): Promise<BackgroundResult> {
  const warnings: string[] = [];
  const remoteImports: string[] = [];
  let dynamicImportScripts = false;
  const text = (path: string, from: string) => {
    const bytes = files.get(path);
    if (bytes) return decodeText(bytes);
    warnings.push(`${from}: ${path} isn't in the extension, so it was left out`);
    return "";
  };
  const module = async (entry: string) => {
    if (!esbuild) throw new Error("convert: this extension's background is an ES module, which needs the esbuild option");
    const bundle = await bundleModule(esbuild, files, entry, { format: "iife", define: { "import.meta": "__x2uImportMeta" } });
    remoteImports.push(...bundle.remoteImports);
    return bundle.code;
  };
  // A worker resolves importScripts URLs against its own script, whichever file makes the call.
  const inline = (path: string, base: string, stack: string[]): string => {
    let code = text(path, stack.length === 0 ? "background.service_worker" : `importScripts in ${stack[stack.length - 1]}`);
    const calls = scan(code).importScripts.sort((a, b) => b.start - a.start);
    for (const call of calls) {
      if (!call.urls) {
        dynamicImportScripts = true;
        continue;
      }
      const parts = call.urls.map((url) => {
        let target: string;
        try {
          target = joinPath(url.startsWith("/") ? "" : base, url);
        } catch {
          warnings.push(`importScripts("${url}") in ${path} points outside the extension`);
          return "";
        }
        if (stack.includes(target) || target === path) {
          warnings.push(`importScripts("${url}") in ${path} imports itself, so it was left out the second time`);
          return "";
        }
        return inline(target, base, [...stack, path]);
      });
      const inlined = parts.join("\n;\n");
      code = `${code.slice(0, call.start)}/* importScripts(${call.urls.map((url) => JSON.stringify(url)).join(", ")}) */\n${call.nested ? asGlobals(inlined) : inlined}\n${code.slice(call.end)}`;
    }
    return code;
  };

  const background = model.background;
  let result: BackgroundBundle | null = null;
  if (background?.kind === "worker") {
    const code = background.module ? await module(background.entry) : inline(background.entry, dirname(background.entry), []);
    result = { code, worker: true, entry: background.entry };
  } else if (background?.kind === "scripts") {
    const code = background.files.map((path) => text(path, "background.scripts")).join("\n;\n");
    result = { code, worker: false, entry: background.files[0] ?? "background.js", exports: scan(code).declarations };
  } else if (background?.kind === "page") {
    // An MV2 background page: its scripts run in page order. Its own HTML isn't created (a ceiling the report states).
    const html = text(background.html, "background.page");
    const parts: string[] = [];
    for (const match of html.matchAll(SCRIPT_TAG)) {
      const src = attribute(match[1], "src");
      if (!src) continue; // extension pages can't run inline scripts
      if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith("//")) {
        warnings.push(`background.page loads ${src}, which isn't in the extension, so it was left out`);
        continue;
      }
      const path = joinPath(src.startsWith("/") ? "" : dirname(background.html), src);
      parts.push(attribute(match[1], "type") === "module" ? await module(path) : text(path, "background.page"));
    }
    const code = parts.join("\n;\n");
    result = { code, worker: false, entry: background.html, exports: scan(code).declarations };
  }
  return { background: result, warnings, dynamicImportScripts, remoteImports };
}
