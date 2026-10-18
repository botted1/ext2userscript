# ext2userscript Plan 5: The Web App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-page web app (spec §8) that converts an extension's archive in the browser: drop a file, or paste a store link when a download proxy is configured, and get the report with the userscript to download or copy. Also the optional download proxy.

**Architecture:**
- **The build:** `web/build.ts` builds a static folder with esbuild, which the project already depends on:
  - the page (`index.html`, `style.css`, `main.js`);
  - the conversion worker (`worker.js`, with the built runtime inside);
  - esbuild-wasm's `.wasm`.
- **Loading:** the page loads the worker with the first conversion, and the worker loads esbuild-wasm (14 MB) only when a conversion needs it (a module background or page).
- **Store links:** these go through a small Cloudflare Worker (`proxy/worker.ts`), because the stores send no CORS headers. The CLI, the proxy and the page share one store-URL parser and fetcher in `src/download.ts`.

**Tech Stack:**
- TypeScript, run directly by Node 22.16 with `--experimental-strip-types`.
- `node:test`.
- Playwright 1.64 (Chromium, Firefox, WebKit).
- esbuild 0.28.2, esbuild-wasm 0.28.2 and fflate 0.8.3.
- No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`

**Scope:** Plan 5 of 6. It covers:
- spec §8;
- the `web/` and `proxy/` entries of §2;
- §10.2's runtime tests for the page.

Plan 6 (the benchmark) is unchanged.

**Prototype:** every test below was run before the plan was written, on 2026-10-18, against a copy of `main` at 9f9f739.

| Check | Result |
|---|---|
| Unit tests | 379 of 379; `tsc` clean |
| `test/browser/web.test.ts` | Chromium 10 of 10, WebKit 9 of 9. The copy test is Chromium-only (only Chromium lets a test read the clipboard); Firefox doesn't launch on macOS 27, so it runs in CI |
| Overlap test | Fails, showing the stale result, with the page's job-id guard removed |
| `npm run web -- dir --serve` | Serves the page, scripts and `.wasm` (as `application/wasm`) at `http://localhost:8000/` |
| Sizes | `main.js` 3 KB, `worker.js` 198 KB (converter, runtime and esbuild-wasm's JS), `esbuild.wasm` 14 MB |
| Design | Screenshots reviewed in light, dark and at 390 px wide |

What the prototype found:
1. **A failed `esbuild.wasm` load** shows `Couldn't convert it: Failed to download "…/esbuild.wasm"` in both browsers, and the next conversion loads it: `loadEsbuild` already clears a failed init.
2. **The sample extension's report** has 1 partly supported and 6 supported entries, so the page shows two groups.
3. **A dropped folder** reaches the page as a file without an archive extension, so the "isn't an extension archive" message covers it; no folder check is needed.

**Decisions that need the human's OK along with this plan:**
1. **esbuild instead of Vite.** Spec §2 names "a static Vite site" and Vite as a dev dependency. One page and a worker need no dev server or plugins; esbuild builds them in about 30 lines and is already a dependency, and `--serve` covers local viewing. Task 1's spec corrections say so.
2. **The GitHub Pages deployment can't be tried yet.** The repository has no GitHub remote, so the `pages` job in `ci.yml` (Task 3) stays untested until it has one. The job is standard (`upload-pages-artifact` and `deploy-pages`).
3. **The spec corrections Task 1 applies** (listed there).

## Global Constraints

- **Node:** Node ≥ 22.16. TypeScript runs directly with `--experimental-strip-types --disable-warning=ExperimentalWarning`. No tsx, no build step for the CLI.
- **Running things:** one test file with `npm run test:file -- <path>`. Under machine load, run the unit suite with `npm test -- --test-concurrency=2`.
- **TypeScript:** erasable syntax only; relative imports end in `.ts`; type-only imports use `import type`; the `lib` is `es2022` plus DOM.
- **Exact versions:**
  - `esbuild` and `esbuild-wasm` 0.28.2; `fflate` 0.8.3.
  - Dev: `playwright` 1.64.0, `typescript` 7.0.2, `@types/node` 22.20.5.
  - No other dependencies: no Vite, no wrangler, no static server.
- **Tests:** `node:test` with `node:assert/strict`. Browser tests use the `playwright` library.
- **Isomorphic code:**
  - `src/convert/*` and `src/download.ts` import no `node:` module.
  - `web/main.ts`, `web/worker.ts`, `web/protocol.ts` and `proxy/worker.ts` import none either.
  - Only `web/build.ts` is Node-only.
- **Relative URLs only** in the built page, so it works under any path (GitHub Pages serves a project site at `/<repo>/`).
- **Text from an extension** (its name, the report's subjects, reasons and warnings) goes into the page through `textContent` or text nodes only, never as HTML.
- **Copy (spec §8):** the buttons say "Download .user.js" and "Copy".
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, passed as a second `-m`.

## Review Focus

1. **The site served from a subpath**, as GitHub Pages serves `https://<user>.github.io/<repo>/`: every script, worker, style sheet and `.wasm` must load. Pinned in Task 2: `web.test.ts` serves the built site under `/x2u/` for every test.
2. **A large archive** (20 MB) must convert, with the page answering while it does. Pinned in Task 2 (`web.test.ts`, "converts a 20 MB archive").
3. **`esbuild.wasm` failing to load** (offline, a flaky connection, a blocked file) must show why, and the next conversion must try again. Pinned in Task 2 (`web.test.ts`, "says so when esbuild fails to load, and loads it on the next try").
4. **Text from the extension** must show as text, never run as markup: a name like `<img src=x onerror=…>`. Pinned in Task 2 (`web.test.ts`, "shows an extension's name as text, never as markup").
5. **Two conversions overlapping:** the user picks a second file while a slower first one converts, and the page must end on the second one. Pinned in Task 2 (`web.test.ts`, "shows the latest of two overlapping conversions").

---

### Task 1: Spec corrections, and store links for the CLI and the download proxy

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`, `src/download.ts`, `src/source.ts`, `tsconfig.json`
- Create: `proxy/worker.ts`, `proxy/wrangler.toml`, `proxy/README.md`
- Test: `test/unit/proxy.test.ts` (and the existing `test/unit/source.test.ts`, unchanged)

**Interfaces:**
- Produces:
  - **`src/download.ts`:**
    - `type StoreSource = { kind: "cws"; id: string } | { kind: "edge"; id: string } | { kind: "amo"; slug: string }`;
    - `parseStoreUrl(url: URL): StoreSource | undefined`, moved from `source.ts`'s private `parseUrl`;
    - `storeArchive(store: StoreSource, limits?: FetchLimits): Promise<Uint8Array<ArrayBuffer>>`;
    - `fetchBytes` now returns `Promise<Uint8Array<ArrayBuffer>>`.
  - **`src/source.ts`:** `Source` is `StoreSource | { kind: "url" } | { kind: "file" } | { kind: "dir" }`, and its `parseUrl` and `readArchive` use the two functions above.
  - **`proxy/worker.ts`:**
    - `export const MAX_BYTES = 50 * 1024 * 1024`;
    - `export type Env = { ALLOWED_ORIGIN?: string }`;
    - `export default { fetch(request: Request, env: Env): Promise<Response> }`.

- [ ] **Step 1: Apply the spec corrections.**
  1. **§2:**
     - `web/` is "static page built with esbuild by `web/build.ts`, vanilla TS".
     - `proxy/` is "optional Cloudflare Worker for store-link downloads (~30 lines)".
     - The dev dependencies line drops `vite`.
  2. **§8:**
     - **esbuild-wasm:** it and its `.wasm` file load on the first conversion that needs them (a module background or page), not on page load. The conversion worker loads with the first conversion.
     - **The store-link field:** enabled only when `X2U_PROXY_URL` names a proxy at build time; without one it is disabled, saying why.
     - **Report groups:** "Not supported", "Partly supported" and "Supported", the last collapsed. The verdict reads "Likely works", "Partly works" or "Unlikely to work".
     - **Relative URLs:** every URL the page uses is relative, so it works under any path.
     - **GitHub Pages:** a `pages` job in `ci.yml` deploys after the tests, on pushes to `main`. The repository variable `X2U_PROXY_URL` names the proxy.
     - **The proxy** accepts only GET with `?src=<store page URL>` for the three store hosts, and fetches the archive with `src/download.ts`. Its answers carry `Access-Control-Allow-Origin` set to its `ALLOWED_ORIGIN` variable, and it refuses anything above 50 MB. When it fails, it gives its reason as plain text, with status 400, 405 or 502.
  3. **§10.2:** the web app's tests are `test/browser/web.test.ts`, on Chromium, Firefox and WebKit. Playwright's Firefox doesn't launch on macOS 27, so Firefox runs in CI.

- [ ] **Step 2: Write the failing test** `test/unit/proxy.test.ts`:

```ts
// The optional download proxy (proxy/worker.ts), run in Node with the stores' fetch stubbed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import proxy, { MAX_BYTES } from "../../proxy/worker.ts";
import { cwsCrxUrl, edgeCrxUrl } from "../../src/download.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const ask = (src: string, env = {}, init?: RequestInit) => proxy.fetch(new Request(`https://proxy.test/?src=${encodeURIComponent(src)}`, init), env);

describe("download proxy", () => {
  it("fetches a store page's archive, readable by the configured site only", async (t) => {
    const asked: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      asked.push(String(url));
      return new Response(new Uint8Array([80, 75, 3, 4]));
    });
    const response = await ask(`https://chromewebstore.google.com/detail/some-name/${ID}`, { ALLOWED_ORIGIN: "https://site.test" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://site.test");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [80, 75, 3, 4]);
    assert.deepEqual(asked, [cwsCrxUrl(ID)]);
  });

  it("refuses anything but a store page, and anything but GET, saying why", async () => {
    for (const src of ["https://example.com/extension.crx", `https://clients2.google.com/service/update2/crx?x=id%3D${ID}`, "not a url", ""]) {
      const response = await ask(src);
      assert.equal(response.status, 400, src);
      assert.match(await response.text(), /Chrome Web Store, Firefox Add-ons or Edge Add-ons/);
    }
    assert.equal((await ask(`https://chromewebstore.google.com/detail/${ID}`, {}, { method: "POST" })).status, 405);
  });

  it("stops at 50 MB, and passes the store's failure on", async (t) => {
    assert.equal(MAX_BYTES, 50 * 1024 * 1024);
    t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(MAX_BYTES + 1)));
    const large = await ask(`https://microsoftedge.microsoft.com/addons/detail/some-name/${ID}`);
    assert.equal(large.status, 502);
    assert.match(await large.text(), /larger than 50 MiB/);
    t.mock.method(globalThis, "fetch", async () => new Response("gone", { status: 404, statusText: "Not Found" }));
    const missing = await ask(`https://microsoftedge.microsoft.com/addons/detail/${ID}`);
    assert.equal(missing.status, 502);
    assert.equal(await missing.text(), `Download failed (404 Not Found): ${edgeCrxUrl(ID)}`);
  });
});
```

- [ ] **Step 3: Run it.**
  - Command: `npm run test:file -- test/unit/proxy.test.ts`.
  - Expected: FAIL, `Cannot find module '…/proxy/worker.ts'`.

- [ ] **Step 4: Implement.**
  - **`src/download.ts`:** add `StoreSource`, `parseStoreUrl` (the body of `source.ts`'s `parseUrl`, returning `undefined` instead of `{ kind: "url" }`) and `storeArchive`. `storeArchive` uses `cwsCrxUrl`, `edgeCrxUrl` or `amoXpiUrl`, then `fetchBytes(url, limits)`. Update the header comment: the CLI, the web app and the download proxy share the module.
  - **`src/source.ts`:**
    - `parseUrl = (url) => parseStoreUrl(url) ?? { kind: "url", url: url.href }`;
    - `readArchive` handles `url` and `file`, and otherwise returns `storeArchive(source)`.
  - **`proxy/worker.ts`:**
    - Every answer carries `access-control-allow-origin: <ALLOWED_ORIGIN or "">` and `cache-control: no-store`.
    - Non-GET → 405 `Only GET is allowed`.
    - `src` must parse as a URL that `parseStoreUrl` accepts; otherwise → 400 `src must be a Chrome Web Store, Firefox Add-ons or Edge Add-ons page`.
    - Then `storeArchive(store, { maxBytes: MAX_BYTES })`: success → 200 `application/octet-stream`; a throw → 502 with the error's message.
    - Error bodies are `text/plain; charset=utf-8`.
  - **`proxy/wrangler.toml`:** `name = "ext2userscript-proxy"`, `main = "worker.ts"`, `compatibility_date = "2026-10-01"`, and `[vars] ALLOWED_ORIGIN = "https://<you>.github.io"`.
  - **`proxy/README.md`** covers:
    - what the proxy does, and why the page needs it (no CORS from the stores);
    - its limits: the three stores' pages, GET, 50 MB;
    - deploying: `npx wrangler deploy` from `proxy/`, with `ALLOWED_ORIGIN` set to the site's origin;
    - turning it on: build the page with `X2U_PROXY_URL=https://ext2userscript-proxy.<account>.workers.dev`, or set the repository variable of that name for the Pages job.

    State that it is off by default.
  - **`tsconfig.json`:** `include` gains `"proxy"` (and `"web"`, which Task 2 fills).

- [ ] **Step 5: Run it.**
  - Command: `npm run test:file -- test/unit/proxy.test.ts test/unit/source.test.ts`, then `npm test -- --test-concurrency=2` and `npm run typecheck`.
  - Expected: PASS, all.

- [ ] **Step 6: Commit.**

```bash
git add docs/superpowers/specs/2026-10-09-ext2userscript-design.md src/download.ts src/source.ts tsconfig.json proxy test/unit/proxy.test.ts
git commit -m "Share store links between the CLI and an optional download proxy, and bring the spec in line with the web app plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The web app: its build, its conversion worker and its page

**Files:**
- Create: `web/build.ts`, `web/protocol.ts`, `web/worker.ts`, `web/main.ts`, `web/index.html`, `web/style.css`
- Modify: `src/convert/esbuild.ts`, `package.json`
- Test: `test/unit/esbuild.test.ts`, `test/browser/web.test.ts`

**Interfaces:**
- Consumes: `convert` (`src/convert/index.ts`), `unpack`, `loadEsbuild(wasmURL)` (`esbuild-browser.ts`), `loadRuntime` (`runtime-node.ts`), `slugify` (`metadata.ts`), `Report` (`report.ts`).
- Produces:
  - **`src/convert/esbuild.ts`:** `lazyEsbuild(load: () => Promise<EsbuildApi>): EsbuildApi`. Its `build` and `transform` call `load()` on each use; `load` memoises (`loadEsbuild` does).
  - **`web/build.ts`:** `buildWeb(outDir: string, options?: { proxyUrl?: string }): Promise<void>`.
    - It writes `index.html`, `style.css`, `main.js`, `worker.js` and `esbuild.wasm`.
    - The scripts are bundled as `iife`, `platform: "browser"`, `target: "es2020"`, minified, `legalComments: "none"`.
    - It defines `__X2U_RUNTIME__` (the built runtime) and `__X2U_PROXY__` (the proxy's URL, or `""`), as JSON strings.
    - Run as a script, it builds into `dist/web` (or its first non-flag argument), takes `X2U_PROXY_URL` from the environment, and with `--serve` serves the folder through esbuild's `context().serve({ servedir, port: 8000 })`.
  - **`web/protocol.ts`:**
    - `type JobRequest = { kind: "file"; bytes: ArrayBuffer }` (Task 3 adds the store kind);
    - `type Job = { id: number } & JobRequest`;
    - `type WorkerMessage = { id; type: "progress"; text } | { id; type: "done"; userscript; report: Report } | { id; type: "error"; message }`.
  - **`package.json`:** `"web": "node --experimental-strip-types --disable-warning=ExperimentalWarning web/build.ts"`.

- [ ] **Step 1: Write the failing tests.**

In `test/unit/esbuild.test.ts`, import `lazyEsbuild` too, and add before `describe("bundleModule", …)`:

```ts
describe("lazyEsbuild", () => {
  it("loads esbuild when a conversion first uses it, not before", async () => {
    let loads = 0;
    const esbuild = lazyEsbuild(async () => {
      loads++;
      return loadEsbuild();
    });
    assert.equal(loads, 0);
    assert.equal((await esbuild.transform("let a = 1", { minify: true })).code, "let a=1;\n");
    assert.equal(loads, 1);
  });
});
```

`test/browser/web.test.ts`:

```ts
// The web app (spec §8) end to end: built as `npm run web` builds it, served under a subpath as GitHub Pages serves a
// project site, and driven in Chromium, Firefox and WebKit.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { buildWeb } from "../../web/build.ts";
import { files, moduleBackgroundExtension, sampleExtension, zipFiles } from "../support/extension.ts";
import { startServer, type Handler, type Server } from "../support/server.ts";

const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css", js: "text/javascript", wasm: "application/wasm" };

/** The built site's routes under /x2u/, as GitHub Pages serves a project site. */
async function site(proxyUrl?: string) {
  const dir = await mkdtemp(join(tmpdir(), "x2u-web-"));
  await buildWeb(dir, { proxyUrl });
  const routes: Record<string, Handler> = {};
  for (const name of await readdir(dir)) {
    const bytes = await readFile(join(dir, name));
    const response = () => new Response(bytes, { headers: { "content-type": TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream" } });
    routes[`/x2u/${name}`] = response;
    if (name === "index.html") routes["/x2u/"] = response;
  }
  await rm(dir, { recursive: true });
  return routes;
}

const archive = (name: string, extension: Map<string, Uint8Array>) => ({ name, mimeType: "application/zip", buffer: Buffer.from(zipFiles(extension)) });

async function result(page: Page): Promise<string> {
  await page.locator("#result").waitFor({ state: "visible", timeout: 30_000 });
  return (await page.locator("#result-title").textContent()) ?? "";
}

const browsers: Array<[string, BrowserType]> = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];
for (const [name, type] of browsers) {
  describe(`web app in ${name}`, { skip: name === "firefox" && process.platform === "darwin" ? "Playwright's Firefox doesn't launch on macOS 27 (CI runs it)" : false }, () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    before(async () => {
      browser = await type.launch();
      server = await startServer(await site());
      origin = server.origin;
    });

    after(async () => {
      await browser?.close();
      await server?.close();
    });

    it("converts a chosen archive and shows its report, with the userscript to download", async () => {
      const page = await browser.newPage({ acceptDownloads: true });
      await page.goto(`${origin}/x2u/`);
      await page.locator("#file").setInputFiles(archive("sample.zip", sampleExtension(origin)));
      assert.equal(await result(page), "Sample Extension 1.2.3");
      assert.equal(await page.locator("#verdict").textContent(), "Partly works");
      assert.deepEqual(await page.locator("#groups summary").allTextContents(), ["Partly supported (1)", "Supported (6)"]);
      const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download").click()]);
      assert.equal(download.suggestedFilename(), "sample-extension.user.js");
      const userscript = await readFile((await download.path()) as string, "utf8");
      assert.match(userscript, /^\/\/ ==UserScript==\n\/\/ @name {9}Sample Extension\n/);
      await page.close();
    });

    it("copies the userscript, and is usable from the keyboard", { skip: name !== "chromium" ? "only Chromium lets a test read the clipboard" : false }, async () => {
      const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
      const page = await context.newPage();
      await page.goto(`${origin}/x2u/`);
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "file");
      await page.locator("#file").setInputFiles(archive("sample.zip", sampleExtension(origin)));
      await result(page);
      await page.locator("#copy").click();
      await page.locator("#status", { hasText: "Copied." }).waitFor();
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^\/\/ ==UserScript==\n\/\/ @name {9}Sample Extension\n/);
      await context.close();
    });

    it("loads the converter with the first conversion, and esbuild only for one that needs it", async () => {
      const page = await browser.newPage();
      const asked: string[] = [];
      page.on("request", (request) => asked.push(new URL(request.url()).pathname));
      await page.goto(`${origin}/x2u/`);
      assert.deepEqual(asked.filter((path) => /worker|wasm/.test(path)), []);
      await page.locator("#file").setInputFiles(archive("sample.zip", sampleExtension(origin)));
      await result(page);
      assert.deepEqual(asked.filter((path) => /worker|wasm/.test(path)), ["/x2u/worker.js"]);
      await page.locator("#file").setInputFiles(archive("module.zip", moduleBackgroundExtension(origin)));
      await page.locator("#result-title", { hasText: "Module Background" }).waitFor({ timeout: 30_000 });
      assert.deepEqual(asked.filter((path) => /worker|wasm/.test(path)), ["/x2u/worker.js", "/x2u/esbuild.wasm"]);
      await page.close();
    });

    it("converts a 20 MB archive", async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/x2u/`);
      const extension = sampleExtension(origin);
      // Incompressible, so the archive is as large as its files.
      extension.set("data/blob.bin", randomBytes(20 * 1024 * 1024));
      await page.locator("#file").setInputFiles(archive("large.zip", extension));
      assert.equal(await result(page), "Sample Extension 1.2.3");
      await page.close();
    });

    it("says so when esbuild fails to load, and loads it on the next try", async () => {
      // esbuild.wasm fails once, as on a flaky connection, then loads.
      const routes = await site();
      let failures = 1;
      const wasm = routes["/x2u/esbuild.wasm"];
      routes["/x2u/esbuild.wasm"] = (request) => (failures-- > 0 ? new Response("unavailable", { status: 503 }) : wasm(request));
      const flaky = await startServer(routes);
      try {
        const page = await browser.newPage();
        await page.goto(`${flaky.origin}/x2u/`);
        await page.locator("#file").setInputFiles(archive("module.zip", moduleBackgroundExtension(flaky.origin)));
        await page.locator("#error").waitFor({ state: "visible", timeout: 30_000 });
        assert.match((await page.locator("#error").textContent()) ?? "", /^Couldn't convert it: Failed to download ".*\/x2u\/esbuild\.wasm"$/);
        await page.locator("#file").setInputFiles(archive("module.zip", moduleBackgroundExtension(flaky.origin)));
        assert.equal(await result(page), "Module Background 2.0.0");
        await page.close();
      } finally {
        await flaky.close();
      }
    });

    it("shows the latest of two overlapping conversions", async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/x2u/`);
      // The module background waits for esbuild to load; the sample, chosen after it, finishes first.
      await page.locator("#file").setInputFiles(archive("module.zip", moduleBackgroundExtension(origin)));
      await page.locator("#file").setInputFiles(archive("sample.zip", sampleExtension(origin)));
      assert.equal(await result(page), "Sample Extension 1.2.3");
      await page.waitForTimeout(3_000);
      assert.equal(await page.locator("#result-title").textContent(), "Sample Extension 1.2.3");
      await page.close();
    });

    it("takes a dropped archive, and says what is wrong with a file that isn't one", async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/x2u/`);
      await page.evaluate((bytes) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], "sample.zip", { type: "application/zip" }));
        document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }, [...zipFiles(sampleExtension(origin))]);
      assert.equal(await result(page), "Sample Extension 1.2.3");
      await page.locator("#file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
      assert.equal(await page.locator("#error").textContent(), "notes.txt isn't an extension archive: choose a .crx, .zip or .xpi file (zip a folder first).");
      await page.locator("#file").setInputFiles({ name: "broken.zip", mimeType: "application/zip", buffer: Buffer.from("not a zip") });
      await page.locator("#error", { hasText: "Unrecognised" }).waitFor();
      assert.equal(await page.locator("#error").textContent(), "Couldn't convert it: Unrecognised archive: expected a .crx, .xpi or .zip file");
      assert.equal(await page.locator("#result").isHidden(), true);
      await page.close();
    });

    it("shows an extension's name as text, never as markup", async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/x2u/`);
      const name = '<img src=x onerror="document.title = 1">';
      const extension = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name, version: "1.0", content_scripts: [{ matches: ["https://a.test/*"], js: ["c.js"] }] }), "c.js": "" });
      await page.locator("#file").setInputFiles(archive("odd.zip", extension));
      assert.equal(await result(page), `${name} 1.0`);
      assert.equal(await page.locator("#result img").count(), 0);
      assert.equal(await page.title(), "ext2userscript");
      await page.close();
    });
  });
}
```

- [ ] **Step 2: Run them.**
  - Commands: `npm run test:file -- test/unit/esbuild.test.ts`, then `npm run test:file -- test/browser/web.test.ts`.
  - Expected:
    - `lazyEsbuild is not a function` (or no such export);
    - `web.test.ts` fails to load with `Cannot find module '…/web/build.ts'`.

- [ ] **Step 3: Implement the build and the worker.**
  - **`lazyEsbuild`:** an object whose `build` and `transform` await `load()` and call through. The casts to `EsbuildApi["build"]` and `EsbuildApi["transform"]` are needed for esbuild's overloads.
  - **`web/build.ts`:** per the Interfaces block. `esbuild.wasm` is copied from `node_modules/esbuild-wasm/esbuild.wasm`.
  - **`web/worker.ts`:** a classic worker; type `self` with a cast, as `test/browser/s3/worker.ts` does.
    - **esbuild:** `esbuild = lazyEsbuild(() => loadEsbuild(new URL("esbuild.wasm", self.location.href).href))`. The first time it loads, it posts `{ type: "progress", text: "Loading esbuild (once; 14 MB)…" }` for the current job.
    - **On a job:**
      1. post `Reading the archive…`;
      2. `unpack(new Uint8Array(bytes))`;
      3. post `Converting…`;
      4. `convert(files, { runtime: __X2U_RUNTIME__, esbuild })`;
      5. post `{ type: "done", userscript, report }`.
    - **Any throw** posts `{ type: "error", message: error.message }`.

- [ ] **Step 4: Implement the page.**

  **`web/index.html`:**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ext2userscript</title>
    <meta name="description" content="Convert a Chrome or Firefox extension into a userscript for Tampermonkey or Violentmonkey, in your browser.">
    <link rel="stylesheet" href="style.css">
    <script src="main.js" defer></script>
  </head>
  <body>
    <header class="meta">
      <p class="fence" aria-hidden="true">// ==UserScript==</p>
      <div class="line"><span class="key" aria-hidden="true">// @name</span><h1>ext2userscript</h1></div>
      <div class="line"><span class="key" aria-hidden="true">// @description</span><p>Converts a Chrome or Firefox extension into a userscript for Tampermonkey or Violentmonkey.</p></div>
      <div class="line"><span class="key" aria-hidden="true">// @privacy</span><p>Runs in your browser: the extension never leaves it.</p></div>
      <p class="fence" aria-hidden="true">// ==/UserScript==</p>
    </header>

    <main>
      <label class="drop" id="drop">
        <input type="file" id="file" accept=".crx,.zip,.xpi">
        <span class="drop-text">Drop a <b>.crx</b>, <b>.zip</b> or <b>.xpi</b> file here, or <span class="pick">choose one</span></span>
      </label>

      <p class="status" id="status" role="status" aria-live="polite"></p>
      <p class="error" id="error" role="alert" hidden></p>

      <section class="result" id="result" hidden aria-labelledby="result-title">
        <h2 id="result-title"></h2>
        <p class="verdict" id="verdict"></p>
        <div class="actions">
          <button type="button" id="download">Download .user.js</button>
          <button type="button" id="copy" class="secondary">Copy</button>
        </div>
        <p class="install">Open the downloaded file in your browser, and Tampermonkey or Violentmonkey offers to install it.</p>
        <ul class="warnings" id="warnings"></ul>
        <div id="groups"></div>
      </section>
    </main>
  </body>
</html>
```

  **`web/style.css`.** The design: the page's own userscript header is its one bold element; everything else is quiet.
  - **Tokens on `:root`:**
    - `--paper #f6f7f9`, `--ink #1c2533`, `--muted #5b6676`, `--line #d7dce3`;
    - `--accent #2f4bd0`, `--on-accent #fff`;
    - `--supported #1f7a4d`, `--partial #9a5b00`, `--unsupported #b42318`;
    - `--text: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    - `--code: ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    - `color-scheme: light dark`.

    Dark values under `prefers-color-scheme: dark`: `#12161d`, `#e4e8ee`, `#9aa4b2`, `#2c3440`, `#8ea2ff`, `#10142a`, `#5cc794`, `#e0a64a`, `#ff8a7a`. System fonts on purpose: the page fetches nothing from a third party.
  - **Layout:** `header` and `main` are one left-aligned column, `max-width: 46rem`, with `1rem` side padding.
  - **The header:**
    - it is `--code`;
    - each `.line` is a grid of `9.5em 1fr`, one column below `34rem`;
    - `.key` and `.fence` are `--muted`;
    - `h1` is `clamp(1.9rem, 6vw, 2.75rem)`, `letter-spacing: -0.02em`.
  - **The drop zone:**
    - `.drop` is a 2 px dashed `--line` border, 12 px radius, padded and centred;
    - its file input is visually hidden but focusable;
    - `.drop:focus-within` and `.drop.over` turn the border `--accent`, and `:focus-within` adds an outline.
  - **Buttons:** solid `--accent`; `.secondary` is outlined.
  - **Text styles:** `.status`, `.install` and `.hint` are `--muted`, and `.status:empty` is hidden. `.error` has a 3 px left border in `--unsupported`.
  - **Verdict and groups:** `.verdict.<verdict>` and `details.<status> summary` take the status colours.
  - **The table:** `.table` scrolls horizontally if it must; its first cell is `--code` at `0.88rem` with `overflow-wrap: break-word`.
  - **Focus:** `:focus-visible` gets a 2 px `--accent` outline.

  **`web/main.ts`:**
  - **Starting a job:** `start(job: JobRequest, transfer?)`.
    1. It bumps a job counter, hides the error and the result, and sets the status to `Starting…`.
    2. On first use it creates `new Worker("worker.js")`. The URL is relative, so it works under a subpath.
    3. It posts `{ ...job, id }`.
    4. A worker `error` event shows `The converter couldn't start: <message>`.
  - **Answers:** an answer whose `id` isn't the latest job is ignored.
    - `progress` sets the status;
    - `error` shows `Couldn't convert it: <message>` in `#error`;
    - `done` renders.
  - **A file:** one whose name doesn't match `/\.(crx|zip|xpi)$/i` shows `<name> isn't an extension archive: choose a .crx, .zip or .xpi file (zip a folder first).`. Otherwise its `arrayBuffer()` is transferred to the worker.
  - **Rendering:** all of it is `textContent` and created elements.
    - `#result-title` is `<name> <version>`.
    - `#verdict` is "Likely works", "Partly works" or "Unlikely to work", with the verdict as a class.
    - The warnings are a `<ul>`.
    - Each status with entries gets a `<details class="<status>">`, in the order unsupported, partial, supported, and only Supported starts closed. Its summary is `Not supported (n)`, `Partly supported (n)` or `Supported (n)`. Its table has the columns "API or feature", "Where" and "Why".
    - The subject cell breaks only after dots: each dot-ended part, then a `<wbr>`.
    - The status clears when the result shows.
  - **Download:** a `text/javascript` Blob URL clicked through an `<a download>`, named `${slugify(name) || "extension"}.user.js`.
  - **Copy:** `navigator.clipboard.writeText`. The status becomes `Copied.`, or on failure `The browser didn't allow copying. Use Download .user.js instead.`
  - **Drag and drop:** the whole page takes a drop. `dragover` prevents the default and adds `.over` to the drop zone; `dragleave` with no `relatedTarget` removes it, and so does `drop`.
  - **The file input:** after reading a file, it clears its value, so choosing the same file again converts again.

- [ ] **Step 5: Run them.**
  - Commands: the Step 2 commands, then `npm test -- --test-concurrency=2`, `npm run typecheck`, and `npm run web -- dist/web`.
  - Expected:
    - PASS, all; Firefox is skipped on macOS, and the copy test runs in Chromium only;
    - the build prints `Built the web app into dist/web`.

- [ ] **Step 6: Commit.**

```bash
git add web src/convert/esbuild.ts package.json test/unit/esbuild.test.ts test/browser/web.test.ts
git commit -m "Add the web app: convert an extension's archive in the browser, in a worker that loads esbuild only when needed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Store links in the web app, its deployment, and the README

**Files:**
- Modify: `web/index.html`, `web/main.ts`, `web/worker.ts`, `web/protocol.ts`, `.github/workflows/ci.yml`, `README.md`
- Test: `test/browser/web.test.ts`

**Interfaces:**
- Consumes:
  - `parseStoreUrl` (Task 1);
  - the proxy contract (Task 1): GET `<proxy>?src=<store page URL>` answers the archive, or plain text with a non-2xx status;
  - `buildWeb`'s `proxyUrl` (Task 2).
- Produces: `JobRequest` gains `{ kind: "store"; link: string }`.

- [ ] **Step 1: Write the failing tests.**

In `test/browser/web.test.ts`, after `TYPES`:

```ts
const ID = "abcdefghijklmnopabcdefghijklmnop";
const STORE_PAGE = `https://chromewebstore.google.com/detail/sample/${ID}`;
const LARGE_PAGE = `https://microsoftedge.microsoft.com/addons/detail/large/${ID}`;
```

and, after "shows an extension's name as text, never as markup":

```ts
    it("converts from a store page through the download proxy, with the store's ID as the extension's", async () => {
      // The site and a stand-in for the proxy on one server, whose address the build needs first.
      const routes: Record<string, Handler> = {};
      const proxied = await startServer(routes);
      try {
        Object.assign(routes, await site(`${proxied.origin}/proxy`), {
          "/proxy": (request: Request) => {
            const src = new URL(request.url).searchParams.get("src");
            if (src === STORE_PAGE) return new Response(zipFiles(sampleExtension(origin)));
            if (src === LARGE_PAGE) return new Response(`Download is larger than 50 MiB: ${src}`, { status: 502 });
            return new Response("src must be a Chrome Web Store, Firefox Add-ons or Edge Add-ons page", { status: 400 });
          },
        });
        const page = await browser.newPage({ acceptDownloads: true });
        await page.goto(`${proxied.origin}/x2u/`);
        await page.locator("#link").fill(STORE_PAGE);
        await page.locator("#store button").click();
        assert.equal(await result(page), "Sample Extension 1.2.3");
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download").click()]);
        assert.match(await readFile((await download.path()) as string, "utf8"), new RegExp(`"id":"${ID}"`));
        await page.locator("#link").fill("https://example.com/extension.crx");
        await page.locator("#store button").click();
        await page.locator("#error", { hasText: "store" }).waitFor();
        assert.equal(await page.locator("#error").textContent(), "Couldn't convert it: That isn't a Chrome Web Store, Firefox Add-ons or Edge Add-ons page");
        // The proxy's own reason for failing reaches the page.
        await page.locator("#link").fill(LARGE_PAGE);
        await page.locator("#store button").click();
        await page.locator("#error", { hasText: "50 MiB" }).waitFor();
        assert.equal(await page.locator("#error").textContent(), `Couldn't convert it: Download is larger than 50 MiB: ${LARGE_PAGE}`);
        await page.close();
      } finally {
        await proxied.close();
      }
    });

    it("disables the store link without a download proxy, saying why", async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/x2u/`);
      assert.equal(await page.locator("#link").isDisabled(), true);
      assert.equal(await page.locator("#store button").isDisabled(), true);
      assert.equal(await page.locator("#store-hint").isVisible(), true);
      await page.close();
    });
```

- [ ] **Step 2: Run them.**
  - Command: `npm run test:file -- test/browser/web.test.ts`.
  - Expected: FAIL on the two new tests (`#link` doesn't exist); the rest pass.

- [ ] **Step 3: Implement.**
  - **`web/index.html`:** between the drop zone and the status line:

```html
      <form class="store" id="store">
        <label for="link">Or paste its store page</label>
        <div class="row">
          <input type="url" id="link" placeholder="https://chromewebstore.google.com/detail/…" autocomplete="off">
          <button type="submit">Convert</button>
        </div>
        <p class="hint" id="store-hint" hidden>Store links need a download proxy, and this site has none. Download the extension's file and drop it above.</p>
      </form>
```

    In `style.css`:
    - `.store` sits below the drop zone, with a muted block label;
    - `.row` is a flex row with gap;
    - `input[type="url"]` takes the free space (`flex: 1; min-width: 0`) and has the input border and radius;
    - disabled controls are at half opacity, with a `not-allowed` cursor.
  - **`web/main.ts`:**
    - With `__X2U_PROXY__` set, the form's submit (default prevented) starts `{ kind: "store", link }` with the trimmed value.
    - Without it, the form's input and button are disabled and `#store-hint` shown.
  - **`web/worker.ts`:** a store job posts `Downloading from the store…`.
    - The link must parse as a URL that `parseStoreUrl` accepts, or it throws `That isn't a Chrome Web Store, Firefox Add-ons or Edge Add-ons page`.
    - It fetches `` `${__X2U_PROXY__}?src=${encodeURIComponent(link)}` ``. A non-OK answer throws with the answer's text, or `The download proxy answered <status>` if it has none.
    - It converts with `extensionId` set to the store's ID for the Chrome Web Store and Edge Add-ons, as the CLI does (spec §7).
  - **`.github/workflows/ci.yml`:** add a `pages` job:

```yaml
  pages:
    needs: test
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run web -- dist/web
        env:
          X2U_PROXY_URL: ${{ vars.X2U_PROXY_URL }}
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist/web
      - id: deployment
        uses: actions/deploy-pages@v4
```

  - **`README.md`, Usage:** after the CLI block, add a paragraph:
    - the web app does the same in the browser;
    - `npm run web -- --serve` builds it into `dist/web` and serves it at `http://localhost:8000/`;
    - CI deploys it to GitHub Pages;
    - store links need the optional download proxy in `proxy/` (see `proxy/README.md`).

- [ ] **Step 4: Run them.**
  - Commands: the Step 2 command, then `npm test -- --test-concurrency=2`, `npm run typecheck` and `npm run test:browser`.
  - Expected: PASS, apart from the known Firefox S3 failure on macOS 27.

- [ ] **Step 5: Commit.**

```bash
git add web .github/workflows/ci.yml README.md test/browser/web.test.ts
git commit -m "Convert from store links through the download proxy, and deploy the web app to GitHub Pages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After Plan 5

- **Plan 6:** the benchmark (spec §10.4), now with the web app as a second way in.
- **Ceilings this plan states:**
  - **Deployment:** the Pages job is untested until the repository has a GitHub remote.
  - **Firefox:** runs in CI only, since Playwright's Firefox doesn't launch on macOS 27.
  - **Store links:** need someone to host the proxy.
