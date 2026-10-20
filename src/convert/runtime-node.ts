// Builds the runtime (src/runtime/index.ts) into the IIFE string convert() embeds (spec §5). Node only: the CLI and the
// tests use it. The web app and the npm package's dist/cli.js (build.ts) ship a copy built ahead of time.
import { build } from "esbuild";

declare const __X2U_RUNTIME__: string | undefined;

let runtime: Promise<string> | undefined;

export function loadRuntime(): Promise<string> {
  // Set only in dist/cli.js, which ships without the runtime's source.
  if (typeof __X2U_RUNTIME__ === "string") return Promise.resolve(__X2U_RUNTIME__);
  runtime ??= build({
    entryPoints: [`${import.meta.dirname}/../runtime/index.ts`],
    bundle: true,
    format: "iife",
    globalName: "__x2uRuntime",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
    write: false,
  }).then((result) => scopeStrictMode(result.outputFiles[0].text.trim()));
  return runtime;
}

/**
 * esbuild starts an IIFE bundle of a module with "use strict". Any code placed after the bundle in the same script, such
 * as an extension's content scripts, would be strict too, so the directive moves inside the IIFE.
 */
export function scopeStrictMode(code: string): string {
  const head = /^"use strict";\s*(var [\w$]+\s*=\s*\(\(\)\s*=>\s*\{)/.exec(code);
  if (!head) throw new Error('scopeStrictMode: expected an esbuild IIFE bundle that starts with "use strict"');
  return `${head[1]}"use strict";${code.slice(head[0].length)}`;
}
