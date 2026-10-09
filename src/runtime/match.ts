// Chrome match patterns (https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns).
// Used by the runtime for per-group matching (spec §5.5) and by the CI emulator for @match.

const PATTERN = /^(\*|https?|wss?|ftp|file):\/\/(\*|\*\.[^/*:]+|[^/*:]+)?(?::(\d+|\*))?(\/.*)$/;
const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const pathToRegExp = (path: string) => path.split("*").map(escape).join(".*");

export function matchPatternToRegExp(pattern: string): RegExp {
  if (pattern === "<all_urls>") return /^(?:https?|wss?|ftp|file):\/\//;
  const parts = PATTERN.exec(pattern);
  if (!parts) throw new Error(`Invalid match pattern: ${pattern}`);
  const [, scheme, host = "", port, path] = parts;
  if (scheme === "file") return new RegExp(`^file://${pathToRegExp(path)}$`);
  if (!host) throw new Error(`Invalid match pattern (missing host): ${pattern}`);
  const schemeRe = scheme === "*" ? "https?" : scheme;
  const hostRe = host === "*" ? "[^/:]+" : host.startsWith("*.") ? `(?:[^/:]+\\.)?${escape(host.slice(2))}` : escape(host);
  // A pattern without a port matches any port, as in Chrome.
  const portRe = port === undefined || port === "*" ? "(?::\\d+)?" : `:${port}`;
  return new RegExp(`^${schemeRe}://${hostRe}${portRe}${pathToRegExp(path)}$`);
}

/** True when the URL, ignoring its fragment, matches any of the patterns. */
export function urlMatches(url: string, patterns: readonly string[]): boolean {
  const target = url.split("#")[0];
  return patterns.some((pattern) => matchPatternToRegExp(pattern).test(target));
}
