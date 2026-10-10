// Content-script code (spec §3.3): each group's JS files concatenated as text in manifest order, as a browser runs
// classic scripts in one shared scope. Nothing is renamed or hoisted. emit.ts wraps the result.
import type { World } from "../runtime/config.ts";
import { decodeText } from "./files.ts";
import type { Model } from "./manifest.ts";
import type { ExtensionFiles } from "./unpack.ts";

export type ContentCode = { world: World; code: string } | null;

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
