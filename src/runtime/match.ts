// Chrome match patterns (https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) and the globs
// content scripts use. The runtime matches content groups with them (spec §5.5), manifest.ts validates the manifest's
// patterns with them, and the CI emulator honours @match with them.
import type { UrlFilter } from "./config.ts";

const PATTERN = /^(\*|https?|wss?|ftp|file):\/\/(\*|\*\.[^/*:[\]]+|\[[\da-fA-F:.]+\]|[^/*:[\]]+)?(?::(\d+|\*))?(\/.*)$/;
/** URLs drop their scheme's default port, so a pattern that names it must match URLs without a port. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: "80", https: "443", ws: "80", wss: "443", ftp: "21" };
const escapeRegExp = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const pathToRegExp = (path: string) => path.split("*").map(escapeRegExp).join(".*");

export function matchPatternToRegExp(pattern: string): RegExp {
  if (pattern === "<all_urls>") return /^(?:https?|wss?|ftp|file):\/\//;
  const parts = PATTERN.exec(pattern);
  if (!parts) throw new Error(`Invalid match pattern: ${pattern}`);
  const [, scheme, rawHost = "", port, path] = parts;
  if (scheme === "file") return new RegExp(`^file://${pathToRegExp(path)}$`);
  if (!rawHost) throw new Error(`Invalid match pattern (missing host): ${pattern}`);
  const host = rawHost.toLowerCase(); // URLs carry lower-case hosts, and Chrome compares the pattern's host the same way
  const schemeRe = scheme === "*" ? "https?" : scheme;
  const hostRe = host === "*" ? "[^/:]+" : host.startsWith("*.") ? `(?:[^/:]+\\.)?${escapeRegExp(host.slice(2))}` : escapeRegExp(host);
  // A pattern without a port matches any port, as in Chrome.
  const portRe = port === undefined || port === "*" ? "(?::\\d+)?" : port === DEFAULT_PORTS[scheme] ? "" : `:${port}`;
  return new RegExp(`^${schemeRe}://${hostRe}${portRe}${pathToRegExp(path)}$`);
}

/** True when the URL, ignoring its fragment, matches any of the patterns. */
export function urlMatches(url: string, patterns: readonly string[]): boolean {
  const target = url.split("#")[0];
  return patterns.some((pattern) => matchPatternToRegExp(pattern).test(target));
}

/** A content-script glob: `*` matches any run of characters and `?` exactly one, against the whole URL. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (const char of glob) source += char === "*" ? ".*" : char === "?" ? "." : escapeRegExp(char);
  return new RegExp(`^${source}$`);
}

/** Chrome's rule for a content-script group: its matches, narrowed by include_globs, minus exclude_matches and exclude_globs. */
export function filterMatches(url: string, filter: UrlFilter): boolean {
  const target = url.split("#")[0];
  const anyGlob = (globs: readonly string[]) => globs.some((glob) => globToRegExp(glob).test(target));
  return (
    urlMatches(url, filter.matches) &&
    (filter.includeGlobs.length === 0 || anyGlob(filter.includeGlobs)) &&
    !urlMatches(url, filter.excludeMatches) &&
    !anyGlob(filter.excludeGlobs)
  );
}
