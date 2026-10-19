// The asset table (spec §3.6): the extension files the runtime can hand out as blob: URLs. Collected from getURL string
// literals, url() in content CSS, the manifest's icons (when there is a background) and web_accessible_resources; minus
// --ignore-assets globs.
// Content CSS is rewritten so each url() names its file through a placeholder the runtime resolves.
// Locales don't go here: every messages.json is in the runtime config already, as parsed JSON.
import { ASSET_PREFIX } from "../runtime/assets.ts";
import type { AssetTable } from "../runtime/config.ts";
import { decodeText, mimeOf, toBase64 } from "./files.ts";
import type { Model } from "./manifest.ts";
import { dirname, joinPath } from "./paths.ts";
import type { ExtensionFiles } from "./unpack.ts";

export type Assets = {
  table: AssetTable;
  /** Per content group, its CSS files' text with url() targets rewritten to placeholders. */
  css: string[][];
  warnings: string[];
};

/** A path glob from web_accessible_resources or --ignore-assets: `*` matches any run of characters, including `/`. */
export function pathGlob(glob: string): RegExp {
  const source = glob.replace(/^\/+/, "").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`);
}

const CSS_URL = /url\(\s*(["']?)([^"')]*?)\1\s*\)/g;

export function collectAssets(model: Model, files: ExtensionFiles, getUrls: readonly string[], ignore: readonly string[] = []): Assets {
  const ignored = ignore.map(pathGlob);
  const wanted = new Set<string>();
  const warnings: string[] = [];
  /** Adds a file to the table unless it's ignored; false when it can't be served. */
  const include = (path: string, from: string): boolean => {
    if (ignored.some((glob) => glob.test(path))) return false;
    if (!files.has(path)) {
      warnings.push(`${from} refers to ${path}, which isn't in the extension`);
      return false;
    }
    wanted.add(path);
    return true;
  };

  for (const url of getUrls) {
    try {
      include(joinPath("", url), "runtime.getURL");
    } catch {
      warnings.push(`runtime.getURL("${url}") points outside the extension`);
    }
  }
  // The extension's icons, which a background's notifications usually show.
  if (model.background) for (const path of Object.values(model.icons)) include(path, "icons");
  // Source maps are web-accessible for the page's developer tools; no extension code reads them, and they can be most
  // of an archive (Augmented Steam's are 100 MB). One the code names by getURL stays in.
  const sourceMaps = new Set<string>();
  for (const resource of model.webAccessibleResources) {
    const glob = pathGlob(resource);
    for (const path of files.keys()) {
      if (!glob.test(path) || ignored.some((ignore) => ignore.test(path)) || wanted.has(path)) continue;
      if (path.endsWith(".map")) sourceMaps.add(path);
      else wanted.add(path);
    }
  }
  if (sourceMaps.size > 0) warnings.push(`${sourceMaps.size} source map${sourceMaps.size === 1 ? "" : "s"} (*.map) in web_accessible_resources left out: only developer tools read them`);
  const css = model.contentScripts.map((group, i) =>
    group.css.flatMap((path) => {
      const bytes = files.get(path);
      if (!bytes) {
        warnings.push(`content_scripts[${i}].css: ${path} isn't in the extension`);
        return [];
      }
      return [rewriteCssUrls(decodeText(bytes), path, (asset) => include(asset, path))];
    }),
  );

  const table: AssetTable = {};
  for (const path of [...wanted].sort()) table[path] = [mimeOf(path), toBase64(files.get(path) as Uint8Array)];
  return { table, css, warnings };
}

/** The asset placeholder for an extension file, which the runtime swaps for the file's blob: URL (src/runtime/assets.ts). */
export const assetPlaceholder = (path: string) => `${ASSET_PREFIX}${encodeURIComponent(path)}`;

/** Rewrites each url() in CSS that names an extension file the table will hold (keep says whether it does) to a placeholder. */
export function rewriteCssUrls(css: string, cssPath: string, keep: (asset: string) => boolean): string {
  return css.replace(CSS_URL, (whole, _quote, target: string) => {
    const asset = extensionPath(target, cssPath);
    return asset !== undefined && keep(asset) ? `url("${assetPlaceholder(asset)}")` : whole;
  });
}

/** The extension file a URL in a file at fromPath points at, or undefined for data:, remote and fragment-only URLs. */
export function extensionPath(target: string, fromPath: string): string | undefined {
  const url = target.trim().replace(/[?#].*$/, "");
  if (url === "" || url.startsWith("#") || url.startsWith("//") || /^(?:data|https?|blob|about|file):/i.test(url)) return undefined;
  const own = /^(?:chrome|moz)-extension:\/\/__MSG_@@extension_id__\/(.*)$/i.exec(url);
  try {
    return own ? joinPath("", own[1]) : joinPath(url.startsWith("/") ? "" : dirname(fromPath), url);
  } catch {
    return undefined;
  }
}
