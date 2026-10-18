// Builds the web app (spec §8) into a static folder: the page, its style and script, the conversion worker with the
// built runtime inside, and esbuild-wasm's .wasm, which the worker fetches only when a conversion needs it.
// Usage: npm run web [-- out-dir] [--serve]; X2U_PROXY_URL, if set, is the download proxy's URL (proxy/README.md).
// --serve serves the folder at http://localhost:8000/, rebuilding the scripts on each request.
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { build, context, type BuildOptions } from "esbuild";
import { loadRuntime } from "../src/convert/runtime-node.ts";

const here = (file: string) => join(import.meta.dirname, file);

async function scripts(outDir: string, proxyUrl = ""): Promise<BuildOptions> {
  return {
    entryPoints: { main: here("main.ts"), worker: here("worker.ts") },
    outdir: outDir,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
    logLevel: "warning",
    define: { __X2U_RUNTIME__: JSON.stringify(await loadRuntime()), __X2U_PROXY__: JSON.stringify(proxyUrl) },
  };
}

export async function buildWeb(outDir: string, options: { proxyUrl?: string } = {}): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await build(await scripts(outDir, options.proxyUrl));
  for (const file of ["index.html", "style.css"]) await copyFile(here(file), join(outDir, file));
  await copyFile(join(import.meta.dirname, "..", "node_modules", "esbuild-wasm", "esbuild.wasm"), join(outDir, "esbuild.wasm"));
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const outDir = args.find((arg) => !arg.startsWith("--")) ?? "dist/web";
  const proxyUrl = process.env.X2U_PROXY_URL;
  await buildWeb(outDir, { proxyUrl });
  console.log(`Built the web app into ${outDir}`);
  if (args.includes("--serve")) {
    const server = await (await context(await scripts(outDir, proxyUrl))).serve({ servedir: outDir, port: 8000 });
    console.log(`Serving it at http://localhost:${server.port}/`);
  }
}
