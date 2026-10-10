# ext2userscript Plan 2: Converter Core and CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an extension into a working userscript end to end for the content-script context, with an honest compatibility report, from a CLI that reads store links, archives and folders.

**Architecture:**
- `convert(files, options)` (in `src/convert/index.ts`) is isomorphic. It is pure apart from esbuild, which it uses only for `--minify`, and it runs the same in Node and the browser. The pipeline:
  1. `manifest.ts` normalises the manifest into one model.
  2. `bundle.ts` concatenates each content group's files.
  3. `scan.ts` and `analyze.ts` read the `chrome.*` use against `support.ts`.
  4. `assets.ts` builds the asset table.
  5. `metadata.ts` writes the header.
  6. `emit.ts` assembles the userscript.
- The runtime (`src/runtime/index.ts`) is bundled by esbuild into one IIFE string (`runtime-node.ts`), which `emit.ts` embeds. At page load it:
  - matches content groups against the URL and frame;
  - injects their CSS;
  - runs their JS at each group's `run_at`, with a `chrome` object holding `runtime`, `storage`, `i18n` and `extension`.
- `src/source.ts` and `src/cli.ts` are the Node-only shell around the core: store downloads, archives, folders, the report table, and exit codes.

**Tech Stack:**
- TypeScript, run directly by Node 22.16 with `--experimental-strip-types`.
- `node:test`.
- Playwright 1.64, using the Plan 1 emulator and the release-tier harness.
- esbuild 0.28.2 and fflate 0.8.3.
- No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`

**Scope:** Plan 2 of 6. It converts the **content-script context** end to end. Each later context comes with its runtime:
- Background bundling and boot, messaging, tabs and the network shim come in Plan 3. That includes the ES-module and `importScripts` bundling, and the `import.meta` decision carried from Plan 1.
- Popup and options come in Plan 4, which also chooses the HTML parser.

Until then, the report marks those parts **unsupported** ("…isn't converted yet"). So an extension with a background gets the verdict `unlikely`, which is the truth for this version's output. `support.ts` grows with the runtime: each later plan adds its rows along with the code that implements them.

**Prototype:** every code block in this plan was run before the plan was written, on 2026-10-10:
- **Unit tests:** 165 of 165 pass.
- **Type check:** `tsc` is clean.
- **Plan 1 regression:** the emulator browser tests (emulator, conformance, S4) pass 19, with 1 skipped as designed.
- **New end-to-end test, emulator:** 5 of 5 in three runs.
- **New end-to-end test, real managers:** 10 of 10 on Tampermonkey 5.5.1 and Violentmonkey 2.49.0.

The prototype found two bugs that the plan fixes:
- esbuild's leading `"use strict"` would make every extension's code strict (Task 11).
- The Plan 1 emulator ran userscripts in strict mode, which real managers don't (Task 11).

**Spec corrections (Task 1 applies them; they need the human's OK along with this plan):**
1. **§4:** `include_globs` and `exclude_globs` aren't written to the header. An `@include` adds URLs to the `@match` list instead of narrowing it, and an `@exclude` would also hide pages that other groups match. The runtime applies them.
   - `@exclude-match` is written only for patterns that every group excludes.
2. **§3.5:** the verdict is `partial` when there are partial entries, *or unsupported entries outside background and content*. As written, an unsupported popup left the verdict at `likely-works`.
3. **§3.6:** the `_locales` files go into the runtime config as parsed JSON, not into the asset table, because `i18n.getMessage` picks the locale in the browser.
4. **Status line:** the spike revisions are approved (2026-10-10).

**Carried from Plan 1's ledger:**
- Every `matches`/`exclude_matches` pattern is validated at build time, with an error naming the key (Task 5).
- Match patterns:
  - upper-case hosts;
  - IPv6 hosts;
  - default ports (Task 1).
- Unpacking:
  - checks each entry's CRC-32;
  - rejects ambiguous archives (duplicates, a file that is also a folder);
  - bounds the zip64 entry count (the CPU denial of service);
  - handles backslash folder entries (Task 2).
- `fetchBytes` gets a timeout and a size limit (Task 12).
- Deferred to Plan 3, with ES-module bundling: `import.meta` in function-wrapped ESM.

## Global Constraints

- **Node:** Node ≥ 22.16. TypeScript runs directly with `--experimental-strip-types --disable-warning=ExperimentalWarning`. No tsx, no build step.
- **Running things:**
  - One test file: `npm run test:file -- <path>`.
  - One script: `npm run script -- <path>`.
- **TypeScript:**
  - Erasable syntax only (no `enum`, `namespace` or parameter properties).
  - Relative imports end in `.ts`.
  - Type-only imports use `import type` or inline `type`.
  - `tsconfig.json` enforces this (`erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`). The `lib` is `es2022` plus DOM, so there is no `Array.prototype.findLast`.
- **Exact versions:**
  - `esbuild` 0.28.2 and `esbuild-wasm` 0.28.2 (the two must match).
  - `fflate` 0.8.3.
  - Dev: `playwright` 1.64.0, `typescript` 7.0.2, `@types/node` 22.20.5.
  - No other dependencies.
- **Tests:** `node:test` with `node:assert/strict`. Browser tests use the `playwright` library, not `@playwright/test`.
- **Isomorphic core:**
  - `src/convert/*` and `src/runtime/*` import no `node:` module and use no Node-only global (`Buffer`, `process`).
  - Exceptions: `src/convert/esbuild-node.ts` and `src/convert/runtime-node.ts`.
  - `src/source.ts` and `src/cli.ts` are Node-only.
- **The GM layer:** every GM call goes through `src/runtime/gm.ts`, and no other `src/` file names a `GM_*` function. `@grant` lines come from its `GRANTS` table, via `grantsFor`.
- **GM value keys:**
  - `x2u:<ns>:tab:<id>`, `x2u:<ns>:out:<id>` and `x2u:<ns>:roster` (Plan 1);
  - `x2u:<ns>:s:<area>:<key>` (`chrome.storage`, spec §5.2);
  - `x2u:<ns>:storage-keys` (the storage doorbell, new in this plan).
- **Errors (spec §9):**
  - **Hard errors only for:**
    - an unreadable archive;
    - an invalid `manifest.json`, which includes an invalid match pattern and a path outside the extension;
    - an esbuild failure.
  - Everything else becomes a report entry or a report warning.
  - Runtime logs start with `[ext2userscript:<name>]`.
  - An unavailable API fails with `ext2userscript: chrome.<api> is not available in userscripts`, logged once per page.
- **The runtime bundle:**
  - `runtime-node.ts` builds `src/runtime/index.ts` as an IIFE named `__x2uRuntime`, with its `"use strict"` inside the IIFE.
  - Every userscript calls `__x2uRuntime.start(config, code)` once.
  - Extension code stays in sloppy mode.
- **Binaries:** third-party extension and manager binaries are never committed. `bench/.cache/` is git-ignored.
- **Real managers:** the release-tier profile (`bench/.cache/profile`) is used by one browser at a time. Leave no Chrome for Testing process running.
- **Commits:** every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Each commit step passes it as a second `-m`.

## Review Focus

1. **Content code that declares its own `browser` or `chrome`.** Code such as `const browser = chrome;` must load. The wrapper's parameters live in an outer function, so the code's own scope can redeclare them. Pinned in Task 10 (`emit.test.ts`, "lets content code declare its own chrome or browser") and Task 11 (the sample's `content.js`).
2. **File boundaries in concatenated content scripts.**
   - A file whose last line is a `//` comment with no newline must not swallow the next file.
   - A file starting with a byte-order mark must still run.
   - Sloppy-mode code (assigning an undeclared name) must not become strict.
   - Pinned in Task 10 (`emit.test.ts`, bundleContent) and Task 11 (`runtime-build.test.ts`, "keeps its strict mode to itself"; the sample's `lib.js`).
3. **Large bundles.** A 5 MB content bundle must scan in well under 2 s. Pinned in Task 6 (`scan.test.ts`).
4. **Every kind of CSS `url()`:**
   - quoted and unquoted, with spaces;
   - `data:`, remote and protocol-relative URLs;
   - fragment-only URLs (`#filter`);
   - `chrome-extension://__MSG_@@extension_id__/…`;
   - missing files.
   - Pinned in Task 8 (`assets.test.ts`, "rewrites url() in content CSS").
5. **webextension-polyfill and failing groups.**
   - A content script that checks `globalThis.chrome?.runtime?.id` while loading (webextension-polyfill 0.10+) must pass the check.
   - A group that throws must not stop the other groups (spec §9).
   - Pinned in Task 11 (the sample's `lib.js` and `broken.js`, checked by `content-runtime.test.ts`).

---

### Task 1: Spec corrections, shared runtime types, match patterns and globs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-ext2userscript-design.md` (status line, §3.5, §3.6, §4)
- Create: `src/runtime/config.ts`
- Modify: `src/runtime/match.ts` (whole file below)
- Test: `test/unit/content-match.test.ts`

**Interfaces:**
- Produces:
  - `src/runtime/config.ts`: `RunAt`, `World`, `Message`, `Messages`, `UrlFilter`, `GroupConfig`, `AssetTable`, `RuntimeConfig`, `GroupCode`. These are the types the converter and the runtime share.
  - `src/runtime/match.ts`:
    - `matchPatternToRegExp(pattern)` and `urlMatches(url, patterns)`: same signatures, now with lower-cased hosts, IPv6 hosts and default ports;
    - `globToRegExp(glob): RegExp`;
    - `filterMatches(url, filter: UrlFilter): boolean`.

- [ ] **Step 1: Write the failing test** `test/unit/content-match.test.ts`

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterMatches, globToRegExp, urlMatches } from "../../src/runtime/match.ts";

describe("match patterns, Plan 2 additions", () => {
  it("compares the pattern's host lower-cased", () => {
    assert.equal(urlMatches("https://github.com/a", ["https://GitHub.com/*"]), true);
  });

  it("accepts IPv6 hosts", () => {
    assert.equal(urlMatches("http://[::1]:8080/a", ["http://[::1]/*"]), true);
    assert.equal(urlMatches("http://[::2]/a", ["http://[::1]/*"]), false);
  });

  it("treats a scheme's default port as no port", () => {
    assert.equal(urlMatches("https://example.com/x", ["https://example.com:443/*"]), true);
    assert.equal(urlMatches("http://example.com/x", ["http://example.com:80/*"]), true);
    assert.equal(urlMatches("https://example.com:8443/x", ["https://example.com:443/*"]), false);
  });
});

describe("globToRegExp", () => {
  it("matches * as any run and ? as one character, across the whole URL", () => {
    assert.equal(globToRegExp("*glob-yes*").test("http://a.test/glob-yes.html"), true);
    assert.equal(globToRegExp("http://a.test/?.html").test("http://a.test/x.html"), true);
    assert.equal(globToRegExp("http://a.test/?.html").test("http://a.test/xy.html"), false);
    assert.equal(globToRegExp("http://a.test/a+b(c).html").test("http://a.test/a+b(c).html"), true);
  });
});

describe("filterMatches", () => {
  const filter = { matches: ["https://a.test/*"], excludeMatches: ["https://a.test/private/*"], includeGlobs: [], excludeGlobs: [] };

  it("applies matches and exclude_matches", () => {
    assert.equal(filterMatches("https://a.test/x", filter), true);
    assert.equal(filterMatches("https://a.test/private/x", filter), false);
    assert.equal(filterMatches("https://b.test/x", filter), false);
  });

  it("narrows matches with include_globs", () => {
    const narrowed = { ...filter, includeGlobs: ["*/docs/*", "*/blog/*"] };
    assert.equal(filterMatches("https://a.test/docs/1", narrowed), true);
    assert.equal(filterMatches("https://a.test/blog/1", narrowed), true);
    assert.equal(filterMatches("https://a.test/x", narrowed), false);
  });

  it("subtracts exclude_globs, ignoring the fragment", () => {
    const excluded = { ...filter, excludeGlobs: ["*.pdf"] };
    assert.equal(filterMatches("https://a.test/file.pdf#page=2", excluded), false);
    assert.equal(filterMatches("https://a.test/file.html", excluded), true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/content-match.test.ts`
Expected: FAIL. `globToRegExp` and `filterMatches` aren't exported, and the host and port cases fail.

- [ ] **Step 3: Write `src/runtime/config.ts`**

```ts
// Types shared by the converter (src/convert) and the runtime it embeds in every userscript (src/runtime).

export type RunAt = "document_start" | "document_end" | "document_idle";
export type World = "ISOLATED" | "MAIN";

export type Message = { message: string; placeholders?: Record<string, { content: string }> };
/** One locale's messages.json. Message and placeholder names are lower-cased, because Chrome ignores their case. */
export type Messages = Record<string, Message>;

/** Which URLs a content-script group runs on (Chrome's matches, exclude_matches, include_globs, exclude_globs). */
export type UrlFilter = { matches: string[]; excludeMatches: string[]; includeGlobs: string[]; excludeGlobs: string[] };

export type GroupConfig = UrlFilter & {
  runAt: RunAt;
  allFrames: boolean;
  world: World;
  /** The group's CSS files, in order, with asset URLs replaced by placeholders (see src/runtime/assets.ts). */
  css: string[];
};

/** Extension files the runtime can hand out as blob: URLs, by path: [MIME type, base64 bytes]. */
export type AssetTable = Record<string, [mime: string, base64: string]>;

export type RuntimeConfig = {
  /** The extension's name, for log prefixes. */
  name: string;
  /** Namespace for GM value keys (x2u:<ns>:…). */
  ns: string;
  /** chrome.runtime.id. */
  id: string;
  /** manifest.json as parsed, for chrome.runtime.getManifest(). */
  manifest: unknown;
  groups: GroupConfig[];
  assets: AssetTable;
  /** Every locale's messages, keyed by the _locales folder name. */
  locales: Record<string, Messages>;
  defaultLocale?: string;
  /** Set by --locale: i18n uses this locale instead of the browser's languages. */
  locale?: string;
};

/**
 * One entry per content group, in manifest order: isolated-world code as a factory that takes the chrome and browser
 * objects and returns the code to run, MAIN-world code as source text, or null for a group without JS.
 */
export type GroupCode = ((chrome: unknown, browser: unknown) => () => void) | string | null;
```

- [ ] **Step 4: Replace `src/runtime/match.ts`**

```ts
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
```

- [ ] **Step 5: Run the match tests**

Run: `npm run test:file -- test/unit/content-match.test.ts` and `npm run test:file -- test/unit/match.test.ts`
Expected: both PASS (the Plan 1 cases are unchanged).

- [ ] **Step 6: Apply the spec corrections** in `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`. Each replacement is exact:

1. Line 4. Replace `Status: reviewed 2026-10-09; GM-layer revision applied; spike revisions (§5.1, §5.5, §6) applied 2026-10-10, awaiting review` with:
   `Status: reviewed 2026-10-09; GM-layer revision applied; spike revisions (§5.1, §5.5, §6) approved 2026-10-10; Plan 2 corrections (§3.5, §3.6, §4) applied 2026-10-10`
2. §3.5. Replace ``- `partial` if there are partial entries.`` with:
   ``- `partial` if there are partial entries, or unsupported entries in other contexts (popup, options, page).``
3. §3.6. Replace ``plus all of `web_accessible_resources` and `_locales`.`` with ``plus all of `web_accessible_resources`.``. Then add this bullet after the "Collected" bullet:
   ``- **Locales:** every `_locales/<locale>/messages.json` goes into the runtime config as parsed JSON, not into the asset table, because `i18n.getMessage` picks the locale in the browser.``
4. §4 table. Replace the row ``| `exclude_matches` | `@exclude-match` |`` with:
   ``| `exclude_matches` | `@exclude-match` for the patterns every group excludes; the runtime applies the rest |``
   Replace the row ``| `include_globs` / `exclude_globs` | `@include` / `@exclude` (glob syntax supported by both managers) |`` with:
   ``| `include_globs` / `exclude_globs` | not in the header; the runtime applies them. An `@include` adds URLs to the `@match` list instead of narrowing it, and an `@exclude` would also hide pages other groups match. |``

- [ ] **Step 7: Type-check and commit**

Run: `npm run typecheck` (expected: exit 0), then:

```bash
git add src/runtime/config.ts src/runtime/match.ts test/unit/content-match.test.ts docs/superpowers/specs/2026-10-09-ext2userscript-design.md
git commit -m "Match content groups the way Chrome does, and record Plan 2's spec corrections" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Unpack untrusted archives safely

**Files:**
- Modify: `src/convert/unpack.ts` (whole file below)
- Modify: `test/unit/unpack.test.ts` (one test changes)
- Test: `test/unit/unpack-hardening.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `unpack(bytes): ExtensionFiles` and `type ExtensionFiles`, with the same signatures. It reads the zip's central directory itself and then:
  - limits the entries to 50,000 and the unpacked size to 512 MiB;
  - rejects duplicate and file-and-folder names;
  - checks each entry's CRC-32 and size after inflating;
  - reads zip64 end records.

- [ ] **Step 1: Write the failing test** `test/unit/unpack-hardening.test.ts`

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { unpack } from "../../src/convert/unpack.ts";

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));

/** Overwrites a little-endian field of the first central-directory header; `field` is its offset from that header. */
function patchCentral(zipBytes: Uint8Array, field: number, value: number, bytes: 2 | 4 = 4): Uint8Array {
  const out = zipBytes.slice();
  const header = out.findIndex((_, i) => out[i] === 0x50 && out[i + 1] === 0x4b && out[i + 2] === 0x01 && out[i + 3] === 0x02);
  const view = new DataView(out.buffer);
  if (bytes === 2) view.setUint16(header + field, value, true);
  else view.setUint32(header + field, value, true);
  return out;
}

/** fflate writes no archive comment, so the end-of-central-directory record is the last 22 bytes. */
function patchEnd(zipBytes: Uint8Array, field: number, value: number): Uint8Array {
  const out = zipBytes.slice();
  new DataView(out.buffer).setUint16(out.length - 22 + field, value, true);
  return out;
}

/** Rewrites a zip's end records the zip64 way: the classic record says "see zip64", and a zip64 record holds the numbers. */
function toZip64(zipBytes: Uint8Array, count?: bigint): Uint8Array {
  const eocd = zipBytes.length - 22;
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const entries = BigInt(view.getUint16(eocd + 10, true));
  const out = new Uint8Array(zipBytes.length + 56 + 20);
  out.set(zipBytes.subarray(0, eocd));
  const o = new DataView(out.buffer);
  o.setUint32(eocd, 0x06064b50, true);
  o.setBigUint64(eocd + 4, 44n, true);
  o.setBigUint64(eocd + 24, count ?? entries, true);
  o.setBigUint64(eocd + 32, count ?? entries, true);
  o.setBigUint64(eocd + 40, BigInt(view.getUint32(eocd + 12, true)), true);
  o.setBigUint64(eocd + 48, BigInt(view.getUint32(eocd + 16, true)), true);
  const locator = eocd + 56;
  o.setUint32(locator, 0x07064b50, true);
  o.setBigUint64(locator + 8, BigInt(eocd), true);
  o.setUint32(locator + 16, 1, true);
  const end = locator + 20;
  out.set(zipBytes.subarray(eocd), end);
  o.setUint16(end + 8, 0xffff, true);
  o.setUint16(end + 10, 0xffff, true);
  o.setUint32(end + 12, 0xffffffff, true);
  o.setUint32(end + 16, 0xffffffff, true);
  return out;
}

const body = "x".repeat(300); // long enough that fflate deflates it

describe("unpack hardening", () => {
  it("rejects a path that appears twice after normalising", () => {
    assert.throws(() => unpack(zip({ "manifest.json": "{}", "a.js": "1", "./a.js": "2" })), /Ambiguous archive: a\.js appears more than once/);
  });

  it("rejects a name that is both a file and a folder", () => {
    assert.throws(() => unpack(zip({ "manifest.json": "{}", a: "1", "a/b.js": "2" })), /Ambiguous archive: a is both a file and a folder/);
  });

  it("refuses an archive that claims too many entries, before reading them", () => {
    assert.throws(() => unpack(patchEnd(patchEnd(zip({ "manifest.json": "{}" }), 8, 60_000), 10, 60_000)), /too many files to unpack \(60000; limit 50000\)/);
  });

  it("reads a zip64 end record", () => {
    const files = unpack(toZip64(zip({ "manifest.json": "{}", "a.js": body })));
    assert.equal(new TextDecoder().decode(files.get("a.js")), body);
  });

  it("refuses a zip64 record that claims billions of entries", () => {
    assert.throws(() => unpack(toZip64(zip({ "manifest.json": "{}" }), 2n ** 40n)), /too many files to unpack/);
  });

  it("rejects an entry whose CRC doesn't match", () => {
    assert.throws(() => unpack(patchCentral(zip({ "manifest.json": body }), 16, 0x12345678)), /Corrupt or truncated archive \(manifest\.json fails its CRC check\)/);
  });

  it("rejects an entry whose declared size is smaller than its data", () => {
    assert.throws(() => unpack(patchCentral(zip({ "manifest.json": body }), 24, 3)), /manifest\.json fails its CRC check/);
  });

  it("rejects an entry whose declared size is larger than its data", () => {
    assert.throws(() => unpack(patchCentral(zip({ "manifest.json": body }), 24, 400)), /manifest\.json fails its CRC check/);
  });

  it("rejects encrypted entries", () => {
    assert.throws(() => unpack(patchCentral(zip({ "manifest.json": body }), 8, 1, 2)), /Encrypted archive entries aren't supported: manifest\.json/);
  });

  it("rejects a stored entry whose sizes disagree", () => {
    const stored = zipSync({ "manifest.json": strToU8("{}") }, { level: 0 });
    assert.throws(() => unpack(patchCentral(stored, 24, 1)), /manifest\.json has inconsistent sizes/);
  });

  it("rejects an entry whose data runs past the end of the archive", () => {
    assert.throws(() => unpack(patchCentral(zip({ "manifest.json": body }), 20, 0x100000)), /manifest\.json is cut short/);
  });

  it("treats a backslash-terminated name as a folder", () => {
    assert.deepEqual([...unpack(zip({ "manifest.json": "{}", "icons\\": "", "icons/a.png": "x" })).keys()].sort(), ["icons/a.png", "manifest.json"]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/unpack-hardening.test.ts`
Expected: FAIL. Duplicates are silently dropped, a lying size is accepted, zip64 is "Corrupt or truncated archive", and so on.

- [ ] **Step 3: Replace `src/convert/unpack.ts`**

```ts
// Unpacks extension archives in memory (spec §3.1). Runs in Node and in the browser.
// The zip's central directory is read here rather than by fflate's unzipSync, so every entry is checked before
// anything is inflated: the entry count, the total size, and that names are safe and unambiguous. Each entry's
// CRC-32 is checked after inflating, which catches an entry whose declared size is wrong.
import { inflateSync } from "fflate";

/** An unpacked extension: relative POSIX path → file bytes. */
export type ExtensionFiles = Map<string, Uint8Array>;

const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 50_000;

type Entry = { path: string; flags: number; method: number; crc: number; compressedSize: number; size: number; localOffset: number };

/** Unpacks a .zip, .xpi or .crx (v2 or v3). Throws a readable Error for anything else. */
export function unpack(bytes: Uint8Array): ExtensionFiles {
  const zip = zipPayload(bytes);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const files: ExtensionFiles = new Map();
  for (const entry of readEntries(zip, view)) files.set(entry.path, extract(zip, view, entry));
  if (!files.has("manifest.json")) throw new Error("Not an extension: manifest.json is missing from the archive");
  return files;
}

const corrupt = (detail: string, cause?: unknown) => new Error(`Corrupt or truncated archive (${detail})`, { cause });
const tooLarge = () => new Error(`Archive is too large to unpack (limit ${MAX_UNPACKED_BYTES / 1024 / 1024} MiB)`);

function readEntries(zip: Uint8Array, view: DataView): Entry[] {
  const eocd = findEndRecord(zip, view);
  let count = view.getUint16(eocd + 10, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) ({ count, cdSize, cdOffset } = readZip64(view, eocd));
  // Checked before the loop: a zip64 record can claim billions of entries in a few bytes.
  if (count > MAX_ENTRIES) throw new Error(`Archive has too many files to unpack (${count}; limit ${MAX_ENTRIES})`);
  const cdEnd = cdOffset + cdSize;
  if (cdEnd > eocd) throw corrupt("the central directory is out of bounds");
  const decoder = new TextDecoder();
  const entries: Entry[] = [];
  const paths = new Set<string>();
  let total = 0;
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > cdEnd || view.getUint32(at, true) !== 0x02014b50) throw corrupt("bad central directory entry");
    const nameLength = view.getUint16(at + 28, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    const entry = {
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    };
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (/[/\\]$/.test(name)) continue; // a directory entry
    total += entry.size;
    if (entry.size === 0xffffffff || total > MAX_UNPACKED_BYTES) throw tooLarge();
    const path = safePath(name);
    if (paths.has(path)) throw new Error(`Ambiguous archive: ${path} appears more than once`);
    paths.add(path);
    entries.push({ path, ...entry });
  }
  // A name that is both a file and a folder (a and a/b) can't be unpacked faithfully.
  for (const path of paths) {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      if (paths.has(path.slice(0, slash))) throw new Error(`Ambiguous archive: ${path.slice(0, slash)} is both a file and a folder`);
    }
  }
  return entries;
}

function findEndRecord(zip: Uint8Array, view: DataView): number {
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) return at;
  }
  throw corrupt("no end of central directory record");
}

function readZip64(view: DataView, eocd: number): { count: number; cdSize: number; cdOffset: number } {
  const locator = eocd - 20;
  if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) throw corrupt("missing zip64 locator");
  const record = Number(view.getBigUint64(locator + 8, true));
  if (record + 56 > locator || view.getUint32(record, true) !== 0x06064b50) throw corrupt("bad zip64 end record");
  return {
    count: Number(view.getBigUint64(record + 32, true)),
    cdSize: Number(view.getBigUint64(record + 40, true)),
    cdOffset: Number(view.getBigUint64(record + 48, true)),
  };
}

function extract(zip: Uint8Array, view: DataView, entry: Entry): Uint8Array {
  if (entry.flags & 1) throw new Error(`Encrypted archive entries aren't supported: ${entry.path}`);
  const at = entry.localOffset;
  if (at + 30 > zip.length || view.getUint32(at, true) !== 0x04034b50) throw corrupt(`bad local header for ${entry.path}`);
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw corrupt(`${entry.path} is cut short`);
  let out: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw corrupt(`${entry.path} has inconsistent sizes`);
    out = data.slice();
  } else if (entry.method === 8) {
    try {
      // A buffer of the declared size caps memory: inflating never grows it, and a wrong size fails the checks below.
      out = inflateSync(data, { out: new Uint8Array(entry.size) });
    } catch (error) {
      throw corrupt(`${entry.path}: ${(error as Error).message}`, error);
    }
  } else {
    throw new Error(`Unsupported compression method ${entry.method} for ${entry.path}`);
  }
  if (out.length !== entry.size || crc32(out) !== entry.crc) throw corrupt(`${entry.path} fails its CRC check`);
  return out;
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipPayload(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) throw new Error("The download is empty (the store returned no package)");
  if (!startsWith(bytes, "Cr24")) {
    if (!startsWith(bytes, "PK")) throw new Error("Unrecognised archive: expected a .crx, .xpi or .zip file");
    return bytes;
  }
  if (bytes.length < 12) throw new Error("Truncated CRX header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  let start: number;
  if (version === 3) {
    start = 12 + view.getUint32(8, true);
  } else if (version === 2) {
    if (bytes.length < 16) throw new Error("Truncated CRX header");
    start = 16 + view.getUint32(8, true) + view.getUint32(12, true);
  } else {
    throw new Error(`Unsupported CRX version ${version}`);
  }
  if (start >= bytes.length) throw new Error("Truncated CRX: the header is longer than the file");
  return bytes.subarray(start);
}

const startsWith = (bytes: Uint8Array, magic: string) => [...magic].every((char, i) => bytes[i] === char.charCodeAt(0));

/** Normalises an entry name and rejects anything that could escape the extension root. */
function safePath(name: string): string {
  const parts = name.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..") || parts.some((part) => part.includes(":"))) {
    throw new Error(`Unsafe path in archive: ${name}`);
  }
  return parts.join("/");
}
```

- [ ] **Step 4: Update the one Plan 1 test whose expectation changes.** A stored entry must now have equal sizes and fit inside the archive, so this case is corrupt rather than too large. In `test/unit/unpack.test.ts`, replace:

```ts
  it("counts stored entries by their compressed size", () => {
    const stored = zipSync({ "manifest.json": strToU8("{}") }, { level: 0 });
    assert.throws(() => unpack(patchCentral(patchCentral(stored, 20, 0x40000000), 24, 0)), /too large to unpack/);
  });
```

with:

```ts
  it("rejects a stored entry that claims more data than the archive holds", () => {
    const stored = zipSync({ "manifest.json": strToU8("{}") }, { level: 0 });
    assert.throws(() => unpack(patchCentral(patchCentral(stored, 20, 0x40000000), 24, 0)), /Corrupt or truncated archive \(manifest\.json is cut short\)/);
  });
```

- [ ] **Step 5: Run the unpack tests**

Run: `npm run test:file -- test/unit/unpack-hardening.test.ts` and `npm run test:file -- test/unit/unpack.test.ts`
Expected: both PASS.

- [ ] **Step 6: Type-check and commit**

Run: `npm run typecheck`, then:

```bash
git add src/convert/unpack.ts test/unit/unpack.test.ts test/unit/unpack-hardening.test.ts
git commit -m "Check every zip entry before and after inflating it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The runtime's shared parts: chrome.* calls, i18n and assets

**Files:**
- Create: `src/runtime/chrome.ts`, `src/runtime/i18n.ts`, `src/runtime/assets.ts`
- Test: `test/unit/runtime-core.test.ts`

**Interfaces:**
- Consumes: `RuntimeConfig`, `AssetTable` (Task 1).
- Produces:
  - **`chrome.ts`:**
    - `type Logger = { error(...args); once(key, ...args) }` and `createLogger(name)`;
    - `readLastError()` and `callWithLastError(log, error, callback)`;
    - `method(log, impl)`: callback-or-promise;
    - `type ChromeEvent<F>` and `createEvent<F>(log, onFirstListener?) → { event, dispatch }`;
    - `unavailable(api): Error`;
    - `withFallback(log, namespace, members)`.
  - **`i18n.ts`:**
    - `pickLocale(available, wanted, fallback?)`;
    - `createI18n(config, log, languages?) → { getMessage, getUILanguage, getAcceptLanguages }`.
  - **`assets.ts`:**
    - `ASSET_PREFIX = "x2u-asset:"`;
    - `createAssets(table, id, getMessage, log) → { url, pathOf, text, css }`;
    - `type Assets`.

- [ ] **Step 1: Write the failing test** `test/unit/runtime-core.test.ts`

```ts
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAssets } from "../../src/runtime/assets.ts";
import { callWithLastError, createEvent, createLogger, method, readLastError, withFallback, type Logger } from "../../src/runtime/chrome.ts";
import { createI18n, pickLocale } from "../../src/runtime/i18n.ts";

/** A logger that records what it would print. */
function recorder(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const seen = new Set<string>();
  return {
    lines,
    error: (...args) => lines.push(args.map(String).join(" ")),
    once: (key, ...args) => {
      if (seen.has(key)) return;
      seen.add(key);
      lines.push(args.map(String).join(" "));
    },
  };
}

describe("createLogger", () => {
  it("prefixes errors with the extension's name and logs a keyed message once", (t: TestContext) => {
    const errors = t.mock.method(console, "error", () => {});
    const log = createLogger("Sample");
    log.error("boom");
    log.once("k", "first");
    log.once("k", "second");
    assert.deepEqual(errors.mock.calls.map((call) => call.arguments), [["[ext2userscript:Sample]", "boom"], ["[ext2userscript:Sample]", "first"]]);
  });
});

describe("method", () => {
  it("returns a promise when there is no callback", async () => {
    const add = method(recorder(), async (a: number, b: number) => a + b);
    assert.equal(await add(1, 2), 3);
  });

  it("calls back instead of returning a promise when the last argument is a function", async () => {
    const add = method(recorder(), async (a: number, b: number) => a + b);
    const result = await new Promise((resolve) => assert.equal(add(1, 2, resolve), undefined));
    assert.equal(result, 3);
  });

  it("sets runtime.lastError during the callback of a failed call, and clears it afterwards", async () => {
    const log = recorder();
    const fail = method(log, async () => {
      throw new Error("nope");
    });
    const seen = await new Promise((resolve) => fail(() => resolve(readLastError()?.message)));
    assert.equal(seen, "nope");
    assert.equal(readLastError(), undefined);
    assert.deepEqual(log.lines, []);
  });

  it("logs an unchecked lastError", () => {
    const log = recorder();
    callWithLastError(log, new Error("ignored"), () => {});
    assert.deepEqual(log.lines, ["Unchecked runtime.lastError: ignored"]);
  });

  it("turns a synchronous throw into a rejection", async () => {
    const broken = method(recorder(), () => {
      throw new Error("sync");
    });
    await assert.rejects(broken() as Promise<unknown>, /sync/);
  });
});

describe("createEvent", () => {
  it("dispatches to every listener, once each, isolating a listener that throws", () => {
    const log = recorder();
    const { event, dispatch } = createEvent<(n: number) => void>(log);
    const seen: number[] = [];
    const listener = (n: number) => seen.push(n);
    event.addListener(listener);
    event.addListener(listener);
    event.addListener(() => {
      throw new Error("bad listener");
    });
    event.addListener((n) => seen.push(n * 10));
    dispatch(1);
    assert.deepEqual(seen, [1, 10]);
    assert.equal(log.lines.length, 1);
    assert.equal(event.hasListener(listener), true);
    event.removeListener(listener);
    assert.equal(event.hasListener(listener), false);
  });

  it("runs onFirstListener when the first listener is added", () => {
    let starts = 0;
    const { event } = createEvent<() => void>(recorder(), () => starts++);
    event.addListener(() => {});
    event.addListener(() => {});
    assert.equal(starts, 1);
  });
});

describe("withFallback", () => {
  it("keeps implemented members and rejects unknown ones with a named error, logged once", async () => {
    const log = recorder();
    const runtime = withFallback(log, "runtime", { id: "abc" }) as Record<string, unknown> & { id: string };
    assert.equal(runtime.id, "abc");
    const send = runtime.sendMessage as (...args: unknown[]) => Promise<unknown>;
    await assert.rejects(send({}), /ext2userscript: chrome\.runtime\.sendMessage is not available in userscripts/);
    await assert.rejects(send({}), /not available/);
    assert.equal(log.lines.length, 1);
  });

  it("calls back with lastError when an unknown method gets a callback", async () => {
    const runtime = withFallback(recorder(), "runtime", {}) as Record<string, (...args: unknown[]) => unknown>;
    const message = await new Promise((resolve) => runtime.sendMessage({}, () => resolve(readLastError()?.message)));
    assert.match(String(message), /chrome\.runtime\.sendMessage is not available/);
  });

  it("gives unknown events an addListener that logs and never fires", () => {
    const log = recorder();
    const runtime = withFallback(log, "runtime", {}) as Record<string, { addListener(fn: () => void): void; hasListeners(): boolean }>;
    runtime.onMessage.addListener(() => {});
    assert.match(log.lines[0], /chrome\.runtime\.onMessage is not available in userscripts; the listener will never be called/);
    assert.equal(runtime.onMessage.hasListeners(), false);
  });

  it("doesn't fake then or toJSON, so a namespace never looks like a promise", async () => {
    const storage = withFallback(recorder(), "storage", { local: 1 });
    assert.equal((storage as Record<string, unknown>).then, undefined);
    assert.equal(await Promise.resolve(storage), storage);
    assert.equal(JSON.stringify(storage), '{"local":1}');
  });
});

describe("pickLocale", () => {
  const available = ["en", "en_GB", "pt_BR", "fr"];

  it("prefers an exact match, ignoring case and - versus _", () => assert.equal(pickLocale(available, ["en-gb"], "en"), "en_GB"));
  it("falls back to the base language", () => assert.equal(pickLocale(available, ["fr-CA"], "en"), "fr"));
  it("tries each wanted locale in order", () => assert.equal(pickLocale(available, ["de", "pt-BR"], "en"), "pt_BR"));
  it("uses the fallback when nothing matches", () => assert.equal(pickLocale(available, ["de"], "en"), "en"));
});

describe("createI18n", () => {
  const config = {
    id: "abcdefghijklmnopabcdefghijklmnop",
    defaultLocale: "en",
    locales: {
      en: {
        greeting: { message: "Hello $who$ and $2", placeholders: { who: { content: "$1" } } },
        price: { message: "Costs $$5" },
        onlydefault: { message: "from en" },
      },
      fr: { greeting: { message: "Bonjour $WHO$", placeholders: { who: { content: "$1" } } } },
    },
  };

  it("picks the browser's language and fills placeholders and substitutions", () => {
    const i18n = createI18n(config, recorder(), ["fr-FR", "en"]);
    assert.equal(i18n.getMessage("Greeting", ["x2u"]), "Bonjour x2u");
  });

  it("falls back to the default locale per message, and returns '' for unknown names", () => {
    const i18n = createI18n(config, recorder(), ["fr"]);
    assert.equal(i18n.getMessage("onlyDefault"), "from en");
    assert.equal(i18n.getMessage("missing"), "");
  });

  it("substitutes $1–$9 and $$, and accepts a single string substitution", () => {
    const i18n = createI18n(config, recorder(), ["en-US"]);
    assert.equal(i18n.getMessage("greeting", ["a", "b"]), "Hello a and b");
    assert.equal(i18n.getMessage("greeting", "solo"), "Hello solo and ");
    assert.equal(i18n.getMessage("price"), "Costs $5");
  });

  it("honours a forced locale and answers predefined messages", () => {
    const i18n = createI18n({ ...config, locale: "fr" }, recorder(), ["en"]);
    assert.equal(i18n.getMessage("greeting", ["x"]), "Bonjour x");
    assert.equal(i18n.getMessage("@@extension_id"), config.id);
    assert.equal(i18n.getMessage("@@ui_locale"), "fr");
    assert.equal(i18n.getMessage("@@bidi_dir"), "ltr");
  });

  it("reports the browser's languages", async () => {
    const i18n = createI18n(config, recorder(), ["de-DE", "en"]);
    assert.equal(i18n.getUILanguage(), "de-DE");
    assert.deepEqual(await i18n.getAcceptLanguages(), ["de-DE", "en"]);
  });
});

describe("createAssets", () => {
  const table = { "img/dot.png": ["image/png", btoa("PNGDATA")] as [string, string], "inject.js": ["text/javascript", btoa("window.x = 1;")] as [string, string] };

  it("hands out one blob URL per path, whatever form the path takes", async () => {
    const assets = createAssets(table, "id", () => "", recorder());
    const url = assets.url("/img/dot.png?v=2");
    assert.match(url, /^blob:/);
    assert.equal(assets.url("./img/dot.png"), url);
    assert.equal(assets.pathOf(url), "img/dot.png");
    const blob = await fetch(url).then((response) => response.blob());
    assert.equal(blob.type, "image/png");
    assert.equal(await blob.text(), "PNGDATA");
  });

  it("returns a chrome-extension URL and logs once for a file it doesn't have", () => {
    const log = recorder();
    const assets = createAssets(table, "abc", () => "", log);
    assert.equal(assets.url("missing.png"), "chrome-extension://abc/missing.png");
    assets.url("missing.png");
    assert.equal(log.lines.length, 1);
  });

  it("decodes a text asset", () => assert.equal(createAssets(table, "id", () => "", recorder()).text("inject.js"), "window.x = 1;"));

  it("resolves asset placeholders and __MSG_ names in CSS", () => {
    const assets = createAssets(table, "id", (name) => (name === "@@extension_id" ? "abc" : `[${name}]`), recorder());
    const css = assets.css('a { background: url("x2u-asset:img%2Fdot.png"); content: "__MSG_label__"; }');
    assert.match(css, /^a \{ background: url\("blob:[^"]+"\); content: "\[label\]"; \}$/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/runtime-core.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/runtime/assets.ts`.

- [ ] **Step 3: Write `src/runtime/chrome.ts`**

```ts
// What every chrome.* namespace shares (spec §5.2, §9): logging with the extension's name, calls that take a trailing
// callback or return a promise, runtime.lastError, events, and a named rejection for any member this version doesn't
// implement.

export type Logger = {
  error(...args: unknown[]): void;
  /** Logs once per key for the page's lifetime. */
  once(key: string, ...args: unknown[]): void;
};

export function createLogger(name: string): Logger {
  const prefix = `[ext2userscript:${name}]`;
  const seen = new Set<string>();
  return {
    error: (...args) => console.error(prefix, ...args),
    once: (key, ...args) => {
      if (seen.has(key)) return;
      seen.add(key);
      console.error(prefix, ...args);
    },
  };
}

let lastError: { message: string } | undefined;
let lastErrorChecked = false;

/** chrome.runtime.lastError: set only while a failed call's callback runs. */
export function readLastError(): { message: string } | undefined {
  lastErrorChecked = true;
  return lastError;
}

/** Runs a callback with runtime.lastError set, as Chrome does, and logs the error if the callback never looked at it. */
export function callWithLastError(log: Logger, error: unknown, callback: () => void): void {
  lastError = { message: error instanceof Error ? error.message : String(error) };
  lastErrorChecked = false;
  try {
    callback();
  } finally {
    if (!lastErrorChecked) log.error(`Unchecked runtime.lastError: ${lastError.message}`);
    lastError = undefined;
  }
}

/** A chrome.* method: with a trailing callback it calls back (setting lastError on failure); without one it returns a promise. */
export function method<A extends unknown[], R>(log: Logger, impl: (...args: A) => Promise<R>) {
  return (...args: unknown[]): Promise<R> | undefined => {
    const callback = typeof args[args.length - 1] === "function" ? (args.pop() as (result?: R) => void) : undefined;
    let promise: Promise<R>;
    try {
      promise = impl(...(args as A));
    } catch (error) {
      promise = Promise.reject(error);
    }
    if (!callback) return promise;
    promise.then(
      (result) => callback(result),
      (error: unknown) => callWithLastError(log, error, () => callback()),
    );
    return undefined;
  };
}

export type ChromeEvent<F extends (...args: never[]) => unknown> = {
  addListener(listener: F): void;
  removeListener(listener: F): void;
  hasListener(listener: F): boolean;
  hasListeners(): boolean;
};

/** A chrome.* event. onFirstListener runs when the first listener is added, so costly watching starts only when needed. */
export function createEvent<F extends (...args: never[]) => unknown>(log: Logger, onFirstListener?: () => void) {
  const listeners = new Set<F>();
  const event: ChromeEvent<F> = {
    addListener: (listener) => {
      if (listeners.size === 0) onFirstListener?.();
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    hasListener: (listener) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
  };
  const dispatch = (...args: Parameters<F>) => {
    for (const listener of [...listeners]) {
      try {
        listener(...args);
      } catch (error) {
        log.error("Error in event handler:", error);
      }
    }
  };
  return { event, dispatch };
}

export const unavailable = (api: string) => new Error(`ext2userscript: chrome.${api} is not available in userscripts`);

/** Properties a namespace object must not fake: `then` would make it look like a promise, `toJSON` would change JSON output. */
const NEVER_FAKED = new Set(["then", "toJSON"]);

/**
 * Wraps a namespace so that members it doesn't implement fail with a named error, logged once (spec §9): an event's
 * addListener logs that the listener will never be called, and a method rejects or calls back with lastError set.
 */
export function withFallback<T extends object>(log: Logger, namespace: string, members: T): T {
  return new Proxy(members, {
    get(target, property, receiver) {
      if (typeof property === "symbol" || property in target || NEVER_FAKED.has(property)) return Reflect.get(target, property, receiver);
      const api = `${namespace}.${property}`;
      if (/^on[A-Z]/.test(property)) {
        return {
          addListener: () => log.once(api, `${unavailable(api).message}; the listener will never be called`),
          removeListener: () => {},
          hasListener: () => false,
          hasListeners: () => false,
        };
      }
      return method(log, () => {
        log.once(api, unavailable(api).message);
        return Promise.reject(unavailable(api));
      });
    },
  });
}
```

- [ ] **Step 4: Write `src/runtime/i18n.ts`**

```ts
// chrome.i18n (spec §5.2): messages from the extension's _locales, in the locale chosen from the browser's languages
// (or forced with --locale), falling back to default_locale. pickLocale is shared with manifest.ts.
import { method, type Logger } from "./chrome.ts";
import type { RuntimeConfig } from "./config.ts";

const normalize = (locale: string) => locale.replace(/-/g, "_").toLowerCase();

/** The first wanted locale the extension has, trying each one's base language (en_GB → en) too; otherwise the fallback. */
export function pickLocale(available: readonly string[], wanted: readonly string[], fallback?: string): string | undefined {
  const byName = new Map(available.map((locale) => [normalize(locale), locale]));
  for (const locale of wanted) {
    const found = byName.get(normalize(locale)) ?? byName.get(normalize(locale).split("_")[0]);
    if (found) return found;
  }
  return fallback === undefined ? undefined : (byName.get(normalize(fallback)) ?? fallback);
}

const RTL = /^(ar|dv|fa|he|ku|ps|sd|ug|ur|yi)(_|$)/i;

export function createI18n(
  config: Pick<RuntimeConfig, "id" | "locales" | "defaultLocale" | "locale">,
  log: Logger,
  languages: readonly string[] = navigator.languages,
) {
  const chosen = config.locale ?? pickLocale(Object.keys(config.locales), languages, config.defaultLocale);
  const tables = [...new Set([chosen, config.defaultLocale])].flatMap((locale) => (locale && config.locales[locale] ? [config.locales[locale]] : []));
  const rtl = RTL.test(chosen ?? "");
  const predefined: Record<string, string> = {
    "@@extension_id": config.id,
    "@@ui_locale": chosen ?? "en",
    "@@bidi_dir": rtl ? "rtl" : "ltr",
    "@@bidi_reversed_dir": rtl ? "ltr" : "rtl",
    "@@bidi_start_edge": rtl ? "right" : "left",
    "@@bidi_end_edge": rtl ? "left" : "right",
  };

  /** Chrome's getMessage: "" for an unknown name; $placeholder$ first, then $1–$9 and $$. */
  const getMessage = (name: string, substitutions?: unknown): string => {
    const key = String(name).toLowerCase();
    if (key in predefined) return predefined[key];
    const entry = tables.map((table) => table[key]).find((found) => found !== undefined);
    if (!entry) return "";
    const values = (Array.isArray(substitutions) ? substitutions : substitutions === undefined ? [] : [substitutions]).map(String);
    const text = entry.message.replace(/\$([\w@]+)\$/g, (whole, placeholder: string) => entry.placeholders?.[placeholder.toLowerCase()]?.content ?? whole);
    return text.replace(/\$\$|\$([1-9])/g, (_whole, index?: string) => (index === undefined ? "$" : (values[Number(index) - 1] ?? "")));
  };

  return {
    getMessage,
    getUILanguage: () => languages[0] ?? "en",
    getAcceptLanguages: method(log, async () => [...languages]),
  };
}
```

- [ ] **Step 5: Write `src/runtime/assets.ts`**

```ts
// Extension files at runtime (spec §3.6): runtime.getURL hands out a blob: URL per bundled file, made on first use and
// cached. CSS from content groups carries placeholders for its url() targets, which become those blob URLs here.
import type { Logger } from "./chrome.ts";
import type { AssetTable } from "./config.ts";

/** The converter writes `url("x2u-asset:<encoded path>")` into CSS; css() swaps each one for the file's blob URL. */
export const ASSET_PREFIX = "x2u-asset:";
const PLACEHOLDER = /x2u-asset:([^"')\s]+)/g;

/** getURL's argument as a path in the asset table: leading slashes, ./ and any query or fragment are dropped. */
const toPath = (url: string) => url.replace(/[?#].*$/, "").split("/").filter((part) => part !== "" && part !== ".").join("/");

const decode = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

export function createAssets(table: AssetTable, id: string, getMessage: (name: string) => string, log: Logger) {
  const urls = new Map<string, string>();
  const paths = new Map<string, string>();

  const url = (input: string): string => {
    const path = toPath(String(input));
    const entry = table[path];
    if (!entry) {
      log.once(`asset:${path}`, `${path} isn't in the userscript (missing from the extension, or excluded with --ignore-assets)`);
      return `chrome-extension://${id}/${path}`;
    }
    let blobUrl = urls.get(path);
    if (blobUrl === undefined) {
      blobUrl = URL.createObjectURL(new Blob([decode(entry[1])], { type: entry[0] }));
      urls.set(path, blobUrl);
      paths.set(blobUrl, path);
    }
    return blobUrl;
  };

  return {
    url,
    /** The asset path behind a blob URL this table handed out. */
    pathOf: (blobUrl: string) => paths.get(blobUrl),
    text: (path: string) => (table[path] ? new TextDecoder().decode(decode(table[path][1])) : undefined),
    /** Resolves asset placeholders and __MSG_name__ in a content group's CSS, as Chrome does for extension CSS. */
    css: (text: string) =>
      text
        .replace(PLACEHOLDER, (_whole, encoded: string) => url(decodeURIComponent(encoded)))
        .replace(/__MSG_([\w@]+)__/g, (_whole, name: string) => getMessage(name)),
  };
}

export type Assets = ReturnType<typeof createAssets>;
```

- [ ] **Step 6: Run the test**

Run: `npm run test:file -- test/unit/runtime-core.test.ts`
Expected: PASS, with no console output. The logger test stubs `console.error`.

- [ ] **Step 7: Type-check and commit**

```bash
git add src/runtime/chrome.ts src/runtime/i18n.ts src/runtime/assets.ts test/unit/runtime-core.test.ts
git commit -m "Add the runtime's chrome.* call conventions, i18n and asset URLs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: chrome.storage on GM values

**Files:**
- Modify: `src/runtime/keys.ts` (whole file below)
- Create: `src/runtime/storage.ts`
- Test: `test/unit/storage.test.ts`

**Interfaces:**
- Consumes:
  - `createGm`, `type Gm` (Plan 1);
  - `createEvent`, `method`, `withFallback`, `type Logger` (Task 3);
  - `createHub` (Plan 1 test support).
- Produces:
  - `keys(ns)` gains `storage(area, key)`, `storagePrefix` and `storageDoorbell`.
  - `createStorage(gm, ns, log)` returns `{ local, sync, session, managed, onChanged }`:
    - each area has `get`, `set`, `remove`, `clear` and `onChanged`;
    - `managed` and any member not listed fail with a named error.
  - `type StorageChange = { oldValue?; newValue? }`.

- [ ] **Step 1: Write the failing test** `test/unit/storage.test.ts`

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/runtime/chrome.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { createStorage, type StorageChange } from "../../src/runtime/storage.ts";
import { createHub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

type Changes = Record<string, StorageChange>;
type StorageArea = {
  get(query?: unknown, callback?: (items: Record<string, unknown>) => void): Promise<Record<string, unknown>> | undefined;
  set(items: Record<string, unknown>, callback?: () => void): Promise<void> | undefined;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
  onChanged: { addListener(fn: (changes: Changes) => void): void };
};
type Storage = { local: StorageArea; sync: StorageArea; session: StorageArea; onChanged: { addListener(fn: (changes: Changes, area: string) => void): void } };

const tab = (hub: ReturnType<typeof createHub>) => createStorage(createGm(hub.tab()), "t", createLogger("test")) as unknown as Storage;

describe("chrome.storage", () => {
  it("stores one GM value per key under the namespace and area", async () => {
    const hub = createHub();
    const storage = tab(hub);
    await storage.local.set({ a: 1, b: { c: [1, 2] } });
    await storage.sync.set({ a: "sync" });
    assert.deepEqual(Object.fromEntries(hub.store), {
      "x2u:t:s:local:a": 1,
      "x2u:t:s:local:b": { c: [1, 2] },
      "x2u:t:s:sync:a": "sync",
      "x2u:t:storage-keys": hub.store.get("x2u:t:storage-keys"),
    });
  });

  it("gets everything, one key, a list of keys, or keys with defaults", async () => {
    const storage = tab(createHub());
    await storage.local.set({ a: 1, b: 2, "x:y": 3 });
    assert.deepEqual(await storage.local.get(null), { a: 1, b: 2, "x:y": 3 });
    assert.deepEqual(await storage.local.get(), { a: 1, b: 2, "x:y": 3 });
    assert.deepEqual(await storage.local.get("a"), { a: 1 });
    assert.deepEqual(await storage.local.get(["a", "missing"]), { a: 1 });
    assert.deepEqual(await storage.local.get({ a: 0, missing: "default" }), { a: 1, missing: "default" });
  });

  it("supports callbacks", async () => {
    const storage = tab(createHub());
    await new Promise<void>((resolve) => storage.local.set({ a: 1 }, resolve));
    const items = await new Promise((resolve) => storage.local.get("a", resolve));
    assert.deepEqual(items, { a: 1 });
  });

  it("removes and clears only its own area", async () => {
    const storage = tab(createHub());
    await storage.local.set({ a: 1, b: 2, c: 3 });
    await storage.sync.set({ a: "kept" });
    await storage.local.remove("a");
    assert.deepEqual(await storage.local.get(null), { b: 2, c: 3 });
    await storage.local.remove(["b"]);
    await storage.local.clear();
    assert.deepEqual(await storage.local.get(null), {});
    assert.deepEqual(await storage.sync.get(null), { a: "kept" });
  });

  it("follows Chrome's value rules: undefined is skipped, a function becomes {}, a Date becomes a string", async () => {
    const storage = tab(createHub());
    await storage.local.set({ u: undefined, f: () => 1, d: new Date(0) });
    assert.deepEqual(await storage.local.get(null), { f: {}, d: "1970-01-01T00:00:00.000Z" });
  });

  it("fires onChanged in the writing tab with one event per set() call", async () => {
    const storage = tab(createHub());
    await storage.local.set({ a: 1 });
    const events: Array<[Changes, string]> = [];
    storage.onChanged.addListener((changes, area) => events.push([changes, area]));
    await sleep(20);
    await storage.local.set({ a: 2, b: 3 });
    await eventually(() => events.length > 0, 1000);
    await sleep(20);
    assert.deepEqual(events, [[{ a: { oldValue: 1, newValue: 2 }, b: { newValue: 3 } }, "local"]]);
  });

  it("tells other tabs about changes to existing keys, new keys and removals, per area", async () => {
    const hub = createHub();
    const writer = tab(hub);
    const reader = tab(hub);
    await writer.local.set({ existing: 1 });
    await sleep(20); // the reader has the key before it starts listening, so its creation isn't news
    const events: Array<[Changes, string]> = [];
    const localOnly: Changes[] = [];
    reader.onChanged.addListener((changes, area) => events.push([changes, area]));
    reader.local.onChanged.addListener((changes) => localOnly.push(changes));
    await sleep(20);

    await writer.local.set({ existing: 2 });
    await eventually(() => events.length === 1, 1000);
    assert.deepEqual(events[0], [{ existing: { oldValue: 1, newValue: 2 } }, "local"]);

    await writer.sync.set({ created: "new" });
    await eventually(() => events.length === 2, 1000);
    assert.deepEqual(events[1], [{ created: { newValue: "new" } }, "sync"]);

    await writer.local.remove("existing");
    await eventually(() => events.length === 3, 1000);
    assert.deepEqual(events[2], [{ existing: { oldValue: 2 } }, "local"]);
    assert.equal(localOnly.length, 2);
  });

  it("keeps working when a tab adds a listener after keys already exist in another area", async () => {
    const hub = createHub();
    const writer = tab(hub);
    await writer.session.set({ s: 1 });
    const reader = tab(hub);
    const events: string[] = [];
    reader.onChanged.addListener((changes, area) => events.push(`${area}:${Object.keys(changes).join(",")}`));
    await sleep(20);
    await writer.session.set({ s: 2 });
    await eventually(() => events.length === 1, 1000);
    assert.deepEqual(events, ["session:s"]);
  });

  it("rejects an unknown member with a named error", async () => {
    const storage = tab(createHub()) as unknown as { managed: { get(): Promise<unknown> } };
    await assert.rejects(storage.managed.get(), /chrome\.storage\.managed\.get is not available/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/storage.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/runtime/storage.ts`.

- [ ] **Step 3: Replace `src/runtime/keys.ts`**

```ts
// GM value keys the runtime uses (spec §5.2–5.4). ns is the converted extension's namespace.
export function keys(ns: string) {
  return {
    tab: (id: number) => `x2u:${ns}:tab:${id}`,
    tabPrefix: `x2u:${ns}:tab:`,
    out: (id: number) => `x2u:${ns}:out:${id}`,
    roster: `x2u:${ns}:roster`,
    /** chrome.storage: one value per key. */
    storage: (area: string, key: string) => `x2u:${ns}:s:${area}:${key}`,
    storagePrefix: `x2u:${ns}:s:`,
    /** Rung when a storage key is created, so tabs watching storage.onChanged start listening to it. */
    storageDoorbell: `x2u:${ns}:storage-keys`,
  };
}
```

- [ ] **Step 4: Write `src/runtime/storage.ts`**

```ts
// chrome.storage on GM values (spec §5.2): one value per key under x2u:<ns>:s:<area>:<key>, with Chrome's JSON-like
// value rules. GM value listeners are per key, so onChanged works like this:
// - once a listener is added, the tab listens to every storage key that exists, and to a doorbell key;
// - a tab that creates a key rings the doorbell, and listening tabs rescan and start listening to the new key;
// - changes that arrive in the same task are delivered as one event per area, as one set() call would be.
import { createEvent, method, withFallback, type Logger } from "./chrome.ts";
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";

const AREAS = ["local", "sync", "session"] as const;
type Area = (typeof AREAS)[number];
export type StorageChange = { oldValue?: unknown; newValue?: unknown };
type Changes = Record<string, StorageChange>;
type Query = null | undefined | string | string[] | Record<string, unknown>;

export function createStorage(gm: Gm, ns: string, log: Logger) {
  const k = keys(ns);
  const watched = new Set<string>();
  let watching: Promise<void> | undefined;
  const onChanged = createEvent<(changes: Changes, areaName: string) => void>(log, () => void watch());
  const areaChanged = Object.fromEntries(AREAS.map((area) => [area, createEvent<(changes: Changes) => void>(log, () => void watch())])) as Record<
    Area,
    ReturnType<typeof createEvent<(changes: Changes) => void>>
  >;

  const parse = (fullKey: string): { area: Area; key: string } | undefined => {
    if (!fullKey.startsWith(k.storagePrefix)) return undefined;
    const rest = fullKey.slice(k.storagePrefix.length);
    const colon = rest.indexOf(":");
    const area = rest.slice(0, colon) as Area;
    return colon > 0 && AREAS.includes(area) ? { area, key: rest.slice(colon + 1) } : undefined;
  };

  const pending = new Map<Area, Changes>();
  const queue = (area: Area, key: string, change: StorageChange) => {
    let batch = pending.get(area);
    if (!batch) {
      const fresh: Changes = {};
      batch = fresh;
      pending.set(area, fresh);
      setTimeout(() => {
        pending.delete(area);
        onChanged.dispatch(fresh, area);
        areaChanged[area].dispatch(fresh);
      });
    }
    const earlier = batch[key];
    const merged: StorageChange = {};
    const oldValue = earlier ? earlier.oldValue : change.oldValue;
    if (oldValue !== undefined) merged.oldValue = oldValue;
    if (change.newValue !== undefined) merged.newValue = change.newValue;
    batch[key] = merged;
  };

  const listen = async (fullKey: string) => {
    if (watched.has(fullKey)) return;
    watched.add(fullKey);
    await gm.addValueChangeListener(fullKey, (name, oldValue, newValue) => {
      const parsed = parse(name);
      if (parsed) queue(parsed.area, parsed.key, { oldValue, newValue });
    });
  };

  /** Starts listening to keys this tab doesn't know yet; with announce, reports each one as just created. */
  const rescan = async (announce: boolean) => {
    for (const fullKey of await gm.listValues()) {
      const parsed = parse(fullKey);
      if (!parsed || watched.has(fullKey)) continue;
      await listen(fullKey);
      if (!announce) continue;
      const value = await gm.getValue(fullKey);
      if (value !== undefined) queue(parsed.area, parsed.key, { newValue: value });
    }
  };

  const watch = () =>
    (watching ??= (async () => {
      // The doorbell listener comes first, so a key created during the first scan still gets picked up.
      await gm.addValueChangeListener(k.storageDoorbell, () => void rescan(true).catch((error: unknown) => log.error(error)));
      await rescan(false);
    })().catch((error: unknown) => log.error("storage.onChanged couldn't start:", error)));

  const area = (name: Area) => {
    const fullKey = (key: string) => k.storage(name, key);
    const prefix = k.storage(name, "");
    const all = async () => {
      const items: Record<string, unknown> = {};
      for (const key of await gm.listValues()) {
        if (!key.startsWith(prefix)) continue;
        const value = await gm.getValue(key);
        if (value !== undefined) items[key.slice(prefix.length)] = value;
      }
      return items;
    };
    return withFallback(log, `storage.${name}`, {
      get: method(log, async (query?: Query) => {
        if (query === null || query === undefined) return all();
        const names = typeof query === "string" ? [query] : Array.isArray(query) ? query : Object.keys(query);
        const defaults = typeof query === "object" && !Array.isArray(query) ? query : {};
        const items: Record<string, unknown> = {};
        for (const key of names) {
          const value = await gm.getValue(fullKey(key));
          if (value !== undefined) items[key] = value;
          else if (key in defaults) items[key] = defaults[key];
        }
        return items;
      }),
      set: method(log, async (items: Record<string, unknown>) => {
        let created = false;
        for (const [key, value] of Object.entries(items)) {
          if (value === undefined) continue; // Chrome skips undefined values
          const id = fullKey(key);
          if (watching) await listen(id); // so this tab's own onChanged hears a key it creates
          if ((await gm.getValue(id)) === undefined) created = true;
          await gm.setValue(id, typeof value === "function" ? {} : value); // Chrome stores a function as {}
        }
        if (created) await gm.setValue(k.storageDoorbell, `${Date.now()}:${Math.random()}`);
      }),
      remove: method(log, async (names: string | string[]) => {
        for (const key of typeof names === "string" ? [names] : names) await gm.deleteValue(fullKey(key));
      }),
      clear: method(log, async () => {
        for (const key of await gm.listValues()) if (key.startsWith(prefix)) await gm.deleteValue(key);
      }),
      onChanged: areaChanged[name].event,
    });
  };

  const managed = withFallback(log, "storage.managed", {});
  return withFallback(log, "storage", { local: area("local"), sync: area("sync"), session: area("session"), managed, onChanged: onChanged.event });
}
```

- [ ] **Step 5: Run the tests**

Run:
- `npm run test:file -- test/unit/storage.test.ts`
- the Plan 1 users of `keys()`: `npm run test:file -- test/unit/registry.test.ts`, and the same for `test/unit/bus.test.ts`.

Expected: all PASS. Run the storage file 5 times; it should pass every time. Its timing margins are 20 ms against a 1 ms hub.

- [ ] **Step 6: Type-check and commit**

```bash
git add src/runtime/keys.ts src/runtime/storage.ts test/unit/storage.test.ts
git commit -m "Implement chrome.storage and storage.onChanged on GM values" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The manifest model

**Files:**
- Create: `src/convert/files.ts`, `src/convert/manifest.ts`
- Create: `test/support/extension.ts` (the in-memory extensions every later converter test uses)
- Test: `test/unit/manifest.test.ts`

**Interfaces:**
- Consumes:
  - `pickLocale` (Task 3);
  - `matchPatternToRegExp` (Task 1);
  - `joinPath` (Plan 1);
  - `Messages`, `RunAt`, `UrlFilter`, `World` (Task 1).
- Produces:
  - **`files.ts`:** `decodeText(bytes)`, `toBase64(bytes)`, `mimeOf(path)`.
  - **`manifest.ts`:**
    - `parseJsonc(text)`;
    - `readManifest(files, { locale? }) → { model: Model; warnings: string[] }`;
    - types `Model`, `ContentGroup` and `Background`.
    - `Model` fields:
      - `manifestVersion`, `name`, `description`, `version`;
      - `geckoId?`, `key?`;
      - `icons`, `background?`, `contentScripts`, `popup?`, `options?`;
      - `webAccessibleResources`;
      - `defaultLocale?`, `locales`, `locale?`;
      - `raw`.
  - **`test/support/extension.ts`:** `PIXEL`, `files(entries)`, `zipFiles(extension)`, `sampleExtension(origin)` and `plainExtension(origin?)`.

- [ ] **Step 1: Write the test support** `test/support/extension.ts`. Later tasks use the sample extensions; the manifest test uses `files()`.

```ts
// Sample extensions for conversion tests, built in memory. sampleExtension exercises the content-script features this
// version converts; plainExtension is the smallest one that converts with no unsupported or partial entries.
import { strToU8, zipSync } from "fflate";
import type { ExtensionFiles } from "../../src/convert/unpack.ts";

/** A 1×1 PNG. */
export const PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

export const files = (entries: Record<string, string | Uint8Array>): ExtensionFiles =>
  new Map(Object.entries(entries).map(([path, content]) => [path, typeof content === "string" ? strToU8(content) : content]));

export const zipFiles = (extension: ExtensionFiles): Uint8Array<ArrayBuffer> => zipSync(Object.fromEntries(extension));

/** origin is where the test pages are served, e.g. http://127.0.0.1:4567. */
export function sampleExtension(origin: string): ExtensionFiles {
  const site = `${origin}/*`;
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "__MSG_extName__",
      version: "1.2.3",
      description: "__MSG_extDescription__",
      default_locale: "en",
      icons: { "16": "icons/16.png", "48": "icons/48.png" },
      web_accessible_resources: [{ resources: ["inject.js", "data/*"], matches: ["<all_urls>"] }],
      content_scripts: [
        { matches: [site], exclude_matches: [`${origin}/excluded*`], js: ["lib.js", "content.js"], css: ["style.css"], all_frames: true },
        { matches: [site], js: ["main-world.js"], world: "MAIN", run_at: "document_end" },
        { matches: [site], js: ["start.js"], run_at: "document_start" },
        { matches: [site], include_globs: ["*glob-yes*"], js: ["glob.js"] },
        { matches: [site], js: ["broken.js"] },
      ],
    }),
    "_locales/en/messages.json": JSON.stringify({
      extName: { message: "Sample Extension" },
      extDescription: { message: "Exercises content scripts" },
      greeting: { message: "Hello $WHO$", placeholders: { who: { content: "$1" } } },
    }),
    "_locales/fr/messages.json": JSON.stringify({ greeting: { message: "Bonjour $who$", placeholders: { who: { content: "$1" } } } }),
    // webextension-polyfill 0.10+ refuses to load unless globalThis.chrome looks like an extension's.
    // Sloppy code, as many content scripts are: assigning an undeclared name would throw if the group ran strict.
    "lib.js": 'if (!globalThis.chrome?.runtime?.id) throw new Error("not in an extension");\nsampleUndeclared = 1;\nvar sampleLib = { tag: "lib" }; // no newline at the end',
    "content.js": `const browser = chrome;
const html = document.documentElement;
html.dataset.content = sampleLib.tag;
html.dataset.greeting = browser.i18n.getMessage("greeting", ["x2u"]);
chrome.storage.local.get({ visits: 0 }).then(({ visits }) => chrome.storage.local.set({ visits: visits + 1 })).then(() => { html.dataset.stored = "1"; });
fetch(chrome.runtime.getURL("data/info.json")).then((r) => r.json()).then((info) => { html.dataset.info = info.kind; });
const script = document.createElement("script");
script.src = chrome.runtime.getURL("inject.js");
script.onload = () => { script.remove(); html.dataset.injectLoaded = "1"; };
(document.head || html).appendChild(script);
chrome.runtime.sendMessage({ hello: true }).catch((error) => { html.dataset.sendError = error.message; });
chrome.storage.onChanged.addListener((changes) => {
  const seen = new Set((html.dataset.changed || "").split(",").filter(Boolean));
  for (const key of Object.keys(changes)) seen.add(key);
  html.dataset.changed = [...seen].sort().join(",");
});
if (location.pathname === "/writer.html") setTimeout(() => chrome.storage.local.set({ fromWriter: Date.now() }), 500);
`,
    "style.css": ".x2u-box { color: rgb(1, 2, 3); background-image: url(img/dot.png); }",
    "inject.js": 'document.documentElement.dataset.injected = typeof chrome === "object" && chrome !== null && chrome.runtime && chrome.runtime.getURL ? "extension" : "page";',
    "main-world.js": "document.documentElement.dataset.main = String(window.pageValue);",
    "start.js": `const startState = document.readyState;
const markStart = () => document.documentElement.setAttribute("data-start", startState);
if (document.documentElement) markStart(); else document.addEventListener("DOMContentLoaded", markStart);`,
    "glob.js": 'document.documentElement.dataset.glob = "1";',
    "broken.js": 'throw new Error("this group fails on purpose");',
    "data/info.json": '{"kind":"sample"}',
    "img/dot.png": PIXEL,
    "icons/16.png": PIXEL,
    "icons/48.png": PIXEL,
    "unused.txt": "not referenced anywhere",
  });
}

/** Content scripts that use nothing unsupported or partial, so the report's verdict is likely-works. */
export function plainExtension(origin = "https://example.com"): ExtensionFiles {
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Plain Extension",
      version: "0.1.0",
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"] }],
    }),
    "content.js": 'chrome.storage.local.set({ seen: true }); document.documentElement.dataset.plain = "1";',
  });
}
```

- [ ] **Step 2: Write the failing test** `test/unit/manifest.test.ts`

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc, readManifest } from "../../src/convert/manifest.ts";
import { files } from "../support/extension.ts";

const read = (manifest: unknown, extra: Record<string, string> = {}, locale?: string) =>
  readManifest(files({ "manifest.json": typeof manifest === "string" ? manifest : JSON.stringify(manifest), ...extra }), { locale });

const mv3 = { manifest_version: 3, name: "Ext", version: "1.0" };

describe("parseJsonc", () => {
  it("accepts comments and a byte-order mark, and leaves comment-like text in strings alone", () => {
    assert.deepEqual(parseJsonc('﻿{ // note\n "a": "http://x/*", /* block */ "b": "/* no */" }'), { a: "http://x/*", b: "/* no */" });
  });

  it("handles escaped quotes inside strings", () => assert.deepEqual(parseJsonc('{"a": "say \\"hi\\" // still a string"}'), { a: 'say "hi" // still a string' }));
});

describe("readManifest", () => {
  it("normalises MV3 content scripts with Chrome's defaults", () => {
    const { model } = read({ ...mv3, content_scripts: [{ matches: ["https://a.test/*"], js: ["/js/a.js", "./b.js"] }] });
    assert.deepEqual(model.contentScripts, [
      { matches: ["https://a.test/*"], excludeMatches: [], includeGlobs: [], excludeGlobs: [], js: ["js/a.js", "b.js"], css: [], runAt: "document_idle", allFrames: false, matchAboutBlank: false, world: "ISOLATED" },
    ]);
  });

  it("reads every kind of background, popup and options page", () => {
    assert.deepEqual(read({ ...mv3, background: { service_worker: "sw.js", type: "module" } }).model.background, { kind: "worker", entry: "sw.js", module: true });
    assert.deepEqual(read({ ...mv3, manifest_version: 2, background: { scripts: ["a.js", "b.js"] } }).model.background, { kind: "scripts", files: ["a.js", "b.js"] });
    assert.deepEqual(read({ ...mv3, manifest_version: 2, background: { page: "bg.html" } }).model.background, { kind: "page", html: "bg.html" });
    assert.deepEqual(read({ ...mv3, action: { default_popup: "popup.html" } }).model.popup, { key: "action", page: "popup.html" });
    assert.deepEqual(read({ ...mv3, manifest_version: 2, browser_action: { default_popup: "p.html" } }).model.popup, { key: "browser_action", page: "p.html" });
    assert.deepEqual(read({ ...mv3, options_ui: { page: "o.html" } }).model.options, { key: "options_ui", page: "o.html" });
    assert.deepEqual(read({ ...mv3, options_page: "o.html" }).model.options, { key: "options_page", page: "o.html" });
  });

  it("flattens web_accessible_resources from MV2 and MV3", () => {
    assert.deepEqual(read({ ...mv3, web_accessible_resources: [{ resources: ["/img/*", "a.js"], matches: ["<all_urls>"] }] }).model.webAccessibleResources, ["img/*", "a.js"]);
    assert.deepEqual(read({ ...mv3, manifest_version: 2, web_accessible_resources: ["x.png"] }).model.webAccessibleResources, ["x.png"]);
  });

  it("resolves __MSG_x__ in the name and description, ignoring case, with the default locale", () => {
    const { model } = read({ ...mv3, name: "__MSG_appName__", description: "__MSG_DESC__ v2", default_locale: "en" }, {
      "_locales/en/messages.json": JSON.stringify({ AppName: { message: "My App" }, desc: { message: "Does things" } }),
      "_locales/de/messages.json": JSON.stringify({ appName: { message: "Meine App" } }),
    });
    assert.equal(model.name, "My App");
    assert.equal(model.description, "Does things v2");
    assert.equal(model.locale, "en");
    assert.deepEqual(Object.keys(model.locales).sort(), ["de", "en"]);
    assert.deepEqual(model.locales.en, { appname: { message: "My App" }, desc: { message: "Does things" } });
  });

  it("resolves against --locale, matching its base language, and falls back to the default per message", () => {
    const locales = {
      "_locales/en/messages.json": JSON.stringify({ appName: { message: "My App" }, desc: { message: "Does things" } }),
      "_locales/pt_BR/messages.json": JSON.stringify({ appName: { message: "Meu App" } }),
    };
    const { model, warnings } = read({ ...mv3, name: "__MSG_appName__", description: "__MSG_desc__", default_locale: "en" }, locales, "pt-br");
    assert.equal(model.name, "Meu App");
    assert.equal(model.description, "Does things");
    assert.equal(model.locale, "pt_BR");
    assert.deepEqual(warnings, []);
  });

  it("warns about an unknown --locale, a missing message and a broken messages.json", () => {
    const { model, warnings } = read({ ...mv3, name: "__MSG_nope__", default_locale: "en" }, {
      "_locales/en/messages.json": "{}",
      "_locales/fr/messages.json": "{ broken",
    }, "ja");
    assert.equal(model.name, "__MSG_nope__");
    assert.equal(warnings.length, 3);
    assert.match(warnings.join("\n"), /--locale ja: the extension has no such locale/);
    assert.match(warnings.join("\n"), /__MSG_nope__ isn't in _locales/);
    assert.match(warnings.join("\n"), /_locales\/fr\/messages\.json isn't valid JSON/);
  });

  it("reads the gecko ID from browser_specific_settings or applications", () => {
    assert.equal(read({ ...mv3, browser_specific_settings: { gecko: { id: "x@y" } } }).model.geckoId, "x@y");
    assert.equal(read({ ...mv3, manifest_version: 2, applications: { gecko: { id: "a@b" } } }).model.geckoId, "a@b");
  });

  it("refuses a manifest Chrome would refuse, naming the key", () => {
    assert.throws(() => read("{ nope"), /^Error: Invalid manifest\.json: /);
    assert.throws(() => read({ ...mv3, manifest_version: 4 }), /manifest_version must be 2 or 3 \(got 4\)/);
    assert.throws(() => read({ manifest_version: 3, version: "1" }), /name is required/);
    assert.throws(() => read({ manifest_version: 3, name: "x" }), /version is required/);
    assert.throws(() => read({ ...mv3 }, { "_locales/en/messages.json": "{}" }), /default_locale is required/);
    assert.throws(() => read({ ...mv3, content_scripts: [{ js: ["a.js"] }] }), /content_scripts\[0\]\.matches is required/);
    assert.throws(
      () => read({ ...mv3, content_scripts: [{ matches: ["https://a.test/*"], exclude_matches: ["https://ok.test/*", "nope"] }] }),
      /content_scripts\[0\]\.exclude_matches\[1\]: Invalid match pattern: nope/,
    );
    assert.throws(() => read({ ...mv3, content_scripts: [{ matches: ["<all_urls>"], run_at: "document_soon" }] }), /content_scripts\[0\]\.run_at: unknown value "document_soon"/);
    assert.throws(() => read({ ...mv3, content_scripts: [{ matches: ["<all_urls>"], js: ["../x.js"] }] }), /content_scripts\[0\]\.js: \.\.\/x\.js points outside the extension/);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm run test:file -- test/unit/manifest.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/convert/manifest.ts`.

- [ ] **Step 4: Write `src/convert/files.ts`**

```ts
// Small helpers for extension files: text decoding, base64 and MIME types. Isomorphic (Node and browser).

/** UTF-8 text, without a leading byte-order mark. */
export const decodeText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const MIME: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", html: "text/html", htm: "text/html",
  txt: "text/plain", xml: "application/xml", wasm: "application/wasm",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm",
};

/** The MIME type for a file, from its extension; application/octet-stream when unknown. */
export const mimeOf = (path: string): string => MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
```

- [ ] **Step 5: Write `src/convert/manifest.ts`**

```ts
// Reads manifest.json into one model for MV2 and MV3 (spec §3.2), with __MSG_x__ resolved against _locales.
// A manifest Chrome would refuse is a hard error naming the key (spec §9); anything else odd becomes a warning.
import type { Messages, RunAt, UrlFilter, World } from "../runtime/config.ts";
import { pickLocale } from "../runtime/i18n.ts";
import { matchPatternToRegExp } from "../runtime/match.ts";
import { decodeText } from "./files.ts";
import { joinPath } from "./paths.ts";
import type { ExtensionFiles } from "./unpack.ts";

export type ContentGroup = UrlFilter & { js: string[]; css: string[]; runAt: RunAt; allFrames: boolean; matchAboutBlank: boolean; world: World };

export type Background = { kind: "worker"; entry: string; module: boolean } | { kind: "scripts"; files: string[] } | { kind: "page"; html: string };

export type Model = {
  manifestVersion: 2 | 3;
  name: string;
  description: string;
  version: string;
  geckoId?: string;
  /** The manifest's public key (base64), from which Chrome derives the extension ID. */
  key?: string;
  /** Icon size → path. */
  icons: Record<string, string>;
  background?: Background;
  contentScripts: ContentGroup[];
  /** The page and the manifest key it came from: action, browser_action or page_action. */
  popup?: { key: string; page: string };
  /** The page and the manifest key it came from: options_ui or options_page. */
  options?: { key: string; page: string };
  /** Paths and globs, flattened from the MV2 and MV3 forms. */
  webAccessibleResources: string[];
  defaultLocale?: string;
  /** Every _locales/<locale>/messages.json, keyed by folder name. */
  locales: Record<string, Messages>;
  /** The locale the manifest's __MSG_x__ strings were resolved against. */
  locale?: string;
  /** manifest.json as parsed, for runtime.getManifest(). */
  raw: Record<string, unknown>;
};

const RUN_AT: readonly string[] = ["document_start", "document_end", "document_idle"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (detail: string) => new Error(`Invalid manifest.json: ${detail}`);

/** JSON with comments, which Chrome accepts in manifest.json and messages.json. A leading byte-order mark is ignored. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      out += " ";
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/^﻿/, ""));
}

export function readManifest(files: ExtensionFiles, options: { locale?: string } = {}): { model: Model; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = parseJsonc(decodeText(files.get("manifest.json") ?? new Uint8Array()));
  } catch (error) {
    throw invalid((error as Error).message);
  }
  if (!isObject(raw)) throw invalid("expected an object");
  const manifestVersion = raw.manifest_version;
  if (manifestVersion !== 2 && manifestVersion !== 3) throw invalid(`manifest_version must be 2 or 3 (got ${JSON.stringify(manifestVersion)})`);

  const locales = readLocales(files, warnings);
  const defaultLocale = typeof raw.default_locale === "string" ? raw.default_locale : undefined;
  if (Object.keys(locales).length > 0 && defaultLocale === undefined) throw invalid("_locales exists, so default_locale is required");
  if (options.locale && pickLocale(Object.keys(locales), [options.locale]) === undefined) {
    warnings.push(`--locale ${options.locale}: the extension has no such locale, so ${defaultLocale ?? "its default"} is used`);
  }
  const locale = pickLocale(Object.keys(locales), options.locale ? [options.locale] : [], defaultLocale);
  const lookup = (name: string) => {
    for (const table of [locale, defaultLocale]) {
      const entry = table === undefined ? undefined : locales[table]?.[name.toLowerCase()];
      if (entry) return entry.message;
    }
    warnings.push(`__MSG_${name}__ isn't in _locales, so it stays as written`);
    return undefined;
  };
  const text = (value: unknown) => (typeof value === "string" ? value.replace(/__MSG_([\w@]+)__/g, (whole, name: string) => lookup(name) ?? whole) : "");

  const name = text(raw.name);
  if (!name) throw invalid("name is required");
  if (typeof raw.version !== "string" || raw.version === "") throw invalid("version is required");
  const gecko = isObject(raw.browser_specific_settings) ? raw.browser_specific_settings.gecko : isObject(raw.applications) ? raw.applications.gecko : undefined;

  return {
    model: {
      manifestVersion,
      name,
      description: text(raw.description),
      version: raw.version,
      geckoId: isObject(gecko) && typeof gecko.id === "string" ? gecko.id : undefined,
      key: typeof raw.key === "string" ? raw.key : undefined,
      icons: icons(raw.icons),
      background: background(raw.background),
      contentScripts: contentScripts(raw.content_scripts),
      popup: page(raw, ["action", "browser_action", "page_action"], "default_popup"),
      options: page(raw, ["options_ui"], "page") ?? (typeof raw.options_page === "string" ? { key: "options_page", page: filePath(raw.options_page, "options_page") } : undefined),
      webAccessibleResources: webAccessibleResources(raw.web_accessible_resources),
      defaultLocale,
      locales,
      locale,
      raw,
    },
    warnings,
  };
}

function readLocales(files: ExtensionFiles, warnings: string[]): Record<string, Messages> {
  const locales: Record<string, Messages> = {};
  for (const [path, bytes] of files) {
    const folder = /^_locales\/([^/]+)\/messages\.json$/.exec(path)?.[1];
    if (folder === undefined) continue;
    try {
      locales[folder] = messages(parseJsonc(decodeText(bytes)));
    } catch (error) {
      warnings.push(`${path} isn't valid JSON (${(error as Error).message}), so it was skipped`);
    }
  }
  return locales;
}

/** A messages.json with lower-cased message and placeholder names, keeping only well-formed entries. */
function messages(value: unknown): Messages {
  const out: Messages = {};
  if (!isObject(value)) return out;
  for (const [name, entry] of Object.entries(value)) {
    if (!isObject(entry) || typeof entry.message !== "string") continue;
    const placeholders: Record<string, { content: string }> = {};
    if (isObject(entry.placeholders)) {
      for (const [placeholder, spec] of Object.entries(entry.placeholders)) {
        if (isObject(spec) && typeof spec.content === "string") placeholders[placeholder.toLowerCase()] = { content: spec.content };
      }
    }
    out[name.toLowerCase()] = Object.keys(placeholders).length > 0 ? { message: entry.message, placeholders } : { message: entry.message };
  }
  return out;
}

function strings(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw invalid(`${key} must be a list of strings`);
  return value;
}

/** A path inside the extension, without a leading slash or ./, as unpack() keys files. */
function filePath(path: string, key: string): string {
  try {
    return joinPath("", path);
  } catch {
    throw invalid(`${key}: ${path} points outside the extension`);
  }
}

function icons(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObject(value)) for (const [size, path] of Object.entries(value)) if (typeof path === "string") out[size] = filePath(path, `icons.${size}`);
  return out;
}

function background(value: unknown): Background | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.service_worker === "string") return { kind: "worker", entry: filePath(value.service_worker, "background.service_worker"), module: value.type === "module" };
  if (value.scripts !== undefined) return { kind: "scripts", files: strings(value.scripts, "background.scripts").map((path) => filePath(path, "background.scripts")) };
  if (typeof value.page === "string") return { kind: "page", html: filePath(value.page, "background.page") };
  return undefined;
}

function contentScripts(value: unknown): ContentGroup[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("content_scripts must be a list");
  return value.map((entry: unknown, i) => {
    const key = `content_scripts[${i}]`;
    if (!isObject(entry)) throw invalid(`${key} must be an object`);
    const matches = strings(entry.matches, `${key}.matches`);
    if (matches.length === 0) throw invalid(`${key}.matches is required`);
    const excludeMatches = strings(entry.exclude_matches, `${key}.exclude_matches`);
    for (const [list, name] of [[matches, "matches"], [excludeMatches, "exclude_matches"]] as const) {
      list.forEach((pattern, j) => {
        try {
          matchPatternToRegExp(pattern);
        } catch (error) {
          throw invalid(`${key}.${name}[${j}]: ${(error as Error).message}`);
        }
      });
    }
    const runAt = entry.run_at ?? "document_idle";
    if (typeof runAt !== "string" || !RUN_AT.includes(runAt)) throw invalid(`${key}.run_at: unknown value ${JSON.stringify(entry.run_at)}`);
    const world = entry.world ?? "ISOLATED";
    if (world !== "ISOLATED" && world !== "MAIN") throw invalid(`${key}.world: unknown value ${JSON.stringify(entry.world)}`);
    return {
      matches,
      excludeMatches,
      includeGlobs: strings(entry.include_globs, `${key}.include_globs`),
      excludeGlobs: strings(entry.exclude_globs, `${key}.exclude_globs`),
      js: strings(entry.js, `${key}.js`).map((path) => filePath(path, `${key}.js`)),
      css: strings(entry.css, `${key}.css`).map((path) => filePath(path, `${key}.css`)),
      runAt: runAt as RunAt,
      allFrames: entry.all_frames === true,
      matchAboutBlank: entry.match_about_blank === true || entry.match_origin_as_fallback === true,
      world,
    };
  });
}

function page(raw: Record<string, unknown>, keys: readonly string[], field: string): { key: string; page: string } | undefined {
  for (const key of keys) {
    const section = raw[key];
    if (isObject(section) && typeof section[field] === "string") return { key, page: filePath(section[field], `${key}.${field}`) };
  }
  return undefined;
}

function webAccessibleResources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const resources = value.flatMap((entry: unknown) => (typeof entry === "string" ? [entry] : isObject(entry) ? strings(entry.resources, "web_accessible_resources[].resources") : []));
  return resources.map((resource) => resource.replace(/^\/+/, ""));
}
```

- [ ] **Step 6: Run the test**

Run: `npm run test:file -- test/unit/manifest.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check and commit**

```bash
git add src/convert/files.ts src/convert/manifest.ts test/support/extension.ts test/unit/manifest.test.ts
git commit -m "Read MV2 and MV3 manifests into one model, with locales" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: A scanner for chrome.* chains and getURL literals

**Files:**
- Create: `src/convert/scan.ts`
- Test: `test/unit/scan.test.ts`

**Interfaces:**
- Produces:
  - `type ScanResult = { chains: string[]; urls: string[]; dynamicImport: boolean }`;
  - `scan(code: string): ScanResult`. Chains always start with `chrome.`; `browser.*` is reported as `chrome.*`.

- [ ] **Step 1: Write the failing test** `test/unit/scan.test.ts`

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scan } from "../../src/convert/scan.ts";

describe("scan", () => {
  it("finds member chains rooted at chrome and browser, reporting browser as chrome", () => {
    const { chains } = scan("chrome.tabs.query({}); browser.storage.local.get('a'); chrome?.runtime?.sendMessage(1);");
    assert.deepEqual(chains, ["chrome.tabs.query", "chrome.storage.local.get", "chrome.runtime.sendMessage"]);
  });

  it("follows window.chrome, globalThis.browser and self.chrome, but not other objects' chrome property", () => {
    const { chains } = scan("window.chrome.i18n.getMessage('x'); globalThis.browser.runtime.id; self.chrome.storage.sync; foo.chrome.tabs.query();");
    assert.deepEqual(chains, ["chrome.i18n.getMessage", "chrome.runtime.id", "chrome.storage.sync"]);
  });

  it("ignores a bare chrome or browser without a member", () => {
    assert.deepEqual(scan("if (typeof chrome !== 'undefined' && browser) {}").chains, []);
  });

  it("skips comments, strings and regular expressions", () => {
    const code = [
      "// chrome.tabs.query()",
      "/* browser.cookies.getAll() */",
      "const a = 'chrome.history.search';",
      'const b = "browser.downloads.download";',
      "const c = /chrome\\.webRequest\\.x/g;",
      "const d = a / 2 / chrome.alarms.create;",
    ].join("\n");
    assert.deepEqual(scan(code).chains, ["chrome.alarms.create"]);
  });

  it("reads regular expressions that contain slashes in a character class", () => {
    assert.deepEqual(scan("const r = /[/]chrome.tabs/; chrome.runtime.id;").chains, ["chrome.runtime.id"]);
  });

  it("scans template substitutions, including nested braces and templates, but not template text", () => {
    const code = "const t = `chrome.tabs.query ${chrome.i18n.getMessage('a')} and ${ { x: `${browser.runtime.id}` }.x } done`; chrome.storage.local;";
    assert.deepEqual(scan(code).chains, ["chrome.i18n.getMessage", "chrome.runtime.id", "chrome.storage.local"]);
  });

  it("collects getURL string literals from runtime and extension", () => {
    const code = "chrome.runtime.getURL('img/a.png'); browser.extension.getURL(\"b.css\"); chrome.runtime.getURL(`c.js`); chrome.runtime.getURL(name); chrome.runtime.getURL('d' + x);";
    assert.deepEqual(scan(code).urls, ["img/a.png", "b.css", "c.js"]);
  });

  it("doesn't take a template with substitutions as a getURL literal", () => {
    assert.deepEqual(scan("chrome.runtime.getURL(`img/${name}.png`)").urls, []);
  });

  it("notices dynamic import()", () => {
    assert.equal(scan("import('./a.js')").dynamicImport, true);
    assert.equal(scan("loader.import('./a.js'); const s = 'import(x)';").dynamicImport, false);
  });

  it("survives unterminated strings, templates, comments and regular expressions", () => {
    for (const code of ["'abc", "`abc ${", "/* abc", "x = /abc", "chrome."]) assert.doesNotThrow(() => scan(code));
  });

  it("scans a 5 MB bundle in well under two seconds", () => {
    const chunk = "function f(a){ return chrome.storage.local.get(a).then((x) => x / 2) /* note */ + `t ${a}` + 're'; }\n";
    const code = chunk.repeat(Math.ceil((5 * 1024 * 1024) / chunk.length));
    const started = performance.now();
    const { chains } = scan(code);
    assert.ok(performance.now() - started < 2000, `took ${Math.round(performance.now() - started)} ms`);
    assert.equal(chains.length, Math.ceil((5 * 1024 * 1024) / chunk.length));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/scan.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write `src/convert/scan.ts`**

```ts
// A JavaScript scanner just deep enough for the analyzer (spec §3.4) and the asset collector (§3.6). It skips comments,
// string and template text and regular expressions, then reads three things from what's left: member chains rooted at
// chrome or browser, the string-literal arguments of getURL(...), and whether the code uses dynamic import().
// Ceilings: aliasing (const c = chrome) and computed access (chrome["tabs"]) are missed, and a regular expression
// right after `)` or `}` is read as a division.

export type ScanResult = {
  /** Chains such as "chrome.tabs.query", in source order. browser.* is reported as chrome.*. */
  chains: string[];
  /** String literals passed to runtime.getURL or extension.getURL, as written. */
  urls: string[];
  dynamicImport: boolean;
};

type Token = { kind: "name" | "punct" | "string" | "template" | "regex"; value: string };

const NAME_CHAR = /[\w$\u0080-￿]/;
/** Keywords after which a `/` starts a regular expression rather than a division. */
const BEFORE_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
/** `window.chrome` and friends are the global chrome; `foo.chrome` is someone else's property. */
const GLOBAL_OWNERS = new Set(["window", "globalThis", "self"]);

export function scan(code: string): ScanResult {
  const tokens = tokenize(code);
  const result: ScanResult = { chains: [], urls: [], dynamicImport: false };
  const isDot = (token: Token | undefined) => token?.kind === "punct" && (token.value === "." || token.value === "?.");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "name") continue;
    if (token.value === "import" && tokens[i + 1]?.value === "(" && !isDot(tokens[i - 1])) result.dynamicImport = true;
    if (token.value === "getURL" && isDot(tokens[i - 1]) && tokens[i + 1]?.value === "(" && tokens[i + 2]?.kind === "string") {
      const after = tokens[i + 3]?.value;
      if (after === ")" || after === ",") result.urls.push(tokens[i + 2].value);
    }
    if (token.value !== "chrome" && token.value !== "browser") continue;
    if (isDot(tokens[i - 1]) && !(tokens[i - 2]?.kind === "name" && GLOBAL_OWNERS.has(tokens[i - 2].value))) continue;
    const parts = ["chrome"];
    let j = i + 1;
    while (isDot(tokens[j]) && tokens[j + 1]?.kind === "name") {
      parts.push(tokens[j + 1].value);
      j += 2;
    }
    if (parts.length > 1) result.chains.push(parts.join("."));
  }
  return result;
}

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  /** For each open `${`, the brace depth its closing `}` returns to. */
  const substitutions: number[] = [];
  let braces = 0;
  let i = 0;

  const regexAllowed = () => {
    const last = tokens[tokens.length - 1];
    if (!last) return true;
    if (last.kind === "name") return BEFORE_EXPRESSION.has(last.value);
    if (last.kind === "punct") return !(last.value === ")" || last.value === "]" || last.value === "}");
    return false;
  };

  /** Reads template text from `start` up to its closing backtick or the next `${`. */
  const templatePart = (start: number) => {
    let text = "";
    let j = start;
    while (j < code.length) {
      const char = code[j];
      if (char === "\\") {
        text += code[j + 1] ?? "";
        j += 2;
      } else if (char === "`") {
        return { text, end: j + 1, open: false };
      } else if (char === "$" && code[j + 1] === "{") {
        return { text, end: j + 2, open: true };
      } else {
        text += char;
        j++;
      }
    }
    return { text, end: j, open: false };
  };

  const template = (start: number, first: boolean) => {
    const part = templatePart(start);
    if (part.open) {
      substitutions.push(braces);
      braces++;
      tokens.push({ kind: "punct", value: "${" });
    } else {
      // A template without substitutions is a plain string; the end of one with substitutions is just "a value".
      tokens.push(first ? { kind: "string", value: part.text } : { kind: "template", value: "" });
    }
    return part.end;
  };

  while (i < code.length) {
    const char = code[i];
    const next = code[i + 1];
    if (char === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      i = end === -1 ? code.length : end;
    } else if (char === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
    } else if (char === '"' || char === "'") {
      let value = "";
      let j = i + 1;
      while (j < code.length && code[j] !== char && code[j] !== "\n") {
        if (code[j] === "\\") {
          value += code[j + 1] ?? "";
          j += 2;
        } else {
          value += code[j];
          j++;
        }
      }
      tokens.push({ kind: "string", value });
      i = j + 1;
    } else if (char === "`") {
      i = template(i + 1, true);
    } else if (char === "}" && substitutions.length > 0 && substitutions[substitutions.length - 1] === braces - 1) {
      substitutions.pop();
      braces--;
      i = template(i + 1, false);
    } else if (char === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < code.length && code[j] !== "\n") {
        const c = code[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (inClass) {
          if (c === "]") inClass = false;
        } else if (c === "[") {
          inClass = true;
        } else if (c === "/") {
          j++;
          while (j < code.length && NAME_CHAR.test(code[j])) j++;
          break;
        }
        j++;
      }
      tokens.push({ kind: "regex", value: "" });
      i = j;
    } else if (NAME_CHAR.test(char)) {
      let j = i + 1;
      while (j < code.length && NAME_CHAR.test(code[j])) j++;
      tokens.push({ kind: "name", value: code.slice(i, j) });
      i = j;
    } else if (char === "?" && next === "." && !/\d/.test(code[i + 2] ?? "")) {
      tokens.push({ kind: "punct", value: "?." });
      i += 2;
    } else if (/\s/.test(char)) {
      i++;
    } else {
      if (char === "{") braces++;
      else if (char === "}") braces--;
      tokens.push({ kind: "punct", value: char });
      i++;
    }
  }
  return tokens;
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test:file -- test/unit/scan.test.ts`
Expected: PASS. The 5 MB case takes well under 2 s.

- [ ] **Step 5: Type-check and commit**

```bash
git add src/convert/scan.ts test/unit/scan.test.ts
git commit -m "Scan extension code for chrome.* chains and getURL literals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The support table, the analyzer and the report

**Files:**
- Create: `src/convert/report.ts`, `src/convert/support.ts`, `src/convert/analyze.ts`
- Test: `test/unit/analyze.test.ts`

**Interfaces:**
- Consumes:
  - `type ScanResult`, `scan` (Task 6);
  - `readManifest`, `type Model` (Task 5);
  - `type GmMethod` (Plan 1).
- Produces:
  - **`report.ts`:**
    - types `Status`, `Context`, `Verdict`, `ReportEntry` and `Report` (spec §3.5);
    - `verdictOf(entries)`, `sortEntries(entries)`, `formatReport(report)`.
  - **`support.ts`:** `type Support`, `CONTENT_NAMESPACES`, `CONTENT_APIS`, `UNSUPPORTED_MANIFEST_KEYS`.
  - **`analyze.ts`:** `analyze(model, scans) → { entries: ReportEntry[]; methods: Set<GmMethod> }`.

- [ ] **Step 1: Write the failing test** `test/unit/analyze.test.ts`

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../../src/convert/analyze.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import { formatReport, sortEntries, verdictOf, type Report, type ReportEntry } from "../../src/convert/report.ts";
import { scan } from "../../src/convert/scan.ts";
import { files } from "../support/extension.ts";

const model = (manifest: Record<string, unknown>) =>
  readManifest(files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1.0", ...manifest }) })).model;
const group = { matches: ["https://a.test/*"], js: ["a.js"] };

describe("analyze", () => {
  it("reports each content API once, with the support table's status, and skips namespaces content scripts don't have", () => {
    const code = "chrome.storage.local.get(); chrome.storage.local.set({}); browser.runtime.sendMessage(1); chrome.tabs.query({}); chrome.runtime.getPlatformInfo();";
    const { entries } = analyze(model({ content_scripts: [group] }), [scan(code)]);
    assert.deepEqual(entries, [
      { subject: "chrome.storage.local", status: "supported", contexts: ["content"] },
      { subject: "chrome.runtime.sendMessage", status: "unsupported", reason: "messaging with the background isn't converted yet", contexts: ["content"] },
    ]);
  });

  it("flags document_start, about:blank frames and dynamic import()", () => {
    const { entries } = analyze(model({ content_scripts: [{ ...group, run_at: "document_start", match_about_blank: true }] }), [scan("import('./x.js')")]);
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status]), [
      ["import()", "partial"],
      ["manifest.content_scripts.run_at", "partial"],
      ["manifest.content_scripts.match_about_blank", "partial"],
    ]);
  });

  it("reports the contexts and manifest features this version doesn't convert", () => {
    const { entries } = analyze(
      model({ background: { service_worker: "sw.js" }, action: { default_popup: "p.html" }, options_ui: { page: "o.html" }, chrome_url_overrides: { newtab: "n.html" }, commands: {} }),
      [],
    );
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status, entry.contexts]), [
      ["manifest.background", "unsupported", ["background"]],
      ["manifest.action.default_popup", "unsupported", ["popup"]],
      ["manifest.options_ui", "unsupported", ["options"]],
      ["manifest.chrome_url_overrides", "unsupported", ["background"]],
      ["manifest.commands", "unsupported", ["background"]],
    ]);
  });

  it("skips groups without a scan (no JS, or the MAIN world)", () => {
    assert.deepEqual(analyze(model({ content_scripts: [group, group] }), [undefined, undefined]).entries, []);
  });
});

describe("verdictOf", () => {
  const entry = (status: ReportEntry["status"], context: ReportEntry["contexts"][number]): ReportEntry => ({ subject: "x", status, contexts: [context] });

  it("is unlikely when something unsupported sits in the background or content scripts", () => {
    assert.equal(verdictOf([entry("unsupported", "content")]), "unlikely");
    assert.equal(verdictOf([entry("unsupported", "background")]), "unlikely");
  });

  it("is partial for partial entries, or unsupported ones elsewhere", () => {
    assert.equal(verdictOf([entry("partial", "content")]), "partial");
    assert.equal(verdictOf([entry("unsupported", "popup")]), "partial");
  });

  it("is likely-works otherwise", () => assert.equal(verdictOf([entry("supported", "content")]), "likely-works"));
});

describe("formatReport", () => {
  it("prints the verdict, then entries worst first in aligned columns, then warnings", () => {
    const report: Report = {
      extension: { name: "Ext", version: "1.0", manifestVersion: 3 },
      verdict: "unlikely",
      entries: sortEntries([
        { subject: "chrome.storage.local", status: "supported", contexts: ["content"] },
        { subject: "manifest.background", status: "unsupported", reason: "background scripts aren't converted yet", contexts: ["background"] },
        { subject: "chrome.storage.session", status: "partial", reason: "kept across browser restarts", contexts: ["content"] },
      ]),
      warnings: ["style.css refers to a.png, which isn't in the extension"],
    };
    assert.equal(
      formatReport(report),
      [
        "Ext 1.0 (manifest v3): unlikely",
        "  unsupported  manifest.background     background  background scripts aren't converted yet",
        "  partial      chrome.storage.session  content     kept across browser restarts",
        "  supported    chrome.storage.local    content",
        "Warnings:",
        "  - style.css refers to a.png, which isn't in the extension",
      ].join("\n"),
    );
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/analyze.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write `src/convert/report.ts`**

```ts
// The compatibility report (spec §3.5): what the conversion supports, partly supports or can't, per context, and an
// overall verdict. The CLI prints it with formatReport and can write it as JSON.

export type Status = "supported" | "partial" | "unsupported";
export type Context = "background" | "content" | "popup" | "options" | "page";
export type Verdict = "likely-works" | "partial" | "unlikely";

export type ReportEntry = { subject: string; status: Status; reason?: string; contexts: Context[] };

export type Report = {
  extension: { name: string; version: string; manifestVersion: 2 | 3; id?: string };
  verdict: Verdict;
  entries: ReportEntry[];
  warnings: string[];
};

/** The contexts an extension can't do without: if one of them hits something unsupported, it's unlikely to work. */
const RELIED_ON: ReadonlySet<Context> = new Set(["background", "content"]);
const STATUS_ORDER: readonly Status[] = ["unsupported", "partial", "supported"];

export function verdictOf(entries: readonly ReportEntry[]): Verdict {
  if (entries.some((entry) => entry.status === "unsupported" && entry.contexts.some((context) => RELIED_ON.has(context)))) return "unlikely";
  return entries.some((entry) => entry.status !== "supported") ? "partial" : "likely-works";
}

/** Unsupported first, then partial, then supported; by subject within each. */
export function sortEntries(entries: readonly ReportEntry[]): ReportEntry[] {
  return [...entries].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.subject.localeCompare(b.subject));
}

export function formatReport(report: Report): string {
  const { name, version, manifestVersion } = report.extension;
  const rows = report.entries.map((entry) => [entry.status, entry.subject, entry.contexts.join(", "), entry.reason ?? ""]);
  const widths = [0, 1, 2].map((column) => Math.max(0, ...rows.map((row) => row[column].length)));
  const lines = [`${name} ${version} (manifest v${manifestVersion}): ${report.verdict}`];
  for (const row of rows) lines.push(`  ${row.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join("  ")}`.trimEnd());
  if (report.warnings.length > 0) lines.push("Warnings:", ...report.warnings.map((warning) => `  - ${warning}`));
  return lines.join("\n");
}
```

- [ ] **Step 4: Write `src/convert/support.ts`**

```ts
// The API support table (spec §5.2): the single source of truth for what the runtime implements. The analyzer reads it
// for the report, and metadata.ts reads the gm methods a row needs for @grant (spec §5.1). It grows with the runtime:
// this version converts content scripts, so it lists the APIs Chrome gives content scripts.
import type { GmMethod } from "../runtime/gm.ts";
import type { Context, Status } from "./report.ts";

export type Support = { status: Status; reason?: string; methods?: readonly GmMethod[] };

/** The namespaces Chrome gives content scripts. Other chrome.* names don't exist there, so the analyzer skips them. */
export const CONTENT_NAMESPACES: ReadonlySet<string> = new Set(["runtime", "storage", "i18n", "extension"]);

const NO_BACKGROUND = "messaging with the background isn't converted yet";

/**
 * Content-script APIs by "<namespace>.<member>". A member not listed doesn't exist in Chrome's content scripts either,
 * so the analyzer ignores it rather than reporting code that can't run there.
 */
export const CONTENT_APIS: Readonly<Record<string, Support>> = {
  "runtime.getURL": { status: "supported" },
  "runtime.getManifest": { status: "supported" },
  "runtime.id": { status: "supported" },
  "runtime.lastError": { status: "supported" },
  "runtime.sendMessage": { status: "unsupported", reason: NO_BACKGROUND },
  "runtime.connect": { status: "unsupported", reason: NO_BACKGROUND },
  "runtime.onMessage": { status: "unsupported", reason: NO_BACKGROUND },
  "runtime.onConnect": { status: "unsupported", reason: NO_BACKGROUND },
  "storage.local": { status: "supported" },
  "storage.sync": { status: "supported" },
  "storage.onChanged": { status: "supported" },
  "storage.session": { status: "partial", reason: "kept across browser restarts" },
  "storage.managed": { status: "unsupported", reason: "userscripts have no managed storage" },
  "i18n.getMessage": { status: "supported" },
  "i18n.getUILanguage": { status: "supported" },
  "i18n.getAcceptLanguages": { status: "supported" },
  "i18n.detectLanguage": { status: "unsupported", reason: "language detection isn't available in userscripts" },
  "extension.getURL": { status: "supported" },
  "extension.inIncognitoContext": { status: "supported" },
  "extension.sendRequest": { status: "unsupported", reason: NO_BACKGROUND },
  "extension.onRequest": { status: "unsupported", reason: NO_BACKGROUND },
};

/** Manifest keys for browser features a userscript can't provide. The extension relies on them like on its background. */
export const UNSUPPORTED_MANIFEST_KEYS: Readonly<Record<string, { reason: string; context: Context }>> = {
  chrome_url_overrides: { reason: "a userscript can't replace browser pages", context: "background" },
  devtools_page: { reason: "a userscript can't add developer tools panels", context: "background" },
  side_panel: { reason: "a userscript can't open the side panel", context: "background" },
  sidebar_action: { reason: "a userscript can't open the sidebar", context: "background" },
  declarative_net_request: { reason: "a userscript can't block or change network requests", context: "background" },
  omnibox: { reason: "a userscript can't add address-bar keywords", context: "background" },
  commands: { reason: "keyboard shortcuts aren't converted yet", context: "background" },
};
```

- [ ] **Step 5: Write `src/convert/analyze.ts`**

```ts
// The analyzer (spec §3.4): report entries for the chrome.* APIs the content scripts use and for manifest features,
// plus the gm methods those need for @grant (spec §5.1).
import type { GmMethod } from "../runtime/gm.ts";
import type { Model } from "./manifest.ts";
import type { Context, ReportEntry, Status } from "./report.ts";
import type { ScanResult } from "./scan.ts";
import { CONTENT_APIS, CONTENT_NAMESPACES, UNSUPPORTED_MANIFEST_KEYS } from "./support.ts";

/**
 * scans has one entry per content group, in manifest order: the group's scanned code, or undefined for a group without
 * JS or a MAIN-world group (code in the page's world has no chrome.* APIs, in Chrome as here).
 */
export function analyze(model: Model, scans: ReadonlyArray<ScanResult | undefined>): { entries: ReportEntry[]; methods: Set<GmMethod> } {
  const entries = new Map<string, ReportEntry>();
  const methods = new Set<GmMethod>();
  const add = (subject: string, status: Status, reason: string | undefined, context: Context) => {
    const entry = entries.get(subject) ?? { subject, status, ...(reason ? { reason } : {}), contexts: [] };
    if (!entry.contexts.includes(context)) entry.contexts.push(context);
    entries.set(subject, entry);
  };

  for (const scan of scans) {
    if (!scan) continue;
    for (const chain of scan.chains) {
      const [, namespace, member] = chain.split(".");
      if (member === undefined || !CONTENT_NAMESPACES.has(namespace)) continue;
      const support = CONTENT_APIS[`${namespace}.${member}`];
      if (!support) continue;
      add(`chrome.${namespace}.${member}`, support.status, support.reason, "content");
      for (const method of support.methods ?? []) methods.add(method);
    }
    if (scan.dynamicImport) add("import()", "partial", "dynamic import() isn't bundled in content scripts", "content");
  }

  const groups = model.contentScripts;
  if (groups.some((group) => group.runAt === "document_start")) {
    add("manifest.content_scripts.run_at", "partial", "document_start is best-effort: the script may run after the page's earliest scripts", "content");
  }
  if (groups.some((group) => group.matchAboutBlank)) {
    add("manifest.content_scripts.match_about_blank", "partial", "content scripts don't run in about:blank frames", "content");
  }
  if (model.background) add("manifest.background", "unsupported", "background scripts aren't converted yet", "background");
  if (model.popup) add(`manifest.${model.popup.key}.default_popup`, "unsupported", "the popup isn't converted yet", "popup");
  if (model.options) add(`manifest.${model.options.key}`, "unsupported", "the options page isn't converted yet", "options");
  for (const [key, { reason, context }] of Object.entries(UNSUPPORTED_MANIFEST_KEYS)) {
    if (model.raw[key] !== undefined) add(`manifest.${key}`, "unsupported", reason, context);
  }
  return { entries: [...entries.values()], methods };
}
```

- [ ] **Step 6: Run the test**

Run: `npm run test:file -- test/unit/analyze.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check and commit**

```bash
git add src/convert/report.ts src/convert/support.ts src/convert/analyze.ts test/unit/analyze.test.ts
git commit -m "Report what the content scripts use and what this version can't convert" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The asset table

**Files:**
- Create: `src/convert/assets.ts`
- Test: `test/unit/assets.test.ts`

**Interfaces:**
- Consumes:
  - `ASSET_PREFIX` (Task 3);
  - `AssetTable` (Task 1);
  - `decodeText`, `mimeOf`, `toBase64`, `readManifest` (Task 5);
  - `dirname`, `joinPath` (Plan 1).
- Produces:
  - `pathGlob(glob): RegExp`;
  - `collectAssets(model, files, getUrls, ignore?) → { table: AssetTable; css: string[][]; warnings: string[] }`.

- [ ] **Step 1: Write the failing test** `test/unit/assets.test.ts`

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectAssets, pathGlob } from "../../src/convert/assets.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import { files } from "../support/extension.ts";

const extension = (manifest: Record<string, unknown>, extra: Record<string, string>) => {
  const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1.0", ...manifest }), ...extra });
  return { model: readManifest(all).model, files: all };
};

describe("pathGlob", () => {
  it("matches * across folders, from the extension root", () => {
    assert.equal(pathGlob("img/*").test("img/a/b.png"), true);
    assert.equal(pathGlob("/*.png").test("a.png"), true);
    assert.equal(pathGlob("a.js").test("xa.js"), false);
  });
});

describe("collectAssets", () => {
  it("collects getURL literals in any form, and web_accessible_resources globs", () => {
    const { model, files: all } = extension({ web_accessible_resources: [{ resources: ["fonts/*"], matches: ["<all_urls>"] }] }, {
      "img/a.png": "a", "b.json": "{}", "fonts/x.woff2": "f", "fonts/y.woff2": "f", "other.txt": "",
    });
    const { table, warnings } = collectAssets(model, all, ["/img/a.png", "./b.json?v=1", "missing.js", "../out.js"]);
    assert.deepEqual(Object.keys(table), ["b.json", "fonts/x.woff2", "fonts/y.woff2", "img/a.png"]);
    assert.deepEqual(table["img/a.png"], ["image/png", btoa("a")]);
    assert.equal(table["fonts/x.woff2"][0], "font/woff2");
    assert.deepEqual(warnings, ["runtime.getURL refers to missing.js, which isn't in the extension", 'runtime.getURL("../out.js") points outside the extension']);
  });

  it("rewrites url() in content CSS to placeholders, relative to the CSS file", () => {
    const css = [
      "a { background: url(../img/a.png) }",
      "b { background: url( '/img/b.svg' ) }",
      'c { background: url("chrome-extension://__MSG_@@extension_id__/img/c.gif") }',
      "@font-face { src: url(font.woff2) format('woff2'), url(data:font/woff2;base64,AAAA) }",
      "d { filter: url(#blur); background: url(https://cdn.test/x.png), url(//cdn.test/y.png) }",
      "e { background: url(missing.png) }",
    ].join("\n");
    const { model, files: all } = extension({ content_scripts: [{ matches: ["<all_urls>"], css: ["css/site.css"] }] }, {
      "css/site.css": css, "img/a.png": "", "img/b.svg": "", "img/c.gif": "", "css/font.woff2": "",
    });
    const result = collectAssets(model, all, []);
    assert.deepEqual(result.css, [[
      [
        'a { background: url("x2u-asset:img%2Fa.png") }',
        'b { background: url("x2u-asset:img%2Fb.svg") }',
        'c { background: url("x2u-asset:img%2Fc.gif") }',
        "@font-face { src: url(\"x2u-asset:css%2Ffont.woff2\") format('woff2'), url(data:font/woff2;base64,AAAA) }",
        "d { filter: url(#blur); background: url(https://cdn.test/x.png), url(//cdn.test/y.png) }",
        "e { background: url(missing.png) }",
      ].join("\n"),
    ]]);
    assert.deepEqual(Object.keys(result.table), ["css/font.woff2", "img/a.png", "img/b.svg", "img/c.gif"]);
    assert.deepEqual(result.warnings, ["css/site.css refers to css/missing.png, which isn't in the extension"]);
  });

  it("leaves out --ignore-assets globs, keeping their url() as written", () => {
    const { model, files: all } = extension({ content_scripts: [{ matches: ["<all_urls>"], css: ["a.css"] }], web_accessible_resources: ["big/*"] }, {
      "a.css": "x { background: url(big/huge.png) }", "big/huge.png": "", "big/other.png": "", "small.png": "",
    });
    const result = collectAssets(model, all, ["small.png"], ["big/*"]);
    assert.deepEqual(Object.keys(result.table), ["small.png"]);
    assert.deepEqual(result.css, [["x { background: url(big/huge.png) }"]]);
    assert.deepEqual(result.warnings, []);
  });

  it("warns about a CSS file the manifest lists but the extension lacks", () => {
    const { model, files: all } = extension({ content_scripts: [{ matches: ["<all_urls>"], css: ["gone.css"] }] }, {});
    const result = collectAssets(model, all, []);
    assert.deepEqual(result.css, [[]]);
    assert.deepEqual(result.warnings, ["content_scripts[0].css: gone.css isn't in the extension"]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/assets.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write `src/convert/assets.ts`**

```ts
// The asset table (spec §3.6): the extension files the runtime can hand out as blob: URLs. Collected from getURL string
// literals in the content scripts, url() in their CSS, and web_accessible_resources; minus --ignore-assets globs.
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
  for (const resource of model.webAccessibleResources) {
    const glob = pathGlob(resource);
    for (const path of files.keys()) if (glob.test(path) && !ignored.some((ignore) => ignore.test(path))) wanted.add(path);
  }
  const css = model.contentScripts.map((group, i) =>
    group.css.flatMap((path) => {
      const bytes = files.get(path);
      if (!bytes) {
        warnings.push(`content_scripts[${i}].css: ${path} isn't in the extension`);
        return [];
      }
      return [decodeText(bytes).replace(CSS_URL, (whole, _quote, target: string) => {
        const asset = cssTarget(target, path);
        return asset !== undefined && include(asset, path) ? `url("${ASSET_PREFIX}${encodeURIComponent(asset)}")` : whole;
      })];
    }),
  );

  const table: AssetTable = {};
  for (const path of [...wanted].sort()) table[path] = [mimeOf(path), toBase64(files.get(path) as Uint8Array)];
  return { table, css, warnings };
}

/** The extension file a CSS url() points at, or undefined for data:, remote and fragment-only URLs. */
function cssTarget(target: string, cssPath: string): string | undefined {
  const url = target.trim();
  if (url === "" || url.startsWith("#") || url.startsWith("//") || /^(?:data|https?|blob|about|file):/i.test(url)) return undefined;
  const own = /^(?:chrome|moz)-extension:\/\/__MSG_@@extension_id__\/(.*)$/i.exec(url);
  try {
    return own ? joinPath("", own[1]) : joinPath(url.startsWith("/") ? "" : dirname(cssPath), url);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test:file -- test/unit/assets.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

```bash
git add src/convert/assets.ts test/unit/assets.test.ts
git commit -m "Collect the files the runtime serves and rewrite content CSS urls" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The userscript header

**Files:**
- Create: `src/convert/metadata.ts`
- Test: `test/unit/metadata.test.ts`

**Interfaces:**
- Consumes:
  - `mimeOf`, `toBase64`, `readManifest`, `type Model` (Task 5);
  - `RunAt` (Task 1);
  - `grantsFor` (Plan 1, used by the test).
- Produces:
  - `slugify(text)`;
  - `namespaceOf(model)`;
  - `renderMetadata(model, files, ns, grants): string`.

- [ ] **Step 1: Write the failing test** `test/unit/metadata.test.ts`

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readManifest } from "../../src/convert/manifest.ts";
import { namespaceOf, renderMetadata, slugify } from "../../src/convert/metadata.ts";
import { grantsFor } from "../../src/runtime/gm.ts";
import { files, PIXEL } from "../support/extension.ts";

const extension = (manifest: Record<string, unknown>, extra: Record<string, string | Uint8Array> = {}) => {
  const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "My Ext", version: "2.0.1", ...manifest }), ...extra });
  return { model: readManifest(all).model, files: all };
};
const header = (manifest: Record<string, unknown>, extra?: Record<string, string | Uint8Array>) => {
  const { model, files: all } = extension(manifest, extra);
  return renderMetadata(model, all, namespaceOf(model), grantsFor([]));
};
const values = (text: string, key: string) => [...text.matchAll(new RegExp(`^// @${key}(?: +(.*))?$`, "gm"))].map((match) => match[1] ?? "");

describe("slugify and namespaceOf", () => {
  it("makes a lower-case slug", () => assert.equal(slugify("  Réfined GitHub!! v2 "), "r-fined-github-v2"));
  it("falls back to 'extension' for a name with no letters or digits", () => assert.equal(slugify("★★"), "extension"));
  it("prefers the gecko ID", () => {
    assert.equal(namespaceOf(extension({ browser_specific_settings: { gecko: { id: "a@b" } } }).model), "a@b");
    assert.equal(namespaceOf(extension({}).model), "x2u-my-ext");
  });
});

describe("renderMetadata", () => {
  it("writes the identity lines and the core grants", () => {
    const text = header({ description: "Line one\nline two" });
    assert.match(text, /^\/\/ ==UserScript==\n\/\/ @name {9}My Ext\n\/\/ @namespace {4}x2u-my-ext\n\/\/ @version {6}2\.0\.1\n\/\/ @description {2}Line one line two\n/);
    assert.match(text, /\n\/\/ ==\/UserScript==$/);
    assert.deepEqual(values(text, "grant"), ["GM_addElement", "GM_addValueChangeListener", "GM_deleteValue", "GM_getValue", "GM_listValues", "GM_removeValueChangeListener", "GM_setValue"]);
    assert.deepEqual(values(text, "sandbox"), ["DOM"]);
    assert.deepEqual(values(text, "inject-into"), ["content"]);
  });

  it("matches the union of the groups, maps <all_urls>, and runs everywhere when there are no content scripts", () => {
    const text = header({ content_scripts: [{ matches: ["https://a.test/*", "<all_urls>"] }, { matches: ["https://a.test/*", "https://b.test/*"] }] });
    assert.deepEqual(values(text, "match"), ["https://a.test/*", "*://*/*", "https://b.test/*"]);
    assert.deepEqual(values(header({}), "match"), ["*://*/*"]);
  });

  it("excludes only what every group excludes, and leaves globs to the runtime", () => {
    const text = header({
      content_scripts: [
        { matches: ["https://a.test/*"], exclude_matches: ["https://a.test/x/*", "https://a.test/y/*"], include_globs: ["*a*"] },
        { matches: ["https://b.test/*"], exclude_matches: ["https://a.test/y/*"], exclude_globs: ["*b*"] },
      ],
    });
    assert.deepEqual(values(text, "exclude-match"), ["https://a.test/y/*"]);
    assert.deepEqual([...values(text, "include"), ...values(text, "exclude")], []);
  });

  it("runs at the earliest group's run_at, and adds @noframes unless a group wants frames", () => {
    assert.deepEqual(values(header({ content_scripts: [{ matches: ["<all_urls>"], run_at: "document_end" }, { matches: ["<all_urls>"] }] }), "run-at"), ["document-end"]);
    assert.deepEqual(values(header({ content_scripts: [{ matches: ["<all_urls>"] }] }), "run-at"), ["document-idle"]);
    assert.equal(values(header({ content_scripts: [{ matches: ["<all_urls>"] }] }), "noframes").length, 1);
    assert.equal(values(header({ content_scripts: [{ matches: ["<all_urls>"], all_frames: true }] }), "noframes").length, 0);
  });

  it("uses the smallest icon of at least 32px, else the largest, as a data URL", () => {
    const icons = { icons: { "16": "i16.png", "48": "i48.png", "128": "i128.svg" } };
    assert.deepEqual(values(header(icons, { "i16.png": PIXEL, "i48.png": PIXEL, "i128.svg": "<svg/>" }), "icon"), [`data:image/png;base64,${btoa(String.fromCharCode(...PIXEL))}`]);
    assert.deepEqual(values(header({ icons: { "16": "i16.png" } }, { "i16.png": PIXEL }), "icon").length, 1);
    assert.deepEqual(values(header({ icons: { "48": "missing.png" } }), "icon"), []);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/metadata.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write `src/convert/metadata.ts`**

```ts
// The userscript header (spec §4). Grants come from gm.ts's grant table; nothing here names a GM function.
import type { RunAt } from "../runtime/config.ts";
import { mimeOf, toBase64 } from "./files.ts";
import type { Model } from "./manifest.ts";
import type { ExtensionFiles } from "./unpack.ts";

const RUN_AT_ORDER: readonly RunAt[] = ["document_start", "document_end", "document_idle"];

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "extension";
}

/** The namespace for @namespace and for GM value keys: the Firefox add-on ID when there is one, otherwise the name. */
export function namespaceOf(model: Model): string {
  return model.geckoId ?? `x2u-${slugify(model.name)}`;
}

export function renderMetadata(model: Model, files: ExtensionFiles, ns: string, grants: readonly string[]): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const lines: Array<[key: string, value: string]> = [["name", oneLine(model.name)], ["namespace", ns], ["version", oneLine(model.version)]];
  if (model.description) lines.push(["description", oneLine(model.description)]);
  const icon = iconDataUrl(model, files);
  if (icon) lines.push(["icon", icon]);

  const groups = model.contentScripts;
  const matches = groups.length === 0 ? ["*://*/*"] : [...new Set(groups.flatMap((group) => group.matches.map((p) => (p === "<all_urls>" ? "*://*/*" : p))))];
  for (const pattern of matches) lines.push(["match", pattern]);
  // The header is the union of the groups, so it can only exclude what every group excludes; the runtime does the rest.
  const excludedByAll = groups.length === 0 ? [] : groups[0].excludeMatches.filter((pattern) => groups.every((group) => group.excludeMatches.includes(pattern)));
  for (const pattern of excludedByAll) lines.push(["exclude-match", pattern]);
  const runAt = RUN_AT_ORDER.find((value) => groups.some((group) => group.runAt === value)) ?? "document_idle";
  lines.push(["run-at", runAt.replace("_", "-")]);
  if (!groups.some((group) => group.allFrames)) lines.push(["noframes", ""]);
  lines.push(["sandbox", "DOM"], ["inject-into", "content"]);
  for (const grant of grants) lines.push(["grant", grant]);
  return ["// ==UserScript==", ...lines.map(([key, value]) => `// @${key.padEnd(12)} ${value}`.trimEnd()), "// ==/UserScript=="].join("\n");
}

/** The smallest icon of at least 32px, or the largest one when all are smaller, as a data: URL. */
function iconDataUrl(model: Model, files: ExtensionFiles): string | undefined {
  const sizes = Object.keys(model.icons).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const size = sizes.find((value) => value >= 32) ?? sizes[sizes.length - 1];
  if (size === undefined) return undefined;
  const path = model.icons[String(size)];
  const bytes = files.get(path);
  return bytes ? `data:${mimeOf(path)};base64,${toBase64(bytes)}` : undefined;
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test:file -- test/unit/metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

```bash
git add src/convert/metadata.ts test/unit/metadata.test.ts
git commit -m "Write the userscript header from the manifest model" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Bundle, emit and convert()

**Files:**
- Create: `src/convert/bundle.ts`, `src/convert/emit.ts`, `src/convert/index.ts`
- Modify: `src/convert/esbuild.ts:8`. Widen `EsbuildApi` so `--minify` can use `transform`. Replace
  `export type EsbuildApi = Pick<typeof import("esbuild"), "build">;` with
  `export type EsbuildApi = Pick<typeof import("esbuild"), "build" | "transform">;`
- Test: `test/unit/emit.test.ts`, `test/unit/convert.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–9; `loadEsbuild` (Plan 1, used by the test); `sampleExtension` and `plainExtension` (Task 5).
- Produces:
  - **`bundle.ts`:** `type ContentCode = { world; code } | null` and `bundleContent(model, files) → { code: ContentCode[]; warnings }`.
  - **`emit.ts`:** `emit(header, runtime, config, code): string`.
  - **`index.ts`:**
    - `type ConvertOptions = { runtime; esbuild?; locale?; minify?; ignoreAssets?; extensionId? }`;
    - `type InspectOptions`;
    - `convert(files, options) → Promise<{ userscript; report }>`;
    - `inspect(files, options?) → Promise<Report>`.

- [ ] **Step 1: Write the failing tests** `test/unit/emit.test.ts` and `test/unit/convert.test.ts`. The convert tests use a stand-in runtime string; the real runtime comes in Task 11.

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bundleContent } from "../../src/convert/bundle.ts";
import { emit } from "../../src/convert/emit.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import type { GroupCode, RuntimeConfig } from "../../src/runtime/config.ts";
import { files } from "../support/extension.ts";

const config = { name: "Ext", ns: "x2u-ext", id: "a".repeat(32), manifest: {}, groups: [], assets: {}, locales: {} } satisfies RuntimeConfig;

/** Runs an emitted userscript with a stand-in runtime that hands back what start() received. */
function run(userscript: string): { config: RuntimeConfig; code: GroupCode[] } {
  let received: { config: RuntimeConfig; code: GroupCode[] } | undefined;
  const runtime = "var __x2uRuntime = { start: (config, code) => __received(config, code) };";
  new Function("__received", userscript.replace("__RUNTIME__", runtime))((c: RuntimeConfig, code: GroupCode[]) => (received = { config: c, code }));
  return received as { config: RuntimeConfig; code: GroupCode[] };
}

describe("bundleContent", () => {
  const extension = (scripts: unknown[], extra: Record<string, string>) => {
    const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1", content_scripts: scripts }), ...extra });
    return bundleContent(readManifest(all).model, all);
  };

  it("concatenates each group's files in order, so a trailing // comment can't swallow the next file", () => {
    const { code } = extension([{ matches: ["<all_urls>"], js: ["a.js", "b.js"] }], { "a.js": "var a = 1 // no newline", "b.js": "var b = a + 1" });
    assert.deepEqual(code, [{ world: "ISOLATED", code: "var a = 1 // no newline\n;\nvar b = a + 1" }]);
  });

  it("drops a byte-order mark, gives a CSS-only group null, and warns about a missing file", () => {
    const { code, warnings } = extension(
      [{ matches: ["<all_urls>"], js: ["bom.js", "gone.js"], world: "MAIN" }, { matches: ["<all_urls>"], css: ["a.css"] }],
      { "bom.js": "﻿var x = 1;" },
    );
    assert.deepEqual(code, [{ world: "MAIN", code: "var x = 1;" }, null]);
    assert.deepEqual(warnings, ["content_scripts[0].js: gone.js isn't in the extension, so it was left out"]);
  });
});

describe("emit", () => {
  it("passes the config and one entry per group to start()", () => {
    const userscript = emit("// ==UserScript==\n// ==/UserScript==", "__RUNTIME__", config, [{ world: "ISOLATED", code: "globalThis.__ran = [chrome, browser];" }, { world: "MAIN", code: "page();" }, null]);
    const { config: received, code } = run(userscript);
    assert.deepEqual(received, config);
    assert.equal(typeof code[0], "function");
    assert.equal(code[1], "page();");
    assert.equal(code[2], null);
    const chrome = { tag: "chrome" };
    (code[0] as (c: unknown, b: unknown) => () => void)(chrome, chrome)();
    assert.deepEqual((globalThis as unknown as { __ran: unknown[] }).__ran, [chrome, chrome]);
  });

  it("lets content code declare its own chrome or browser", () => {
    const userscript = emit("// h", "__RUNTIME__", config, [{ world: "ISOLATED", code: "const browser = chrome; let chrome2 = browser; globalThis.__same = chrome2 === chrome;" }]);
    const { code } = run(userscript);
    (code[0] as (c: unknown, b: unknown) => () => void)({}, {})();
    assert.equal((globalThis as unknown as { __same: boolean }).__same, true);
  });
});
```

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { convert, inspect } from "../../src/convert/index.ts";
import { plainExtension, sampleExtension } from "../support/extension.ts";

const origin = "http://127.0.0.1:4567";
/** A stand-in for the built runtime: convert() only embeds it. */
const runtime = "var __x2uRuntime = { start() {} };";

describe("convert", () => {
  it("writes the header, the runtime and the content groups", async () => {
    const { userscript } = await convert(sampleExtension(origin), { runtime });
    const header = userscript.slice(0, userscript.indexOf("// ==/UserScript==") + "// ==/UserScript==".length);
    assert.match(header, /^\/\/ ==UserScript==\n\/\/ @name {9}Sample Extension\n/);
    assert.match(header, /\n\/\/ @match {8}http:\/\/127\.0\.0\.1:4567\/\*\n/);
    assert.match(header, /\n\/\/ @run-at {7}document-start\n/);
    assert.doesNotMatch(header, /@noframes/); // one group has all_frames
    assert.doesNotMatch(header, /@exclude-match/); // only one group excludes it
    assert.match(userscript, /__x2uRuntime\.start\(/);
    assert.match(userscript, /function \(chrome, browser\) \{\nreturn function \(\) \{\nif \(!globalThis\.chrome/);
    assert.match(userscript, /"document\.documentElement\.dataset\.main = String\(window\.pageValue\);"/); // the MAIN group, as text
    assert.doesNotThrow(() => new Function(userscript), "the userscript parses");
  });

  it("puts referenced files and web_accessible_resources in the asset table, and nothing else", async () => {
    const { userscript } = await convert(sampleExtension(origin), { runtime });
    const config = JSON.parse(/__x2uRuntime\.start\((\{.*?\}), \[\n/s.exec(userscript)?.[1] ?? "{}");
    assert.deepEqual(Object.keys(config.assets), ["data/info.json", "img/dot.png", "inject.js"]);
    assert.equal(config.assets["img/dot.png"][0], "image/png");
    assert.deepEqual(config.groups[0].css, ['.x2u-box { color: rgb(1, 2, 3); background-image: url("x2u-asset:img%2Fdot.png"); }']);
    assert.deepEqual(Object.keys(config.locales).sort(), ["en", "fr"]);
  });

  it("leaves --ignore-assets files out", async () => {
    const { userscript } = await convert(sampleExtension(origin), { runtime, ignoreAssets: ["data/*", "*.png"] });
    const config = JSON.parse(/__x2uRuntime\.start\((\{.*?\}), \[\n/s.exec(userscript)?.[1] ?? "{}");
    assert.deepEqual(Object.keys(config.assets), ["inject.js"]);
    assert.deepEqual(config.groups[0].css, [".x2u-box { color: rgb(1, 2, 3); background-image: url(img/dot.png); }"], "an ignored file's url() stays as written");
  });

  it("minifies with esbuild and keeps the header", async () => {
    const options = { runtime, esbuild: await loadEsbuild() };
    const plain = await convert(sampleExtension(origin), options);
    const minified = await convert(sampleExtension(origin), { ...options, minify: true });
    assert.match(minified.userscript, /^\/\/ ==UserScript==[\s\S]*\/\/ ==\/UserScript==\n/);
    assert.ok(minified.userscript.length < plain.userscript.length);
    assert.doesNotThrow(() => new Function(minified.userscript));
  });

  it("uses the store's ID, else one derived from the manifest key, else the gecko ID, for chrome.runtime.id", async () => {
    const withId = await convert(plainExtension(), { runtime, extensionId: "abcdefghijklmnopabcdefghijklmnop" });
    assert.equal(withId.report.extension.id, "abcdefghijklmnopabcdefghijklmnop");
    const derived = (await convert(plainExtension(), { runtime })).report.extension.id;
    assert.match(derived ?? "", /^[a-p]{32}$/);
    assert.equal((await convert(plainExtension(), { runtime })).report.extension.id, derived, "the same input gives the same ID");
  });
});

describe("inspect", () => {
  it("reports the sample as unlikely, naming what it uses", async () => {
    const report = await inspect(sampleExtension(origin));
    assert.equal(report.verdict, "unlikely");
    assert.deepEqual(report.extension, { name: "Sample Extension", version: "1.2.3", manifestVersion: 3, id: report.extension.id });
    const bySubject = Object.fromEntries(report.entries.map((entry) => [entry.subject, entry.status]));
    assert.deepEqual(bySubject, {
      "chrome.runtime.sendMessage": "unsupported",
      "manifest.content_scripts.run_at": "partial",
      "chrome.i18n.getMessage": "supported",
      "chrome.runtime.getURL": "supported",
      "chrome.runtime.id": "supported",
      "chrome.storage.local": "supported",
      "chrome.storage.onChanged": "supported",
    });
    assert.deepEqual(report.entries.map((entry) => entry.status), ["unsupported", "partial", "supported", "supported", "supported", "supported", "supported"]);
    assert.deepEqual(report.warnings, []);
  });

  it("reports a plain content-script extension as likely-works", async () => {
    assert.equal((await inspect(plainExtension())).verdict, "likely-works");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:file -- test/unit/emit.test.ts` and `npm run test:file -- test/unit/convert.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write `src/convert/bundle.ts`**

```ts
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
```

- [ ] **Step 4: Write `src/convert/emit.ts`**

```ts
// Final assembly (spec §3, §5): the header, then one function holding the runtime and a start() call with the config
// and each content group's code.
// - Isolated-world code becomes a factory: function (chrome, browser) { return function () { <code> }; }. The outer
//   parameters give the code its chrome and browser, and the inner function is a scope of its own, so the code may
//   still declare `const browser = …` itself.
// - MAIN-world code stays text: the runtime puts it in the page with gm.addElement.
import type { RuntimeConfig } from "../runtime/config.ts";
import type { ContentCode } from "./bundle.ts";

export function emit(header: string, runtime: string, config: RuntimeConfig, code: readonly ContentCode[]): string {
  const groups = code.map((group) => {
    if (group === null) return "null";
    if (group.world === "MAIN") return JSON.stringify(group.code);
    return `function (chrome, browser) {\nreturn function () {\n${group.code}\n};\n}`;
  });
  return `${header}\n\n(function () {\n${runtime}\n__x2uRuntime.start(${JSON.stringify(config)}, [\n${groups.join(",\n")}\n]);\n})();\n`;
}
```

- [ ] **Step 5: Widen `EsbuildApi` in `src/convert/esbuild.ts`** (see Files), then write `src/convert/index.ts`

```ts
// The conversion core (spec §3): convert(files, options) → { userscript, report }. Pure apart from esbuild (used here
// only for --minify), and the same in the CLI and the web app. inspect() builds the report without the userscript.
import type { RuntimeConfig } from "../runtime/config.ts";
import { grantsFor } from "../runtime/gm.ts";
import { analyze } from "./analyze.ts";
import { collectAssets } from "./assets.ts";
import { bundleContent, type ContentCode } from "./bundle.ts";
import { emit } from "./emit.ts";
import type { EsbuildApi } from "./esbuild.ts";
import { readManifest } from "./manifest.ts";
import { namespaceOf, renderMetadata } from "./metadata.ts";
import { sortEntries, verdictOf, type Report } from "./report.ts";
import { scan } from "./scan.ts";
import type { ExtensionFiles } from "./unpack.ts";

export type ConvertOptions = {
  /** The built runtime (src/convert/runtime-node.ts builds it in Node). */
  runtime: string;
  /** Needed only with minify. */
  esbuild?: EsbuildApi;
  /** --locale: the locale for the header and for chrome.i18n. */
  locale?: string;
  minify?: boolean;
  /** --ignore-assets: path globs to leave out of the asset table. */
  ignoreAssets?: readonly string[];
  /** The store's extension ID, when the source was a store; chrome.runtime.id uses it. */
  extensionId?: string;
};

export type InspectOptions = Omit<ConvertOptions, "runtime" | "esbuild" | "minify">;

export async function convert(files: ExtensionFiles, options: ConvertOptions): Promise<{ userscript: string; report: Report }> {
  const prepared = await prepare(files, options);
  let userscript = emit(prepared.header, options.runtime, prepared.config, prepared.code);
  if (options.minify) {
    if (!options.esbuild) throw new Error("convert: minify needs the esbuild option");
    const body = userscript.slice(prepared.header.length);
    userscript = `${prepared.header}\n${(await options.esbuild.transform(body, { minify: true, target: "es2020" })).code}`;
  }
  return { userscript, report: prepared.report };
}

export async function inspect(files: ExtensionFiles, options: InspectOptions = {}): Promise<Report> {
  return (await prepare(files, options)).report;
}

async function prepare(files: ExtensionFiles, options: InspectOptions): Promise<{ header: string; config: RuntimeConfig; code: ContentCode[]; report: Report }> {
  const { model, warnings: manifestWarnings } = readManifest(files, { locale: options.locale });
  const { code, warnings: bundleWarnings } = bundleContent(model, files);
  const scans = code.map((group) => (group?.world === "ISOLATED" ? scan(group.code) : undefined));
  const { entries, methods } = analyze(model, scans);
  const assets = collectAssets(model, files, scans.flatMap((result) => result?.urls ?? []), options.ignoreAssets);
  const id = options.extensionId ?? (model.key ? await chromeId(base64Bytes(model.key)) : undefined) ?? model.geckoId ?? (await chromeId(new TextEncoder().encode(model.name)));
  const ns = namespaceOf(model);
  const config: RuntimeConfig = {
    name: model.name,
    ns,
    id,
    manifest: model.raw,
    groups: model.contentScripts.map((group, i) => ({
      matches: group.matches,
      excludeMatches: group.excludeMatches,
      includeGlobs: group.includeGlobs,
      excludeGlobs: group.excludeGlobs,
      runAt: group.runAt,
      allFrames: group.allFrames,
      world: group.world,
      css: assets.css[i],
    })),
    assets: assets.table,
    locales: model.locales,
    defaultLocale: model.defaultLocale,
    locale: options.locale ? model.locale : undefined,
  };
  const report: Report = {
    extension: { name: model.name, version: model.version, manifestVersion: model.manifestVersion, id },
    verdict: verdictOf(entries),
    entries: sortEntries(entries),
    warnings: [...manifestWarnings, ...bundleWarnings, ...assets.warnings],
  };
  return { header: renderMetadata(model, files, ns, grantsFor(methods)), config, code, report };
}

const base64Bytes = (base64: string) => Uint8Array.from(atob(base64.replace(/\s+/g, "")), (char) => char.charCodeAt(0));

/** Chrome's extension ID scheme: the first 128 bits of a SHA-256, written with the letters a–p. */
async function chromeId(seed: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", seed));
  return [...hash.subarray(0, 16)].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
}
```

- [ ] **Step 6: Run the tests**

Run: `npm run test:file -- test/unit/emit.test.ts`, the same for `test/unit/convert.test.ts`, and `npm run test:file -- test/unit/esbuild.test.ts`
Expected: all PASS.

- [ ] **Step 7: Type-check and commit**

```bash
git add src/convert/bundle.ts src/convert/emit.ts src/convert/index.ts src/convert/esbuild.ts test/unit/emit.test.ts test/unit/convert.test.ts
git commit -m "Assemble the userscript and the report in convert()" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Run converted content scripts

**Files:**
- Create: `src/runtime/content.ts`, `src/runtime/index.ts`, `src/convert/runtime-node.ts`
- Modify: `bench/emulator/index.ts`. Its page bundle must not make userscripts strict (two edits, below).
- Test: `test/unit/runtime-build.test.ts`, `test/browser/content-runtime.test.ts`

**Interfaces:**
- Consumes:
  - `createGm` (Plan 1);
  - `createLogger`, `readLastError`, `withFallback` and the other Task 3 pieces;
  - `createStorage` (Task 4);
  - `filterMatches` (Task 1);
  - `convert` (Task 10);
  - `backendsFromEnv` and `startSession` (Plan 1);
  - `sampleExtension` (Task 5).
- Produces:
  - **`src/runtime/index.ts`:** `start(config: RuntimeConfig, code: readonly GroupCode[]): void`.
  - **`content.ts`:** `runContent(config, code, deps)`.
  - **`runtime-node.ts`:** `loadRuntime(): Promise<string>` (built once, then cached) and `scopeStrictMode(code): string`.

- [ ] **Step 1: Write the failing tests**

`test/unit/runtime-build.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convert } from "../../src/convert/index.ts";
import { loadRuntime } from "../../src/convert/runtime-node.ts";
import { sampleExtension } from "../support/extension.ts";

describe("loadRuntime", () => {
  it("builds src/runtime into a minified IIFE named __x2uRuntime with a start() function", async () => {
    const runtime = await loadRuntime();
    const exported = new Function(`${runtime}\nreturn __x2uRuntime;`)() as { start?: unknown };
    assert.equal(typeof exported.start, "function");
    assert.equal(await loadRuntime(), runtime, "built once, then cached");
  });

  it("keeps its strict mode to itself, so the extension's code after it stays sloppy", async () => {
    const runtime = await loadRuntime();
    assert.match(runtime, /^var __x2uRuntime=\(\(\)=>\{"use strict";/);
    // Assigning an undeclared name throws in strict code and creates a global in sloppy code.
    const sloppy = new Function(`${runtime}\nx2uUndeclared = 1; const ok = globalThis.x2uUndeclared === 1; delete globalThis.x2uUndeclared; return ok;`);
    assert.equal(sloppy(), true);
  });

  it("gives a userscript that parses", async () => {
    const { userscript } = await convert(sampleExtension("http://127.0.0.1:4567"), { runtime: await loadRuntime() });
    assert.doesNotThrow(() => new Function(userscript));
  });
});
```

`test/browser/content-runtime.test.ts`:

```ts
// A converted extension's content scripts end to end, on each backend in X2U_BACKENDS (default: the CI emulator).
// Release tier: X2U_BACKENDS=tm,vm with the bench profile from `npm run bench:setup`.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { backendsFromEnv, startSession, type Session } from "../../bench/session.ts";
import { convert } from "../../src/convert/index.ts";
import { loadRuntime } from "../../src/convert/runtime-node.ts";
import { readAttr, waitForAttr } from "../support/dom.ts";
import { sampleExtension } from "../support/extension.ts";
import { startServer, type Server } from "../support/server.ts";
import { sleep } from "../support/time.ts";

const html = (body: string, head = "") => () =>
  new Response(`<!doctype html><html><head><title>x2u</title>${head}</head><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
const page = html('<div class="x2u-box">box</div>', "<script>window.pageValue = 42;</script>");

/** Polls an attribute on any element (a frame's <html>, say) until it satisfies ok, for up to 10 s. */
async function attrUntil(element: Locator, name: string, ok: (value: string | null) => boolean): Promise<string | null> {
  let value = await element.getAttribute(name);
  for (let waited = 0; !ok(value) && waited < 10_000; waited += 100) {
    await sleep(100);
    value = await element.getAttribute(name);
  }
  return value;
}

for (const backend of backendsFromEnv()) {
  describe(`converted content scripts on ${backend}`, () => {
    let site: Server;
    let session: Session;

    before(async () => {
      site = await startServer({
        "/page.html": page,
        "/writer.html": page,
        "/excluded.html": page,
        "/glob-yes.html": page,
        "/framed.html": html('<iframe src="/child.html"></iframe>'),
        "/child.html": html("child"),
      });
      const { userscript } = await convert(sampleExtension(site.origin), { runtime: await loadRuntime() });
      session = await startSession(backend, userscript);
    });

    after(async () => {
      await session?.close();
      await site?.close();
    });

    const open = async (path: string): Promise<Page> => {
      const tab = await session.context.newPage();
      await tab.goto(`${site.origin}${path}`);
      return tab;
    };

    it("runs isolated, MAIN-world and document_start groups with their chrome APIs, despite a failing group", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-content", "lib"); // lib.js passed webextension-polyfill's globalThis.chrome check
      assert.equal(await readAttr(tab, "data-greeting"), "Hello x2u");
      await waitForAttr(tab, "data-stored", "1");
      await waitForAttr(tab, "data-info", "sample");
      await waitForAttr(tab, "data-main", "42");
      assert.match((await readAttr(tab, "data-start")) ?? "", /^(loading|interactive|complete)$/);
      assert.equal(await readAttr(tab, "data-glob"), null);
      await waitForAttr(tab, "data-send-error", "ext2userscript: chrome.runtime.sendMessage is not available in userscripts");
    });

    it("applies the group's CSS, with its images as blob URLs", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-content", "lib");
      const style = await tab.locator(".x2u-box").evaluate((box) => ({ color: getComputedStyle(box).color, image: getComputedStyle(box).backgroundImage }));
      assert.equal(style.color, "rgb(1, 2, 3)");
      assert.match(style.image, /^url\("blob:/);
    });

    it("runs a <script src=runtime.getURL(...)> in the page's world, then fires its load event", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-inject-loaded", "1");
      assert.equal(await readAttr(tab, "data-injected"), "page");
    });

    it("honours exclude_matches, include_globs and all_frames", async () => {
      const excluded = await open("/excluded.html");
      await waitForAttr(excluded, "data-main", "42");
      assert.equal(await readAttr(excluded, "data-content"), null);

      await waitForAttr(await open("/glob-yes.html"), "data-glob", "1");

      const child = (await open("/framed.html")).frameLocator("iframe").locator("html");
      assert.equal(await attrUntil(child, "data-content", (value) => value === "lib"), "lib");
      assert.equal(await child.getAttribute("data-main"), null);
    });

    it("delivers storage.onChanged across tabs", async () => {
      const reader = await open("/page.html");
      await waitForAttr(reader, "data-stored", "1");
      await open("/writer.html");
      assert.match((await attrUntil(reader.locator("html"), "data-changed", (value) => (value ?? "").includes("fromWriter"))) ?? "", /fromWriter/);
    });
  });
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:file -- test/unit/runtime-build.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/convert/runtime-node.ts`.

- [ ] **Step 3: Write `src/runtime/content.ts`**

```ts
// Content-script boot (spec §5.5). Each group whose URL filter matches this page (and this frame) gets:
// - its CSS, injected through gm.addElement as soon as there is a document element (Chrome injects content CSS early);
// - its JS at its run_at: isolated-world code called with this extension's chrome object, MAIN-world code put in the
//   page through gm.addElement. One failing group doesn't stop the others (spec §9).
// It also makes <script src=runtime.getURL(...)> work: such a script is swapped for gm.addElement with the file's text.
import type { Assets } from "./assets.ts";
import type { Logger } from "./chrome.ts";
import type { GroupCode, RunAt, RuntimeConfig } from "./config.ts";
import type { Gm } from "./gm.ts";
import { filterMatches } from "./match.ts";

type Deps = { gm: Gm; chrome: object; assets: Assets; log: Logger };

export function runContent(config: RuntimeConfig, code: readonly GroupCode[], deps: Deps): void {
  const inFrame = window.top !== window;
  const groups = config.groups
    .map((group, index) => ({ group, index, code: code[index] }))
    .filter(({ group }) => (!inFrame || group.allFrames) && filterMatches(location.href, group));
  if (groups.length === 0) return;
  if (groups.some(({ code: c }) => typeof c === "function")) interceptAssetScripts(deps);

  const root = () => document.head ?? document.documentElement;
  whenRoot(() => {
    for (const { group } of groups) {
      for (const css of group.css) deps.gm.addElement(root(), "style", { textContent: deps.assets.css(css) }).catch((error: unknown) => deps.log.error(error));
    }
  });

  for (const { group, index, code: c } of groups) {
    if (c === null || c === undefined) continue;
    const run = () => {
      try {
        if (typeof c === "string") deps.gm.addElement(root(), "script", { textContent: c }).catch((error: unknown) => deps.log.error(error));
        else withGlobals(deps.chrome, c(deps.chrome, deps.chrome));
      } catch (error) {
        deps.log.error(`content_scripts[${index}] failed:`, error);
      }
    };
    // MAIN-world code needs an element to go into; isolated-world code at document_start runs at once, as in Chrome.
    if (group.runAt === "document_start") (typeof c === "string" ? whenRoot : (fn: () => void) => fn())(run);
    else whenParsed(group.runAt, run);
  }
}

/** document_end runs at DOMContentLoaded; document_idle runs in a task after that, so after every document_end group. */
function whenParsed(runAt: Exclude<RunAt, "document_start">, fn: () => void): void {
  const run = runAt === "document_end" ? fn : () => setTimeout(fn, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
}

/** A userscript can start before <html> exists; this waits for it. */
function whenRoot(fn: () => void): void {
  if (document.documentElement) return fn();
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    fn();
  });
  observer.observe(document, { childList: true });
}

/**
 * Runs a group's code with globalThis.chrome and globalThis.browser set to this extension's object, then restores
 * them. webextension-polyfill 0.10+ checks globalThis.chrome?.runtime?.id while it loads; code that reads those globals
 * later, from a callback, sees the originals (a ceiling).
 */
function withGlobals(chrome: object, fn: () => void): void {
  const global = globalThis as unknown as Record<string, unknown>;
  const saved = (["chrome", "browser"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(global, name)] as const);
  for (const [name, descriptor] of saved) {
    if (!descriptor || descriptor.configurable) Object.defineProperty(global, name, { value: chrome, configurable: true, writable: true });
  }
  try {
    fn();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor && !descriptor.configurable) continue;
      if (descriptor) Object.defineProperty(global, name, descriptor);
      else delete global[name];
    }
  }
}

/**
 * Content scripts often run code in the page with <script src=runtime.getURL("inject.js")>. A blob: URL would meet the
 * page's CSP, so when such a script is inserted, gm.addElement inserts the file's text instead, and the original
 * element gets its load event. Patched: appendChild, insertBefore, append and prepend (spec §5.5); the script goes at
 * the end of the parent whatever position was asked for.
 */
function interceptAssetScripts({ gm, assets, log }: Deps): void {
  const assetPath = (node: unknown) =>
    node instanceof HTMLScriptElement && node.src && node.type !== "module" ? assets.pathOf(node.src) : undefined;
  // A script with a src runs after the current task, never during the call that inserted it; so does this one.
  const inject = (parent: Node, script: HTMLScriptElement, path: string) =>
    setTimeout(() =>
      gm.addElement(parent, "script", { textContent: assets.text(path) ?? "" }).then(
        () => script.dispatchEvent(new Event("load")),
        (error: unknown) => {
          log.error(error);
          script.dispatchEvent(new Event("error"));
        },
      ),
    );

  const appendChild = Node.prototype.appendChild;
  Node.prototype.appendChild = function <T extends Node>(this: Node, node: T): T {
    const path = assetPath(node);
    if (path === undefined) return appendChild.call(this, node) as T;
    inject(this, node as unknown as HTMLScriptElement, path);
    return node;
  };
  const insertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, child: Node | null): T {
    const path = assetPath(node);
    if (path === undefined) return insertBefore.call(this, node, child) as T;
    inject(this, node as unknown as HTMLScriptElement, path);
    return node;
  };
  for (const name of ["append", "prepend"] as const) {
    const original = Element.prototype[name];
    Element.prototype[name] = function (this: Element, ...nodes: Array<Node | string>) {
      if (!nodes.some((node) => assetPath(node) !== undefined)) return original.apply(this, nodes);
      for (const node of nodes) {
        const path = assetPath(node);
        if (path === undefined) original.call(this, node);
        else inject(this, node as HTMLScriptElement, path);
      }
    };
  }
}
```

- [ ] **Step 4: Write `src/runtime/index.ts`**

```ts
// The runtime's entry point (spec §5). runtime-node.ts bundles this file to an IIFE named __x2uRuntime, and every
// userscript calls __x2uRuntime.start(config, code) once.
import { createAssets } from "./assets.ts";
import { createLogger, readLastError, withFallback } from "./chrome.ts";
import type { GroupCode, RuntimeConfig } from "./config.ts";
import { runContent } from "./content.ts";
import { createGm } from "./gm.ts";
import { createI18n } from "./i18n.ts";
import { createStorage } from "./storage.ts";

export function start(config: RuntimeConfig, code: readonly GroupCode[]): void {
  const log = createLogger(config.name);
  try {
    const gm = createGm();
    if (!gm.caps.valueListeners) {
      log.error(`${gm.handler} isn't supported: ext2userscript supports Tampermonkey and Violentmonkey`);
      return;
    }
    const i18n = withFallback(log, "i18n", createI18n(config, log));
    const assets = createAssets(config.assets, config.id, i18n.getMessage, log);
    const getURL = (path: string) => assets.url(path);
    const runtime = withFallback(log, "runtime", {
      id: config.id,
      get lastError() {
        return readLastError();
      },
      getURL,
      getManifest: () => structuredClone(config.manifest),
    });
    const extension = withFallback(log, "extension", {
      getURL,
      inIncognitoContext: false,
      get lastError() {
        return readLastError();
      },
    });
    // The namespaces Chrome gives content scripts. chrome.tabs and the rest are undefined there, as in Chrome.
    const chrome = { runtime, storage: createStorage(gm, config.ns, log), i18n, extension };
    runContent(config, code, { gm, chrome, assets, log });
  } catch (error) {
    log.error("couldn't start:", error);
  }
}
```

- [ ] **Step 5: Write `src/convert/runtime-node.ts`**

```ts
// Builds the runtime (src/runtime/index.ts) into the IIFE string convert() embeds (spec §5). Node only: the CLI and the
// tests use it. The web app will ship a copy built ahead of time.
import { build } from "esbuild";

let runtime: Promise<string> | undefined;

export function loadRuntime(): Promise<string> {
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
```

- [ ] **Step 6: Run the unit test**

Run: `npm run test:file -- test/unit/runtime-build.test.ts`
Expected: PASS.

- [ ] **Step 7: Stop the emulator from making userscripts strict.** The emulator puts its page bundle and the userscript in one init script. esbuild starts that bundle with `"use strict"`, so every userscript ran strict, which a real manager doesn't do. The sample's `lib.js` assigns an undeclared name, so the browser test fails until this is fixed. In `bench/emulator/index.ts`:
  1. After `import type { BrowserContext, Page } from "playwright";`, add:
     `import { scopeStrictMode } from "../../src/convert/runtime-node.ts";`
  2. Replace `  }).then((result) => result.outputFiles[0].text);` with:
     `  }).then((result) => scopeStrictMode(result.outputFiles[0].text)); // a manager runs userscripts sloppy, so this must not make them strict`

- [ ] **Step 8: Run the browser tests on the emulator**

Run: `npm run test:file -- test/browser/content-runtime.test.ts`
Expected: PASS, 5 tests. Run it 3 times.

Run: `S4_CHURN_MS=10000 npm run test:browser`
Expected: everything passes, apart from the known Firefox S3 failure on macOS 27 ("Could not find profile folder"). The Plan 1 emulator, conformance and S4 tests are unchanged by Step 7.

- [ ] **Step 9 (controller, release tier): run the same file on real managers.** It needs the bench profile and one browser at a time.

Run: `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/content-runtime.test.ts`
Expected: PASS, 10 tests. The prototype got 10 of 10 on Tampermonkey 5.5.1 and Violentmonkey 2.49.0 on 2026-10-10. Afterwards, `pgrep -fl "Google Chrome for Testing"` should show nothing.

- [ ] **Step 10: Type-check and commit**

```bash
git add src/runtime/content.ts src/runtime/index.ts src/convert/runtime-node.ts bench/emulator/index.ts test/unit/runtime-build.test.ts test/browser/content-runtime.test.ts
git commit -m "Run converted content scripts: per-group matching, CSS, run_at, MAIN world and getURL scripts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Downloads and sources

**Files:**
- Modify: `src/download.ts` (whole file below)
- Create: `src/source.ts`
- Modify: `test/unit/download.test.ts` (whole file below)
- Test: `test/unit/source.test.ts`

**Interfaces:**
- Consumes: `unpack` (Task 2); `startServer` (Plan 1 test support).
- Produces:
  - **`download.ts`:**
    - `CWS_PRODVERSION` and `cwsCrxUrl(id)`, both unchanged;
    - `edgeCrxUrl(id)`, `amoAddonUrl(slug)` and `amoXpiUrl(slug)`;
    - `type FetchLimits`;
    - `fetchBytes(url, limits?)`, which now times out (60 s) and stops at a size limit (100 MiB).
  - **`source.ts`:**
    - `type Source`;
    - `parseSource(input)`;
    - `readArchive(source)`;
    - `readSource(source) → { files; extensionId? }`;
    - `sourceName(source)`.
  - `bench/real/setup.ts` keeps using `cwsCrxUrl` and `fetchBytes` unchanged.

- [ ] **Step 1: Write the failing tests.** Replace `test/unit/download.test.ts` with:

```ts
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { amoAddonUrl, CWS_PRODVERSION, cwsCrxUrl, edgeCrxUrl, fetchBytes } from "../../src/download.ts";
import { startServer, type Server } from "../support/server.ts";
import { sleep } from "../support/time.ts";

describe("cwsCrxUrl", () => {
  it("builds the Chrome Web Store download URL", () => {
    assert.equal(
      cwsCrxUrl("hlepfoohegkhhmjieoechaddaejaokhf"),
      `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${CWS_PRODVERSION}&acceptformat=crx2,crx3&x=id%3Dhlepfoohegkhhmjieoechaddaejaokhf%26uc`,
    );
  });

  it("rejects strings that are not extension IDs", () => {
    assert.throws(() => cwsCrxUrl("../etc"), /Not a Chrome Web Store extension ID/);
  });
});

describe("edgeCrxUrl and amoAddonUrl", () => {
  it("builds the Edge Add-ons download URL", () => {
    assert.equal(
      edgeCrxUrl("jbleklapnaakbjjeaojmpgajfgpnpnmf"),
      "https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=id%3Djbleklapnaakbjjeaojmpgajfgpnpnmf%26installsource%3Dondemand%26uc",
    );
    assert.throws(() => edgeCrxUrl("nope"), /Not an Edge Add-ons extension ID/);
  });

  it("builds the AMO API URL, escaping the slug", () => {
    assert.equal(amoAddonUrl("ublock-origin"), "https://addons.mozilla.org/api/v5/addons/addon/ublock-origin/");
    assert.equal(amoAddonUrl("{a b}"), "https://addons.mozilla.org/api/v5/addons/addon/%7Ba%20b%7D/");
  });
});

describe("fetchBytes", () => {
  let server: Server;

  before(async () => {
    server = await startServer({
      "/ok": () => new Response(new Uint8Array([1, 2, 3])),
      "/missing": () => new Response("no", { status: 404, statusText: "Not Found" }),
      "/big": () => new Response(new Uint8Array(2048)),
      "/slow": async () => {
        await sleep(500);
        return new Response("late");
      },
    });
  });

  after(() => server.close());

  it("returns the body", async () => assert.deepEqual(await fetchBytes(`${server.origin}/ok`), new Uint8Array([1, 2, 3])));

  it("fails with the status", async () => {
    await assert.rejects(fetchBytes(`${server.origin}/missing`), /Download failed \(404 Not Found\)/);
  });

  it("stops at maxBytes", async () => {
    await assert.rejects(fetchBytes(`${server.origin}/big`, { maxBytes: 1024 }), /Download is larger than/);
  });

  it("times out", async () => {
    await assert.rejects(fetchBytes(`${server.origin}/slow`, { timeoutMs: 100 }), /Download timed out after 0\.1 s/);
  });
});
```

and write `test/unit/source.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSource, readSource, sourceName } from "../../src/source.ts";

const ID = "hlepfoohegkhhmjieoechaddaejaokhf";

describe("parseSource", () => {
  it("reads Chrome Web Store URLs, old and new, and bare IDs", async () => {
    assert.deepEqual(await parseSource(`https://chromewebstore.google.com/detail/refined-github/${ID}`), { kind: "cws", id: ID });
    assert.deepEqual(await parseSource(`https://chromewebstore.google.com/detail/${ID}?hl=en`), { kind: "cws", id: ID });
    assert.deepEqual(await parseSource(`https://chrome.google.com/webstore/detail/refined-github/${ID}`), { kind: "cws", id: ID });
    assert.deepEqual(await parseSource(ID), { kind: "cws", id: ID });
  });

  it("reads Edge Add-ons URLs", async () => {
    assert.deepEqual(await parseSource(`https://microsoftedge.microsoft.com/addons/detail/some-name/${ID}`), { kind: "edge", id: ID });
  });

  it("reads AMO URLs and slugs", async () => {
    assert.deepEqual(await parseSource("https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/"), { kind: "amo", slug: "ublock-origin" });
    assert.deepEqual(await parseSource("darkreader"), { kind: "amo", slug: "darkreader" });
  });

  it("treats any other URL as a direct download", async () => {
    assert.deepEqual(await parseSource("https://example.com/files/ext.crx"), { kind: "url", url: "https://example.com/files/ext.crx" });
  });

  it("prefers a local file or directory, and names a missing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-source-"));
    await writeFile(join(dir, "darkreader"), "");
    assert.deepEqual(await parseSource(join(dir, "darkreader")), { kind: "file", path: join(dir, "darkreader") });
    assert.deepEqual(await parseSource(dir), { kind: "dir", path: dir });
    await assert.rejects(parseSource(join(dir, "missing.zip")), /No such file or directory/);
    await assert.rejects(parseSource("missing.crx"), /No such file or directory/);
  });
});

describe("readSource", () => {
  it("reads a directory, skipping hidden files and folders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-source-"));
    await mkdir(join(dir, "js"));
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "manifest.json"), "{}");
    await writeFile(join(dir, "js", "a.js"), "1");
    await writeFile(join(dir, ".git", "HEAD"), "x");
    await writeFile(join(dir, ".DS_Store"), "x");
    const { files, extensionId } = await readSource({ kind: "dir", path: dir });
    assert.deepEqual([...files.keys()].sort(), ["js/a.js", "manifest.json"]);
    assert.equal(extensionId, undefined);
  });

  it("refuses a directory without manifest.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-source-"));
    await assert.rejects(readSource({ kind: "dir", path: dir }), /has no manifest\.json/);
  });
});

describe("sourceName", () => {
  it("names output after the store ID, slug or file", () => {
    assert.equal(sourceName({ kind: "cws", id: ID }), ID);
    assert.equal(sourceName({ kind: "amo", slug: "darkreader" }), "darkreader");
    assert.equal(sourceName({ kind: "url", url: "https://example.com/a/ext.crx?x=1" }), "ext");
    assert.equal(sourceName({ kind: "file", path: "/tmp/my-ext.zip" }), "my-ext");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:file -- test/unit/download.test.ts`
Expected: FAIL. `edgeCrxUrl` and `amoAddonUrl` aren't exported, and fetchBytes has no limits.

- [ ] **Step 3: Replace `src/download.ts`**

```ts
// Store downloads (spec §7): Chrome Web Store, Firefox Add-ons (AMO) and Edge Add-ons, plus plain URLs.
// Works in Node and in a browser (the proxy and web app will reuse it).

/** Chrome version reported to the Web Store; some extensions are only served to recent versions. */
export const CWS_PRODVERSION = "153.0.0.0";

const ID = /^[a-p]{32}$/;

export function cwsCrxUrl(id: string): string {
  if (!ID.test(id)) throw new Error(`Not a Chrome Web Store extension ID: ${id}`);
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${CWS_PRODVERSION}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
}

export function edgeCrxUrl(id: string): string {
  if (!ID.test(id)) throw new Error(`Not an Edge Add-ons extension ID: ${id}`);
  return `https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=id%3D${id}%26installsource%3Dondemand%26uc`;
}

/** AMO API v5 for an add-on's slug, numeric ID or GUID. */
export const amoAddonUrl = (slug: string): string => `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(slug)}/`;

/** The current version's .xpi URL, from AMO API v5. */
export async function amoXpiUrl(slug: string): Promise<string> {
  const addon = JSON.parse(new TextDecoder().decode(await fetchBytes(amoAddonUrl(slug), { maxBytes: 5 * 1024 * 1024 }))) as {
    current_version?: { file?: { url?: unknown } };
  };
  const url = addon.current_version?.file?.url;
  if (typeof url !== "string") throw new Error(`AMO has no downloadable version of ${slug}`);
  return url;
}

export type FetchLimits = { timeoutMs?: number; maxBytes?: number };

/** Downloads a URL, failing after timeoutMs (default 60 s) or beyond maxBytes (default 100 MiB). */
export async function fetchBytes(url: string, { timeoutMs = 60_000, maxBytes = 100 * 1024 * 1024 }: FetchLimits = {}): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal });
  } catch (error) {
    throw new Error(signal.aborted ? `Download timed out after ${timeoutMs / 1000} s: ${url}` : `Download failed (${(error as Error).message}): ${url}`, { cause: error });
  }
  if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  try {
    for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader?.read()) {
      length += chunk.value.length;
      if (length > maxBytes) throw new Error(`Download is larger than ${maxBytes / 1024 / 1024} MiB: ${url}`);
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader?.cancel().catch(() => {});
    if (signal.aborted) throw new Error(`Download timed out after ${timeoutMs / 1000} s: ${url}`, { cause: error });
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
```

- [ ] **Step 4: Write `src/source.ts`**

```ts
// The CLI's <source> (spec §7): a Chrome Web Store, AMO or Edge Add-ons URL or ID, a direct archive URL, a local
// archive or a directory. Node only.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { unpack, type ExtensionFiles } from "./convert/unpack.ts";
import { amoXpiUrl, cwsCrxUrl, edgeCrxUrl, fetchBytes } from "./download.ts";

export type Source =
  | { kind: "cws"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "amo"; slug: string }
  | { kind: "url"; url: string }
  | { kind: "file"; path: string }
  | { kind: "dir"; path: string };

const ID = /^[a-p]{32}$/;

/** Works out what a <source> argument names. A local path wins over everything but a URL. */
export async function parseSource(input: string): Promise<Source> {
  if (/^https?:\/\//i.test(input)) return parseUrl(new URL(input));
  const found = await stat(input).catch(() => undefined);
  if (found) return found.isDirectory() ? { kind: "dir", path: input } : { kind: "file", path: input };
  if (ID.test(input)) return { kind: "cws", id: input };
  if (/[/\\]/.test(input) || /\.(crx|xpi|zip)$/i.test(input)) throw new Error(`No such file or directory: ${input}`);
  if (/^[\w.@{}-]+$/.test(input)) return { kind: "amo", slug: input };
  throw new Error(`Not a store URL, extension ID, AMO slug, file or directory: ${input}`);
}

function parseUrl(url: URL): Source {
  const segments = url.pathname.split("/").filter(Boolean);
  const host = url.hostname.toLowerCase();
  const id = segments.filter((segment) => ID.test(segment)).pop();
  if ((host === "chromewebstore.google.com" || (host === "chrome.google.com" && segments[0] === "webstore")) && id) return { kind: "cws", id };
  if (host === "microsoftedge.microsoft.com" && id) return { kind: "edge", id };
  const addon = segments.indexOf("addon");
  if (host === "addons.mozilla.org" && addon !== -1 && segments[addon + 1]) return { kind: "amo", slug: decodeURIComponent(segments[addon + 1]) };
  return { kind: "url", url: url.href };
}

/** The archive's bytes, for every source but a directory. */
export async function readArchive(source: Exclude<Source, { kind: "dir" }>): Promise<Uint8Array> {
  switch (source.kind) {
    case "cws":
      return fetchBytes(cwsCrxUrl(source.id));
    case "edge":
      return fetchBytes(edgeCrxUrl(source.id));
    case "amo":
      return fetchBytes(await amoXpiUrl(source.slug));
    case "url":
      return fetchBytes(source.url);
    case "file":
      return new Uint8Array(await readFile(source.path));
  }
}

/** The extension's files, and its store ID when the store has one Chrome would use for chrome.runtime.id. */
export async function readSource(source: Source): Promise<{ files: ExtensionFiles; extensionId?: string }> {
  if (source.kind === "dir") return { files: await readDirectory(source.path) };
  const files = unpack(await readArchive(source));
  return source.kind === "cws" || source.kind === "edge" ? { files, extensionId: source.id } : { files };
}

/** A short name for output files: the store ID or slug, or the file or URL's base name without its extension. */
export function sourceName(source: Source): string {
  switch (source.kind) {
    case "cws":
    case "edge":
      return source.id;
    case "amo":
      return source.slug;
    case "url":
      return basename(new URL(source.url).pathname).replace(/\.[^.]*$/, "") || "extension";
    case "file":
    case "dir":
      return basename(source.path).replace(/\.(crx|xpi|zip)$/i, "") || "extension";
  }
}

/** Reads an unpacked extension. Hidden files and folders (.git and the like) and symbolic links are skipped. */
async function readDirectory(root: string): Promise<ExtensionFiles> {
  const files: ExtensionFiles = new Map();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (path.split("/").some((part) => part.startsWith("."))) continue;
    files.set(path, new Uint8Array(await readFile(join(entry.parentPath, entry.name))));
  }
  if (!files.has("manifest.json")) throw new Error(`Not an extension: ${root} has no manifest.json`);
  return files;
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:file -- test/unit/download.test.ts` and `npm run test:file -- test/unit/source.test.ts`
Expected: both PASS. They use a local server only, never a store.

- [ ] **Step 6: Type-check and commit**

```bash
git add src/download.ts src/source.ts test/unit/download.test.ts test/unit/source.test.ts
git commit -m "Read sources from every store, URLs, archives and folders, with download limits" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The CLI

**Files:**
- Create: `src/cli.ts`
- Modify: `package.json`. Add the script `"cli": "node --experimental-strip-types --disable-warning=ExperimentalWarning src/cli.ts"` after `"script"`.
- Modify: `README.md` (usage section, below)
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes:
  - `convert` and `inspect` (Task 10);
  - `loadRuntime` (Task 11);
  - `loadEsbuild` (Plan 1);
  - `formatReport` (Task 7);
  - `slugify` (Task 9);
  - `parseSource`, `readArchive`, `readSource`, `sourceName` (Task 12);
  - `plainExtension`, `sampleExtension`, `zipFiles` (Task 5).
- Produces:
  - `USAGE`;
  - `main(argv, out?, err?): Promise<number>`, which returns the exit code: 0 done; 1 error; 2 when the verdict is "unlikely".

- [ ] **Step 1: Write the failing test** `test/unit/cli.test.ts`

```ts
// The CLI as a user runs it: a child process, in a temporary directory.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plainExtension, sampleExtension, zipFiles } from "../support/extension.ts";
import { startServer, type Server } from "../support/server.ts";

const CLI = join(import.meta.dirname, "../../src/cli.ts");

function run(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", CLI, ...args], { cwd }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe("ext2userscript CLI", () => {
  let cwd: string;
  let server: Server;
  const sampleZip = zipFiles(sampleExtension("https://example.com"));

  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), "x2u-cli-"));
    await mkdir(join(cwd, "plain"));
    for (const [path, bytes] of plainExtension()) await writeFile(join(cwd, "plain", path), bytes);
    await writeFile(join(cwd, "sample.zip"), sampleZip);
    server = await startServer({ "/sample.zip": () => new Response(sampleZip) });
  });

  after(() => server.close());

  it("converts a directory, exits 0 and prints the report", async () => {
    const result = await run(cwd, "convert", "plain");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Wrote plain-extension\.user\.js/);
    assert.match(result.stdout, /Plain Extension 0\.1\.0 \(manifest v3\): likely-works/);
    assert.match(await readFile(join(cwd, "plain-extension.user.js"), "utf8"), /^\/\/ ==UserScript==/);
  });

  it("refuses to overwrite without --force", async () => {
    await run(cwd, "convert", "plain", "-o", "again.user.js");
    const refused = await run(cwd, "convert", "plain", "-o", "again.user.js");
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /again\.user\.js already exists \(use --force to overwrite it\)/);
    assert.equal((await run(cwd, "convert", "plain", "-o", "again.user.js", "--force")).code, 0);
  });

  it("exits 2 when the verdict is unlikely, and writes the JSON report", async () => {
    const result = await run(cwd, "convert", "sample.zip", "-o", "sample.user.js", "--report", "sample.json");
    assert.equal(result.code, 2, result.stderr);
    const report = JSON.parse(await readFile(join(cwd, "sample.json"), "utf8"));
    assert.equal(report.verdict, "unlikely");
    assert.ok(report.entries.some((entry: { subject: string }) => entry.subject === "chrome.runtime.sendMessage"));
  });

  it("reports without writing a userscript", async () => {
    const result = await run(cwd, "report", "plain");
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Wrote/);
  });

  it("converts from a URL and downloads an archive as it is", async () => {
    const converted = await run(cwd, "convert", `${server.origin}/sample.zip`, "-o", "from-url.user.js");
    assert.equal(converted.code, 2, converted.stderr);
    const named = await run(cwd, "download", `${server.origin}/sample.zip`);
    assert.equal(named.code, 1, "sample.zip is already there");
    const downloaded = await run(cwd, "download", `${server.origin}/sample.zip`, "-o", "downloaded.zip");
    assert.equal(downloaded.code, 0, downloaded.stderr);
    assert.deepEqual(new Uint8Array(await readFile(join(cwd, "downloaded.zip"))), sampleZip);
  });

  it("explains a bad command line or a missing source", async () => {
    const usage = await run(cwd, "explode", "x");
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /Usage:/);
    const unknown = await run(cwd, "convert", "plain", "--bogus");
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Unknown option '--bogus'/);
    const missing = await run(cwd, "convert", "missing/ext.zip");
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No such file or directory: missing\/ext\.zip/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/cli.test.ts`
Expected: FAIL. The child process can't find `src/cli.ts`.

- [ ] **Step 3: Write `src/cli.ts`**

```ts
// The ext2userscript command line (spec §7): convert, download and report.
// Run it with: npm run cli -- <command> <source> [options]
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadEsbuild } from "./convert/esbuild-node.ts";
import { convert, inspect } from "./convert/index.ts";
import { slugify } from "./convert/metadata.ts";
import { formatReport, type Report } from "./convert/report.ts";
import { loadRuntime } from "./convert/runtime-node.ts";
import { parseSource, readArchive, readSource, sourceName } from "./source.ts";

export const USAGE = `Usage:
  ext2userscript convert <source> [-o out.user.js] [--report report.json] [--locale xx] [--minify] [--ignore-assets glob,...] [--force]
  ext2userscript download <source> [-o file] [--force]
  ext2userscript report <source> [--report report.json] [--locale xx]

<source> is a Chrome Web Store URL or ID, an AMO URL or slug, an Edge Add-ons URL, a .crx/.xpi/.zip URL,
a local archive or a directory. A bare 32-letter ID is looked up on the Chrome Web Store.

--force overwrites output files that already exist.
Exit codes: 0 done; 1 error; 2 converted or reported, but the verdict is "unlikely".`;

type Output = { write(text: string): unknown };

export async function main(argv: readonly string[], out: Output = process.stdout, err: Output = process.stderr): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        report: { type: "string" },
        locale: { type: "string" },
        minify: { type: "boolean" },
        "ignore-assets": { type: "string" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    err.write(`ext2userscript: ${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }
  const { positionals, values } = parsed;
  const [command, input, ...extra] = positionals;
  if (values.help) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  if (!command || !["convert", "download", "report"].includes(command) || !input || extra.length > 0) {
    err.write(`${USAGE}\n`);
    return 1;
  }

  try {
    const source = await parseSource(input);
    const write = (path: string, data: string | Uint8Array) => writeOnce(path, data, values.force === true);

    if (command === "download") {
      if (source.kind === "dir") throw new Error("download needs a store, URL or archive source, not a directory");
      const bytes = await readArchive(source);
      const path = values.output ?? `${sourceName(source)}.${archiveExtension(bytes, source.kind === "amo")}`;
      await write(path, bytes);
      out.write(`Wrote ${path} (${bytes.length} bytes)\n`);
      return 0;
    }

    const { files, extensionId } = await readSource(source);
    const options = {
      locale: values.locale,
      extensionId,
      ignoreAssets: values["ignore-assets"]?.split(",").map((glob) => glob.trim()).filter(Boolean),
    };
    let report: Report;
    if (command === "report") {
      report = await inspect(files, options);
    } else {
      const result = await convert(files, { ...options, runtime: await loadRuntime(), esbuild: await loadEsbuild(), minify: values.minify });
      report = result.report;
      const path = values.output ?? `${slugify(report.extension.name)}.user.js`;
      await write(path, result.userscript);
      out.write(`Wrote ${path}\n`);
    }
    if (values.report) await write(values.report, `${JSON.stringify(report, null, 2)}\n`);
    out.write(`${formatReport(report)}\n`);
    return report.verdict === "unlikely" ? 2 : 0;
  } catch (error) {
    err.write(`ext2userscript: ${(error as Error).message}\n`);
    return 1;
  }
}

/** Writes a new file; an existing one is overwritten only with --force. */
async function writeOnce(path: string, data: string | Uint8Array, force: boolean): Promise<void> {
  try {
    await writeFile(path, data, { flag: force ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${path} already exists (use --force to overwrite it)`);
    throw error;
  }
}

function archiveExtension(bytes: Uint8Array, firefox: boolean): string {
  if (bytes[0] === 0x43 && bytes[1] === 0x72 && bytes[2] === 0x32 && bytes[3] === 0x34) return "crx"; // "Cr24"
  return firefox ? "xpi" : "zip";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
```

- [ ] **Step 4: Add the `cli` script to `package.json`, and a usage section to `README.md`** after its first paragraph:

````markdown
## Usage

Content scripts are converted today; background pages, popups and options pages come next, and the report says what
didn't convert.

```bash
npm run cli -- convert <source> [-o out.user.js] [--report report.json] [--locale xx] [--minify] [--ignore-assets glob,...] [--force]
npm run cli -- download <source> [-o file]
npm run cli -- report <source>
```

`<source>` is a Chrome Web Store URL or ID, an AMO URL or slug, an Edge Add-ons URL, a `.crx`/`.xpi`/`.zip` URL, a
local archive or a folder. Exit codes: 0 done, 1 error, 2 converted but the verdict is "unlikely".
````

- [ ] **Step 5: Run the test, then everything**

Run: `npm run test:file -- test/unit/cli.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm test && S4_CHURN_MS=10000 npm run test:browser`
Expected:
- typecheck: exit 0.
- unit: every test passes.
- browser: everything passes apart from the known Firefox S3 failure on macOS 27.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts package.json README.md test/unit/cli.test.ts
git commit -m "Add the convert, download and report commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After Plan 2

- **Ceilings this plan accepts.** Each one is noted where its code is.
  - Top-level declarations aren't shared between content groups and don't land on `window`.
  - A `"use strict"` at the top of a group's first file makes the whole group strict.
  - `globalThis.chrome` is the extension's object only while a group's code first runs.
  - Asset scripts are appended to the end of their parent, whatever position was asked for.
  - `storage.session` survives browser restarts; Plan 3's leader clears it.
  - Several `set()` calls in one task arrive as one `onChanged` event.
  - Dynamic `import()` in content scripts isn't bundled.
  - Content scripts don't run in `about:blank` frames.
- **Plan 3:**
  - background bundling (classic, `importScripts`, ES modules, and the `import.meta` decision) and boot;
  - `runtime.sendMessage`/`onMessage`/`connect` (the support rows flip to supported);
  - tabs;
  - the fetch/XHR shim, with `@connect` and `GM_xmlhttpRequest`;
  - alarms, commands and notifications.
  - Plan 1's carry-forwards come first: the `out:<id>` cleanup, taking the message handler before the catch-up read, and messages during churn.
- **Plan 3, also:** the model fields only the background uses (`commands`, `hostPermissions`, `permissions` and `optionalPermissions`, spec §3.2), and the header's `@connect` lines (spec §4), along with `GM_xmlhttpRequest`.
- **Plan 4:** popup and options, including the HTML-parser choice from the §6 revision, and HTML `src`/`href`/`srcset` asset collection (spec §3.6).
