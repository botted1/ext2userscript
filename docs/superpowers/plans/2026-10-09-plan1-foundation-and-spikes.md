# ext2userscript Plan 1: Foundation and Spikes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tested foundation every later plan depends on and answer spikes S1–S4, recording the results in the spec. The foundation is the repo scaffold, the GM layer, the CI emulator, the real-manager harness, cross-tab messaging and ES-module bundling.

**Architecture:**
- All GM access goes through `src/runtime/gm.ts`. Tests reach it two ways:
  - Unit tests use a Node in-memory hub of fake `GM_*` functions.
  - Browser tests use a Playwright emulator that stands in for Tampermonkey/Violentmonkey in real pages (CI).
- The same probes also run against real Tampermonkey (TM) and Violentmonkey (VM) in a persistent Chrome for Testing profile (release tier), chosen with `X2U_BACKENDS`.
- Cross-tab messaging (registry, bus, election) is built on `gm.ts`.
- ES-module bundling takes the esbuild API as a parameter, so it runs on native esbuild and on esbuild-wasm.

**Tech Stack:**
- TypeScript, run directly by Node 22.16 with `--experimental-strip-types`. There is no build step.
- `node:test`.
- Playwright 1.64 (Chrome for Testing, Firefox, WebKit).
- esbuild and esbuild-wasm 0.28.2, fflate 0.8.3.
- TypeScript 7.0.2, for type-checking only.

**Spec:** `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`

**Scope:** This is Plan 1 of 6. Each later plan is written after the previous one lands:
2. Converter core and CLI.
3. Cross-tab runtime APIs and background boot.
4. Popup and options UI.
5. Benchmark corpus, scorecard and release tier.
6. Web app, proxy and npm release.

If a spike here fails, the spec is revised before Plan 2 is written (spec §11).

## Global Constraints

- **Node:** Node ≥ 22.16. TypeScript runs directly with `--experimental-strip-types --disable-warning=ExperimentalWarning`. No tsx, no build step.
- **Running things:**
  - One test file: `npm run test:file -- <path>`.
  - One script: `npm run script -- <path>`.
- **TypeScript:** erasable syntax only (no `enum`, `namespace` or parameter properties). Relative imports end in `.ts`. Type-only imports use `import type` or inline `type`. `tsconfig.json` enforces this (`erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`).
- **Exact versions:** `esbuild` 0.28.2 and `esbuild-wasm` 0.28.2 (the two must match), `fflate` 0.8.3. Dev: `playwright` 1.64.0, `typescript` 7.0.2, `@types/node` 22.20.5. No other dependencies.
- **Tests:** `node:test` with `node:assert/strict`. Browser tests use the `playwright` library, not `@playwright/test`.
- **The GM layer:** every GM call goes through `src/runtime/gm.ts`, and no other `src/` file names a `GM_*` function.
  - It is async-only and exposes `caps = { valueListeners, menus, cookies }`.
  - It has one TM/VM implementation and no fallback code.
  - `@grant` lines come from its `GRANTS` table.
- **The CI emulator** stands in for TM/VM *behind* gm.ts: it provides `GM_*` functions and never implements the `Gm` type itself.
- **GM value keys:** `x2u:<ns>:tab:<id>`, `x2u:<ns>:out:<id>`, `x2u:<ns>:roster`.
- **Production timings:**
  - Heartbeat every 2s; a tab is stale after 90s.
  - Election grace period 300ms.
  - Outbox ring: 64 messages, none older than 10s.
- **Backends:** the release-tier profile path is `BENCH_PROFILE` (default `bench/.cache/profile`). `X2U_BACKENDS` chooses backends: `emulator` by default, `tm,vm` for the release tier.
- **Binaries:** third-party extension and manager binaries are never committed. `bench/.cache/` is git-ignored.
- **Spikes:** throwaway spike code lives in `spikes/`, marked THROWAWAY.
- **Commits:** every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Each commit step passes it as a second `-m`.

## Review Focus

1. **Long-hidden tabs.** Chrome throttles a hidden tab's timers to one wake-up per minute, so a leader heartbeats late. Leadership must not move while heartbeats arrive within the staleness limit. Covered by Task 9, "keeps a slowly heartbeating leader".
2. **Back/forward cache and tab close.**
   - `pagehide` must leave the registry, and its leader must lose leadership at once.
   - `pageshow` (persisted) must rejoin with a new `since`, so it doesn't take leadership back.
   - Covered by Task 7, "leave and rejoin", and Task 9, "hands over at once".
3. **Corrupt or foreign values under `x2u:` keys** (older script versions, other scripts sharing the namespace). The registry and bus must clean them up or ignore them, never throw. Covered by Task 7, "cleans up values it cannot read", and Task 8, "ignores outbox values it cannot read".
4. **Managers that coalesce rapid writes.** A reader that misses intermediate outbox states must count the lost messages in `dropped`, never lose them silently. Covered by Task 8, "counts messages lost when a manager coalesces writes".
5. **Hostile or malformed archives:** path traversal (`../`), drive-letter paths, truncated CRX headers, unknown CRX versions, empty downloads. Each must fail with a clear error before anything is written to disk. Covered by Task 2's `unpack` tests.

---

### Task 1: Repository scaffold and match patterns

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `README.md`
- Create: `src/runtime/match.ts`
- Test: `test/unit/match.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `matchPatternToRegExp(pattern: string): RegExp`
  - `urlMatches(url: string, patterns: readonly string[]): boolean`
  - npm scripts `test`, `test:browser`, `test:file`, `script`, `typecheck`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "ext2userscript",
  "version": "0.0.0",
  "description": "Convert browser extensions into userscripts for Tampermonkey and Violentmonkey",
  "license": "MIT",
  "type": "module",
  "engines": {
    "node": ">=22.16"
  },
  "scripts": {
    "test": "node --experimental-strip-types --disable-warning=ExperimentalWarning --test \"test/unit/**/*.test.ts\"",
    "test:browser": "node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-concurrency=1 \"test/browser/**/*.test.ts\"",
    "test:file": "node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-concurrency=1",
    "script": "node --experimental-strip-types --disable-warning=ExperimentalWarning",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "esbuild": "0.28.2",
    "esbuild-wasm": "0.28.2",
    "fflate": "0.8.3"
  },
  "devDependencies": {
    "@types/node": "22.20.5",
    "playwright": "1.64.0",
    "typescript": "7.0.2"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json` and `.gitignore`**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2022", "dom", "dom.iterable"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true
  },
  "include": ["src", "test", "bench", "spikes"]
}
```

`.gitignore`:

```
node_modules/
bench/.cache/
dist/
```

- [ ] **Step 3: Install dependencies and browsers**

Run: `npm install`
Expected: installs without errors and creates `package-lock.json`.

Run: `npx playwright install chromium firefox webkit`
Expected: downloads the three browsers (about 400 MB, cached in `~/Library/Caches/ms-playwright` on macOS).

- [ ] **Step 4: Write `LICENSE` and `README.md`**

Run (the copyright holder comes from your git config):

```bash
cat > LICENSE <<EOF
MIT License

Copyright (c) 2026 $(git config user.name)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF
```

`README.md`:

```markdown
# ext2userscript

Convert Chrome and Firefox extensions into userscripts for Tampermonkey and Violentmonkey.

Work in progress. Design: [docs/superpowers/specs/2026-10-09-ext2userscript-design.md](docs/superpowers/specs/2026-10-09-ext2userscript-design.md).

## Development

Requires Node 22.16 or newer.

    npm install
    npx playwright install chromium firefox webkit
    npm test               # unit tests
    npm run test:browser   # browser tests against the CI emulator
    npm run typecheck
```

- [ ] **Step 5: Write the failing test**

`test/unit/match.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { urlMatches } from "../../src/runtime/match.ts";

const cases: Array<[pattern: string, url: string, expected: boolean]> = [
  ["<all_urls>", "https://example.com/a", true],
  ["<all_urls>", "chrome://extensions/", false],
  ["*://*/*", "http://example.com/", true],
  ["*://*/*", "https://example.com/x?y=1", true],
  ["*://*/*", "ftp://example.com/", false],
  ["https://*.github.com/*", "https://github.com/a", true],
  ["https://*.github.com/*", "https://gist.github.com/a", true],
  ["https://*.github.com/*", "https://notgithub.com/a", false],
  ["https://github.com/*/issues", "https://github.com/a/b/issues", true],
  ["https://github.com/*/issues", "https://github.com/a/issues/1", false],
  ["http://127.0.0.1/*", "http://127.0.0.1:8080/page", true],
  ["http://127.0.0.1:8080/*", "http://127.0.0.1:8080/page", true],
  ["http://127.0.0.1:8080/*", "http://127.0.0.1:9090/page", false],
  ["https://example.com/*", "https://example.com/page#fragment", true],
  ["https://example.com/page", "https://example.com/page?q=1", false],
  ["file:///*", "file:///Users/x/a.html", true],
];

describe("urlMatches", () => {
  for (const [pattern, url, expected] of cases) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${url}`, () => {
      assert.equal(urlMatches(url, [pattern]), expected);
    });
  }

  it("matches when any pattern matches", () => {
    assert.equal(urlMatches("https://b.example/", ["https://a.example/*", "https://b.example/*"]), true);
  });

  it("rejects invalid patterns", () => {
    assert.throws(() => urlMatches("https://example.com/", ["example.com/*"]), /Invalid match pattern/);
    assert.throws(() => urlMatches("https://example.com/", ["https://example.com"]), /Invalid match pattern/);
  });
});
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/runtime/match.ts`.

- [ ] **Step 7: Implement `src/runtime/match.ts`**

```ts
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
```

- [ ] **Step 8: Run the tests and the type-check**

Run: `npm test`
Expected: PASS, 18 tests.

Run: `npm run typecheck`
Expected: no output, exit code 0.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore LICENSE README.md src/runtime/match.ts test/unit/match.test.ts
git commit -m "Scaffold the repo and add Chrome match patterns" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Archive unpacking and Chrome Web Store URLs

**Files:**
- Create: `src/convert/unpack.ts`, `src/download.ts`
- Test: `test/unit/unpack.test.ts`, `test/unit/download.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ExtensionFiles = Map<string, Uint8Array>`
  - `unpack(bytes: Uint8Array): ExtensionFiles`. It throws `Error` with a readable message for anything that isn't a safe extension archive.
  - `CWS_PRODVERSION: string`
  - `cwsCrxUrl(id: string): string`
  - `fetchBytes(url: string): Promise<Uint8Array>`

- [ ] **Step 1: Write the failing tests**

`test/unit/unpack.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { unpack } from "../../src/convert/unpack.ts";

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));

function crx3(payload: Uint8Array, headerLength = 7): Uint8Array {
  const out = new Uint8Array(12 + headerLength + payload.length);
  out.set(strToU8("Cr24"));
  const view = new DataView(out.buffer);
  view.setUint32(4, 3, true);
  view.setUint32(8, headerLength, true);
  out.set(payload, 12 + headerLength);
  return out;
}

function crx2(payload: Uint8Array, keyLength = 5, signatureLength = 3): Uint8Array {
  const out = new Uint8Array(16 + keyLength + signatureLength + payload.length);
  out.set(strToU8("Cr24"));
  const view = new DataView(out.buffer);
  view.setUint32(4, 2, true);
  view.setUint32(8, keyLength, true);
  view.setUint32(12, signatureLength, true);
  out.set(payload, 16 + keyLength + signatureLength);
  return out;
}

const extension = zip({ "manifest.json": '{"manifest_version":3}', "js/content.js": "console.log(1)", "icons/": "" });

describe("unpack", () => {
  it("reads a zip or xpi and skips directory entries", () => {
    const files = unpack(extension);
    assert.deepEqual([...files.keys()].sort(), ["js/content.js", "manifest.json"]);
    assert.equal(new TextDecoder().decode(files.get("js/content.js")), "console.log(1)");
  });

  it("strips a CRX3 header", () => assert.ok(unpack(crx3(extension)).has("manifest.json")));

  it("strips a CRX2 header", () => assert.ok(unpack(crx2(extension)).has("manifest.json")));

  it("normalises ./ and leading slashes", () => {
    assert.deepEqual([...unpack(zip({ "./manifest.json": "{}", "/a/./b.js": "" })).keys()].sort(), ["a/b.js", "manifest.json"]);
  });

  it("rejects an archive without manifest.json", () => {
    assert.throws(() => unpack(zip({ "a.js": "" })), /manifest\.json is missing/);
  });

  it("rejects path traversal", () => {
    assert.throws(() => unpack(zip({ "manifest.json": "{}", "../evil.js": "" })), /Unsafe path in archive: \.\.\/evil\.js/);
  });

  it("rejects drive-letter paths", () => {
    assert.throws(() => unpack(zip({ "manifest.json": "{}", "C:/evil.js": "" })), /Unsafe path in archive/);
  });

  it("rejects bytes that are not an archive", () => {
    assert.throws(() => unpack(strToU8("<html>")), /Unrecognised archive/);
  });

  it("rejects an empty download", () => {
    assert.throws(() => unpack(new Uint8Array()), /empty/);
  });

  it("rejects a truncated CRX", () => {
    assert.throws(() => unpack(crx3(extension).subarray(0, 10)), /Truncated CRX/);
    assert.throws(() => unpack(crx3(new Uint8Array(), 50).subarray(0, 30)), /Truncated CRX/);
  });

  it("rejects unknown CRX versions", () => {
    const bad = crx3(extension);
    new DataView(bad.buffer).setUint32(4, 4, true);
    assert.throws(() => unpack(bad), /Unsupported CRX version 4/);
  });
});
```

`test/unit/download.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CWS_PRODVERSION, cwsCrxUrl } from "../../src/download.ts";

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
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/convert/unpack.ts` and `src/download.ts`.

- [ ] **Step 3: Implement `src/convert/unpack.ts`**

```ts
// Unpacks extension archives in memory (spec §3.1). Runs in Node and in the browser.
import { unzipSync } from "fflate";

/** An unpacked extension: relative POSIX path → file bytes. */
export type ExtensionFiles = Map<string, Uint8Array>;

/** Unpacks a .zip, .xpi or .crx (v2 or v3). Throws a readable Error for anything else. */
export function unpack(bytes: Uint8Array): ExtensionFiles {
  const files: ExtensionFiles = new Map();
  for (const [name, data] of Object.entries(unzipSync(zipPayload(bytes)))) {
    if (name.endsWith("/")) continue; // directory entry
    files.set(safePath(name), data);
  }
  if (!files.has("manifest.json")) throw new Error("Not an extension: manifest.json is missing from the archive");
  return files;
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
  if (parts.length === 0 || parts.includes("..") || /^[a-z]:$/i.test(parts[0])) {
    throw new Error(`Unsafe path in archive: ${name}`);
  }
  return parts.join("/");
}
```

- [ ] **Step 4: Implement `src/download.ts`**

```ts
// Store downloads (spec §7). Plan 1 needs only the Chrome Web Store; AMO and Edge come with the CLI.

/** Chrome version reported to the Web Store; some extensions are only served to recent versions. */
export const CWS_PRODVERSION = "153.0.0.0";

export function cwsCrxUrl(id: string): string {
  if (!/^[a-p]{32}$/.test(id)) throw new Error(`Not a Chrome Web Store extension ID: ${id}`);
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${CWS_PRODVERSION}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
}

export async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}
```

- [ ] **Step 5: Run the tests and the type-check**

Run: `npm test`
Expected: PASS (match, unpack and download suites).

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add src/convert/unpack.ts src/download.ts test/unit/unpack.test.ts test/unit/download.test.ts
git commit -m "Unpack zip/xpi/crx archives safely and build Web Store URLs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The GM layer (`gm.ts`)

**Files:**
- Create: `src/runtime/gm.ts`
- Test: `test/unit/gm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `src/runtime/gm.ts`:
  - `type GmMethod`
  - `GRANTS: Readonly<Record<GmMethod, readonly string[]>>`
  - `CORE_METHODS: readonly GmMethod[]`
  - `grantsFor(methods: Iterable<GmMethod>): string[]`
  - `type ValueListener = (key, oldValue, newValue, remote: boolean) => void`
  - `type GmApi`: the raw `GM_*` shape, every member optional
  - `readManagerApi(): GmApi`
  - `createGm(api?: GmApi): Gm`
  - `type Gm`, with these members:
    - `caps`, `handler`
    - `getValue`, `setValue`, `deleteValue`, `listValues`
    - `addValueChangeListener`, `removeValueChangeListener`
    - `registerMenuCommand`, `unregisterMenuCommand`
    - `xmlHttpRequest`, `addElement`, `openInTab`, `notification`
    - `cookie.list`, `cookie.set`, `cookie.delete`
  - types `Caps`, `XhrRequest`, `GmXhrResponse`, `TabControl`, `GmNotification`, `GmCookie`, `CookieDetails`
  - `class GmUnavailableError extends Error`

- [ ] **Step 1: Write the failing test**

`test/unit/gm.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CORE_METHODS,
  createGm,
  GmUnavailableError,
  grantsFor,
  GRANTS,
  readManagerApi,
  type GmApi,
  type GmCookie,
  type ValueListener,
} from "../../src/runtime/gm.ts";

describe("grant table", () => {
  it("always includes the core set", () => {
    assert.deepEqual(grantsFor([]), [
      "GM_addElement", "GM_addValueChangeListener", "GM_deleteValue", "GM_getValue",
      "GM_listValues", "GM_removeValueChangeListener", "GM_setValue",
    ]);
  });

  it("adds what a conversion needs, sorted and without duplicates", () => {
    assert.deepEqual(grantsFor(["cookie", "xmlHttpRequest", "getValue"]), [
      "GM_addElement", "GM_addValueChangeListener", "GM_cookie", "GM_deleteValue", "GM_getValue",
      "GM_listValues", "GM_removeValueChangeListener", "GM_setValue", "GM_xmlhttpRequest",
    ]);
  });

  it("names at least one GM function for every core method", () => {
    for (const method of CORE_METHODS) assert.ok(GRANTS[method].length > 0, method);
  });
});

describe("createGm", () => {
  it("detects capabilities from the functions the manager provides", () => {
    const full = createGm({
      GM_addValueChangeListener: () => 1,
      GM_registerMenuCommand: () => 1,
      GM_cookie: { list() {}, set() {}, delete() {} },
      GM_info: { scriptHandler: "Tampermonkey" },
    });
    assert.deepEqual(full.caps, { valueListeners: true, menus: true, cookies: true });
    assert.equal(full.handler, "Tampermonkey");
    const bare = createGm({});
    assert.deepEqual(bare.caps, { valueListeners: false, menus: false, cookies: false });
    assert.equal(bare.handler, "unknown");
  });

  it("makes the GM call before returning, so only the result is async", async () => {
    const calls: string[] = [];
    const gm = createGm({
      GM_setValue: (key) => { calls.push(`set ${key}`); },
      GM_addElement: () => { calls.push("addElement"); return {} as Element; },
    });
    const pending = [gm.setValue("a", 1), gm.addElement(null, "style", {})];
    assert.deepEqual(calls, ["set a", "addElement"]);
    await Promise.all(pending);
  });

  it("stores JSON: Dates become strings, functions vanish, undefined deletes", async () => {
    const stored: Record<string, unknown> = {};
    const deleted: string[] = [];
    const gm = createGm({
      GM_setValue: (key, value) => { stored[key] = value; },
      GM_deleteValue: (key) => { deleted.push(key); },
    });
    await gm.setValue("d", { at: new Date(0), skip: undefined, fn: () => 1 });
    assert.deepEqual(stored.d, { at: "1970-01-01T00:00:00.000Z" });
    await gm.setValue("gone", undefined);
    assert.deepEqual(deleted, ["gone"]);
  });

  it("rejects values that cannot be stored as JSON", async () => {
    const gm = createGm({ GM_setValue: () => {} });
    await assert.rejects(gm.setValue("big", 1n), TypeError);
  });

  it("rejects, rather than throws, when a GM function is missing", async () => {
    const gm = createGm({});
    const pending = gm.cookie.list({ url: "https://example.com/" });
    await assert.rejects(pending, (error: unknown) => error instanceof GmUnavailableError && /GM_cookie/.test((error as Error).message));
    await assert.rejects(gm.getValue("x"), GmUnavailableError);
  });

  it("passes values, listeners and menu commands through", async () => {
    const store = new Map<string, unknown>([["k", 1]]);
    let listener: ValueListener | undefined;
    const removed: unknown[] = [];
    const gm = createGm({
      GM_getValue: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      GM_listValues: () => [...store.keys()],
      GM_addValueChangeListener: (_key, fn) => { listener = fn; return "L1"; },
      GM_removeValueChangeListener: (id) => { removed.push(id); },
      GM_registerMenuCommand: () => 7,
      GM_unregisterMenuCommand: (id) => { removed.push(id); },
    });
    assert.equal(await gm.getValue("k"), 1);
    assert.equal(await gm.getValue("missing", "fallback"), "fallback");
    const keys = await gm.listValues();
    keys.push("mutated");
    assert.deepEqual(await gm.listValues(), ["k"]);
    assert.equal(await gm.addValueChangeListener("k", () => {}), "L1");
    assert.equal(typeof listener, "function");
    await gm.removeValueChangeListener("L1");
    assert.equal(await gm.registerMenuCommand("Open", () => {}), 7);
    await gm.unregisterMenuCommand(7);
    assert.deepEqual(removed, ["L1", 7]);
  });

  function fakeXhr(respond: (details: Parameters<NonNullable<GmApi["GM_xmlhttpRequest"]>>[0]) => void) {
    const aborted: string[] = [];
    const gm = createGm({
      GM_xmlhttpRequest: (details) => {
        respond(details);
        return { abort: () => { aborted.push(details.url); details.onabort({}); } };
      },
    });
    return { gm, aborted };
  }

  it("xmlHttpRequest resolves with the response on load", async () => {
    const { gm } = fakeXhr((d) => queueMicrotask(() => d.onload({ status: 201, statusText: "Created", finalUrl: d.url, responseHeaders: "a: b", response: { ok: true } })));
    const response = await gm.xmlHttpRequest({ url: "https://api.example/x", method: "POST", responseType: "json" });
    assert.deepEqual(response, { status: 201, statusText: "Created", finalUrl: "https://api.example/x", responseHeaders: "a: b", response: { ok: true } });
  });

  it("xmlHttpRequest passes method, headers, data and responseType through", async () => {
    let seen: unknown;
    const { gm } = fakeXhr((d) => {
      seen = { method: d.method, url: d.url, headers: d.headers, data: d.data, responseType: d.responseType };
      queueMicrotask(() => d.onload({ status: 200, statusText: "OK", finalUrl: d.url, responseHeaders: "", response: "" }));
    });
    await gm.xmlHttpRequest({ url: "https://x/", headers: { a: "1" }, data: "body" });
    assert.deepEqual(seen, { method: "GET", url: "https://x/", headers: { a: "1" }, data: "body", responseType: "text" });
  });

  it("xmlHttpRequest turns errors, timeouts and aborts into rejections", async () => {
    await assert.rejects(fakeXhr((d) => queueMicrotask(() => d.onerror({}))).gm.xmlHttpRequest({ url: "https://x/" }), TypeError);
    await assert.rejects(fakeXhr((d) => queueMicrotask(() => d.ontimeout({}))).gm.xmlHttpRequest({ url: "https://x/" }), { name: "TimeoutError" });
    const { gm, aborted } = fakeXhr(() => {});
    const controller = new AbortController();
    const pending = gm.xmlHttpRequest({ url: "https://x/slow", signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(aborted, ["https://x/slow"]);
  });

  it("addElement passes the parent only when given one", async () => {
    const calls: unknown[][] = [];
    const gm = createGm({ GM_addElement: (...args: unknown[]) => { calls.push(args); return {} as Element; } });
    const parent = {} as Node;
    await gm.addElement(parent, "style", { textContent: "a{}" });
    await gm.addElement(null, "script", { textContent: "1" });
    assert.deepEqual(calls, [[parent, "style", { textContent: "a{}" }], ["script", { textContent: "1" }]]);
  });

  it("openInTab returns a control that closes the tab and reports the close", async () => {
    const handle = {
      closed: false,
      onclose: null as (() => void) | null,
      close() { handle.closed = true; handle.onclose?.(); },
    };
    let opened: unknown;
    const gm = createGm({ GM_openInTab: (url, options) => { opened = { url, options }; return handle; } });
    const tab = await gm.openInTab("https://example.com/", { active: false });
    assert.deepEqual(opened, { url: "https://example.com/", options: { active: false, insert: true } });
    let closeEvents = 0;
    tab.onClose(() => closeEvents++);
    tab.close();
    assert.equal(tab.closed, true);
    assert.equal(closeEvents, 1);
  });

  it("notification forwards the details", async () => {
    let shown: unknown;
    const gm = createGm({ GM_notification: (details) => { shown = details; } });
    const onclick = () => {};
    await gm.notification({ title: "T", text: "body", onclick });
    assert.deepEqual(shown, { text: "body", title: "T", image: undefined, onclick, ondone: undefined });
  });

  it("cookie methods turn callbacks into promises", async () => {
    const jar: GmCookie[] = [];
    const gm = createGm({
      GM_cookie: {
        list: (_details, callback) => callback([...jar]),
        set: (details, callback) => { jar.push({ name: details.name ?? "", value: details.value ?? "" }); callback(); },
        delete: (_details, callback) => callback("denied"),
      },
    });
    await gm.cookie.set({ url: "https://example.com/", name: "a", value: "1" });
    assert.deepEqual(await gm.cookie.list({ url: "https://example.com/" }), [{ name: "a", value: "1" }]);
    await assert.rejects(gm.cookie.delete({ url: "https://example.com/", name: "a" }), /denied/);
  });

  it("readManagerApi finds the GM functions in scope and ignores the rest", () => {
    const scope = globalThis as Record<string, unknown>;
    scope.GM_getValue = () => 1;
    scope.GM_info = { scriptHandler: "Violentmonkey" };
    try {
      const api = readManagerApi();
      assert.equal(typeof api.GM_getValue, "function");
      assert.equal(api.GM_setValue, undefined);
      assert.equal(createGm(api).handler, "Violentmonkey");
    } finally {
      delete scope.GM_getValue;
      delete scope.GM_info;
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run test:file -- test/unit/gm.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/runtime/gm.ts`.

- [ ] **Step 3: Implement `src/runtime/gm.ts`**

```ts
// The only file in src/ that touches GM_* (spec §5.1). Async-only, with one implementation for Tampermonkey
// and Violentmonkey. Each method calls its GM_* function before its first await, so only the result is async.

export type GmMethod =
  | "getValue" | "setValue" | "deleteValue" | "listValues"
  | "addValueChangeListener" | "removeValueChangeListener"
  | "registerMenuCommand" | "unregisterMenuCommand"
  | "xmlHttpRequest" | "addElement" | "openInTab" | "notification" | "cookie";

/** The GM_* functions each method calls. metadata.ts writes @grant lines from this table. */
export const GRANTS: Readonly<Record<GmMethod, readonly string[]>> = {
  getValue: ["GM_getValue"],
  setValue: ["GM_setValue"],
  deleteValue: ["GM_deleteValue"],
  listValues: ["GM_listValues"],
  addValueChangeListener: ["GM_addValueChangeListener"],
  removeValueChangeListener: ["GM_removeValueChangeListener"],
  registerMenuCommand: ["GM_registerMenuCommand"],
  unregisterMenuCommand: ["GM_unregisterMenuCommand"],
  xmlHttpRequest: ["GM_xmlhttpRequest"],
  addElement: ["GM_addElement"],
  openInTab: ["GM_openInTab"],
  notification: ["GM_notification"],
  cookie: ["GM_cookie"],
};

/** Methods every converted script uses (spec §5.1). */
export const CORE_METHODS: readonly GmMethod[] = [
  "getValue", "setValue", "deleteValue", "listValues",
  "addValueChangeListener", "removeValueChangeListener", "addElement",
];

/** @grant names for the core set plus the given methods, sorted and without duplicates. */
export function grantsFor(methods: Iterable<GmMethod>): string[] {
  const names = new Set<string>();
  for (const method of [...CORE_METHODS, ...methods]) for (const name of GRANTS[method]) names.add(name);
  return [...names].sort();
}

export type ValueListener = (key: string, oldValue: unknown, newValue: unknown, remote: boolean) => void;

export type GmXhrResponse = { status: number; statusText: string; finalUrl: string; responseHeaders: string; response: unknown };

export type GmXhrDetails = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
  responseType: "text" | "json" | "blob" | "arraybuffer";
  timeout?: number;
  anonymous?: boolean;
  onload(response: GmXhrResponse): void;
  onerror(response: unknown): void;
  ontimeout(response: unknown): void;
  onabort(response: unknown): void;
};

export type GmTabHandle = { close(): void; closed: boolean; onclose?: (() => void) | null };

export type GmCookie = { name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number };

export type CookieDetails = { url?: string; name?: string; value?: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number };

/** The raw functions a manager puts in scope. A manager defines only what the script was granted. */
export type GmApi = {
  GM_getValue?(key: string, fallback?: unknown): unknown;
  GM_setValue?(key: string, value: unknown): void;
  GM_deleteValue?(key: string): void;
  GM_listValues?(): string[];
  GM_addValueChangeListener?(key: string, fn: ValueListener): number | string;
  GM_removeValueChangeListener?(id: number | string): void;
  GM_registerMenuCommand?(caption: string, onClick: () => void): number | string;
  GM_unregisterMenuCommand?(id: number | string): void;
  GM_xmlhttpRequest?(details: GmXhrDetails): { abort(): void };
  GM_addElement?(...args: [parent: Node, tag: string, attributes: Record<string, string>] | [tag: string, attributes: Record<string, string>]): Element;
  GM_openInTab?(url: string, options: { active: boolean; insert: boolean }): GmTabHandle;
  GM_notification?(details: { text: string; title?: string; image?: string; onclick?: () => void; ondone?: () => void }): unknown;
  GM_cookie?: {
    list(details: CookieDetails, callback: (cookies: GmCookie[], error?: unknown) => void): void;
    set(details: CookieDetails, callback: (error?: unknown) => void): void;
    delete(details: CookieDetails, callback: (error?: unknown) => void): void;
  };
  GM_info?: { scriptHandler?: string };
};

// Managers put these in the userscript's scope, not on window. They may be undeclared at runtime.
declare const GM_getValue: GmApi["GM_getValue"];
declare const GM_setValue: GmApi["GM_setValue"];
declare const GM_deleteValue: GmApi["GM_deleteValue"];
declare const GM_listValues: GmApi["GM_listValues"];
declare const GM_addValueChangeListener: GmApi["GM_addValueChangeListener"];
declare const GM_removeValueChangeListener: GmApi["GM_removeValueChangeListener"];
declare const GM_registerMenuCommand: GmApi["GM_registerMenuCommand"];
declare const GM_unregisterMenuCommand: GmApi["GM_unregisterMenuCommand"];
declare const GM_xmlhttpRequest: GmApi["GM_xmlhttpRequest"];
declare const GM_addElement: GmApi["GM_addElement"];
declare const GM_openInTab: GmApi["GM_openInTab"];
declare const GM_notification: GmApi["GM_notification"];
declare const GM_cookie: GmApi["GM_cookie"];
declare const GM_info: GmApi["GM_info"];

/** Collects the GM functions in scope. typeof keeps names the manager didn't define from throwing. */
export function readManagerApi(): GmApi {
  return {
    GM_getValue: typeof GM_getValue === "function" ? GM_getValue : undefined,
    GM_setValue: typeof GM_setValue === "function" ? GM_setValue : undefined,
    GM_deleteValue: typeof GM_deleteValue === "function" ? GM_deleteValue : undefined,
    GM_listValues: typeof GM_listValues === "function" ? GM_listValues : undefined,
    GM_addValueChangeListener: typeof GM_addValueChangeListener === "function" ? GM_addValueChangeListener : undefined,
    GM_removeValueChangeListener: typeof GM_removeValueChangeListener === "function" ? GM_removeValueChangeListener : undefined,
    GM_registerMenuCommand: typeof GM_registerMenuCommand === "function" ? GM_registerMenuCommand : undefined,
    GM_unregisterMenuCommand: typeof GM_unregisterMenuCommand === "function" ? GM_unregisterMenuCommand : undefined,
    GM_xmlhttpRequest: typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : undefined,
    GM_addElement: typeof GM_addElement === "function" ? GM_addElement : undefined,
    GM_openInTab: typeof GM_openInTab === "function" ? GM_openInTab : undefined,
    GM_notification: typeof GM_notification === "function" ? GM_notification : undefined,
    GM_cookie: typeof GM_cookie === "object" && GM_cookie !== null ? GM_cookie : undefined,
    GM_info: typeof GM_info === "object" && GM_info !== null ? GM_info : undefined,
  };
}

export type Caps = { valueListeners: boolean; menus: boolean; cookies: boolean };

export type XhrRequest = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: string | Blob | ArrayBuffer | FormData | URLSearchParams;
  responseType?: "text" | "json" | "blob" | "arraybuffer";
  timeout?: number;
  anonymous?: boolean;
  signal?: AbortSignal;
};

export type TabControl = { close(): void; readonly closed: boolean; onClose(fn: () => void): void };

export type GmNotification = { text: string; title?: string; image?: string; onclick?: () => void; ondone?: () => void };

export type Gm = {
  readonly caps: Caps;
  /** GM_info.scriptHandler, e.g. "Tampermonkey". */
  readonly handler: string;
  getValue<T = unknown>(key: string, fallback?: T): Promise<T | undefined>;
  setValue(key: string, value: unknown): Promise<void>;
  deleteValue(key: string): Promise<void>;
  listValues(): Promise<string[]>;
  addValueChangeListener(key: string, fn: ValueListener): Promise<number | string>;
  removeValueChangeListener(id: number | string): Promise<void>;
  registerMenuCommand(caption: string, onClick: () => void): Promise<number | string>;
  unregisterMenuCommand(id: number | string): Promise<void>;
  xmlHttpRequest(request: XhrRequest): Promise<GmXhrResponse>;
  addElement(parent: Node | null, tag: string, attributes?: Record<string, string>): Promise<Element>;
  openInTab(url: string, options?: { active?: boolean }): Promise<TabControl>;
  notification(notification: GmNotification): Promise<void>;
  cookie: {
    list(details: CookieDetails): Promise<GmCookie[]>;
    set(details: CookieDetails): Promise<void>;
    delete(details: CookieDetails): Promise<void>;
  };
};

export class GmUnavailableError extends Error {
  constructor(name: string) {
    super(`ext2userscript: ${name} is not available (not granted, or not supported by this userscript manager)`);
    this.name = "GmUnavailableError";
  }
}

const abortError = () => new DOMException("The operation was aborted.", "AbortError");
const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/** chrome.storage-like JSON semantics on every manager: Dates become strings, functions and undefined vanish. */
const toJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

export function createGm(api: GmApi = readManagerApi()): Gm {
  const need = <K extends keyof GmApi>(name: K): NonNullable<GmApi[K]> => {
    const value = api[name];
    if (value === undefined) throw new GmUnavailableError(name);
    return value as NonNullable<GmApi[K]>;
  };
  /** Runs the GM call now; only the result is async. A throw becomes a rejection. */
  const now = <T>(run: () => T): Promise<T> => {
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const viaCallback = <T>(run: (done: (error: unknown, value?: T) => void) => void): Promise<T> =>
    new Promise((resolve, reject) => run((error, value) => (error ? reject(toError(error)) : resolve(value as T))));

  return {
    caps: {
      valueListeners: typeof api.GM_addValueChangeListener === "function",
      menus: typeof api.GM_registerMenuCommand === "function",
      cookies: typeof api.GM_cookie === "object" && api.GM_cookie !== null,
    },
    handler: api.GM_info?.scriptHandler ?? "unknown",
    getValue: <T>(key: string, fallback?: T) => now(() => need("GM_getValue")(key, fallback) as T | undefined),
    setValue: (key, value) =>
      now(() => {
        if (value === undefined) need("GM_deleteValue")(key);
        else need("GM_setValue")(key, toJson(value));
      }),
    deleteValue: (key) => now(() => need("GM_deleteValue")(key)),
    listValues: () => now(() => [...need("GM_listValues")()]),
    addValueChangeListener: (key, fn) => now(() => need("GM_addValueChangeListener")(key, fn)),
    removeValueChangeListener: (id) => now(() => need("GM_removeValueChangeListener")(id)),
    registerMenuCommand: (caption, onClick) => now(() => need("GM_registerMenuCommand")(caption, onClick)),
    unregisterMenuCommand: (id) => now(() => need("GM_unregisterMenuCommand")(id)),
    xmlHttpRequest: (request) =>
      new Promise<GmXhrResponse>((resolve, reject) => {
        const send = need("GM_xmlhttpRequest"); // the executor runs synchronously, so the GM call happens before return
        if (request.signal?.aborted) return reject(abortError());
        const control = send({
          method: request.method ?? "GET",
          url: request.url,
          headers: request.headers,
          data: request.data,
          responseType: request.responseType ?? "text",
          timeout: request.timeout,
          anonymous: request.anonymous,
          onload: (r) => resolve({ status: r.status, statusText: r.statusText, finalUrl: r.finalUrl, responseHeaders: r.responseHeaders, response: r.response }),
          onerror: () => reject(new TypeError(`ext2userscript: request to ${request.url} failed`)),
          ontimeout: () => reject(new DOMException(`ext2userscript: request to ${request.url} timed out`, "TimeoutError")),
          onabort: () => reject(abortError()),
        });
        request.signal?.addEventListener("abort", () => control.abort(), { once: true });
      }),
    addElement: (parent, tag, attributes = {}) =>
      now(() => (parent ? need("GM_addElement")(parent, tag, attributes) : need("GM_addElement")(tag, attributes))),
    openInTab: (url, options = {}) => now(() => wrapTab(need("GM_openInTab")(url, { active: options.active ?? true, insert: true }))),
    notification: (n) =>
      now(() => {
        need("GM_notification")({ text: n.text, title: n.title, image: n.image, onclick: n.onclick, ondone: n.ondone });
      }),
    cookie: {
      list: (details) => viaCallback<GmCookie[]>((done) => need("GM_cookie").list(details, (cookies, error) => done(error, cookies))),
      set: (details) => viaCallback<void>((done) => need("GM_cookie").set(details, (error) => done(error))),
      delete: (details) => viaCallback<void>((done) => need("GM_cookie").delete(details, (error) => done(error))),
    },
  };
}

function wrapTab(handle: GmTabHandle): TabControl {
  const listeners: Array<() => void> = [];
  handle.onclose = () => {
    for (const fn of listeners) fn();
  };
  return {
    close: () => handle.close(),
    get closed() {
      return handle.closed;
    },
    onClose: (fn) => {
      listeners.push(fn);
    },
  };
}
```

- [ ] **Step 4: Run the tests and the type-check**

Run: `npm run test:file -- test/unit/gm.test.ts`
Expected: PASS, 17 tests.

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/gm.ts test/unit/gm.test.ts
git commit -m "Add the async-only GM layer with capability flags and grant table" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: CI emulator

The emulator plays the userscript manager in Playwright pages: it provides the granted `GM_*` functions and runs the userscript. Each page keeps a local copy of the values for synchronous reads. Writes travel through Node to the other pages, which see them asynchronously with `remote: true`, as with a real manager.

**Files:**
- Create: `bench/emulator/values.ts`, `bench/emulator/meta.ts`, `bench/emulator/page.ts`, `bench/emulator/index.ts`
- Create: `test/support/server.ts`, `test/support/userscript.ts`, `test/support/dom.ts`
- Test: `test/unit/emulator.test.ts`, `test/browser/emulator.test.ts`

**Interfaces:**
- Consumes: `urlMatches` (Task 1), `type ValueListener` (Task 3).
- Produces:
  - **`bench/emulator/values.ts`:**
    - `type ValueStore`: `GM_getValue`, `GM_setValue`, `GM_deleteValue`, `GM_listValues`, `GM_addValueChangeListener`, `GM_removeValueChangeListener`, `applyRemote(key, value)`
    - `createValueStore(initial: Record<string, unknown>, publish: (key: string, value: unknown) => void): ValueStore`
  - **`bench/emulator/meta.ts`:**
    - `type Meta = { name; match; excludeMatch; grant; connect; runAt }`
    - `parseMeta(userscript: string): Meta`
  - **`bench/emulator/index.ts`:**
    - `type Emulator = { store: Map<string, unknown>; clickMenu(page, caption): Promise<boolean>; menu(page): Promise<string[]>; notifications(page) }`
    - `installEmulator(context: BrowserContext, userscript: string): Promise<Emulator>`
  - **`test/support/server.ts`:**
    - `type Handler = (request: Request) => Response | Promise<Response>`
    - `type Server = { origin; port; close() }`
    - `startServer(routes: Record<string, Handler>, port?: number): Promise<Server>`
  - **`test/support/userscript.ts`:**
    - `type RunAt`
    - `type MetaInput = { name; match; excludeMatch?; grant; connect?; runAt?; isolated? }`
    - `renderMeta(meta: MetaInput): string`
    - `buildUserscript(entry: string, meta: MetaInput, define?: Record<string, string>): Promise<string>`
  - **`test/support/dom.ts`:**
    - `readAttr(page, name): Promise<string | null>`
    - `waitForAttr(page, name, expected, timeout?)`
    - `waitForJson<T>(page, name, ok?, timeout?): Promise<T>`

- [ ] **Step 1: Write the failing unit tests**

`test/unit/emulator.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMeta } from "../../bench/emulator/meta.ts";
import { createValueStore } from "../../bench/emulator/values.ts";
import { renderMeta } from "../support/userscript.ts";

describe("createValueStore", () => {
  it("returns copies, fires listeners with remote set correctly, and publishes local writes", () => {
    const published: Array<[string, unknown]> = [];
    const store = createValueStore({ a: { n: 1 } }, (key, value) => published.push([key, value]));
    (store.GM_getValue("a") as { n: number }).n = 99;
    assert.deepEqual(store.GM_getValue("a"), { n: 1 });

    const events: unknown[] = [];
    store.GM_addValueChangeListener("a", (key, oldValue, newValue, remote) => events.push({ key, oldValue, newValue, remote }));
    store.GM_setValue("a", { n: 2 });
    store.applyRemote("a", { n: 3 });
    store.GM_deleteValue("a");
    assert.deepEqual(events, [
      { key: "a", oldValue: { n: 1 }, newValue: { n: 2 }, remote: false },
      { key: "a", oldValue: { n: 2 }, newValue: { n: 3 }, remote: true },
      { key: "a", oldValue: { n: 3 }, newValue: undefined, remote: false },
    ]);
    assert.deepEqual(published, [["a", { n: 2 }], ["a", undefined]]);
    assert.deepEqual(store.GM_listValues(), []);
    assert.equal(store.GM_getValue("a", "fallback"), "fallback");
  });

  it("stops calling a removed listener", () => {
    const store = createValueStore({}, () => {});
    let calls = 0;
    const id = store.GM_addValueChangeListener("k", () => calls++);
    store.GM_setValue("k", 1);
    store.GM_removeValueChangeListener(id);
    store.GM_setValue("k", 2);
    assert.equal(calls, 1);
  });
});

describe("parseMeta", () => {
  it("reads back what renderMeta writes", () => {
    const text = `${renderMeta({
      name: "t",
      match: ["https://a.example/*"],
      excludeMatch: ["https://a.example/x*"],
      grant: ["GM_getValue"],
      connect: ["api.example"],
      runAt: "document-start",
      isolated: true,
    })}\ncode();`;
    assert.deepEqual(parseMeta(text), {
      name: "t",
      match: ["https://a.example/*"],
      excludeMatch: ["https://a.example/x*"],
      grant: ["GM_getValue"],
      connect: ["api.example"],
      runAt: "document-start",
    });
  });

  it("treats @grant none as no grants", () => {
    assert.deepEqual(parseMeta(renderMeta({ name: "t", match: [], grant: [] })).grant, []);
  });

  it("rejects a script without a metadata block", () => {
    assert.throws(() => parseMeta("code();"), /no ==UserScript== block/);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm run test:file -- test/unit/emulator.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `bench/emulator/meta.ts`.

- [ ] **Step 3: Implement `bench/emulator/values.ts`**

```ts
// GM value functions over a local copy of the store (spec §10.2). Shared by the browser emulator and the Node
// test hub: each page or tab reads its copy synchronously, and writes reach the others asynchronously.
import type { ValueListener } from "../../src/runtime/gm.ts";

export type ValueStore = {
  GM_getValue(key: string, fallback?: unknown): unknown;
  GM_setValue(key: string, value: unknown): void;
  GM_deleteValue(key: string): void;
  GM_listValues(): string[];
  GM_addValueChangeListener(key: string, fn: ValueListener): string;
  GM_removeValueChangeListener(id: number | string): void;
  /** Applies a change made by another page or tab. */
  applyRemote(key: string, value: unknown): void;
};

const copy = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export function createValueStore(initial: Record<string, unknown>, publish: (key: string, value: unknown) => void): ValueStore {
  const cache = new Map<string, unknown>(Object.entries(initial));
  const listeners = new Map<string, { key: string; fn: ValueListener }>();
  let nextId = 1;

  const change = (key: string, value: unknown, remote: boolean) => {
    const oldValue = cache.get(key);
    if (value === undefined) cache.delete(key);
    else cache.set(key, value);
    for (const listener of [...listeners.values()]) {
      if (listener.key === key) listener.fn(key, copy(oldValue), copy(value), remote);
    }
  };

  return {
    GM_getValue: (key, fallback) => (cache.has(key) ? copy(cache.get(key)) : fallback),
    GM_setValue: (key, value) => {
      const stored = copy(value);
      change(key, stored, false);
      publish(key, stored);
    },
    GM_deleteValue: (key) => {
      if (!cache.has(key)) return;
      change(key, undefined, false);
      publish(key, undefined);
    },
    GM_listValues: () => [...cache.keys()],
    GM_addValueChangeListener: (key, fn) => {
      const id = String(nextId++);
      listeners.set(id, { key, fn });
      return id;
    },
    GM_removeValueChangeListener: (id) => {
      listeners.delete(String(id));
    },
    applyRemote: (key, value) => change(key, copy(value), true),
  };
}
```

- [ ] **Step 4: Implement `bench/emulator/meta.ts`**

```ts
// Reads the userscript header keys the emulator acts on (spec §10.2).

export type Meta = {
  name: string;
  match: string[];
  excludeMatch: string[];
  grant: string[];
  connect: string[];
  runAt: "document-start" | "document-end" | "document-idle";
};

export function parseMeta(userscript: string): Meta {
  const block = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(userscript);
  if (!block) throw new Error("Userscript has no ==UserScript== block");
  const meta: Meta = { name: "", match: [], excludeMatch: [], grant: [], connect: [], runAt: "document-end" };
  for (const line of block[1].split("\n")) {
    const parts = /^\s*\/\/\s*@([\w-]+)(?:\s+(.*?))?\s*$/.exec(line);
    if (!parts) continue;
    const [, key, value = ""] = parts;
    if (key === "name") meta.name = value;
    else if (key === "match") meta.match.push(value);
    else if (key === "exclude-match") meta.excludeMatch.push(value);
    else if (key === "grant" && value !== "none") meta.grant.push(value);
    else if (key === "connect") meta.connect.push(value);
    else if (key === "run-at") {
      if (value !== "document-start" && value !== "document-end" && value !== "document-idle") throw new Error(`Unsupported @run-at ${value}`);
      meta.runAt = value;
    }
  }
  return meta;
}
```

- [ ] **Step 5: Implement `test/support/userscript.ts`**

```ts
// Builds userscripts for tests: a metadata block plus a probe bundled with esbuild.
import { build } from "esbuild";

export type RunAt = "document-start" | "document-end" | "document-idle";

export type MetaInput = {
  name: string;
  match: string[];
  excludeMatch?: string[];
  grant: string[];
  connect?: string[];
  runAt?: RunAt;
  /** Ask both managers for the isolated world (spec §4): @sandbox DOM (TM), @inject-into content (VM). */
  isolated?: boolean;
};

export function renderMeta(meta: MetaInput): string {
  const lines = ["// ==UserScript==", `// @name         ${meta.name}`, "// @namespace    x2u-tests", "// @version      1.0.0"];
  for (const pattern of meta.match) lines.push(`// @match        ${pattern}`);
  for (const pattern of meta.excludeMatch ?? []) lines.push(`// @exclude-match ${pattern}`);
  for (const grant of meta.grant.length > 0 ? meta.grant : ["none"]) lines.push(`// @grant        ${grant}`);
  for (const host of meta.connect ?? []) lines.push(`// @connect      ${host}`);
  if (meta.isolated) lines.push("// @sandbox      DOM", "// @inject-into  content");
  lines.push(`// @run-at       ${meta.runAt ?? "document-end"}`, "// ==/UserScript==");
  return lines.join("\n");
}

export async function buildUserscript(entry: string, meta: MetaInput, define: Record<string, string> = {}): Promise<string> {
  const result = await build({ entryPoints: [entry], bundle: true, format: "iife", platform: "browser", target: "es2020", write: false, define });
  return `${renderMeta(meta)}\n${result.outputFiles[0].text}`;
}
```

- [ ] **Step 6: Run the unit tests**

Run: `npm run test:file -- test/unit/emulator.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Implement `test/support/server.ts` and `test/support/dom.ts`**

`test/support/server.ts`:

```ts
// A small HTTP server for browser tests. Routes are Fetch-API handlers keyed by path.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (request: Request) => Response | Promise<Response>;
export type Server = { origin: string; port: number; close(): Promise<void> };

const SKIPPED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"]);

export async function startServer(routes: Record<string, Handler>, port = 0): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const handler = routes[url.pathname];
      if (!handler) {
        res.writeHead(404).end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string" && !SKIPPED_HEADERS.has(name)) headers.set(name, value);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(url, { method: req.method, headers, body: hasBody ? new Uint8Array(Buffer.concat(chunks)) : undefined });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${actual}`,
    port: actual,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

`test/support/dom.ts`:

```ts
// Reads results that probes leave on <html> attributes. DOM attributes are shared between the page world
// and a userscript's isolated world, so this works on every backend.
import type { Page } from "playwright";

export const readAttr = (page: Page, name: string): Promise<string | null> => page.locator("html").getAttribute(name);

export async function waitForAttr(page: Page, name: string, expected: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let last: string | null = null;
  while ((last = await readAttr(page, name)) !== expected) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout}ms waiting for <html ${name}="${expected}"> (last value: ${last})`);
    await page.waitForTimeout(100);
  }
}

export async function waitForJson<T>(page: Page, name: string, ok: (value: T) => boolean = () => true, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const raw = await readAttr(page, name);
    if (raw !== null) {
      const value = JSON.parse(raw) as T;
      if (ok(value)) return value;
    }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout}ms waiting for <html ${name}> (last value: ${raw})`);
    await page.waitForTimeout(100);
  }
}
```

- [ ] **Step 8: Write the failing browser test**

`test/browser/emulator.test.ts`:

```ts
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { installEmulator, type Emulator } from "../../bench/emulator/index.ts";
import { readAttr, waitForAttr } from "../support/dom.ts";
import { startServer, type Server } from "../support/server.ts";
import { renderMeta, type MetaInput } from "../support/userscript.ts";

const html = (head = "") => () =>
  new Response(`<!doctype html><html><head><title>t</title>${head}</head><body></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("CI emulator", () => {
  let browser: Browser;
  let site: Server;
  let other: Server;

  before(async () => {
    browser = await chromium.launch();
    site = await startServer({
      "/a.html": html(),
      "/ab.html": html(),
      "/order.html": html(`<script>document.documentElement.setAttribute("data-page-saw", document.documentElement.getAttribute("data-us") ?? "none")</script>`),
      "/echo": async (request) => Response.json({ body: await request.text() }),
    });
    other = await startServer({ "/b.html": html() });
  });

  after(async () => {
    await browser.close();
    await site.close();
    await other.close();
  });

  async function withScript(meta: Partial<MetaInput>, body: string, run: (context: BrowserContext, emulator: Emulator) => Promise<void>) {
    const context = await browser.newContext();
    try {
      const userscript = `${renderMeta({ name: "emulator test", match: [`${site.origin}/*`, `${other.origin}/*`], grant: [], runAt: "document-start", ...meta })}\n${body}`;
      await run(context, await installEmulator(context, userscript));
    } finally {
      await context.close();
    }
  }

  it("shares values across pages on different origins", async () => {
    const body = `
      const root = document.documentElement;
      root.setAttribute("data-initial", JSON.stringify(GM_getValue("k") ?? null));
      GM_addValueChangeListener("k", (key, oldValue, newValue, remote) => root.setAttribute("data-change", JSON.stringify({ newValue, remote })));
      if (location.pathname === "/a.html") GM_setValue("k", { n: 1 });
    `;
    await withScript({ grant: ["GM_getValue", "GM_setValue", "GM_addValueChangeListener"], runAt: "document-end" }, body, async (context) => {
      const b = await context.newPage();
      await b.goto(`${other.origin}/b.html`);
      await waitForAttr(b, "data-initial", "null");
      const a = await context.newPage();
      await a.goto(`${site.origin}/a.html`);
      await waitForAttr(b, "data-change", JSON.stringify({ newValue: { n: 1 }, remote: true }));
      const c = await context.newPage();
      await c.goto(`${other.origin}/b.html`);
      await waitForAttr(c, "data-initial", JSON.stringify({ n: 1 }));
    });
  });

  it("honours @match, @exclude-match and @run-at", async () => {
    const body = `document.documentElement.setAttribute("data-us", "ran");`;
    await withScript({ match: [`${site.origin}/*`], excludeMatch: [`${site.origin}/ab*`] }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/a.html`);
      assert.equal(await readAttr(page, "data-us"), "ran");
      await page.goto(`${site.origin}/ab.html`);
      assert.equal(await readAttr(page, "data-us"), null);
      await page.goto(`${other.origin}/b.html`);
      assert.equal(await readAttr(page, "data-us"), null);
      await page.goto(`${site.origin}/order.html`);
      assert.equal(await readAttr(page, "data-page-saw"), "ran", "document-start runs before the page's scripts");
    });
    await withScript({ runAt: "document-end" }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/order.html`);
      await waitForAttr(page, "data-us", "ran");
      assert.equal(await readAttr(page, "data-page-saw"), "none", "document-end runs after the page's scripts");
    });
  });

  it("defines only the granted functions", async () => {
    const body = `document.documentElement.setAttribute("data-types", [typeof GM_getValue, typeof GM_setValue, typeof GM_info].join(","));`;
    await withScript({ grant: ["GM_getValue"] }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/a.html`);
      assert.equal(await readAttr(page, "data-types"), "function,undefined,object");
    });
  });

  it("GM_xmlhttpRequest skips CORS but enforces @connect", async () => {
    const body = `
      const root = document.documentElement;
      if (location.pathname === "/b.html") GM_xmlhttpRequest({ url: "${site.origin}/echo", method: "POST", data: "hi", responseType: "json",
        onload: (r) => root.setAttribute("data-xhr", r.response.body), onerror: () => root.setAttribute("data-xhr", "error") });
      if (location.pathname === "/a.html") GM_xmlhttpRequest({ url: "http://blocked.example/",
        onload: () => root.setAttribute("data-xhr", "loaded"), onerror: () => root.setAttribute("data-xhr", "blocked") });
    `;
    await withScript({ grant: ["GM_xmlhttpRequest"], connect: ["127.0.0.1"] }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${other.origin}/b.html`);
      await waitForAttr(page, "data-xhr", "hi");
      await page.goto(`${site.origin}/a.html`);
      await waitForAttr(page, "data-xhr", "blocked");
    });
  });

  it("runs menu commands through the test hook", async () => {
    const body = `GM_registerMenuCommand("Say hi", () => document.documentElement.setAttribute("data-menu", "clicked"));`;
    await withScript({ grant: ["GM_registerMenuCommand"] }, body, async (context, emulator) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/a.html`);
      assert.deepEqual(await emulator.menu(page), ["Say hi"]);
      assert.equal(await emulator.clickMenu(page, "Say hi"), true);
      assert.equal(await readAttr(page, "data-menu"), "clicked");
    });
  });
});
```

- [ ] **Step 9: Run it to make sure it fails**

Run: `npm run test:file -- test/browser/emulator.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `bench/emulator/index.ts`.

- [ ] **Step 10: Implement `bench/emulator/page.ts`**

```ts
// In-page half of the CI emulator (spec §10.2). It plays the userscript manager:
// - provides only the granted GM_* functions;
// - honours @match, @exclude-match and @run-at;
// - keeps a local copy of the shared values.
// index.ts bundles it to an IIFE (global __x2uEmuPage) and injects it with context.addInitScript.
import { urlMatches } from "../../src/runtime/match.ts";
import type { Meta } from "./meta.ts";
import { createValueStore } from "./values.ts";

type XhrResult =
  | { status: number; statusText: string; finalUrl: string; responseHeaders: string; contentType: string; bodyBase64: string }
  | { error: string };

/** Playwright bindings installed by index.ts. */
type Bridge = {
  __x2uEmuSet(key: string, value: unknown): Promise<void>;
  __x2uEmuXhr(details: { method: string; url: string; headers: Record<string, string>; data?: string; timeout?: number }): Promise<XhrResult>;
  __x2uEmuOpen(url: string, active: boolean): Promise<number>;
  __x2uEmuClose(id: number): Promise<void>;
  __x2uEmuCookie(op: "list" | "set" | "delete", details: Record<string, unknown>): Promise<unknown>;
};

/** Hooks the Node side calls with frame.evaluate. */
export type Hooks = {
  apply(key: string, value: unknown): void;
  clickMenu(caption: string): boolean;
  menu(): string[];
  notifications: Array<{ text: string; title?: string }>;
  tabClosed(id: number): void;
};

type TabHandle = { closed: boolean; onclose: (() => void) | null; close(): void };

type XhrDetails = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
  responseType?: string;
  timeout?: number;
  onload?(response: unknown): void;
  onerror?(response: unknown): void;
  ontimeout?(response: unknown): void;
  onabort?(response: unknown): void;
};

export function boot(meta: Meta, run: (api: Record<string, unknown>) => void): void {
  if (!urlMatches(location.href, meta.match) || urlMatches(location.href, meta.excludeMatch)) return;
  const win = window as unknown as Bridge & { __x2uEmu?: Hooks };
  const values = createValueStore(readSnapshot(), (key, value) => {
    void win.__x2uEmuSet(key, value);
  });
  const menu = new Map<string, { caption: string; onClick: () => void }>();
  const tabs = new Map<number, TabHandle>();
  const notifications: Hooks["notifications"] = [];
  let nextMenuId = 1;

  win.__x2uEmu = {
    apply: (key, value) => values.applyRemote(key, value),
    clickMenu: (caption) => {
      for (const command of menu.values()) {
        if (command.caption === caption) {
          command.onClick();
          return true;
        }
      }
      return false;
    },
    menu: () => [...menu.values()].map((command) => command.caption),
    notifications,
    tabClosed: (id) => {
      const tab = tabs.get(id);
      if (tab && !tab.closed) {
        tab.closed = true;
        tab.onclose?.();
      }
    },
  };

  const provided: Record<string, unknown> = {
    GM_getValue: values.GM_getValue,
    GM_setValue: values.GM_setValue,
    GM_deleteValue: values.GM_deleteValue,
    GM_listValues: values.GM_listValues,
    GM_addValueChangeListener: values.GM_addValueChangeListener,
    GM_removeValueChangeListener: values.GM_removeValueChangeListener,
    GM_registerMenuCommand: (caption: string, onClick: () => void) => {
      const id = String(nextMenuId++);
      menu.set(id, { caption, onClick });
      return id;
    },
    GM_unregisterMenuCommand: (id: number | string) => {
      menu.delete(String(id));
    },
    GM_xmlhttpRequest: (details: XhrDetails) => xhr(win, meta, details),
    GM_addElement: addElement,
    GM_openInTab: (url: string, options?: boolean | { active?: boolean }) => openInTab(win, tabs, url, options),
    GM_notification: (details: { text: string; title?: string }) => {
      notifications.push({ text: details.text, title: details.title });
      return { remove: async () => {} };
    },
    GM_cookie: cookieApi(win),
  };
  const api: Record<string, unknown> = { GM_info: { scriptHandler: "x2u-emulator", version: "1", script: { name: meta.name } } };
  for (const name of meta.grant) if (name in provided) api[name] = provided[name];

  const start = () => run(api);
  if (meta.runAt === "document-start") whenRootExists(start);
  else if (meta.runAt === "document-end") whenParsed(start);
  else whenParsed(() => setTimeout(start, 0));
}

/**
 * Init scripts can run before <html> exists. A manager's document-start runs once it does.
 * The MutationObserver callback is a microtask, and the parser runs a microtask checkpoint before each
 * script, so this still runs before the page's first script.
 */
function whenRootExists(fn: () => void): void {
  if (document.documentElement) return fn();
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    fn();
  });
  observer.observe(document, { childList: true });
}

function whenParsed(fn: () => void): void {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
  else fn();
}

/** Synchronous, so GM_getValue sees stored values from the userscript's first line. index.ts routes this URL. */
function readSnapshot(): Record<string, unknown> {
  const request = new XMLHttpRequest();
  request.open("GET", "/__x2u_emu__/snapshot", false);
  request.send();
  return request.status === 200 ? (JSON.parse(request.responseText) as Record<string, unknown>) : {};
}

function xhr(win: Bridge, meta: Meta, details: XhrDetails): { abort(): void } {
  let settled = false;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };
  const url = new URL(details.url, location.href);
  const allowed = url.hostname === location.hostname || meta.connect.some((host) => host === "*" || url.hostname === host || url.hostname.endsWith(`.${host}`));
  if (!allowed) {
    queueMicrotask(() => settle(() => details.onerror?.({ status: 0, error: `@connect does not allow ${url.hostname}` })));
    return { abort() {} };
  }
  const request = { method: details.method ?? "GET", url: url.href, headers: details.headers ?? {}, data: typeof details.data === "string" ? details.data : undefined, timeout: details.timeout };
  void win.__x2uEmuXhr(request).then((result) => {
    if ("error" in result) {
      settle(() => (result.error === "timeout" ? details.ontimeout?.({}) : details.onerror?.({ status: 0, error: result.error })));
      return;
    }
    const bytes = Uint8Array.from(atob(result.bodyBase64), (char) => char.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    const type = details.responseType ?? "text";
    const response =
      type === "json" ? parseJson(text)
      : type === "arraybuffer" ? bytes.buffer
      : type === "blob" ? new Blob([bytes], { type: result.contentType })
      : text;
    settle(() =>
      details.onload?.({ status: result.status, statusText: result.statusText, finalUrl: result.finalUrl, responseHeaders: result.responseHeaders, response, responseText: text }),
    );
  });
  return { abort: () => settle(() => details.onabort?.({})) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function addElement(...args: unknown[]): Element {
  const hasParent = typeof args[0] !== "string";
  const parent = hasParent ? (args[0] as Node | null) : null;
  const tag = (hasParent ? args[1] : args[0]) as string;
  const attributes = ((hasParent ? args[2] : args[1]) ?? {}) as Record<string, string>;
  const doc = parent === null ? document : parent.nodeType === Node.DOCUMENT_NODE ? (parent as Document) : (parent.ownerDocument ?? document);
  const element = doc.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "textContent") element.textContent = value;
    else element.setAttribute(name, value);
  }
  const fallback = tag === "script" || tag === "style" || tag === "link" ? doc.head : doc.body;
  (parent ?? fallback ?? doc.documentElement).appendChild(element);
  return element;
}

function openInTab(win: Bridge, tabs: Map<number, TabHandle>, url: string, options?: boolean | { active?: boolean }): TabHandle {
  const active = typeof options === "boolean" ? !options : (options?.active ?? true);
  let id: number | undefined;
  let closeRequested = false;
  const handle: TabHandle = {
    closed: false,
    onclose: null,
    close: () => {
      closeRequested = true;
      if (id !== undefined) void win.__x2uEmuClose(id);
    },
  };
  void win.__x2uEmuOpen(new URL(url, location.href).href, active).then((tabId) => {
    id = tabId;
    tabs.set(tabId, handle);
    if (closeRequested) void win.__x2uEmuClose(tabId);
  });
  return handle;
}

function cookieApi(win: Bridge) {
  const call = (op: "list" | "set" | "delete") => (details: Record<string, unknown>, callback?: (...args: unknown[]) => void) => {
    win.__x2uEmuCookie(op, details).then(
      (result) => (op === "list" ? callback?.(result, undefined) : callback?.(undefined)),
      (error: unknown) => (op === "list" ? callback?.([], String(error)) : callback?.(String(error))),
    );
  };
  return { list: call("list"), set: call("set"), delete: call("delete") };
}
```

- [ ] **Step 11: Implement `bench/emulator/index.ts`**

```ts
// Node half of the CI emulator (spec §10.2): stands in for Tampermonkey/Violentmonkey behind gm.ts.
// Shared values live here. Each page keeps a local copy (page.ts) that reads synchronously, and writes reach
// the other pages asynchronously with remote: true, as with a real manager.
import { build } from "esbuild";
import type { BrowserContext, Page } from "playwright";
import { parseMeta } from "./meta.ts";
import type { Hooks } from "./page.ts";

export type Emulator = {
  /** The values as the "manager" has stored them. */
  store: Map<string, unknown>;
  clickMenu(page: Page, caption: string): Promise<boolean>;
  menu(page: Page): Promise<string[]>;
  notifications(page: Page): Promise<Array<{ text: string; title?: string }>>;
};

type HookWindow = { __x2uEmu?: Hooks };

let pageBundle: Promise<string> | undefined;
function bundlePage(): Promise<string> {
  pageBundle ??= build({
    entryPoints: [`${import.meta.dirname}/page.ts`],
    bundle: true,
    format: "iife",
    globalName: "__x2uEmuPage",
    platform: "browser",
    target: "es2020",
    write: false,
  }).then((result) => result.outputFiles[0].text);
  return pageBundle;
}

export async function installEmulator(context: BrowserContext, userscript: string): Promise<Emulator> {
  const meta = parseMeta(userscript);
  const store = new Map<string, unknown>();
  const tabs = new Map<number, Page>();
  let nextTabId = 1;

  await context.route("**/__x2u_emu__/snapshot", (route) => route.fulfill({ json: Object.fromEntries(store) }));

  await context.exposeBinding("__x2uEmuSet", async ({ frame }, key: string, value: unknown) => {
    if (value === undefined) store.delete(key);
    else store.set(key, value);
    for (const page of context.pages()) {
      for (const other of page.frames()) {
        if (other === frame) continue;
        other.evaluate(([k, v]) => (window as unknown as HookWindow).__x2uEmu?.apply(k, v), [key, value] as const).catch(() => {});
      }
    }
  });

  await context.exposeBinding("__x2uEmuXhr", async (_source, d: { method: string; url: string; headers: Record<string, string>; data?: string; timeout?: number }) => {
    try {
      // context.request shares the browser context's cookies, like a manager's background fetch.
      const response = await context.request.fetch(d.url, { method: d.method, headers: d.headers, data: d.data, timeout: d.timeout ?? 0, failOnStatusCode: false });
      return {
        status: response.status(),
        statusText: response.statusText(),
        finalUrl: response.url(),
        responseHeaders: response.headersArray().map((h) => `${h.name}: ${h.value}`).join("\r\n"),
        contentType: response.headers()["content-type"] ?? "",
        bodyBase64: (await response.body()).toString("base64"),
      };
    } catch (error) {
      return { error: /timeout/i.test(String(error)) ? "timeout" : String(error) };
    }
  });

  await context.exposeBinding("__x2uEmuOpen", async ({ frame }, url: string) => {
    const id = nextTabId++;
    const page = await context.newPage();
    tabs.set(id, page);
    page.on("close", () => {
      frame.evaluate((tabId) => (window as unknown as HookWindow).__x2uEmu?.tabClosed(tabId), id).catch(() => {});
    });
    page.goto(url).catch(() => {});
    return id;
  });

  await context.exposeBinding("__x2uEmuClose", async (_source, id: number) => {
    await tabs.get(id)?.close();
  });

  await context.exposeBinding("__x2uEmuCookie", async (_source, op: "list" | "set" | "delete", d: { url?: string; name?: string; value?: string; domain?: string }) => {
    const url = d.url ?? "";
    if (op === "list") {
      const cookies = await context.cookies(url ? [url] : []);
      return cookies
        .filter((c) => !d.name || c.name === d.name)
        .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expires > 0 ? c.expires : undefined }));
    }
    if (op === "set") {
      await context.addCookies([{ name: d.name ?? "", value: d.value ?? "", url }]);
      return undefined;
    }
    await context.clearCookies({ name: d.name, domain: d.domain ?? new URL(url).hostname });
    return undefined;
  });

  // Declared as locals of the wrapper function, like a manager's sandbox: only granted names exist.
  const names = ["GM_info", ...meta.grant.filter((name) => /^GM_\w+$/.test(name))];
  const declarations = names.map((name) => `${name} = __x2uApi.${name}`).join(", ");
  await context.addInitScript({
    content: `${await bundlePage()}\n__x2uEmuPage.boot(${JSON.stringify(meta)}, function (__x2uApi) {\nvar ${declarations};\n${userscript}\n});`,
  });

  return {
    store,
    clickMenu: (page, caption) => page.evaluate((c) => (window as unknown as HookWindow).__x2uEmu?.clickMenu(c) ?? false, caption),
    menu: (page) => page.evaluate(() => (window as unknown as HookWindow).__x2uEmu?.menu() ?? []),
    notifications: (page) => page.evaluate(() => (window as unknown as HookWindow).__x2uEmu?.notifications ?? []),
  };
}
```

- [ ] **Step 12: Run the browser test**

Run: `npm run test:file -- test/browser/emulator.test.ts`
Expected: PASS, 5 tests.

If "shares values across pages" times out on the third page (`data-initial` stays `null`), Playwright isn't intercepting the synchronous snapshot request. Fall back to the binding and delay the script until the snapshot arrives:
1. Add `context.exposeBinding("__x2uEmuSnapshot", () => Object.fromEntries(store))` to `index.ts`.
2. In `page.ts`, make `boot` call `win.__x2uEmuSnapshot().then((snapshot) => { /* create values with snapshot, then the run-at logic */ })` instead of calling `readSnapshot()`.
3. Note the change; it goes in the findings doc that Task 6 creates, because document-start timing in CI becomes approximate.

- [ ] **Step 13: Type-check and commit**

Run: `npm run typecheck`
Expected: exit code 0.

```bash
git add bench/emulator test/support/server.ts test/support/userscript.ts test/support/dom.ts test/unit/emulator.test.ts test/browser/emulator.test.ts
git commit -m "Add the CI emulator that stands in for TM/VM behind gm.ts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Conformance suite on the emulator

**Files:**
- Create: `bench/session.ts`
- Create: `test/browser/probes/conformance.ts`
- Test: `test/browser/conformance.test.ts`

**Interfaces:**
- Consumes:
  - `createGm`, `GRANTS` (Task 3)
  - `installEmulator`, `Emulator` (Task 4)
  - `startServer`, `buildUserscript`, `waitForJson` (Task 4)
- Produces, from `bench/session.ts`:
  - `BACKENDS`
  - `type Backend = "emulator" | "tm" | "vm"`
  - `type Session = { context: BrowserContext; emulator?: Emulator; close(): Promise<void> }`
  - `backendsFromEnv(): Backend[]`
  - `startSession(backend: Backend, userscript: string): Promise<Session>`

- [ ] **Step 1: Write `bench/session.ts` (emulator only for now; Task 6 adds the real managers)**

```ts
// One API over the backends a userscript can run on (spec §10.5): the CI emulator, or real Tampermonkey and
// Violentmonkey in the release tier.
import { chromium, type BrowserContext } from "playwright";
import { installEmulator, type Emulator } from "./emulator/index.ts";

export const BACKENDS = ["emulator", "tm", "vm"] as const;
export type Backend = (typeof BACKENDS)[number];
export type Session = { context: BrowserContext; emulator?: Emulator; close(): Promise<void> };

export function backendsFromEnv(): Backend[] {
  const names = (process.env.X2U_BACKENDS ?? "emulator").split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    if (!(BACKENDS as readonly string[]).includes(name)) throw new Error(`Unknown backend "${name}" in X2U_BACKENDS (expected ${BACKENDS.join(", ")})`);
  }
  return names as Backend[];
}

export async function startSession(backend: Backend, userscript: string): Promise<Session> {
  if (backend !== "emulator") throw new Error(`Backend "${backend}" is not wired up yet`);
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const emulator = await installEmulator(context, userscript);
  return { context, emulator, close: () => browser.close() };
}
```

- [ ] **Step 2: Write the conformance probe `test/browser/probes/conformance.ts`**

```ts
// Conformance probe (spec §10.3). Exercises the gm.ts contract through the real gm.ts and reports on
// <html data-x2u-conformance>. Runs on the CI emulator and on real Tampermonkey/Violentmonkey.
import { createGm } from "../../../src/runtime/gm.ts";

const html = document.documentElement;
const params = new URLSearchParams(location.search);
const results: Record<string, unknown> = {};
const report = () => html.setAttribute("data-x2u-conformance", JSON.stringify(results));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const gm = createGm();

if (location.pathname === "/conformance.html") singlePage();
if (location.pathname === "/reader.html") void reader();
if (location.pathname === "/writer.html") void gm.setValue(`conf:${params.get("token")}:remote`, "hello");

function singlePage() {
  // Runs at document-start, before the page's own scripts (spec §5.1 and S1).
  const injected = gm.addElement(html, "script", {
    textContent: 'document.documentElement.setAttribute("data-x2u-sync", "1"); window.__x2uPageWorld = 1;',
  });
  results.addElementSync = html.getAttribute("data-x2u-sync") === "1";
  injected.then(
    () => { results.addElementResolved = true; },
    (error: unknown) => { results.addElementError = String(error); },
  );
  document.addEventListener("DOMContentLoaded", () => void afterParse(), { once: true });
}

async function afterParse() {
  try {
    const token = params.get("token") ?? "none";
    results.caps = gm.caps;
    results.handler = gm.handler;
    results.pageSawSync = html.getAttribute("data-page-saw-sync");
    results.pageGlobalVisible = "pageGlobal" in window;

    const key = `conf:${token}:value`;
    let roundtrip = true;
    for (const value of ["s", 42, true, null, { a: [1, "b"] }, [1, 2]]) {
      await gm.setValue(key, value);
      roundtrip &&= JSON.stringify(await gm.getValue(key)) === JSON.stringify(value);
    }
    results.roundtrip = roundtrip;
    results.listed = (await gm.listValues()).includes(key);
    await gm.deleteValue(key);
    results.deleted = (await gm.getValue(key, "fallback")) === "fallback";

    const seen: Array<{ value: unknown; remote: boolean }> = [];
    const listener = await gm.addValueChangeListener(key, (_key, _old, value, remote) => seen.push({ value, remote }));
    await gm.setValue(key, "local");
    await sleep(300);
    results.localListener = seen[0] ?? null;
    await gm.removeValueChangeListener(listener);
    await gm.deleteValue(key);

    const menuId = await gm.registerMenuCommand("ext2userscript conformance", () => {});
    await gm.unregisterMenuCommand(menuId);
    results.menu = true;

    const echo = `http://127.0.0.1:${params.get("api")}/echo`;
    const json = await gm.xmlHttpRequest({ url: echo, method: "POST", data: "ping", headers: { "x-x2u": "1" }, responseType: "json" });
    const body = json.response as { body?: string; header?: string } | undefined;
    results.xhrJson = json.status === 200 && body?.body === "ping" && body?.header === "1";
    const bytes = await gm.xmlHttpRequest({ url: `${echo}?bytes=1`, responseType: "arraybuffer" });
    results.xhrBytes = Object.prototype.toString.call(bytes.response) === "[object ArrayBuffer]" && (bytes.response as ArrayBuffer).byteLength === 4;

    const tab = await gm.openInTab(`${location.origin}/opened.html`, { active: false });
    await sleep(1_000);
    tab.close();
    for (let i = 0; i < 20 && !tab.closed; i++) await sleep(100);
    results.openInTab = tab.closed;

    await gm.notification({ title: "ext2userscript", text: "conformance check" });
    results.notification = true;

    if (gm.caps.cookies) {
      const url = location.href;
      await gm.cookie.set({ url, name: "x2u_conformance", value: token });
      results.cookieSet = (await gm.cookie.list({ url, name: "x2u_conformance" })).some((c) => c.value === token);
      await gm.cookie.delete({ url, name: "x2u_conformance" });
      results.cookieDeleted = !(await gm.cookie.list({ url, name: "x2u_conformance" })).some((c) => c.name === "x2u_conformance");
    }
  } catch (error) {
    results.error = String(error);
  }
  results.done = true;
  report();
}

async function reader() {
  const key = `conf:${params.get("token")}:remote`;
  await gm.addValueChangeListener(key, (_key, _old, value, remote) => {
    void gm.listValues().then((keys) => {
      results.remote = { value, remote, listed: keys.includes(key) };
      report();
    });
  });
  results.readerReady = true;
  report();
}
```

- [ ] **Step 3: Write the conformance test `test/browser/conformance.test.ts`**

```ts
// The gm.ts contract (spec §10.3) on each backend in X2U_BACKENDS (default: emulator).
// Release tier and spike S1: X2U_BACKENDS=tm,vm, with a profile from `npm run bench:setup`.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { backendsFromEnv, startSession } from "../../bench/session.ts";
import { GRANTS } from "../../src/runtime/gm.ts";
import { waitForJson } from "../support/dom.ts";
import { startServer, type Server } from "../support/server.ts";
import { buildUserscript } from "../support/userscript.ts";

const page = (head = "") => () =>
  new Response(`<!doctype html><html><head><title>x2u</title>${head}</head><body>x2u</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });

type SingleResult = {
  done?: boolean;
  error?: string;
  handler?: string;
  caps?: { valueListeners: boolean; menus: boolean; cookies: boolean };
  addElementSync?: boolean;
  addElementResolved?: boolean;
  addElementError?: string;
  pageSawSync?: string;
  pageGlobalVisible?: boolean;
  roundtrip?: boolean;
  listed?: boolean;
  deleted?: boolean;
  localListener?: { value: unknown; remote: boolean } | null;
  menu?: boolean;
  xhrJson?: boolean;
  xhrBytes?: boolean;
  openInTab?: boolean;
  notification?: boolean;
  cookieSet?: boolean;
  cookieDeleted?: boolean;
};

for (const backend of backendsFromEnv()) {
  describe(`gm.ts contract on ${backend}`, () => {
    let site: Server;
    let other: Server;
    let api: Server;
    let userscript: string;

    before(async () => {
      site = await startServer({
        "/conformance.html": page(
          `<script>document.documentElement.setAttribute("data-page-saw-sync", document.documentElement.getAttribute("data-x2u-sync") ?? "no"); window.pageGlobal = "page";</script>`,
        ),
        "/reader.html": page(),
        "/opened.html": page(),
      });
      other = await startServer({ "/writer.html": page() });
      api = await startServer({
        "/echo": async (request) =>
          new URL(request.url).searchParams.has("bytes")
            ? new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "application/octet-stream" } })
            : Response.json({ body: await request.text(), header: request.headers.get("x-x2u") }),
      });
      userscript = await buildUserscript(`${import.meta.dirname}/probes/conformance.ts`, {
        name: "ext2userscript conformance",
        match: [`${site.origin}/*`, `${other.origin}/*`],
        grant: Object.values(GRANTS).flat(),
        connect: ["127.0.0.1"],
        runAt: "document-start",
        isolated: true,
      });
    });

    after(async () => {
      await site.close();
      await other.close();
      await api.close();
    });

    it("passes the single-page contract", async () => {
      const session = await startSession(backend, userscript);
      try {
        const tab = await session.context.newPage();
        await tab.goto(`${site.origin}/conformance.html?token=t${Date.now()}&api=${api.port}`);
        const r = await waitForJson<SingleResult>(tab, "data-x2u-conformance", (x) => x.done === true, 30_000);
        console.log(`[${backend}] ${JSON.stringify(r)}`);
        assert.equal(r.error, undefined, `probe threw: ${r.error}`);
        assert.equal(r.caps?.valueListeners, true);
        assert.equal(r.caps?.menus, true);
        assert.equal(r.addElementSync, true, "gm.addElement must run a page-world script synchronously");
        assert.equal(r.addElementResolved, true, r.addElementError);
        assert.equal(r.pageSawSync, "1", "a script injected at document-start must run before the page's own scripts");
        assert.equal(r.pageGlobalVisible, backend === "emulator", "content scripts must not see page globals (the emulator runs in the page world)");
        assert.equal(r.roundtrip, true);
        assert.equal(r.listed, true);
        assert.equal(r.deleted, true);
        assert.deepEqual(r.localListener, { value: "local", remote: false });
        assert.equal(r.menu, true);
        assert.equal(r.xhrJson, true);
        assert.equal(r.xhrBytes, true);
        assert.equal(r.openInTab, true);
        assert.equal(r.notification, true);
        if (r.caps?.cookies) {
          assert.equal(r.cookieSet, true);
          assert.equal(r.cookieDeleted, true);
        }
      } finally {
        await session.close();
      }
    });

    it("delivers value changes from another tab with remote: true", async () => {
      const session = await startSession(backend, userscript);
      try {
        const token = `t${Date.now()}`;
        const reader = await session.context.newPage();
        await reader.goto(`${site.origin}/reader.html?token=${token}`);
        await waitForJson<{ readerReady?: boolean }>(reader, "data-x2u-conformance", (x) => x.readerReady === true);
        const writer = await session.context.newPage();
        await writer.goto(`${other.origin}/writer.html?token=${token}`);
        const r = await waitForJson<{ remote?: unknown }>(reader, "data-x2u-conformance", (x) => x.remote !== undefined);
        assert.deepEqual(r.remote, { value: "hello", remote: true, listed: true });
      } finally {
        await session.close();
      }
    });
  });
}
```

- [ ] **Step 4: Run it on the emulator**

Run: `npm run test:file -- test/browser/conformance.test.ts`
Expected: PASS, 2 tests, plus a `[emulator] {...}` log line with `"cookieSet":true`.

- [ ] **Step 5: Type-check, run everything and commit**

Run: `npm run typecheck && npm test && npm run test:browser`
Expected: all pass.

```bash
git add bench/session.ts test/browser/probes/conformance.ts test/browser/conformance.test.ts
git commit -m "Add the gm.ts conformance suite and run it on the emulator" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Real-manager harness and spike S1

**Files:**
- Create: `bench/real/managers.ts`, `bench/real/setup.ts`, `bench/real/launch.ts`, `bench/real/install.ts`
- Modify: `bench/session.ts` (replace the whole file)
- Modify: `package.json` (add the `bench:setup` script)
- Create: `docs/superpowers/spikes/2026-10-09-plan1-findings.md`

**Interfaces:**
- Consumes:
  - `unpack` (Task 2)
  - `cwsCrxUrl`, `fetchBytes` (Task 2)
  - `startServer` (Task 4)
  - `installEmulator` (Task 4)
- Produces:
  - `type ManagerName = "tm" | "vm"`
  - `MANAGERS`
  - `profileDir()`, `managerDir(manager)`
  - `launchReal(manager): Promise<{ context: BrowserContext; extensionId: string }>`
  - `installUserscript(context, extensionId, code): Promise<void>`
  - `startSession` now accepts `"tm"` and `"vm"`.

- [ ] **Step 1: Write `bench/real/managers.ts`**

```ts
// Real managers for the release tier (spec §10.5), unpacked into bench/.cache so --load-extension can load them.
import { join } from "node:path";

export type ManagerName = "tm" | "vm";

export const MANAGERS: Record<ManagerName, { label: string; cwsIds: readonly string[] }> = {
  tm: { label: "Tampermonkey", cwsIds: ["dhdgffkkebhmkfjojejmpbldmpobfkfo"] },
  // Stable listing first. The BETA listing is the fallback in case stable still ships MV2.
  vm: { label: "Violentmonkey", cwsIds: ["jinjaccalgkegednnccohejagnlnfdag", "opokoaglpekkimldnlggpoagmjegichg"] },
};

const CACHE = join(import.meta.dirname, "..", ".cache");
export const profileDir = (): string => process.env.BENCH_PROFILE ?? join(CACHE, "profile");
export const managerDir = (manager: ManagerName): string => join(CACHE, "managers", manager);
```

- [ ] **Step 2: Write `bench/real/setup.ts`**

```ts
// One-time, by hand (spec §10.5). Downloads Tampermonkey and Violentmonkey, opens the bench profile in a
// visible browser, and waits while you switch on "Allow User Scripts" for both. Run: npm run bench:setup
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { unpack } from "../../src/convert/unpack.ts";
import { cwsCrxUrl, fetchBytes } from "../../src/download.ts";
import { MANAGERS, managerDir, profileDir, type ManagerName } from "./managers.ts";

async function fetchManager(manager: ManagerName): Promise<string> {
  const { label, cwsIds } = MANAGERS[manager];
  for (const id of cwsIds) {
    const files = unpack(await fetchBytes(cwsCrxUrl(id)));
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as { manifest_version: number; version: string };
    if (manifest.manifest_version !== 3) {
      console.log(`${label} (${id}) is MV${manifest.manifest_version}; trying the next listing`);
      continue;
    }
    const dir = managerDir(manager);
    await rm(dir, { recursive: true, force: true });
    for (const [path, bytes] of files) {
      if (path.startsWith("_metadata/")) continue; // Chrome refuses unpacked extensions that contain _metadata
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    console.log(`${label} ${manifest.version} (${id}) → ${dir}`);
    return dir;
  }
  throw new Error(`No MV3 build of ${label} is available from the Chrome Web Store`);
}

const dirs = [await fetchManager("tm"), await fetchManager("vm")];
const context = await chromium.launchPersistentContext(profileDir(), {
  channel: "chromium",
  headless: false,
  args: [`--disable-extensions-except=${dirs.join(",")}`, `--load-extension=${dirs.join(",")}`],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("chrome://extensions/").catch(() => console.log("Open chrome://extensions/ in the browser window yourself."));
console.log(`
In the browser window that just opened:
  1. Click Details under Tampermonkey and switch on "Allow User Scripts".
  2. Do the same for Violentmonkey.
  3. Close the browser window.
Profile: ${profileDir()}`);
await new Promise<void>((resolve) => context.on("close", () => resolve()));
```

- [ ] **Step 3: Write `bench/real/launch.ts` and `bench/real/install.ts`**

`bench/real/launch.ts`:

```ts
// Launches the bench profile with one real manager loaded (release tier, spec §10.5). HEADED=1 shows the window.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { MANAGERS, managerDir, profileDir, type ManagerName } from "./managers.ts";

export async function launchReal(manager: ManagerName): Promise<{ context: BrowserContext; extensionId: string }> {
  const dir = managerDir(manager);
  if (!existsSync(join(dir, "manifest.json"))) throw new Error(`${MANAGERS[manager].label} isn't set up: run npm run bench:setup first`);
  const context = await chromium.launchPersistentContext(profileDir(), {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
  return { context, extensionId: new URL(worker.url()).host };
}
```

`bench/real/install.ts`:

```ts
// Installs a userscript into a real manager the way a user would: open the .user.js, then confirm the install.
import type { BrowserContext, Page } from "playwright";
import { startServer } from "../../test/support/server.ts";

const INSTALL_BUTTON = /^(install|reinstall|update|overwrite|confirm installation|confirm re-installation)$/i;

export async function installUserscript(context: BrowserContext, extensionId: string, code: string): Promise<void> {
  const server = await startServer({
    "/x2u-test.user.js": () => new Response(code, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
  });
  const isInstallPage = (page: Page) => page.url().startsWith(`chrome-extension://${extensionId}/`);
  try {
    const opener = await context.newPage();
    await opener.goto(`${server.origin}/x2u-test.user.js`).catch(() => {}); // the manager takes over this navigation
    const deadline = Date.now() + 20_000;
    let page = context.pages().find(isInstallPage);
    while (!page && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      page = context.pages().find(isInstallPage);
    }
    if (!page) throw new Error(`The manager (${extensionId}) did not open an install page for the userscript`);
    const installPage = page;
    await installPage.getByRole("button", { name: INSTALL_BUTTON }).first().click({ timeout: 20_000 });
    await installPage.waitForEvent("close", { timeout: 10_000 }).catch(() => installPage.close());
    if (!opener.isClosed()) await opener.close();
  } finally {
    await server.close();
  }
}
```

- [ ] **Step 4: Replace `bench/session.ts`**

```ts
// One API over the backends a userscript can run on (spec §10.5): the CI emulator, or real Tampermonkey and
// Violentmonkey in the release tier.
import { chromium, type BrowserContext } from "playwright";
import { installEmulator, type Emulator } from "./emulator/index.ts";
import { installUserscript } from "./real/install.ts";
import { launchReal } from "./real/launch.ts";

export const BACKENDS = ["emulator", "tm", "vm"] as const;
export type Backend = (typeof BACKENDS)[number];
export type Session = { context: BrowserContext; emulator?: Emulator; close(): Promise<void> };

export function backendsFromEnv(): Backend[] {
  const names = (process.env.X2U_BACKENDS ?? "emulator").split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    if (!(BACKENDS as readonly string[]).includes(name)) throw new Error(`Unknown backend "${name}" in X2U_BACKENDS (expected ${BACKENDS.join(", ")})`);
  }
  return names as Backend[];
}

export async function startSession(backend: Backend, userscript: string): Promise<Session> {
  if (backend === "emulator") {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const emulator = await installEmulator(context, userscript);
    return { context, emulator, close: () => browser.close() };
  }
  const { context, extensionId } = await launchReal(backend);
  await installUserscript(context, extensionId, userscript);
  return { context, close: () => context.close() };
}
```

- [ ] **Step 5: Add the setup script and check that nothing regressed**

Run: `npm pkg set scripts.bench:setup="node --experimental-strip-types --disable-warning=ExperimentalWarning bench/real/setup.ts"`

Run: `npm run typecheck && npm test && npm run test:browser`
Expected: all pass. The default backend is still the emulator.

- [ ] **Step 6: HUMAN CHECKPOINT — set up the bench profile**

Stop and ask the human to do this; an agent can't flip the switches. Steps for the human:
1. Run `npm run bench:setup`.
2. A browser opens on `chrome://extensions`. Open Details for Tampermonkey and switch on **Allow User Scripts**, then do the same for Violentmonkey.
3. Close the window.

The terminal output names each manager's version and Web Store ID. Copy those lines into the findings doc in Step 8. Continue once the human confirms.

- [ ] **Step 7: Run spike S1 — conformance on real Tampermonkey and Violentmonkey**

Run: `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/conformance.test.ts`
Expected:
- PASS, 4 tests (2 per manager).
- One `[tm] {...}` and one `[vm] {...}` log line with the raw probe results.

If the install step times out, re-run with `HEADED=1` to watch it. If a manager's button text differs, adjust `INSTALL_BUTTON` in `bench/real/install.ts` and record that in the findings.

A failing assertion is a spike finding, not something to patch around: record it in Step 8.

- [ ] **Step 8: Record S1 in `docs/superpowers/spikes/2026-10-09-plan1-findings.md`**

Create the file and fill the cells from the Step 6 and Step 7 output:

```markdown
# Plan 1 spike findings

Results of spikes S1–S4 (spec §11): what ran, on which versions, and what it means for the spec.

## S1: GM functions, isolation and addElement timing in real managers

Run: `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/conformance.test.ts`

| | Tampermonkey | Violentmonkey |
|---|---|---|
| Version and Web Store ID | | |
| `handler` and `caps` (from the log line) | | |
| Single-page contract | | |
| Remote value change | | |

**Result:**
- PASS if every row passes for both managers.
- Otherwise, list each failing assertion, what the manager actually did (from the log line), and which spec section it affects: §4 for the isolation headers, §5.1 for the gm.ts contract.
```

- [ ] **Step 9: Commit**

```bash
git add bench/real bench/session.ts package.json docs/superpowers/spikes/2026-10-09-plan1-findings.md
git commit -m "Add the release-tier harness and record spike S1" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Tab registry

**Files:**
- Create: `src/runtime/keys.ts`, `src/runtime/registry.ts`
- Create: `test/support/gm-hub.ts`, `test/support/time.ts`
- Test: `test/unit/registry.test.ts`

**Interfaces:**
- Consumes:
  - `createGm`, `type Gm`, `type GmApi` (Task 3)
  - `createValueStore`, `type ValueStore` (Task 4)
- Produces:
  - **`src/runtime/keys.ts`:** `keys(ns)`, which returns `{ tab(id), tabPrefix, out(id), roster }`.
  - **`src/runtime/registry.ts`:**
    - `type TabInfo = { id; url; title; since; ts }`
    - `type RegistryTiming = { heartbeatMs; staleMs }`
    - `REGISTRY_TIMING`
    - `type Registry`, with members `me`, `self()`, `live()`, `onAdded`, `onRemoved`, `onChange`, `leave()`, `rejoin()`, `stop()`
    - `startRegistry(gm, ns, me, describe, timing?)`
  - **`test/support/gm-hub.ts`:**
    - `type HubOptions = { delayMs?; coalesce? }`
    - `type Hub = { store; tab(): GmApi }`
    - `createHub(options?)`
  - **`test/support/time.ts`:**
    - `sleep(ms)`
    - `eventually(check, timeoutMs)`

- [ ] **Step 1: Write the test support files**

`test/support/time.ts`:

```ts
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until check() is true, or throws after timeoutMs. */
export async function eventually(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs}ms`);
    await sleep(5);
  }
}
```

`test/support/gm-hub.ts`:

```ts
// In-memory GM for Node unit tests.
// - Each tab() returns one tab's raw GM functions, the same shape a manager provides, over a shared store.
// - Changes reach the other tabs after delayMs, like a manager's propagation.
// - With coalesce, a tab sees only the latest value per key in each window (the spec §5.3 overflow case).
import { createValueStore, type ValueStore } from "../../bench/emulator/values.ts";
import type { GmApi } from "../../src/runtime/gm.ts";

export type HubOptions = { delayMs?: number; coalesce?: boolean };
export type Hub = { store: Map<string, unknown>; tab(): GmApi };

export function createHub({ delayMs = 1, coalesce = false }: HubOptions = {}): Hub {
  const store = new Map<string, unknown>();
  const tabs = new Set<ValueStore>();
  const pending = new Map<ValueStore, Map<string, unknown>>();

  const deliver = (target: ValueStore, key: string, value: unknown) => {
    if (!coalesce) {
      setTimeout(() => target.applyRemote(key, value), delayMs);
      return;
    }
    let batch = pending.get(target);
    if (!batch) {
      const fresh = new Map<string, unknown>();
      batch = fresh;
      pending.set(target, fresh);
      setTimeout(() => {
        pending.delete(target);
        for (const [k, v] of fresh) target.applyRemote(k, v);
      }, delayMs);
    }
    batch.set(key, value);
  };

  return {
    store,
    tab() {
      const values: ValueStore = createValueStore(Object.fromEntries(store), (key, value) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
        for (const other of tabs) if (other !== values) deliver(other, key, value);
      });
      tabs.add(values);
      return { ...values, GM_info: { scriptHandler: "hub" } };
    },
  };
}
```

- [ ] **Step 2: Write the failing test**

`test/unit/registry.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGm } from "../../src/runtime/gm.ts";
import { startRegistry, type RegistryTiming } from "../../src/runtime/registry.ts";
import { createHub } from "../support/gm-hub.ts";
import { eventually } from "../support/time.ts";

const page = () => ({ url: "https://example.com/", title: "Example" });
/** Heartbeats far apart: only the roster doorbell can explain fast discovery. */
const SLOW: RegistryTiming = { heartbeatMs: 10_000, staleMs: 60_000 };
const FAST: RegistryTiming = { heartbeatMs: 20, staleMs: 150 };

describe("tab registry", () => {
  it("finds a new tab through the roster, before the next heartbeat", async () => {
    const hub = createHub();
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, SLOW);
    const added: number[] = [];
    a.onAdded((tab) => added.push(tab.id));
    const b = await startRegistry(createGm(hub.tab()), "t", 2, page, SLOW);
    try {
      await eventually(() => added.includes(2), 300);
      assert.deepEqual(b.live().map((tab) => tab.id), [1]);
      assert.equal(b.live()[0].url, "https://example.com/");
      assert.equal(b.live()[0].since, a.self().since);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("sees a tab leave at once, and come back on rejoin with a new since", async () => {
    const hub = createHub();
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, SLOW);
    const b = await startRegistry(createGm(hub.tab()), "t", 2, page, SLOW);
    try {
      await eventually(() => a.live().length === 1, 300);
      const events: string[] = [];
      let changes = 0;
      a.onAdded((tab) => events.push(`+${tab.id}`));
      a.onRemoved((id) => events.push(`-${id}`));
      a.onChange(() => changes++);
      const firstSince = b.self().since;
      await b.leave();
      assert.equal(b.self().present, false);
      await eventually(() => events.join() === "-2", 300);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await b.rejoin();
      await eventually(() => events.join() === "-2,+2", 300);
      assert.ok(b.self().since > firstSince);
      assert.ok(changes >= 2);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("drops a tab whose heartbeat goes stale and deletes its keys", async () => {
    const hub = createHub();
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, FAST);
    const crashed = await startRegistry(createGm(hub.tab()), "t", 2, page, SLOW); // beats once, then never again
    hub.tab().GM_setValue?.("x2u:t:out:2", { epoch: "e", msgs: [] });
    const removed: number[] = [];
    a.onRemoved((id) => removed.push(id));
    try {
      await eventually(() => removed.includes(2), 1_000);
      assert.equal(hub.store.has("x2u:t:tab:2"), false);
      assert.equal(hub.store.has("x2u:t:out:2"), false);
    } finally {
      await a.stop();
      await crashed.stop();
    }
  });

  it("cleans up values it cannot read instead of throwing", async () => {
    const hub = createHub();
    hub.tab().GM_setValue?.("x2u:t:tab:99", "not a heartbeat");
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, FAST);
    try {
      assert.deepEqual(a.live(), []);
      assert.equal(hub.store.has("x2u:t:tab:99"), false);
    } finally {
      await a.stop();
    }
  });

  it("stop removes this tab's key", async () => {
    const hub = createHub();
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, FAST);
    assert.equal(hub.store.has("x2u:t:tab:1"), true);
    await a.stop();
    assert.equal(hub.store.has("x2u:t:tab:1"), false);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npm run test:file -- test/unit/registry.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/runtime/registry.ts`.

- [ ] **Step 4: Implement `src/runtime/keys.ts`**

```ts
// GM value keys the runtime uses (spec §5.3–5.4). ns is the converted extension's namespace.
export function keys(ns: string) {
  return {
    tab: (id: number) => `x2u:${ns}:tab:${id}`,
    tabPrefix: `x2u:${ns}:tab:`,
    out: (id: number) => `x2u:${ns}:out:${id}`,
    roster: `x2u:${ns}:roster`,
  };
}
```

- [ ] **Step 5: Implement `src/runtime/registry.ts`**

```ts
// Tab registry (spec §5.3).
// - Each tab heartbeats its own key.
// - A roster "doorbell" key makes joins and leaves visible at once.
// - A tab whose heartbeat is older than the staleness limit counts as gone, and its keys are cleaned up.
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";

export type TabInfo = { id: number; url: string; title: string; since: number; ts: number };
export type RegistryTiming = { heartbeatMs: number; staleMs: number };

/** Staleness outlives Chrome's one-wake-up-per-minute throttling of long-hidden tabs. */
export const REGISTRY_TIMING: RegistryTiming = { heartbeatMs: 2_000, staleMs: 90_000 };

export type Registry = {
  readonly me: number;
  /** This tab: when it joined (or rejoined), and whether it is registered right now. */
  self(): { id: number; since: number; present: boolean };
  /** Other live tabs, as last seen. */
  live(): TabInfo[];
  onAdded(fn: (tab: TabInfo) => void): void;
  onRemoved(fn: (id: number) => void): void;
  /** Membership changed (a tab came, went or rejoined), or this tab left or rejoined. */
  onChange(fn: () => void): void;
  /** pagehide: stop heartbeating, delete this tab's key and ring the roster. */
  leave(): Promise<void>;
  /** pageshow from the back/forward cache: join again with a new `since`. */
  rejoin(): Promise<void>;
  stop(): Promise<void>;
};

type Beat = { url: string; title: string; since: number; ts: number };

const isBeat = (value: unknown): value is Beat =>
  typeof value === "object" && value !== null &&
  typeof (value as Beat).url === "string" && typeof (value as Beat).since === "number" && typeof (value as Beat).ts === "number";

export async function startRegistry(
  gm: Gm,
  ns: string,
  me: number,
  describe: () => { url: string; title: string },
  timing: RegistryTiming = REGISTRY_TIMING,
): Promise<Registry> {
  const k = keys(ns);
  const known = new Map<number, TabInfo>();
  const added: Array<(tab: TabInfo) => void> = [];
  const removed: Array<(id: number) => void> = [];
  const changes: Array<() => void> = [];
  let since = Date.now();
  let present = true;

  const changed = () => {
    for (const fn of changes) fn();
  };
  const beat = () => gm.setValue(k.tab(me), { ...describe(), since, ts: Date.now() });
  const ring = () => gm.setValue(k.roster, { from: me, t: Date.now() });

  const scanOnce = async () => {
    const now = Date.now();
    const seen = new Set<number>();
    let dirty = false;
    for (const key of await gm.listValues()) {
      if (!key.startsWith(k.tabPrefix)) continue;
      const id = Number(key.slice(k.tabPrefix.length));
      if (!Number.isInteger(id) || id === me) continue;
      const value = await gm.getValue(key);
      if (!isBeat(value) || now - value.ts > timing.staleMs) {
        // Gone, or not a value this runtime wrote: clean up after it.
        await gm.deleteValue(key);
        await gm.deleteValue(k.out(id));
        continue;
      }
      seen.add(id);
      const info: TabInfo = { id, url: value.url, title: String(value.title), since: value.since, ts: value.ts };
      const previous = known.get(id);
      known.set(id, info);
      if (!previous) {
        dirty = true;
        for (const fn of added) fn(info);
      } else if (previous.since !== info.since) {
        dirty = true;
      }
    }
    for (const id of [...known.keys()]) {
      if (seen.has(id)) continue;
      known.delete(id);
      dirty = true;
      for (const fn of removed) fn(id);
    }
    if (dirty) changed();
  };

  // One scan at a time; a request that arrives mid-scan runs one more pass afterwards.
  let scanning = false;
  let again = false;
  const scan = async () => {
    if (scanning) {
      again = true;
      return;
    }
    scanning = true;
    try {
      do {
        again = false;
        await scanOnce();
      } while (again);
    } finally {
      scanning = false;
    }
  };

  await beat();
  const rosterListener = await gm.addValueChangeListener(k.roster, () => {
    void scan();
  });
  await ring();
  await scan();
  const timer = setInterval(() => {
    if (present) void beat().then(scan);
  }, timing.heartbeatMs);

  return {
    me,
    self: () => ({ id: me, since, present }),
    live: () => [...known.values()],
    onAdded: (fn) => {
      added.push(fn);
    },
    onRemoved: (fn) => {
      removed.push(fn);
    },
    onChange: (fn) => {
      changes.push(fn);
    },
    leave: async () => {
      present = false;
      changed();
      await gm.deleteValue(k.tab(me));
      await ring();
    },
    rejoin: async () => {
      present = true;
      since = Date.now();
      changed();
      await beat();
      await ring();
      await scan();
    },
    stop: async () => {
      clearInterval(timer);
      present = false;
      await gm.removeValueChangeListener(rosterListener);
      await gm.deleteValue(k.tab(me));
    },
  };
}
```

- [ ] **Step 6: Run the tests and the type-check**

Run: `npm run test:file -- test/unit/registry.test.ts`
Expected: PASS, 5 tests.

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/keys.ts src/runtime/registry.ts test/support/gm-hub.ts test/support/time.ts test/unit/registry.test.ts
git commit -m "Add the tab registry with heartbeats and a roster doorbell" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Cross-tab bus

**Files:**
- Create: `src/runtime/bus.ts`
- Test: `test/unit/bus.test.ts`

**Interfaces:**
- Consumes:
  - `type Gm`, `createGm` (Task 3)
  - `keys` (Task 7)
  - `startRegistry`, `type Registry` (Task 7)
  - `createHub`, `type Hub` (Task 7)
  - `eventually`, `sleep` (Task 7)
- Produces:
  - `type Envelope = { seq; t; to: number | "*"; payload }`
  - `RING_SIZE = 64`, `RING_MAX_AGE_MS = 10_000`
  - `type Bus = { send(to, payload): Promise<void>; onMessage(fn); readonly dropped: number; stop() }`
  - `startBus(gm: Gm, ns: string, registry: Registry): Promise<Bus>`

- [ ] **Step 1: Write the failing test**

`test/unit/bus.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RING_SIZE, startBus, type Bus } from "../../src/runtime/bus.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { startRegistry, type Registry } from "../../src/runtime/registry.ts";
import { createHub, type Hub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

type Tab = { id: number; registry: Registry; bus: Bus; got: Array<{ payload: unknown; from: number }> };

async function openTab(hub: Hub, id: number): Promise<Tab> {
  const gm = createGm(hub.tab());
  const registry = await startRegistry(gm, "t", id, () => ({ url: "https://example.com/", title: "t" }), { heartbeatMs: 20, staleMs: 5_000 });
  const bus = await startBus(gm, "t", registry);
  const got: Tab["got"] = [];
  bus.onMessage((payload, from) => got.push({ payload, from }));
  return { id, registry, bus, got };
}

async function closeAll(...tabs: Tab[]) {
  for (const tab of tabs) {
    await tab.bus.stop();
    await tab.registry.stop();
  }
}

const connected = (a: Tab, b: Tab) =>
  eventually(() => a.registry.live().some((t) => t.id === b.id) && b.registry.live().some((t) => t.id === a.id), 500);

describe("cross-tab bus", () => {
  it("delivers to one tab, with the sender's id", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    const c = await openTab(hub, 3);
    try {
      await connected(a, b);
      await connected(a, c);
      await a.bus.send(2, { hi: 1 });
      await eventually(() => b.got.length === 1, 500);
      assert.deepEqual(b.got, [{ payload: { hi: 1 }, from: 1 }]);
      await sleep(50);
      assert.deepEqual(c.got, []);
      assert.deepEqual(a.got, []);
    } finally {
      await closeAll(a, b, c);
    }
  });

  it("broadcasts to every other tab", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    const c = await openTab(hub, 3);
    try {
      await connected(a, b);
      await connected(a, c);
      await a.bus.send("*", "all");
      await eventually(() => b.got.length === 1 && c.got.length === 1, 500);
      await sleep(50);
      assert.deepEqual(a.got, []);
      assert.deepEqual(b.got, [{ payload: "all", from: 1 }]);
    } finally {
      await closeAll(a, b, c);
    }
  });

  it("delivers locally when a tab sends to itself", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    try {
      await a.bus.send(1, "self");
      await eventually(() => a.got.length === 1, 200);
      assert.deepEqual(a.got, [{ payload: "self", from: 1 }]);
    } finally {
      await closeAll(a);
    }
  });

  it("delivers a new tab's first message to a tab that hasn't discovered it yet", async () => {
    const hub = createHub({ delayMs: 20 });
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    try {
      await b.bus.send(1, "early");
      await eventually(() => a.got.length === 1, 500);
      assert.deepEqual(a.got, [{ payload: "early", from: 2 }]);
    } finally {
      await closeAll(a, b);
    }
  });

  it("does not replay messages sent before a tab started", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    try {
      await a.bus.send("*", "old");
      await sleep(10);
      const b = await openTab(hub, 2);
      try {
        await connected(a, b);
        await a.bus.send("*", "new");
        await eventually(() => b.got.length >= 1, 500);
        await sleep(30);
        assert.deepEqual(b.got.map((m) => m.payload), ["new"]);
      } finally {
        await closeAll(b);
      }
    } finally {
      await closeAll(a);
    }
  });

  it("counts messages lost when a manager coalesces writes", async () => {
    const hub = createHub({ delayMs: 30, coalesce: true });
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    try {
      await connected(a, b);
      await a.bus.send(2, 0);
      await eventually(() => b.got.length === 1, 500);
      for (let n = 1; n <= 100; n++) void a.bus.send(2, n); // all land within one coalescing window
      await eventually(() => b.got.length === 1 + RING_SIZE, 1_000);
      assert.equal(b.bus.dropped, 100 - RING_SIZE);
      assert.deepEqual(b.got.at(-1), { payload: 100, from: 1 });
    } finally {
      await closeAll(a, b);
    }
  });

  it("restarts the sequence when a tab navigates (new epoch, same id)", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    try {
      await connected(a, b);
      await a.bus.send(2, "before");
      await eventually(() => b.got.length === 1, 500);
      await a.bus.stop();
      const next = await startBus(createGm(hub.tab()), "t", a.registry); // same tab id, fresh page
      try {
        await next.send(2, "after");
        await eventually(() => b.got.length === 2, 500);
        assert.deepEqual(b.got.map((m) => m.payload), ["before", "after"]);
      } finally {
        await next.stop();
      }
    } finally {
      await closeAll(b);
      await a.registry.stop();
    }
  });

  it("ignores outbox values it cannot read", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    try {
      await connected(a, b);
      hub.tab().GM_setValue?.("x2u:t:out:1", { epoch: 5, msgs: "nope" });
      hub.tab().GM_setValue?.("x2u:t:out:1", { epoch: "e", msgs: [{ junk: true }] });
      await sleep(50);
      await a.bus.send(2, "still works");
      await eventually(() => b.got.length === 1, 500);
      assert.deepEqual(b.got, [{ payload: "still works", from: 1 }]);
    } finally {
      await closeAll(a, b);
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run test:file -- test/unit/bus.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/runtime/bus.ts`.

- [ ] **Step 3: Implement `src/runtime/bus.ts`**

```ts
// Cross-tab messaging (spec §5.3).
// - Each tab writes only its own outbox key, so concurrent senders never overwrite each other.
// - Every tab listens to the outboxes of the live tabs and tracks what it has read.
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";
import type { Registry } from "./registry.ts";

export type Envelope = { seq: number; t: number; to: number | "*"; payload: unknown };
type Outbox = { epoch: string; msgs: Envelope[] };

/** An outbox keeps at most RING_SIZE messages, none older than RING_MAX_AGE_MS. */
export const RING_SIZE = 64;
export const RING_MAX_AGE_MS = 10_000;

export type Bus = {
  /** Send to one tab, or "*" for every other tab. Sending to this tab delivers locally. */
  send(to: number | "*", payload: unknown): Promise<void>;
  onMessage(fn: (payload: unknown, from: number) => void): void;
  /** Messages lost because a sender's outbox moved on before this tab read it (spec §5.3). */
  readonly dropped: number;
  stop(): Promise<void>;
};

const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === "object" && value !== null && typeof (value as Envelope).seq === "number" && typeof (value as Envelope).t === "number";

function readOutbox(value: unknown): Outbox | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { epoch, msgs } = value as Partial<Outbox>;
  if (typeof epoch !== "string" || !Array.isArray(msgs)) return undefined;
  const valid = msgs.filter(isEnvelope);
  return valid.length > 0 ? { epoch, msgs: valid } : undefined;
}

export async function startBus(gm: Gm, ns: string, registry: Registry): Promise<Bus> {
  const k = keys(ns);
  const me = registry.me;
  const startedAt = Date.now();
  const epoch = Math.random().toString(36).slice(2);
  const handlers: Array<(payload: unknown, from: number) => void> = [];
  const ring: Envelope[] = [];
  // Per sender. Kept after a tab leaves, so a tab that comes back isn't replayed from the start.
  const read = new Map<number, { epoch: string; seq: number }>();
  const listening = new Map<number, Promise<number | string>>();
  let seq = 0;
  let dropped = 0;
  let warned = false;

  const deliver = (payload: unknown, from: number) => {
    for (const fn of handlers) {
      try {
        fn(payload, from);
      } catch (error) {
        console.error("[ext2userscript] message handler threw", error);
      }
    }
  };

  const receive = (from: number, value: unknown) => {
    const outbox = readOutbox(value);
    if (!outbox) return;
    const previous = read.get(from);
    const continuing = previous !== undefined && previous.epoch === outbox.epoch ? previous.seq : undefined;
    if (continuing !== undefined && outbox.msgs[0].seq > continuing + 1) {
      dropped += outbox.msgs[0].seq - continuing - 1;
      if (!warned) {
        warned = true;
        console.warn(`[ext2userscript] missed cross-tab messages from tab ${from}: its outbox moved on before this tab read it`);
      }
    }
    for (const env of outbox.msgs) {
      // Same epoch: anything newer than what was read. New epoch (the sender navigated): all of it.
      // First contact: only what was sent after this tab started.
      const fresh = continuing !== undefined ? env.seq > continuing : previous !== undefined || env.t >= startedAt;
      if (fresh && (env.to === me || env.to === "*")) deliver(env.payload, from);
    }
    read.set(from, { epoch: outbox.epoch, seq: outbox.msgs[outbox.msgs.length - 1].seq });
  };

  const listen = (id: number) => {
    if (listening.has(id)) return;
    listening.set(
      id,
      (async () => {
        const listener = await gm.addValueChangeListener(k.out(id), (_key, _old, value) => receive(id, value));
        receive(id, await gm.getValue(k.out(id))); // catch up on anything sent before this tab was listening
        return listener;
      })(),
    );
  };
  const unlisten = (id: number) => {
    const listener = listening.get(id);
    listening.delete(id);
    void listener?.then((l) => gm.removeValueChangeListener(l));
  };

  registry.onAdded((tab) => listen(tab.id));
  registry.onRemoved(unlisten);
  for (const tab of registry.live()) listen(tab.id);
  await Promise.all(listening.values());

  return {
    send: async (to, payload) => {
      const copy: unknown = payload === undefined ? null : JSON.parse(JSON.stringify(payload));
      if (to === me) {
        queueMicrotask(() => deliver(copy, me));
        return;
      }
      const now = Date.now();
      ring.push({ seq: ++seq, t: now, to, payload: copy });
      while (ring.length > RING_SIZE || (ring.length > 1 && ring[0].t < now - RING_MAX_AGE_MS)) ring.shift();
      await gm.setValue(k.out(me), { epoch, msgs: ring });
    },
    onMessage: (fn) => {
      handlers.push(fn);
    },
    get dropped() {
      return dropped;
    },
    stop: async () => {
      for (const id of [...listening.keys()]) unlisten(id);
      await gm.deleteValue(k.out(me));
    },
  };
}
```

- [ ] **Step 4: Run the tests and the type-check**

Run: `npm run test:file -- test/unit/bus.test.ts`
Expected: PASS, 8 tests.

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/bus.ts test/unit/bus.test.ts
git commit -m "Add the cross-tab bus with single-writer outboxes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Leader election

**Files:**
- Create: `src/runtime/elect.ts`
- Test: `test/unit/elect.test.ts`

**Interfaces:**
- Consumes:
  - `startRegistry`, `type Registry`, `type RegistryTiming` (Task 7)
  - `createHub`, `type Hub` (Task 7)
  - `eventually`, `sleep` (Task 7)
  - `createGm` (Task 3)
- Produces:
  - `type ElectionTiming = { graceMs: number }`
  - `ELECTION_TIMING`
  - `type Election = { isLeader(): boolean; stop(): void }`
  - `startElection(registry: Registry, on: { acquire(): void; lose(): void }, timing?: ElectionTiming): Election`

- [ ] **Step 1: Write the failing test**

`test/unit/elect.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startElection, type Election } from "../../src/runtime/elect.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { startRegistry, type Registry, type RegistryTiming } from "../../src/runtime/registry.ts";
import { createHub, type Hub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

const FAST: RegistryTiming = { heartbeatMs: 20, staleMs: 150 };
type Member = { id: number; registry: Registry; election: Election; events: string[] };

async function member(hub: Hub, id: number, timing: RegistryTiming = FAST): Promise<Member> {
  const registry = await startRegistry(createGm(hub.tab()), "t", id, () => ({ url: "https://example.com/", title: "t" }), timing);
  const events: string[] = [];
  const election = startElection(registry, { acquire: () => events.push("acquire"), lose: () => events.push("lose") }, { graceMs: 30 });
  return { id, registry, election, events };
}

const leaders = (members: Member[]) => members.filter((m) => m.election.isLeader()).map((m) => m.id);

async function stopAll(...members: Member[]) {
  for (const m of members) {
    m.election.stop();
    await m.registry.stop();
  }
}

describe("leader election", () => {
  it("a lone tab leads once the grace period has passed", async () => {
    const hub = createHub();
    const a = await member(hub, 1);
    try {
      assert.equal(a.election.isLeader(), false);
      await eventually(() => a.election.isLeader(), 500);
      assert.deepEqual(a.events, ["acquire"]);
    } finally {
      await stopAll(a);
    }
  });

  it("the tab that joined first leads, and later tabs don't displace it", async () => {
    const hub = createHub();
    const a = await member(hub, 1);
    await eventually(() => a.election.isLeader(), 500);
    const b = await member(hub, 2);
    const c = await member(hub, 3);
    try {
      await sleep(200);
      assert.deepEqual(leaders([a, b, c]), [1]);
      assert.deepEqual(b.events, []);
      assert.deepEqual(c.events, []);
    } finally {
      await stopAll(a, b, c);
    }
  });

  it("tabs that start together settle on exactly one leader", async () => {
    const hub = createHub();
    const members = await Promise.all([1, 2, 3, 4, 5].map((id) => member(hub, id)));
    try {
      await sleep(300);
      assert.equal(leaders(members).length, 1);
      const first = leaders(members)[0];
      await sleep(300);
      assert.deepEqual(leaders(members), [first]);
    } finally {
      await stopAll(...members);
    }
  });

  it("hands over at once when the leader leaves, and a returning tab doesn't take it back", async () => {
    const hub = createHub();
    const a = await member(hub, 1);
    await eventually(() => a.election.isLeader(), 500);
    const b = await member(hub, 2);
    const c = await member(hub, 3);
    try {
      await a.registry.leave();
      assert.equal(a.election.isLeader(), false);
      await eventually(() => b.election.isLeader(), 300);
      assert.deepEqual(a.events, ["acquire", "lose"]);
      await a.registry.rejoin();
      await sleep(200);
      assert.deepEqual(leaders([a, b, c]), [2]);
    } finally {
      await stopAll(a, b, c);
    }
  });

  it("replaces a leader whose heartbeat goes stale", async () => {
    const hub = createHub();
    const crashed = await member(hub, 1, { heartbeatMs: 10_000, staleMs: 150 });
    await eventually(() => crashed.election.isLeader(), 500);
    const b = await member(hub, 2);
    try {
      await sleep(50);
      assert.equal(b.election.isLeader(), false);
      await eventually(() => b.election.isLeader(), 1_000);
    } finally {
      await stopAll(crashed, b);
    }
  });

  it("keeps a slowly heartbeating (throttled, hidden) leader", async () => {
    const hub = createHub();
    const slow = await member(hub, 1, { heartbeatMs: 100, staleMs: 300 });
    await eventually(() => slow.election.isLeader(), 500);
    const b = await member(hub, 2, { heartbeatMs: 20, staleMs: 300 });
    try {
      await sleep(1_000);
      assert.equal(slow.election.isLeader(), true);
      assert.deepEqual(b.events, []);
    } finally {
      await stopAll(slow, b);
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run test:file -- test/unit/elect.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/runtime/elect.ts`.

- [ ] **Step 3: Implement `src/runtime/elect.ts`**

```ts
// Background leader election (spec §5.4): the live tab that joined first leads. Every tab computes this from
// the registry, whose keys each have a single writer, so all tabs converge on the same answer.
import type { Registry } from "./registry.ts";

export type ElectionTiming = { graceMs: number };

/** A tab must be the oldest for this long before it leads, so tabs that start together can't both lead. */
export const ELECTION_TIMING: ElectionTiming = { graceMs: 300 };

export type Election = { isLeader(): boolean; stop(): void };

export function startElection(registry: Registry, on: { acquire(): void; lose(): void }, timing: ElectionTiming = ELECTION_TIMING): Election {
  let leader = false;
  let stopped = false;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const isOldest = (): boolean => {
    const me = registry.self();
    if (!me.present) return false;
    return registry.live().every((tab) => tab.since > me.since || (tab.since === me.since && tab.id > me.id));
  };
  const cancel = () => {
    if (pending !== undefined) clearTimeout(pending);
    pending = undefined;
  };
  const update = () => {
    if (stopped) return;
    if (!isOldest()) {
      cancel();
      if (leader) {
        leader = false;
        on.lose();
      }
      return;
    }
    if (leader || pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      if (!stopped && !leader && isOldest()) {
        leader = true;
        on.acquire();
      }
    }, timing.graceMs);
  };

  registry.onChange(update);
  update();
  return {
    isLeader: () => leader,
    stop: () => {
      stopped = true;
      cancel();
      if (leader) {
        leader = false;
        on.lose();
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests and the type-check**

Run: `npm run test:file -- test/unit/elect.test.ts`
Expected: PASS, 6 tests.

Run: `npm test && npm run typecheck`
Expected: all unit tests pass; exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/elect.ts test/unit/elect.test.ts
git commit -m "Elect the background leader from the registry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Spike S4 in browsers

**Files:**
- Create: `test/browser/probes/s4.ts`
- Test: `test/browser/s4-crosstab.test.ts`
- Modify: `docs/superpowers/spikes/2026-10-09-plan1-findings.md` (add an S4 section)

**Interfaces:**
- Consumes:
  - `createGm`, `GRANTS` (Task 3)
  - `startRegistry` (Task 7)
  - `startBus` (Task 8)
  - `startElection` (Task 9)
  - `backendsFromEnv`, `startSession` (Task 6)
  - `startServer`, `buildUserscript`, `readAttr`, `waitForAttr` (Task 4)
  - `sleep` (Task 7)
- Produces: the S4 result in the findings doc.

- [ ] **Step 1: Write the probe `test/browser/probes/s4.ts`**

```ts
// Spike S4 probe (spec §11): registry + bus + election on real pages, with scaled-down timings.
// Reports on <html data-ready | data-leader | data-received | data-dropped | data-sent>.
import { startBus } from "../../../src/runtime/bus.ts";
import { startElection } from "../../../src/runtime/elect.ts";
import { createGm } from "../../../src/runtime/gm.ts";
import { startRegistry } from "../../../src/runtime/registry.ts";

const html = document.documentElement;
const params = new URLSearchParams(location.search);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

if (location.pathname === "/s4.html") void main();

async function main() {
  const gm = createGm();
  const ns = `s4-${params.get("run")}`;
  const me = Number(params.get("id"));
  const registry = await startRegistry(gm, ns, me, () => ({ url: location.href, title: document.title }), { heartbeatMs: 200, staleMs: 3_000 });
  const bus = await startBus(gm, ns, registry);
  html.setAttribute("data-leader", "0");
  startElection(registry, { acquire: () => html.setAttribute("data-leader", "1"), lose: () => html.setAttribute("data-leader", "0") }, { graceMs: 300 });
  addEventListener("pagehide", () => {
    void registry.leave();
  });
  addEventListener("pageshow", (event) => {
    if (event.persisted) void registry.rejoin();
  });

  const received = new Set<string>();
  bus.onMessage((payload, from) => {
    received.add(`${from}:${(payload as { n: number }).n}`);
    html.setAttribute("data-received", String(received.size));
    html.setAttribute("data-dropped", String(bus.dropped));
  });
  html.setAttribute("data-ready", "1");

  const to = params.get("sendTo");
  if (!to) return;
  const target = Number(to);
  while (!registry.live().some((tab) => tab.id === target)) await sleep(50);
  await sleep(1_000); // the target has heard this tab's roster ring by now and is reading its outbox
  const count = Number(params.get("count"));
  const spacingMs = Number(params.get("spacingMs"));
  for (let n = 1; n <= count; n++) {
    await bus.send(target, { n });
    if (spacingMs > 0) await sleep(spacingMs);
  }
  html.setAttribute("data-sent", String(count));
}
```

- [ ] **Step 2: Write the test `test/browser/s4-crosstab.test.ts`**

```ts
// Spike S4 (spec §11): election and outbox protocol under churn. Emulator by default; release tier with
// X2U_BACKENDS=tm,vm. S4_CHURN_MS sets the churn phase (default 60s, as the spec asks).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext, Page } from "playwright";
import { backendsFromEnv, startSession } from "../../bench/session.ts";
import { GRANTS } from "../../src/runtime/gm.ts";
import { readAttr, waitForAttr } from "../support/dom.ts";
import { startServer, type Server } from "../support/server.ts";
import { sleep } from "../support/time.ts";
import { buildUserscript } from "../support/userscript.ts";

const CHURN_MS = Number(process.env.S4_CHURN_MS ?? 60_000);
/** Staleness + heartbeat + grace + slack, in case a close skipped pagehide. */
const SETTLE_MS = 3_000 + 200 + 300 + 1_000;
const s4Page = () => new Response("<!doctype html><html><head><title>s4</title></head><body>s4</body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });

for (const backend of backendsFromEnv()) {
  describe(`S4 cross-tab protocol on ${backend}`, () => {
    let siteA: Server;
    let siteB: Server;
    let userscript: string;

    before(async () => {
      siteA = await startServer({ "/s4.html": s4Page });
      siteB = await startServer({ "/s4.html": s4Page });
      userscript = await buildUserscript(`${import.meta.dirname}/probes/s4.ts`, {
        name: "ext2userscript S4",
        match: [`${siteA.origin}/*`, `${siteB.origin}/*`],
        grant: Object.values(GRANTS).flat(),
        runAt: "document-end",
        isolated: true,
      });
    });

    after(async () => {
      await siteA.close();
      await siteB.close();
    });

    async function open(context: BrowserContext, url: string): Promise<Page> {
      const tab = await context.newPage();
      await tab.goto(url);
      await waitForAttr(tab, "data-ready", "1");
      return tab;
    }

    it("delivers 1,000 spaced messages and a 50-message burst without loss", async () => {
      const session = await startSession(backend, userscript);
      try {
        const run = `m${Date.now()}`;
        const receiver = await open(session.context, `${siteB.origin}/s4.html?run=${run}&id=2`);
        const sender = await open(session.context, `${siteA.origin}/s4.html?run=${run}&id=1&sendTo=2&count=1000&spacingMs=5`);
        await waitForAttr(sender, "data-sent", "1000", 90_000);
        await waitForAttr(receiver, "data-received", "1000", 15_000);
        assert.equal(await readAttr(receiver, "data-dropped"), "0");
        await open(session.context, `${siteA.origin}/s4.html?run=${run}&id=3&sendTo=2&count=50&spacingMs=0`);
        await waitForAttr(receiver, "data-received", "1050", 30_000);
        assert.equal(await readAttr(receiver, "data-dropped"), "0");
      } finally {
        await session.close();
      }
    });

    it("has exactly one leader after each settle period, through tab churn", async () => {
      const session = await startSession(backend, userscript);
      try {
        const run = `e${Date.now()}`;
        const tabs = new Map<number, Page>();
        let nextId = 1;
        const openTab = async () => {
          const id = nextId++;
          const origin = id % 2 === 0 ? siteB.origin : siteA.origin;
          tabs.set(id, await open(session.context, `${origin}/s4.html?run=${run}&id=${id}`));
        };
        const countLeaders = async () => {
          const flags = await Promise.all([...tabs.values()].map((tab) => readAttr(tab, "data-leader")));
          return flags.filter((flag) => flag === "1").length;
        };
        for (let i = 0; i < 5; i++) await openTab();
        const end = Date.now() + CHURN_MS;
        let checks = 0;
        do {
          for (let i = 0; i < 5; i++) {
            const ids = [...tabs.keys()];
            const victim = ids[Math.floor(Math.random() * ids.length)];
            await tabs.get(victim)?.close();
            tabs.delete(victim);
            await openTab();
            await sleep(200 + Math.random() * 600);
          }
          await sleep(SETTLE_MS);
          checks++;
          assert.equal(await countLeaders(), 1, `expected exactly one leader after settling (check ${checks})`);
        } while (Date.now() < end);
      } finally {
        await session.close();
      }
    });
  });
}
```

- [ ] **Step 3: Run S4 on the emulator**

Run: `npm run test:file -- test/browser/s4-crosstab.test.ts`
Expected: PASS, 2 tests (about 75s).

If the emulator fails, the protocol or the emulator has a bug. Debug with `superpowers:systematic-debugging` before going on: the real managers will be judged against this result.

- [ ] **Step 4: Run S4 on real Tampermonkey and Violentmonkey (needs the Task 6 profile)**

Run: `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/s4-crosstab.test.ts`
Expected: PASS, 4 tests (about 3 minutes).

A failure here is a spike finding: record it in Step 5.

- [ ] **Step 5: Add the S4 section to the findings doc**

Append this to `docs/superpowers/spikes/2026-10-09-plan1-findings.md` and fill the cells from the Steps 3–4 output:

```markdown
## S4: leader election and outbox protocol under churn

Run:
- `npm run test:file -- test/browser/s4-crosstab.test.ts` (emulator)
- `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/s4-crosstab.test.ts` (real managers)

| | Emulator | Tampermonkey | Violentmonkey |
|---|---|---|---|
| 1,000 spaced messages + 50 burst: received, dropped | | | |
| Churn: settle checks run, checks with exactly one leader | | | |

**Result:**
- PASS if every column passes.
- Otherwise, describe what went wrong (for example two leaders, no leader, or `dropped` > 0) and what it implies for spec §5.3 or §5.4.
```

- [ ] **Step 6: Commit**

```bash
git add test/browser/probes/s4.ts test/browser/s4-crosstab.test.ts docs/superpowers/spikes/2026-10-09-plan1-findings.md
git commit -m "Run spike S4: election and outbox protocol under churn" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: ES-module bundling and spike S3

**Files:**
- Create: `src/convert/paths.ts`, `src/convert/esbuild.ts`, `src/convert/esbuild-node.ts`, `src/convert/esbuild-browser.ts`
- Test: `test/unit/esbuild.test.ts`
- Create: `test/browser/s3/worker.ts`
- Test: `test/browser/s3-esbuild.test.ts`
- Modify: `docs/superpowers/spikes/2026-10-09-plan1-findings.md` (add an S3 section)

**Interfaces:**
- Consumes:
  - `unpack`, `type ExtensionFiles` (Task 2)
  - `cwsCrxUrl`, `fetchBytes` (Task 2)
  - `startServer` (Task 4)
- Produces:
  - **`src/convert/paths.ts`:** `dirname(path)`, `joinPath(base, rel)`
  - **`src/convert/esbuild.ts`:**
    - `type EsbuildApi = Pick<typeof import("esbuild"), "build">`
    - `type ModuleBundle = { code: string; remoteImports: string[] }`
    - `bundleModule(esbuild: EsbuildApi, files: ExtensionFiles, entry: string): Promise<ModuleBundle>`
  - **`src/convert/esbuild-node.ts`:** `loadEsbuild(): Promise<EsbuildApi>`
  - **`src/convert/esbuild-browser.ts`:** `loadEsbuild(wasmURL: string): Promise<EsbuildApi>`

- [ ] **Step 1: Write the failing unit test**

`test/unit/esbuild.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8 } from "fflate";
import { bundleModule } from "../../src/convert/esbuild.ts";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { dirname, joinPath } from "../../src/convert/paths.ts";

const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([path, text]) => [path, strToU8(text)]));

describe("paths", () => {
  it("joins relative to a directory and drops query strings", () => {
    assert.equal(joinPath("js/lib", "../shared/a.js?v=2"), "js/shared/a.js");
    assert.equal(joinPath("", "/root.js"), "root.js");
    assert.equal(dirname("js/lib/a.js"), "js/lib");
    assert.equal(dirname("a.js"), "");
  });

  it("refuses to leave the extension root", () => {
    assert.throws(() => joinPath("js", "../../etc/passwd"), /escapes the extension root/);
  });
});

describe("bundleModule", () => {
  it("bundles static, root-relative and dynamic imports from the extension's files", async () => {
    const { code, remoteImports } = await bundleModule(
      await loadEsbuild(),
      files({
        "bg/worker.js": 'import { a } from "./lib/a.js"; import shared from "/shared.js"; console.log(a, shared); import("./lazy.js").then((m) => console.log(m.lazy));',
        "bg/lib/a.js": 'export const a = "from-a";',
        "shared.js": 'export default "from-shared";',
        "bg/lazy.js": 'export const lazy = "from-lazy";',
      }),
      "bg/worker.js",
    );
    for (const text of ["from-a", "from-shared", "from-lazy"]) assert.ok(code.includes(text), `missing ${text}`);
    assert.deepEqual(remoteImports, []);
  });

  it("keeps remote imports external and lists them", async () => {
    const { code, remoteImports } = await bundleModule(await loadEsbuild(), files({ "w.js": 'import("https://cdn.example.com/x.js");' }), "w.js");
    assert.deepEqual(remoteImports, ["https://cdn.example.com/x.js"]);
    assert.ok(code.includes("https://cdn.example.com/x.js"));
  });

  it("names a missing file and who imported it", async () => {
    await assert.rejects(
      bundleModule(await loadEsbuild(), files({ "w.js": 'import "./missing.js";' }), "w.js"),
      /\.\/missing\.js \(imported from w\.js\) is not in the extension/,
    );
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run test:file -- test/unit/esbuild.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/convert/esbuild.ts`.

- [ ] **Step 3: Implement the four modules**

`src/convert/paths.ts`:

```ts
// POSIX path helpers for extension files. They also run in the browser, where node:path isn't available.

export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Resolves rel against base inside the extension root. Query strings and fragments are dropped. */
export function joinPath(base: string, rel: string): string {
  const parts: string[] = [];
  for (const part of `${base}/${rel.replace(/[?#].*$/, "")}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error(`Path escapes the extension root: ${rel}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}
```

`src/convert/esbuild.ts`:

```ts
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
```

`src/convert/esbuild-node.ts`:

```ts
// Native esbuild for Node callers (the CLI and tests).
import * as esbuild from "esbuild";
import type { EsbuildApi } from "./esbuild.ts";

export async function loadEsbuild(): Promise<EsbuildApi> {
  return esbuild;
}
```

`src/convert/esbuild-browser.ts`:

```ts
// esbuild-wasm for browser callers. Call it inside a Web Worker: with worker: false, esbuild runs on the calling thread.
import * as esbuild from "esbuild-wasm";
import type { EsbuildApi } from "./esbuild.ts";

let ready: Promise<void> | undefined;

export async function loadEsbuild(wasmURL: string): Promise<EsbuildApi> {
  ready ??= esbuild.initialize({ wasmURL, worker: false });
  await ready;
  return esbuild;
}
```

- [ ] **Step 4: Run the unit tests and the type-check**

Run: `npm run test:file -- test/unit/esbuild.test.ts`
Expected: PASS, 5 tests.

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 5: Write the S3 worker `test/browser/s3/worker.ts`**

```ts
// Spike S3 worker: unpack and bundle in a Web Worker with esbuild-wasm, then report a hash of the output.
import { bundleModule } from "../../../src/convert/esbuild.ts";
import { loadEsbuild } from "../../../src/convert/esbuild-browser.ts";
import { unpack } from "../../../src/convert/unpack.ts";

type Job = { url: string; entry: string };
const scope = self as unknown as { onmessage: ((event: MessageEvent<Job>) => void) | null; postMessage(message: unknown): void };

scope.onmessage = async (event) => {
  const started = performance.now();
  try {
    const esbuild = await loadEsbuild("/esbuild.wasm");
    const files = unpack(new Uint8Array(await (await fetch(event.data.url)).arrayBuffer()));
    const { code } = await bundleModule(esbuild, files, event.data.entry);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)));
    scope.postMessage({ sha256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""), ms: performance.now() - started, bytes: code.length });
  } catch (error) {
    scope.postMessage({ error: String(error) });
  }
};
```

- [ ] **Step 6: Write the S3 test `test/browser/s3-esbuild.test.ts`**

```ts
// Spike S3 (spec §11): esbuild-wasm in a Web Worker bundles a real MV3 module service worker byte-for-byte like
// native esbuild, in Chromium, Firefox and WebKit. The fixture is downloaded once into bench/.cache/fixtures.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";
import { bundleModule } from "../../src/convert/esbuild.ts";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { unpack } from "../../src/convert/unpack.ts";
import { cwsCrxUrl, fetchBytes } from "../../src/download.ts";
import { startServer, type Server } from "../support/server.ts";

const FIXTURE = { name: "Refined GitHub", cwsId: "hlepfoohegkhhmjieoechaddaejaokhf" };
const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE_PATH = join(ROOT, "bench", ".cache", "fixtures", `${FIXTURE.cwsId}.crx`);
const PAGE = `<!doctype html><html><head><title>s3</title><script type="module">
const worker = new Worker("/worker.js", { type: "module" });
window.runS3 = (job) => new Promise((resolve) => { worker.onmessage = (event) => resolve(event.data); worker.postMessage(job); });
</script></head><body>s3</body></html>`;

async function fixture(): Promise<Uint8Array<ArrayBuffer>> {
  if (!existsSync(FIXTURE_PATH)) {
    await mkdir(dirname(FIXTURE_PATH), { recursive: true });
    await writeFile(FIXTURE_PATH, await fetchBytes(cwsCrxUrl(FIXTURE.cwsId)));
  }
  return new Uint8Array(await readFile(FIXTURE_PATH));
}

describe(`S3: esbuild-wasm bundles ${FIXTURE.name}'s module service worker in a Web Worker`, () => {
  let server: Server | undefined;
  let entry = "";
  let expected = "";

  before(async () => {
    const crx = await fixture();
    const files = unpack(crx);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as {
      version: string;
      background?: { service_worker?: string; type?: string };
    };
    assert.equal(manifest.background?.type, "module", "the fixture must declare a module service worker");
    entry = manifest.background?.service_worker ?? "";
    const source = new TextDecoder().decode(files.get(entry));
    assert.match(source, /\bimport\b[^;]*["']\.{0,2}\//, "the fixture's worker should import other files, or S3 proves little");
    const native = await bundleModule(await loadEsbuild(), files, entry);
    expected = createHash("sha256").update(native.code).digest("hex");
    console.log(`[S3] ${FIXTURE.name} ${manifest.version}: ${entry}, native bundle ${native.code.length} bytes`);
    const worker = await build({ entryPoints: [join(import.meta.dirname, "s3", "worker.ts")], bundle: true, format: "esm", platform: "browser", target: "es2020", write: false });
    const wasm = new Uint8Array(await readFile(join(ROOT, "node_modules", "esbuild-wasm", "esbuild.wasm")));
    server = await startServer({
      "/s3.html": () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "/worker.js": () => new Response(worker.outputFiles[0].text, { headers: { "content-type": "text/javascript" } }),
      "/esbuild.wasm": () => new Response(wasm, { headers: { "content-type": "application/wasm" } }),
      "/fixture.crx": () => new Response(crx, { headers: { "content-type": "application/octet-stream" } }),
    });
  });

  after(async () => {
    await server?.close();
  });

  const browsers: Array<[string, BrowserType]> = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];
  for (const [name, type] of browsers) {
    it(`${name}: byte-identical to native esbuild, first run under 10s`, async () => {
      const browser = await type.launch();
      try {
        const tab = await browser.newPage();
        await tab.goto(`${server?.origin}/s3.html`);
        await tab.waitForFunction(() => "runS3" in window);
        const result = (await tab.evaluate(
          (e) => (window as unknown as { runS3(job: { url: string; entry: string }): Promise<unknown> }).runS3({ url: "/fixture.crx", entry: e }),
          entry,
        )) as { sha256?: string; ms?: number; error?: string };
        console.log(`[S3] ${name}: ${JSON.stringify(result)}`);
        assert.equal(result.error, undefined);
        assert.equal(result.sha256, expected, "the wasm output differs from native esbuild");
        assert.ok((result.ms ?? Infinity) < 10_000, `the first conversion took ${Math.round(result.ms ?? 0)}ms`);
      } finally {
        await browser.close();
      }
    });
  }
});
```

- [ ] **Step 7: Run S3**

Run: `npm run test:file -- test/browser/s3-esbuild.test.ts`
Expected:
- PASS, 3 tests.
- `[S3]` log lines with the fixture version, the native bundle size, and each browser's `ms`.

If the `before` hook fails one of its fixture assertions, the fixture changed and no longer exercises S3. Pick another site-specific MV3 extension whose manifest has `background.type: "module"` and whose worker imports other files. Update `FIXTURE`, and record the swap and the reason in the findings.

- [ ] **Step 8: Add the S3 section to the findings doc**

Append this to `docs/superpowers/spikes/2026-10-09-plan1-findings.md` and fill it from the Step 7 output:

```markdown
## S3: esbuild-wasm in a Web Worker

Run: `npm run test:file -- test/browser/s3-esbuild.test.ts`

Fixture: Refined GitHub, version from the `[S3]` log line. Entry and native bundle size, from the same line:

| Browser | Byte-identical to native | First conversion (ms) |
|---|---|---|
| Chromium | | |
| Firefox | | |
| WebKit | | |

**Result:**
- PASS if all three rows are byte-identical and under 10,000 ms.
- Otherwise, record which part failed and what it implies for spec §8, the web app.
```

- [ ] **Step 9: Commit**

```bash
git add src/convert/paths.ts src/convert/esbuild.ts src/convert/esbuild-node.ts src/convert/esbuild-browser.ts test/unit/esbuild.test.ts test/browser/s3 test/browser/s3-esbuild.test.ts docs/superpowers/spikes/2026-10-09-plan1-findings.md
git commit -m "Add ES-module bundling for esbuild and esbuild-wasm; run spike S3" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Spike S2, popup on strict-CSP sites (throwaway)

**Files:**
- Create: `spikes/README.md`
- Create: `spikes/s2-popup-csp/probe.ts`, `spikes/s2-popup-csp/run.ts`
- Create (by running): `spikes/s2-popup-csp/results.json`
- Modify: `docs/superpowers/spikes/2026-10-09-plan1-findings.md` (add an S2 section)

**Interfaces:**
- Consumes:
  - `createGm`, `GRANTS` (Task 3)
  - `launchReal`, `installUserscript`, `type ManagerName` (Task 6)
  - `startServer`, `buildUserscript` (Task 4)
- Produces: the S2 result in the findings doc. Nothing in `src/` imports from `spikes/`.

- [ ] **Step 1: Write `spikes/README.md`**

```markdown
# Spikes

THROWAWAY code that answers a question in the spec (§11). Nothing in `src/` imports from here. Results are recorded in `docs/superpowers/spikes/`.
```

- [ ] **Step 2: Write the probe `spikes/s2-popup-csp/probe.ts`**

```ts
// THROWAWAY spike S2 (spec §11): does the popup approach (§6) work on strict-CSP sites?
// - A modal with an about:blank iframe, filled from the userscript.
// - Styles go through gm.addElement; images and fonts load from blob: and data: URLs.
// Results go on <html data-x2u-s2>.
import { createGm } from "../../src/runtime/gm.ts";

declare const __S2_ASSETS__: string; // origin of run.ts's asset server, injected with esbuild define

const gm = createGm();
const results: Record<string, unknown> = {};
const report = () => document.documentElement.setAttribute("data-x2u-s2", JSON.stringify(results));

main().catch((error: unknown) => {
  results.error = String(error);
  report();
});

async function main() {
  const png = await fetchBytes(`${__S2_ASSETS__}/pixel.png`);
  const font = await fetchBytes(`${__S2_ASSETS__}/font.ttf`);
  const pngBlob = URL.createObjectURL(new Blob([png], { type: "image/png" }));
  const fontBlob = URL.createObjectURL(new Blob([font], { type: "font/ttf" }));
  const pngData = `data:image/png;base64,${toBase64(png)}`;
  const fontData = `data:font/ttf;base64,${toBase64(font)}`;

  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const frame = document.createElement("iframe");
  frame.style.cssText = "width: 400px; height: 300px; border: 0";
  root.append(frame);
  document.body.append(host);
  const doc = frame.contentDocument;
  const win = frame.contentWindow as unknown as (typeof globalThis & Window) | null;
  if (!doc || !win) throw new Error("the about:blank iframe has no document");

  try {
    doc.body.innerHTML = "<b>x</b>";
    results.innerHtml = true;
  } catch (error) {
    results.innerHtml = String(error); // Trusted Types sites block this
  }
  try {
    new DOMParser().parseFromString("<b>x</b>", "text/html");
    results.domParser = true;
  } catch (error) {
    results.domParser = String(error);
  }
  doc.body.replaceChildren();

  await gm.addElement(doc.head, "style", {
    textContent: `#t { color: rgb(1, 2, 3); } @font-face { font-family: x2uBlob; src: url(${fontBlob}); } @font-face { font-family: x2uData; src: url(${fontData}); }`,
  });
  const plain = doc.createElement("style");
  plain.textContent = "#t { background-color: rgb(4, 5, 6); }";
  doc.head.append(plain);

  const text = doc.createElement("div");
  text.id = "t";
  text.textContent = "before";
  doc.body.append(text);
  text.textContent = "js-ran"; // JS running in the userscript, driving the iframe's DOM
  results.jsRan = doc.getElementById("t")?.textContent === "js-ran";
  let clicks = 0;
  win.addEventListener("click", () => clicks++);
  text.click();
  results.eventsWork = clicks === 1;
  const style = win.getComputedStyle(text);
  results.gmStyleApplied = style.color === "rgb(1, 2, 3)";
  results.plainStyleApplied = style.backgroundColor === "rgb(4, 5, 6)";

  results.imgBlob = await imageLoads(doc, pngBlob);
  results.imgData = await imageLoads(doc, pngData);
  results.imgIframeBlob = await imageLoads(doc, win.URL.createObjectURL(new win.Blob([png], { type: "image/png" })));
  results.fontBlob = await fontLoads(doc, "x2uBlob");
  results.fontData = await fontLoads(doc, "x2uData");
  results.done = true;
  report();
}

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await gm.xmlHttpRequest({ url, responseType: "arraybuffer" });
  return new Uint8Array(response.response as ArrayBuffer);
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function imageLoads(doc: Document, src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = doc.createElement("img");
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 5_000);
    img.src = src;
    doc.body.append(img);
  });
}

async function fontLoads(doc: Document, family: string): Promise<boolean> {
  try {
    await Promise.race([doc.fonts.load(`16px ${family}`), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  } catch {
    return false;
  }
  return [...doc.fonts].some((face) => face.family.replace(/["']/g, "") === family && face.status === "loaded");
}
```

- [ ] **Step 3: Write the runner `spikes/s2-popup-csp/run.ts`**

```ts
// THROWAWAY spike S2 runner: installs the probe into each real manager and visits strict-CSP sites.
// Needs the release-tier profile (npm run bench:setup). Writes spikes/s2-popup-csp/results.json.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installUserscript } from "../../bench/real/install.ts";
import { launchReal } from "../../bench/real/launch.ts";
import type { ManagerName } from "../../bench/real/managers.ts";
import { GRANTS } from "../../src/runtime/gm.ts";
import { startServer } from "../../test/support/server.ts";
import { buildUserscript } from "../../test/support/userscript.ts";

const SITES = ["https://github.com/", "https://www.youtube.com/", "https://x.com/"];
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Geneva.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function readFont(): Promise<Uint8Array<ArrayBuffer>> {
  for (const path of FONT_CANDIDATES) {
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      // try the next one
    }
  }
  throw new Error(`No TrueType font found; add a path to FONT_CANDIDATES (tried ${FONT_CANDIDATES.join(", ")})`);
}

const font = await readFont();
const pixel = new Uint8Array(Buffer.from(PIXEL, "base64"));
const assets = await startServer({
  "/pixel.png": () => new Response(pixel, { headers: { "content-type": "image/png" } }),
  "/font.ttf": () => new Response(font, { headers: { "content-type": "font/ttf" } }),
});
const userscript = await buildUserscript(
  join(import.meta.dirname, "probe.ts"),
  {
    name: "ext2userscript S2 spike",
    match: SITES.map((site) => `${site}*`),
    grant: Object.values(GRANTS).flat(),
    connect: ["127.0.0.1"],
    runAt: "document-idle",
    isolated: true,
  },
  { __S2_ASSETS__: JSON.stringify(assets.origin) },
);

const results: Record<string, Record<string, unknown>> = {};
for (const manager of ["tm", "vm"] as ManagerName[]) {
  const { context, extensionId } = await launchReal(manager);
  try {
    await installUserscript(context, extensionId, userscript);
    for (const site of SITES) {
      const page = await context.newPage();
      const response = await page.goto(site, { waitUntil: "domcontentloaded" });
      const csp = response?.headers()["content-security-policy"] ?? "(none)";
      let probe: Record<string, unknown> = { error: "timed out after 30s" };
      for (let i = 0; i < 60; i++) {
        const raw = await page.locator("html").getAttribute("data-x2u-s2");
        if (raw) {
          probe = JSON.parse(raw) as Record<string, unknown>;
          if (probe.done || probe.error) break;
        }
        await page.waitForTimeout(500);
      }
      results[`${manager} ${site}`] = { csp, ...probe };
      console.log(manager, site, JSON.stringify(probe));
      await page.close();
    }
  } finally {
    await context.close();
  }
}
await assets.close();
await writeFile(join(import.meta.dirname, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(`Wrote ${join(import.meta.dirname, "results.json")}`);
```

- [ ] **Step 4: Type-check, then run S2 (needs the Task 6 profile)**

Run: `npm run typecheck`
Expected: exit code 0.

Run: `npm run script -- spikes/s2-popup-csp/run.ts`
Expected:
- Six result lines (2 managers × 3 sites).
- `spikes/s2-popup-csp/results.json` is written.
- Every line has `"done":true`, or an `error` that says why the probe stopped.

- [ ] **Step 5: Add the S2 section to the findings doc**

Append this to `docs/superpowers/spikes/2026-10-09-plan1-findings.md` and fill it from `results.json`:

```markdown
## S2: popup modal on strict-CSP sites

Run: `npm run script -- spikes/s2-popup-csp/run.ts`. Raw results: `spikes/s2-popup-csp/results.json`.

| Manager / site | jsRan | eventsWork | gmStyleApplied | plainStyleApplied | innerHtml | domParser | imgBlob | imgData | imgIframeBlob | fontBlob | fontData |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tm github.com | | | | | | | | | | | |
| tm youtube.com | | | | | | | | | | | |
| tm x.com | | | | | | | | | | | |
| vm github.com | | | | | | | | | | | |
| vm youtube.com | | | | | | | | | | | |
| vm x.com | | | | | | | | | | | |

**Result:**
- PASS (spec §11) if `jsRan`, `eventsWork` and `gmStyleApplied` are true on every row.
- Asset columns that are false become report warnings (spec §6 "Known ceiling"). List them here.
- If `innerHtml` or `domParser` failed (Trusted Types), note it: Plan 4 must build popup DOM without those sinks.
```

- [ ] **Step 6: Commit**

```bash
git add spikes docs/superpowers/spikes/2026-10-09-plan1-findings.md
git commit -m "Run spike S2: popup modal on strict-CSP sites (throwaway)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: CI and spike results in the spec

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `docs/superpowers/specs/2026-10-09-ext2userscript-design.md` (§11, plus any section a failed spike affects)
- Modify: `docs/superpowers/spikes/2026-10-09-plan1-findings.md` (add a summary)

**Interfaces:**
- Consumes: every test from Tasks 1–11, and the findings from Tasks 6, 10, 11 and 12.
- Produces: CI on every push; spec §11 with results.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium firefox webkit
      - run: npm run typecheck
      - run: npm test
      - run: npm run test:browser
```

- [ ] **Step 2: Run the whole CI sequence locally**

Run: `npm ci && npm run typecheck && npm test && npm run test:browser`
Expected: all pass.

Run time is about 3 minutes, most of it the 60s S4 churn and the S3 browsers.

- [ ] **Step 3: Add the summary to the findings doc**

Append to `docs/superpowers/spikes/2026-10-09-plan1-findings.md`:

```markdown
## Summary

| Spike | Result | Spec sections affected |
|---|---|---|
| S1 | | |
| S2 | | |
| S3 | | |
| S4 | | |
```

Fill each row with PASS or FAIL, copied from that spike's **Result** line. Under "Spec sections affected", write "none" for a PASS. For a FAIL, list the sections its section named.

- [ ] **Step 4: Put the results into spec §11**

In `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`:
1. Add a `Result` column to the §11 table.
2. Fill each row with PASS or FAIL and a few words of evidence, for example "PASS: TM 5.x and VM 2.49 pass the gm.ts contract".
3. Add this line under the table: `Details: docs/superpowers/spikes/2026-10-09-plan1-findings.md`.

For each FAIL, add a paragraph headed `**Revision (S<n>):**` under the affected section. It should say what the spike showed and what changes. Do not start Plan 2.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml docs/superpowers/specs/2026-10-09-ext2userscript-design.md docs/superpowers/spikes/2026-10-09-plan1-findings.md
git commit -m "Add CI and record spike results in the spec" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: HUMAN CHECKPOINT — review the results**

Stop and show the human the findings summary.
- **All four spikes pass:** Plan 1 is done. Plan 2 (converter core and CLI) can be written next.
- **Any spike fails:** the human reviews the `Revision` paragraphs first (spec §11).
