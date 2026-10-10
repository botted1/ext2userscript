// ES-module bundling for extension code (spec §3.3). The esbuild API is a parameter, so the same code runs on
// native esbuild in Node (esbuild-node.ts) and on esbuild-wasm in a browser worker (esbuild-browser.ts).
import type { Loader, Plugin } from "esbuild";
import { dirname, joinPath } from "./paths.ts";
import type { ExtensionFiles } from "./unpack.ts";

/** The part of the esbuild API used here. Native esbuild and esbuild-wasm both provide it. */
export type EsbuildApi = Pick<typeof import("esbuild"), "build">;
export type ModuleBundle = { code: string; remoteImports: string[] };

const LOADERS: Record<string, Loader> = { js: "js", mjs: "js", cjs: "js", json: "json", css: "css" };

/** Bundles an ES-module entry from the extension's files into one ESM string. Remote imports stay external and are listed. */
export async function bundleModule(esbuild: EsbuildApi, files: ExtensionFiles, entry: string): Promise<ModuleBundle> {
  const remoteImports: string[] = [];
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    write: false,
    logLevel: "silent",
    plugins: [extensionFiles(files, remoteImports)],
  });
  return { code: result.outputFiles[0].text, remoteImports };
}

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
