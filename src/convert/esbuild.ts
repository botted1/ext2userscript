// ES-module bundling for extension code (spec §3.3). The esbuild API is a parameter, so the same code runs on
// native esbuild in Node (esbuild-node.ts) and on esbuild-wasm in a browser worker (esbuild-browser.ts).
import type { Loader, Plugin } from "esbuild";
import { dirname, joinPath } from "./paths.ts";
import type { ExtensionFiles } from "./unpack.ts";

/** The part of the esbuild API used here. Native esbuild and esbuild-wasm both provide it. */
export type EsbuildApi = Pick<typeof import("esbuild"), "build" | "transform">;
export type ModuleBundle = { code: string; remoteImports: string[] };

const LOADERS: Record<string, Loader> = { js: "js", mjs: "js", cjs: "js", json: "json", css: "css" };

export type ModuleOptions = {
  /**
   * "iife" leaves no export statements behind, so the bundle can sit inside a function (a module background); one with
   * a top-level await becomes an async function called at once. "function" is `async (__x2uImportMeta) => exports`,
   * what a dynamic import() resolves to.
   */
  format?: "esm" | "iife" | "function";
  /** esbuild's define, e.g. { "import.meta": "__x2uImportMeta" }. */
  define?: Record<string, string>;
};

/**
 * esbuild loaded on first use: the web app's esbuild-wasm is 14 MB, and most extensions convert without it (spec §8).
 * A failed load fails that call only; the next one tries again (loadEsbuild clears its own failure).
 */
export function lazyEsbuild(load: () => Promise<EsbuildApi>): EsbuildApi {
  return {
    build: (async (options: Parameters<EsbuildApi["build"]>[0]) => (await load()).build(options)) as EsbuildApi["build"],
    transform: (async (input: string, options?: Parameters<EsbuildApi["transform"]>[1]) => (await load()).transform(input, options)) as EsbuildApi["transform"],
  };
}

/** Bundles an ES-module entry from the extension's files into one string. Remote imports stay external and are listed. */
export async function bundleModule(esbuild: EsbuildApi, files: ExtensionFiles, entry: string, options: ModuleOptions = {}): Promise<ModuleBundle> {
  const remoteImports: string[] = [];
  const build = (format: "esm" | "iife", target: string) =>
    esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format,
      platform: "browser",
      target,
      write: false,
      logLevel: "silent",
      ...(options.define ? { define: options.define } : {}),
      plugins: [extensionFiles(files, remoteImports)],
    });
  if (options.format !== "function") {
    try {
      const result = await build(options.format ?? "esm", "es2020");
      return { code: result.outputFiles[0].text, remoteImports };
    } catch (error) {
      if (options.format !== "iife" || !usesTopLevelAwait(error)) throw error;
    }
    remoteImports.length = 0;
  }
  const result = await build("esm", "es2022");
  const fn = asyncFunction(result.outputFiles[0].text);
  if (options.format === "function") return { code: fn, remoteImports };
  // Its remote imports would be import statements inside a function, which stop the whole userscript from parsing.
  if (remoteImports.length > 0) throw new Error(`convert: ${entry} has a top-level await and imports ${remoteImports.join(", ")}: remote modules can't be bundled`);
  // An IIFE can't hold a top-level await, so this entry runs in an async function instead, and an error it throws is
  // thrown again outside the promise, as a failed module's is uncaught.
  return { code: `(${fn})(__x2uImportMeta).catch((error) => setTimeout(() => {\n  throw error;\n}));\n`, remoteImports };
}

/**
 * An ES-module bundle as `async (__x2uImportMeta) => namespace`: its code in the function, which can hold a top-level
 * await, and its closing export statement (esbuild writes one, last) as the object the function resolves to.
 * ponytail: the namespace is a snapshot, not live bindings.
 */
export function asyncFunction(esm: string): string {
  // The last export statement, with only comments after it (esbuild puts license comments at the very end).
  const exports = [...esm.matchAll(/\nexport \{([^}]*)\};/g)].filter((match) => /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*$/.test(esm.slice((match.index ?? 0) + match[0].length))).pop();
  const members = (exports?.[1] ?? "").split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const [local, exported = local] = item.split(/\s+as\s+/);
    return `${JSON.stringify(exported)}: ${local}`;
  });
  const code = exports ? esm.slice(0, exports.index) + esm.slice((exports.index ?? 0) + exports[0].length) : esm;
  return `async (__x2uImportMeta) => {\n"use strict";\n${code}\nreturn { ${members.join(", ")} };\n}`;
}

/** esbuild 0.28 refuses a top-level await in an IIFE with this message. */
const usesTopLevelAwait = (error: unknown) =>
  ((error as { errors?: Array<{ text: string }> }).errors ?? []).some((e) => e.text.startsWith("Top-level await is not available in the configured target environment"));

function extensionFiles(files: ExtensionFiles, remoteImports: string[]): Plugin {
  return {
    name: "x2u-extension-files",
    setup(build) {
      build.onResolve({ filter: /^https?:\/\// }, (args) => {
        remoteImports.push(args.path);
        return { path: args.path, external: true };
      });
      build.onResolve({ filter: /.*/ }, (args) => {
        const base = args.path.startsWith("/") || !args.importer ? "" : dirname(args.importer);
        const path = joinPath(base, args.path);
        if (!files.has(path)) return { errors: [{ text: `${args.path} (imported from ${args.importer || "the manifest"}) is not in the extension` }] };
        return { path, namespace: "x2u" };
      });
      build.onLoad({ filter: /.*/, namespace: "x2u" }, (args) => ({
        contents: files.get(args.path),
        loader: LOADERS[args.path.slice(args.path.lastIndexOf(".") + 1)] ?? "js",
      }));
    },
  };
}
