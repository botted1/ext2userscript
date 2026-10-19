# ext2userscript Plan 7: Closing the Scorecard's Gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the converter, runtime and emulator gaps that Plan 6's scorecard showed, so v1 meets spec §1's ship criteria on the emulator, Tampermonkey and Violentmonkey.

**Architecture:** Thirteen fixes, each traced to a root cause in a corpus extension, grouped by the part of the code they change:
- **Converter:** dynamic `import()` in content scripts, top-level `await`, data files, source maps, grants and `@connect`.
- **Runtime:**
  - Trusted Types for the extension's own strings;
  - the `this` extension code runs with, and the background's `location` and `chrome` object;
  - file URLs and locale files.
- **Emulator:** Trusted Types in `GM_addElement`, and naming its injected script.

**Tech Stack:**
- TypeScript, run directly by Node 22.16 with `--experimental-strip-types`.
- `node:test`.
- Playwright 1.64 (Chromium).
- esbuild 0.28.2.
- No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`

**Scope:** after Plan 6 (the benchmark), this plan makes v1 meet spec §1's criteria, measured by `X2U_BACKENDS=emulator,tm,vm npm run bench -- --gate`.

**Prototype:** every fix and test below was built and run before the plan was written, on 2026-10-19, against a copy of `main` at 9cfe09f.

| Check | Result |
|---|---|
| Unit tests | 418 of 418 (399 before, plus 19), each new one seen failing without its fix; `tsc` clean |
| `npm run test:browser` (emulator) | 70 pass, 4 skipped (emulator-only or Chromium-only), and the Firefox S3 test, which can't launch Firefox on macOS 27 and runs in CI |
| The Trusted Types browser tests on Tampermonkey and Violentmonkey | 2 of 2 on each |
| `X2U_BACKENDS=emulator,tm,vm npm run bench` | ext2userscript passes all 20 browser cases and the 3 negatives on every backend, and every case is conclusive. **All met** on each, below |

| Backend | Cases the baseline passes | Modern cases the baseline fails | Negatives |
|---|---|---|---|
| emulator | 13 of 13 | 6 of 6 | 3 of 3 |
| Tampermonkey | 12 of 12 (the baseline fails JSON Formatter) | 6 of 6 | 3 of 3 |
| Violentmonkey | 11 of 11 (the baseline fails JSON Formatter and BetterTTV) | 7 of 7 | 3 of 3 |

Before this plan (Plan 6's scorecard, emulator): 11 of 13, 2 of 6 (33%), 3 of 3.

What the prototype found, each gap with its root cause (the fix is the task named):
1. **Iridium, on the emulator only.** YouTube requires Trusted Types for scripts. The emulator's `GM_addElement` runs in the page's world, so its `textContent` write throws; the managers' `GM_addElement` isn't held to them (Iridium passes on both). Task 1.
2. **Return YouTube Dislike, on Tampermonkey and the emulator.** Measured on a local page that requires Trusted Types:

   | | Extension's HTML string | After a `default` policy in the userscript | The page's own string, after that |
   |---|---|---|---|
   | Emulator | throws | works | works |
   | Tampermonkey | throws | works | **works** |
   | Violentmonkey | works | works | still throws |

   - Tampermonkey's `@sandbox DOM` hides the page's globals, but shares its DOM prototypes and its Trusted Types factory.
   - So the baseline's fix, a pass-through `default` policy, turns off the site's Trusted Types for the whole page. So does wrapping the sinks for every caller.
   - The runtime instead wraps the sinks and trusts a string only when the code calling the sink is the userscript's own. Its stack frames name its script: `chrome-extension://<id>/userscript.html?name=…` on Tampermonkey.
   - Measured: the extension's strings pass, and the page's still throw, on all three backends. Task 2.
3. **Refined GitHub's options page uses top-level `await`.** esbuild refuses it in an IIFE: `Top-level await is not available in the configured target environment ("es2020")`. Task 3.
4. **Refined GitHub's content script is `void import(chrome.runtime.getURL('assets/refined-github.js'))`.** That's the usual workaround for ES modules in content scripts (Vite, CRXJS). A `blob:` module can't be imported from the page. Task 3.
5. **Refined GitHub's background throws `webext-permission-toggle can only be called from a background page`.**
   - webext-detect compares `location.pathname` with the manifest's `service_worker`, and the background saw the tab's `location`.
   - A `URL` won't do as a stand-in: on a web page, `new URL("chrome-extension://…").origin` is `"null"`.

   Task 4.
6. **Augmented Steam's background throws `Cannot read properties of undefined (reading 'runtime')`.**
   - The background's `chrome` proxy invents a namespace for every name, `__esModule` included.
   - So esbuild's `__toESM` takes webextension-polyfill's export for an ES module and never sets `.default`.

   Task 4.
7. **Improve YouTube! injects `.css` files as scripts.** It tells them apart with `path.indexOf('.css')`, and our `getURL` returns a bare `blob:` URL. Task 5.
8. **Improve YouTube! hangs the page before DOMContentLoaded (all backends).**
   - Its background's `getLocale` fetches `_locales/<lang>/messages.json`. On a failure it fetches again and calls `getLocale('en')` at once, so with `en` missing each failure spawns two more, without end.
   - The runtime had no such file: locales live in the runtime config as parsed messages, with lower-cased names.

   Task 5.
9. **Dark Reader's background reads `config/*.config`** with an XHR to `"../config/dark-sites.config"` (an object literal, not a `fetch` literal), so the files weren't in the asset table. Task 6.
10. **Augmented Steam converts to 128 MB from a 17 MB archive.** Its `web_accessible_resources` lists `*.map`: 103 MB of source maps, base64-encoded. A 128 MB `addInitScript` drops Playwright's connection. Task 6.
11. **Dark Reader opens a tab** with `chrome.tabs.create` (implemented with `GM_openInTab`), but its userscript had no `@grant GM_openInTab`. `windows.create` has the same gap. Task 7.
12. **Refined GitHub hangs on Tampermonkey only.**
    - Its background fetches `https://refined-github.github.io/yolo/…`, which its optional `*://*/*` permission covers, so the shim uses `GM_xmlhttpRequest`.
    - Under `@connect *`, Tampermonkey opens an approval page for a host `@connect` doesn't name, and waits.
    - `connectHosts` also dropped every explicit host once any pattern covered all hosts.
    - A native fetch is no answer: the page's CSP (`connect-src`) blocks it in Tampermonkey's world, as measured.

    Task 7.
13. **Modern for Hacker News, on Tampermonkey and Violentmonkey only.** Its second content group fails with `Cannot read properties of undefined (reading 'applyStyles')`.
    - popper.min.js's UMD wrapper puts `Popper` on `globalThis`, and tippy.js's looks for it on `this`, its top-level `this`.
    - In a manager's world `globalThis` is the manager's proxy, while a plain function call's `this` is the world's own global, so tippy finds nothing. On the emulator both are the page's window.
    - In Chrome, a content script's top-level `this` is its `globalThis`.

    Task 4.

**Decisions that need the human's OK along with this plan:**
1. **Trusted Types: trust the extension's own calls, not every string (finding 2).**
   - This keeps the site's protection, unlike the baseline's `default` policy.
   - Ceilings:
     - a page whose CSP names its allowed policies refuses the runtime's (the extension's strings throw there, as now);
     - only the common sinks are covered (`innerHTML`, `outerHTML`, `ShadowRoot.innerHTML`, `insertAdjacentHTML`, `DOMParser.parseFromString`, `<script src>`);
     - it relies on the manager naming the userscript in its stack frames.
2. **`runtime.getURL` returns `blob:<uuid>#<path>` (finding 7).** The fragment changes no load. Code that parses the URL (`new URL(u).pathname`) still sees a blob path, as before.
3. **Source maps in `web_accessible_resources` are left out, with a warning (finding 10).** A source map the code names with `getURL` stays in. There's no flag to keep the rest.
4. **`@connect` lists the hosts the code names**, when a host permission covers them. Refined GitHub gets about 30 lines. Tampermonkey shows them when installing.
5. **Data files the background or a page names by a relative path go in the asset table (finding 9).** That's any string literal shaped like a path, if the file exists and isn't code. Measured on Dark Reader: its six config files and six icons, 1.2 MB, so the userscript grows from 2.5 MB to 3.7 MB.
6. **Content-script modules run once per content group**, not once per world as in Chrome. Two groups importing the same module each run it. Their namespace is a snapshot, not live bindings.

## Global Constraints

- **Node:** Node ≥ 22.16. TypeScript runs directly with `--experimental-strip-types --disable-warning=ExperimentalWarning`.
- **Running things:** one test file with `npm run test:file -- <path>`. Under machine load, run the unit suite with `npm test -- --test-concurrency=2`.
- **TypeScript:** erasable syntax only; relative imports end in `.ts`; type-only imports use `import type`; the `lib` is `es2022` plus DOM (no `findLast`).
- **Exact versions:**
  - `esbuild` and `esbuild-wasm` 0.28.2; `fflate` 0.8.3.
  - Dev: `playwright` 1.64.0, `typescript` 7.0.2, `@types/node` 22.20.5.
  - No other dependencies.
- **Isomorphic code:** `src/convert/*` imports no `node:` module.
- **Tests:** `node:test` with `node:assert/strict`.
- **No CAPTCHA or bot check is bypassed;** no page's security is turned off for the whole page.
- **Ship criteria, verbatim from spec §1:**
  - passes every corpus case that the baseline passes on the same run;
  - passes at least 75% of the modern MV3 cases that the baseline fails;
  - produces an accurate compatibility report for every negative case.
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, passed as a second `-m`.

## Review Focus

1. **A page whose CSP names its allowed Trusted Types policies** (`trusted-types <names>`) refuses the runtime's. The runtime must still start and run the extension's content scripts. Pinned in Task 2: `content-runtime.test.ts`, "still runs the extension on a page whose CSP names its allowed policies, refusing the runtime's".
2. **The page's own code under Trusted Types, once the extension has run:** its plain strings must still throw (the site keeps its protection). Pinned in Task 2: `content-runtime.test.ts`, "lets the extension's own HTML and script in on a page that requires Trusted Types, while the page's still need them".
3. **A `getURL` result with a cache-buster appended** (`url + "?v=2"`) must still load. Pinned in Task 5: `runtime-core.test.ts`, "puts the file's path in the URL's fragment, which loading ignores".
4. **A content module that imports a remote URL** must leave the `import()` as it is and say why, never leave an `import` statement inside a function (a syntax error that would stop the whole userscript). Pinned in Task 3: `emit.test.ts`, "leaves an import() of a module with remote imports alone, saying why".
5. **A module whose license comments follow its exports** (esbuild writes them last) must keep its exports and its comments. Pinned in Task 3: `esbuild.test.ts`, "finds a module's exports when license comments follow them, as esbuild writes them at the end".

---

### Task 1: Spec corrections, and the emulator's fidelity under Trusted Types

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`, `bench/emulator/page.ts`, `bench/emulator/index.ts`
- Test: `test/browser/emulator.test.ts`

**Interfaces:**
- Produces:
  - the emulator's init script ends with `//# sourceURL=x2u-emulator-userscript.js`, so the userscript's stack frames name a script, as the managers' do (Task 2 relies on it);
  - the emulator's `GM_addElement` writes a `<script>`'s `textContent` through a Trusted Types policy of its own, `x2u-emulator`.

- [ ] **Step 1: Apply the spec corrections.**
  1. **§3.3, ES modules:**
     - An entry with a top-level `await` can't be an IIFE. It becomes an async function, called at once, whose error is thrown again outside the promise.
     - In an isolated-world content script, `import(runtime.getURL("<literal>"))` (Vite and CRXJS's way of running ES modules as content scripts) is bundled by esbuild.
       - Each module becomes an async function in the group's scope, which closes over its `chrome`, as Chrome runs the module in the content script's world.
       - It runs once per group, with `import.meta.url` `chrome-extension://<id>/<path>`, and resolves to a snapshot of its exports.
       - A module with remote imports isn't bundled, with a warning.
  2. **§3.6, Assets:**
     - **Also collected:** a file the background or a page names by a relative path in a string literal (`"../config/a.config"`, read by XHR), when it exists and isn't code.
     - **Excluded:** source maps (`*.map`) matched by `web_accessible_resources`, with a warning; one named by `getURL` stays.
     - **At runtime:**
       - `runtime.getURL(path)` returns `blob:<…>#<path>`. The fragment changes no load, and code that reads the URL's text (`.indexOf('.css')`) sees the path, as in Chrome.
       - `_locales/<locale>/messages.json` is served from the runtime config, rebuilt with its names as the file wrote them.
  3. **§4, header:** `@connect` lists each host permission's host, then each host the extension's code names (in URL string literals and template heads) that a permission covers, and `*` last when any host will do. Tampermonkey asks before reaching a host `@connect` doesn't name, even under `*`.
  4. **§5.2:** `tabs.create` and `windows.create` need `GM_openInTab`, so they grant it.
  5. **§5.4, New leader:**
     - **`location`:** the background gets a `location` of its own: its service worker's script, its page, or `_generated_background_page.html`, with `origin` `chrome-extension://<id>`.
     - **`chrome`:** its object answers only names shaped like a namespace (`/^[a-z][a-zA-Z\d]*$/`), so `chrome.__esModule` is undefined.
  6. **§5.5, Content scripts:** add a "Trusted Types" bullet.
     - On a page that requires Trusted Types, Tampermonkey's userscript world (which shares the page's DOM) is held to them; Violentmonkey's isn't.
     - The runtime wraps the HTML and script-URL sinks in the content context. It passes a string through its own policy, `ext2userscript`, only when the code calling the sink is the userscript's (by its stack frames), so the page's own code stays protected.
     - Ceiling: a CSP that names its allowed policies refuses the runtime's.
  7. **§3.3, the wrapper:** the code runs with its global as `this`, as at the top level of a script in Chrome, so a UMD library that puts itself on `globalThis` and one that looks for it on `this` meet. In a manager's world those two differ for a plain call.
  8. **§10.2:**
     - The emulator's `GM_addElement` isn't held to the page's Trusted Types, as the managers' isn't.
     - Its injected script is named `x2u-emulator-userscript.js` in stack frames, as a manager names a userscript.

- [ ] **Step 2: Write the failing test.** In `test/browser/emulator.test.ts`:
  - add `"/tt.html"` to `site`'s routes, after `"/echo"`, with the comment `// YouTube's rule: scripts need Trusted Types.`;
  - add the test before "shares values across pages on different origins":

```ts
      "/tt.html": () => new Response("<!doctype html><title>t</title>", { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "require-trusted-types-for 'script'" } }),
```

```ts
  it("puts a GM_addElement script into a page that requires Trusted Types, as the managers do", async () => {
    const body = `GM_addElement(document.head, "script", { textContent: "document.documentElement.dataset.ran = 'yes'" });`;
    await withScript({ grant: ["GM_addElement"], runAt: "document-end" }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/tt.html`);
      await waitForAttr(page, "data-ran", "yes");
    });
  });
```

- [ ] **Step 3: Run it.**
  - Command: `npm run test:file -- test/browser/emulator.test.ts`.
  - Expected: FAIL, the new test only, timing out on `data-ran`.

- [ ] **Step 4: Implement.**
  - **`bench/emulator/page.ts`:**
    - `type ScriptPolicy = { createScript(text: string): string }`, and a module-level `let policy: ScriptPolicy | null | undefined`.
    - `trusted(): ScriptPolicy | null` creates `window.trustedTypes?.createPolicy("x2u-emulator", { createScript: (text) => text })` once, or remembers `null` when there's no `trustedTypes`.
    - Its doc comment: the managers' `GM_addElement` isn't held to the page's Trusted Types; the emulator, running in the page's world, is, and a policy of its own stands in for that.
    - In `addElement`, `textContent` on a `script` becomes `trusted()?.createScript(value) ?? value`.
  - **`bench/emulator/index.ts`:**
    - the `addInitScript` content ends with `\n//# sourceURL=x2u-emulator-userscript.js`;
    - the comment above it says it's named as a manager names a userscript in its stack frames, so the runtime tells its own frames from the page's.

- [ ] **Step 5: Run it.**
  - Command: `npm run test:file -- test/browser/emulator.test.ts`, then `npm run typecheck`.
  - Expected: PASS; `tsc` clean.

- [ ] **Step 6: Commit.**

```bash
git add docs/superpowers/specs/2026-10-09-ext2userscript-design.md bench/emulator/page.ts bench/emulator/index.ts test/browser/emulator.test.ts
git commit -m "Let the emulator's GM_addElement put scripts into pages that require Trusted Types, as the managers do" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The extension's own strings under Trusted Types

**Files:**
- Create: `src/runtime/trusted.ts`
- Modify: `src/runtime/content.ts`, `test/support/extension.ts`
- Test: `test/unit/runtime-core.test.ts`, `test/browser/content-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1's named emulator script.
- Produces, in `src/runtime/trusted.ts`:
  - `frameScript(frame: string | undefined): string | undefined`;
  - `trustExtensionStrings(): void`.

  `test/support/extension.ts` gains `trustedTypesExtension(origin: string): ExtensionFiles`.

- [ ] **Step 1: Write the failing tests.**
  - **`test/unit/runtime-core.test.ts`:** import `{ frameScript }` from `../../src/runtime/trusted.ts` and add:

```ts
describe("frameScript", () => {
  it("reads the script a V8 stack frame belongs to, with or without a function name", () => {
    assert.equal(frameScript("    at Proxy.later (chrome-extension://abc/userscript.html?name=a.user.js&id=1:15:134)"), "chrome-extension://abc/userscript.html?name=a.user.js&id=1");
    assert.equal(frameScript("    at chrome-extension://abc/a%20b.user.js#23:14:15"), "chrome-extension://abc/a%20b.user.js#23");
    assert.equal(frameScript("    at <anonymous>:289:15"), "<anonymous>");
    assert.equal(frameScript("Error"), undefined);
    assert.equal(frameScript(undefined), undefined);
  });
});
```

  - **`test/support/extension.ts`:** a header line `// - trustedTypesExtension writes HTML and a <script src=runtime.getURL(...)> into a page that requires Trusted Types.`, and:

```ts
/** A content script that puts HTML and a script of its own into the page, for a page that requires Trusted Types. */
export function trustedTypesExtension(origin: string): ExtensionFiles {
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Trusted",
      version: "1",
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"], run_at: "document_end" }],
      web_accessible_resources: [{ resources: ["inject.js"], matches: ["<all_urls>"] }],
    }),
    "content.js": `
      document.documentElement.dataset.extStarted = "1";
      document.body.insertAdjacentHTML("beforeend", '<b id="ext-html">from the extension</b>');
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("inject.js");
      script.onload = () => (document.documentElement.dataset.injectLoaded = "1");
      document.documentElement.appendChild(script);
      document.documentElement.dataset.extDone = "1";
    `,
    "inject.js": `document.documentElement.dataset.injected = "page";`,
  });
}
```

  - **`test/browser/content-runtime.test.ts`:**
    - import `trustedTypesExtension`;
    - add the two pages below after `strictPage`;
    - add their routes to `harness`'s server (`"/trusted-types.html": trustedTypesPage, "/named-policies.html": namedPoliciesPage`);
    - add the `describe` below before `background on ${backend}`.

```ts
/** A page that requires Trusted Types, as YouTube does; once the extension has run, it tries an HTML string of its own. */
const trustedTypesPage = async () =>
  new Response(
    `<!doctype html><html><head><title>x2u</title></head><body><script>
      new MutationObserver(() => {
        const root = document.documentElement;
        if (!root.dataset.extDone || root.dataset.pageAfter) return;
        try { document.body.insertAdjacentHTML("beforeend", "<i>from the page</i>"); root.dataset.pageAfter = "ok"; } catch { root.dataset.pageAfter = "blocked"; }
      }).observe(document.documentElement, { attributes: true });
    </script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "require-trusted-types-for 'script'" } },
  );

/** A page that requires Trusted Types and names the policies it allows, so the runtime can't create its own. */
const namedPoliciesPage = async () => {
  const response = await trustedTypesPage();
  response.headers.set("content-security-policy", "require-trusted-types-for 'script'; trusted-types site-policy");
  return response;
};
```

```ts
  describe(`Trusted Types on ${backend}`, () => {
    const { open } = harness(backend, trustedTypesExtension);

    it("lets the extension's own HTML and script in on a page that requires Trusted Types, while the page's still need them", async () => {
      const tab = await open("/trusted-types.html");
      await waitForAttr(tab, "data-inject-loaded", "1");
      assert.equal(await readAttr(tab, "data-injected"), "page");
      assert.equal(await tab.locator("#ext-html").count(), 1);
      await waitForAttr(tab, "data-page-after", "blocked");
    });

    it("still runs the extension on a page whose CSP names its allowed policies, refusing the runtime's", async () => {
      const tab = await open("/named-policies.html");
      await waitForAttr(tab, "data-ext-started", "1");
    });
  });
```

- [ ] **Step 2: Run them.**
  - Command: `npm run test:file -- test/unit/runtime-core.test.ts`.
  - Expected: FAIL, `Cannot find module '…/src/runtime/trusted.ts'`.
  - Then `npm run test:file -- test/browser/content-runtime.test.ts --test-name-pattern "Trusted Types"`.
  - Expected: FAIL. On the emulator the first test times out on `data-inject-loaded` (the extension's `insertAdjacentHTML` threw first); the second passes.

- [ ] **Step 3: Implement.**
  - **`src/runtime/trusted.ts`:**
    - **Header comment:** what it fixes (finding 2) and why the trust is per caller (a `default` policy, or trusting every caller, would turn off the page's protection: Tampermonkey shares its DOM). End with `// ponytail: the common sinks only (no document.write, srcdoc, setAttribute or Range); add one if an extension needs it.`
    - **`frameScript`:** `frame?.match(/^\s*at (?:.*\()?(.+?):\d+:\d+\)?$/)?.[1]`.
    - **`trustExtensionStrings`:**
      1. Gather the facts:
         - `factory = globalThis.trustedTypes`;
         - `own = frameScript(new Error().stack?.split("\n")[1])`, the userscript's script as its frames name it;
         - return early when there's no factory, `own` is missing or `"<anonymous>"` (which could be the page's eval'd code), or Trusted Types aren't enforced here. The test: assigning `"<b></b>"` to a new `div`'s `innerHTML` doesn't throw.
      2. Create the policy:
         - `factory.createPolicy("ext2userscript", { createHTML: (text) => text, createScriptURL: (url) => url })`;
         - a throw returns quietly, with the comment `// a CSP that names its allowed policies (trusted-types <names>) refuses this one`.
      3. Decide trust per call:
         - `fromExtension = () => frameScript(new Error().stack?.split("\n")[3]) === own`, called straight from each wrapped sink;
         - the comment: frame 1 is this function, 2 the sink and 3 the code that called the sink.
      4. Wrap the sinks:
         - the setters `Element.prototype.innerHTML`, `Element.prototype.outerHTML`, `ShadowRoot.prototype.innerHTML` (with `policy.createHTML`), and `HTMLScriptElement.prototype.src` (with `policy.createScriptURL`), each by redefining the accessor with its original getter;
         - the methods `Element.prototype.insertAdjacentHTML` and `DOMParser.prototype.parseFromString`;
         - each converts only `typeof value === "string" && fromExtension()`, and passes anything else on unchanged.
  - **`src/runtime/content.ts`:** when any group has isolated-world code (where `interceptAssetScripts` is called today), call `trustExtensionStrings()` first.

- [ ] **Step 4: Run them.**
  - Command: `npm run test:file -- test/unit/runtime-core.test.ts test/browser/content-runtime.test.ts`, then `npm run typecheck`.
  - Expected: PASS; `tsc` clean.
  - **Check:** remove the `try` around `createPolicy`. The named-policies test should then fail; restore it.
  - **Release tier, local only:** `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/content-runtime.test.ts --test-name-pattern "Trusted Types"`. Expected: PASS on both.

- [ ] **Step 5: Commit.**

```bash
git add src/runtime/trusted.ts src/runtime/content.ts test/support/extension.ts test/unit/runtime-core.test.ts test/browser/content-runtime.test.ts
git commit -m "Pass the extension's own strings through a policy of the runtime's under Trusted Types, leaving the page's protected" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: ES modules: top-level await, and import() in content scripts

**Files:**
- Modify: `src/convert/esbuild.ts`, `src/convert/scan.ts`, `src/convert/bundle.ts`, `src/convert/index.ts`
- Test: `test/unit/esbuild.test.ts`, `test/unit/scan.test.ts`, `test/unit/emit.test.ts`

**Interfaces:**
- Produces, in **`src/convert/esbuild.ts`**:
  - `ModuleOptions.format` is `"esm" | "iife" | "function"`;
  - `asyncFunction(esm: string): string`.
- Produces, in **`src/convert/scan.ts`**: `ScanResult.imports: Array<{ start: number; end: number; path?: string }>`.
- Produces, in **`src/convert/bundle.ts`**: `bundleContent(model, files, esbuild?: EsbuildApi): Promise<{ code: ContentCode[]; warnings: string[] }>`, now async.

- [ ] **Step 1: Write the failing tests.**
  - **`test/unit/esbuild.test.ts`**, in `describe("bundleModule")`:

```ts
  it("bundles an IIFE whose entry has a top-level await as an async function called at once", async () => {
    const esbuild = await loadEsbuild();
    const { code } = await bundleModule(esbuild, files({ "page.js": "import { two } from './two.js';\nglobalThis.__got = await Promise.resolve(two);", "two.js": "export const two = 2;" }), "page.js", { format: "iife" });
    await new Function("__x2uImportMeta", code)({ url: "u" });
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal((globalThis as { __got?: number }).__got, 2);
  });

  it("bundles a module as an async function of import.meta that resolves to its exports", async () => {
    const esbuild = await loadEsbuild();
    const { code } = await bundleModule(esbuild, files({ "m.js": "export const url = import.meta.url;\nexport default await Promise.resolve(7);\nexport { url as also };" }), "m.js", { format: "function", define: { "import.meta": "__x2uImportMeta" } });
    const namespace = await (0, eval)(`(${code})`)({ url: "chrome-extension://id/m.js" });
    assert.deepEqual({ ...namespace }, { url: "chrome-extension://id/m.js", default: 7, also: "chrome-extension://id/m.js" });
  });

  it("finds a module's exports when license comments follow them, as esbuild writes them at the end", async () => {
    const esbuild = await loadEsbuild();
    const { code } = await bundleModule(esbuild, files({ "m.js": "/*! Licensed under MIT */\nexport const answer = 42;" }), "m.js", { format: "function" });
    assert.match(code, /\/\*! Licensed under MIT \*\//);
    assert.deepEqual({ ...(await (0, eval)(`(${code})`)({ url: "u" })) }, { answer: 42 });
  });
```

  - **`test/unit/scan.test.ts`**:

```ts
  it("finds import() calls, with the file when the argument is runtime.getURL of a literal", () => {
    const code = 'void import(chrome.runtime.getURL("assets/a.js")); import(/* @vite-ignore */ browser.runtime.getURL("b.js")); import(x); import(chrome.runtime.getURL("c.js") + "?v=1");';
    const { imports } = scan(code);
    assert.deepEqual(imports.map((call) => call.path), ["assets/a.js", "b.js", undefined, undefined]);
    assert.equal(code.slice(imports[0].start, imports[0].end), 'import(chrome.runtime.getURL("assets/a.js"))');
  });
```

  - **`test/unit/emit.test.ts`**:
    - import `loadEsbuild` from `../../src/convert/esbuild-node.ts`;
    - make the two existing `bundleContent` tests `async`, with `await extension(…)`;
    - add these three:

```ts
  it("bundles an isolated content script's import(runtime.getURL(...)), once per module, with import.meta.url and exports", async () => {
    const all = files({
      "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1", content_scripts: [{ matches: ["<all_urls>"], js: ["loader.js", "again.js"] }] }),
      "loader.js": 'globalThis.__first = import(chrome.runtime.getURL("assets/main.js"));',
      "again.js": 'globalThis.__second = import(chrome.runtime.getURL("/assets/main.js"));',
      "assets/main.js": "import { two } from './two.js';\nglobalThis.__runs = (globalThis.__runs ?? 0) + 1;\nexport const url = import.meta.url;\nexport default await Promise.resolve(two);",
      "assets/two.js": "export const two = 2;",
    });
    const { code } = await bundleContent(readManifest(all).model, all, await loadEsbuild());
    const group = code[0] as { code: string };
    assert.doesNotMatch(group.code, /\bimport\(/);
    const scope = globalThis as { __first?: Promise<unknown>; __second?: Promise<unknown>; __runs?: number };
    new Function("chrome", group.code)({ runtime: { id: "abc" } });
    assert.deepEqual({ ...((await scope.__first) as object) }, { url: "chrome-extension://abc/assets/main.js", default: 2 });
    assert.equal(await scope.__second, await scope.__first);
    assert.equal(scope.__runs, 1);
  });

  it("leaves an import() of a module with remote imports alone, saying why", async () => {
    const all = files({
      "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1", content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] }),
      "a.js": 'import(chrome.runtime.getURL("m.js"));',
      "m.js": 'import "https://cdn.example.com/lib.js";',
    });
    const { code, warnings } = await bundleContent(readManifest(all).model, all, await loadEsbuild());
    assert.equal((code[0] as { code: string }).code, 'import(chrome.runtime.getURL("m.js"));');
    assert.deepEqual(warnings, ["content_scripts[0] imports m.js, which imports https://cdn.example.com/lib.js: remote modules can't be bundled, so it wasn't"]);
  });

  it("leaves an import() alone when it isn't a file of the extension, and warns about a missing one", async () => {
    const all = files({
      "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1", content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] }),
      "a.js": 'import(url); import(chrome.runtime.getURL("gone.js"));',
    });
    const { code, warnings } = await bundleContent(readManifest(all).model, all, await loadEsbuild());
    assert.equal((code[0] as { code: string }).code, 'import(url); import(chrome.runtime.getURL("gone.js"));');
    assert.deepEqual(warnings, ["content_scripts[0] imports gone.js, which isn't in the extension"]);
  });
```

- [ ] **Step 2: Run them.**
  - Command: `npm run test:file -- test/unit/esbuild.test.ts test/unit/scan.test.ts test/unit/emit.test.ts`.
  - Expected: FAIL, the new tests only:
    - top-level await: `Top-level await is not available…`;
    - `imports` undefined;
    - the content imports: `bundleContent` neither async nor bundling.

- [ ] **Step 3: Implement.**
  - **`asyncFunction(esm)`** returns `async (__x2uImportMeta) => {\n"use strict";\n<code>\nreturn { <members> };\n}`.
    - **The export statement** is the last `\nexport { … };` that only comments and whitespace follow: `/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*$/` on the rest. Find it with `matchAll`, `filter` and `pop`; `findLast` isn't in `lib`. It's cut out of the code, and whatever follows it stays.
    - **Its members** `a`, `b as c` become `"a": a, "c": b`.
    - Doc comment: `ponytail: the namespace is a snapshot, not live bindings.`
  - **`bundleModule`:**
    - `"iife"` (and `"esm"`) build as now with target `es2020`. When `"iife"` fails because esbuild 0.28 says `Top-level await is not available in the configured target environment` (check `error.errors[].text`), clear `remoteImports` and rebuild as `esm` with target `es2022`.
    - The code is then `(${asyncFunction(text)})(__x2uImportMeta).catch((error) => setTimeout(() => {\n  throw error;\n}));\n`, with a comment saying an IIFE can't hold a top-level await, so the entry runs in an async function whose error is thrown again outside the promise, as a failed module's is uncaught.
    - `"function"` builds `esm` with `es2022` and returns `asyncFunction(text)`.
    - Update `ModuleOptions.format`'s doc comment.
  - **`scan`:** each `import(` (not after a dot) is pushed into `imports` with:
    - `start`: the `import` token's start;
    - `end`: the end of its closing parenthesis, found by counting nested parentheses;
    - `path`: only when the five tokens before that parenthesis are `.`, `getURL`, `(`, a string and `)`, and they start after the `(` of `import(`.

    `dynamicImport` stays as it is.
  - **`bundleContent(model, files, esbuild)`:**
    - **Rewriting:** for an `ISOLATED` group, each file's `imports` with a `path` are rewritten from last to first:
      - the path is `extensionPath(call.path, "")` (from `./assets.ts`), skipped when `undefined`;
      - a file the extension lacks gives `content_scripts[i] imports <call.path>, which isn't in the extension`, and the call stays;
      - otherwise the call becomes `__x2uImport("<path>")`.
    - **Bundling:** each module path is bundled once per group, with `{ format: "function", define: { "import.meta": "__x2uImportMeta" } }`:
      - without `esbuild`, throw `convert: content_scripts[i] imports <path>, which needs the esbuild option`;
      - a bundle with `remoteImports` gives `content_scripts[i] imports <path>, which imports <urls joined with ", ">: remote modules can't be bundled, so it wasn't`, and its calls stay.
    - **The module table:** a group with modules starts with this, then its files as now:

      ```js
      var __x2uImport = (function (modules, loaded) {
        return function (path) {
          return loaded[path] || (loaded[path] = modules[path]({ url: "chrome-extension://" + chrome.runtime.id + "/" + path }));
        };
      })({
      "<path>": <function>,
      …
      }, {});
      ```
    - **Comments:** update the header comment, and its doc comment.
  - **`src/convert/index.ts`:** `await bundleContent(model, files, options.esbuild)`.

- [ ] **Step 4: Run them.**
  - Command: `npm run test:file -- test/unit/esbuild.test.ts test/unit/scan.test.ts test/unit/emit.test.ts`, then `npm test -- --test-concurrency=2` and `npm run typecheck`.
  - Expected: PASS; suite green; `tsc` clean.
  - Then `npm run bench -- --case refined-github,ublacklist`. Expected: `refined-github (emulator): reference pass, ext2userscript fail, …`: its background still fails until Task 4. Also `ublacklist (emulator): reference pass, ext2userscript pass, …`: its content import of `scripts/block-dialog.js` ends in license comments.

- [ ] **Step 5: Commit.**

```bash
git add src/convert/esbuild.ts src/convert/scan.ts src/convert/bundle.ts src/convert/index.ts test/unit/esbuild.test.ts test/unit/scan.test.ts test/unit/emit.test.ts
git commit -m "Bundle content scripts' import(runtime.getURL(...)) and modules with a top-level await" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Running extension code as Chrome does: its `this`, and the background's location and chrome object

**Files:**
- Modify: `src/runtime/background.ts`, `src/runtime/config.ts`, `src/convert/emit.ts`, `src/runtime/content.ts`, `src/runtime/pages.ts`
- Test: `test/unit/runtime-core.test.ts`, `test/unit/emit-background.test.ts`

**Interfaces:**
- Produces, in `src/runtime/background.ts`:
  - `backgroundChrome(known: Record<string, unknown>, log: Logger): Record<string, unknown>`;
  - `backgroundLocation(id: string, background: { worker: boolean; entry: string })`, a location-like object.
- `BackgroundCode` gains a `location` parameter before `__x2uImportMeta`.
- `withGlobals` (content.ts) runs its function with `this` set to the global.

- [ ] **Step 1: Write the failing tests.**
  - **`test/unit/runtime-core.test.ts`:** import `{ backgroundChrome, backgroundLocation }` from `../../src/runtime/background.ts` and `{ withGlobals }` from `../../src/runtime/content.ts`, and add:

```ts
describe("backgroundChrome", () => {
  it("answers a namespace it doesn't implement with one that fails by name, and nothing for other names", async () => {
    const log = recorder();
    const chrome = backgroundChrome({ runtime: { id: "x" } }, log) as Record<string, any>;
    assert.equal(chrome.runtime.id, "x");
    await assert.rejects(chrome.alarms.create("a"), /chrome\.alarms\.create is not available in userscripts/);
    for (const name of ["__esModule", "then", "toJSON", "Symbol", "_private"]) assert.equal(chrome[name], undefined, name);
  });
});

describe("backgroundLocation", () => {
  it("is the service worker's script, the background page, or the generated page, with the extension's origin", () => {
    const worker = backgroundLocation("abc", { worker: true, entry: "js/sw.js" });
    assert.deepEqual([worker.href, worker.origin, worker.protocol, worker.host, worker.pathname, String(worker)], ["chrome-extension://abc/js/sw.js", "chrome-extension://abc", "chrome-extension:", "abc", "/js/sw.js", "chrome-extension://abc/js/sw.js"]);
    assert.equal(new URL("js/sw.js", worker.origin).pathname, worker.pathname);
    assert.equal(backgroundLocation("abc", { worker: false, entry: "bg.html" }).pathname, "/bg.html");
    assert.equal(backgroundLocation("abc", { worker: false, entry: "a.js" }).pathname, "/_generated_background_page.html");
  });
});

describe("withGlobals", () => {
  it("runs the code with this as its global, as Chrome runs a content script's top level", () => {
    assert.equal(withGlobals({}, function (this: unknown) { return this; }), globalThis);
  });
});
```

  - **`test/unit/emit-background.test.ts`:**
    - **First test:** the code becomes `"globalThis.__seen = [typeof window, self.tag, __x2uImportMeta.url, location.pathname];"`, the call passes `{ pathname: "/sw.js" }` before `{ url: "u" }`, and the expectation becomes `["undefined", "shim", "u", "/sw.js"]`.
    - **Second test:** the call passes `{}` before `meta`.

- [ ] **Step 2: Run them.**
  - Command: `npm run test:file -- test/unit/runtime-core.test.ts test/unit/emit-background.test.ts`.
  - Expected: FAIL, a SyntaxError naming `backgroundChrome`, and the emit test seeing `undefined` for `location.pathname`. With the exports added, `withGlobals` still fails: `this` is `undefined`.

- [ ] **Step 3: Implement.**
  - **`backgroundChrome`:** the proxy now built inline in `startBackground`, moved out.
    - Besides symbols, own members, `then` and `toJSON`, it answers `Reflect.get` for any name that doesn't match `/^[a-z][a-zA-Z\d]*$/`.
    - Its doc comment is the existing comment plus why: a bundler's interop check (`chrome.__esModule`) must find nothing, or it takes `chrome` for an ES module.
    - `startBackground` calls it.
  - **`backgroundLocation`:**
    - the page is `background.entry` for a worker or an `.html` entry, else `_generated_background_page.html`;
    - `url = new URL(\`chrome-extension://${id}/${page}\`)`;
    - it returns `{ href, origin: \`chrome-extension://${id}\`, protocol, host, hostname, port: "", pathname, search: "", hash: "", toString: () => url.href }`;
    - its doc comment covers finding 5 and the `"null"` origin.
  - **`run` in `startBackground`:** `const ownLocation = backgroundLocation(config.id, background)`. It goes to `createBackgroundGlobal` as `location: ownLocation`, so `self.location` answers it, and to the factory call before `meta`.
  - **`BackgroundCode` (config.ts):** a `location: unknown` parameter before `__x2uImportMeta`, documented as "The background's own URL: its service worker's script, its page, or _generated_background_page.html."
  - **`emit.ts`:** the background factory's parameter list gains `location` before `__x2uImportMeta`.
  - **`this` (finding 13):** extension code is called with its global as `this`:
    - `withGlobals` calls `fn.call(global)`, with a comment citing Popper and tippy.js (content groups, and the files `scripting.executeScript` injects, go through it);
    - the background's function is called `.call(global)`, with `// this is the background's global, as at a background script's top level.`;
    - a page's function is called `.call(global)`, its window.

- [ ] **Step 4: Run them.**
  - Command: `npm run test:file -- test/unit/runtime-core.test.ts test/unit/emit-background.test.ts`, then `npm test -- --test-concurrency=2` and `npm run typecheck`.
  - Expected: PASS; suite green; `tsc` clean.
  - Then `npm run bench -- --case refined-github,augmented-steam`. Expected: `refined-github (emulator): … ext2userscript pass` and `augmented-steam (emulator): … ext2userscript fail` (it is 128 MB until Task 6).
  - **Release tier, local only:** `X2U_BACKENDS=tm,vm npm run bench -- --case modern-hacker-news`. Expected: `ext2userscript pass` on both. Hacker News sometimes answers repeated automated visits slowly; a run where the baseline fails too is the site, so run it again.

- [ ] **Step 5: Commit.**

```bash
git add src/runtime/background.ts src/runtime/config.ts src/convert/emit.ts src/runtime/content.ts src/runtime/pages.ts test/unit/runtime-core.test.ts test/unit/emit-background.test.ts
git commit -m "Run extension code with its global as this, and give the background its own location and a chrome object bundlers don't take for an ES module" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Extension files at runtime: paths in URLs, and locale files

**Files:**
- Modify: `src/runtime/assets.ts`, `src/runtime/index.ts`, `src/runtime/config.ts`, `src/convert/manifest.ts`
- Test: `test/unit/runtime-core.test.ts`, `test/unit/manifest.test.ts`

**Interfaces:**
- `Message` gains `name?: string`: the name as `messages.json` writes it, when that isn't lower case.
- `createAssets(table, id, getMessage, log, locales: Record<string, Messages> = {})`.
- `url()` returns `blob:…#<encodeURI(path)>`.
- `pathOf(url)` drops a fragment before looking up.

- [ ] **Step 1: Write the failing tests.**
  - **`test/unit/runtime-core.test.ts`**, in `describe("createAssets")`:

```ts
  it("puts the file's path in the URL's fragment, which loading ignores", async () => {
    const assets = createAssets({ ...table, "js&css/a.css": ["text/css", btoa("a{}")] }, "id", () => "", recorder());
    const url = assets.url("/js&css/a.css");
    assert.match(url, /^blob:[^#]+#js&css\/a\.css$/);
    assert.equal(assets.pathOf(url), "js&css/a.css");
    assert.equal(assets.pathOf(url.replace(/#.*$/, "")), "js&css/a.css");
    assert.equal(await fetch(url).then((response) => response.text()), "a{}");
    // Code that adds a cache-buster after the fragment still loads the file.
    assert.equal(await fetch(`${url}?v=2`).then((response) => response.text()), "a{}");
  });

  it("serves a locale's messages.json from the runtime config, with the names as the file wrote them", async () => {
    const locales = { en: { appname: { name: "appName", message: "My App" }, desc: { message: "Does $1$", placeholders: { one: { content: "$1" } } } } };
    const assets = createAssets(table, "id", () => "", recorder(), locales);
    const expected = { appName: { message: "My App" }, desc: { message: "Does $1$", placeholders: { one: { content: "$1" } } } };
    assert.deepEqual(JSON.parse(assets.text("_locales/en/messages.json") ?? ""), expected);
    assert.deepEqual(JSON.parse(await fetch(assets.url("/_locales/en/messages.json")).then((response) => response.text())), expected);
    assert.equal(assets.file("_locales/de/messages.json"), undefined);
  });
```

  - **`test/unit/manifest.test.ts`**, "resolves __MSG_x__ in the name and description…": the last assertion becomes `assert.deepEqual(model.locales.en, { appname: { name: "AppName", message: "My App" }, desc: { message: "Does things" } });`.

- [ ] **Step 2: Run them.**
  - Command: `npm run test:file -- test/unit/runtime-core.test.ts test/unit/manifest.test.ts`.
  - Expected: FAIL, the three tests above only.

- [ ] **Step 3: Implement.**
  - **`messages()` (manifest.ts):** an entry whose name isn't lower case keeps it, as `name`, first.
  - **`createAssets`:**
    - **`lookup(path): { type: string; bytes: Uint8Array<ArrayBuffer> } | undefined`:** the table entry, decoded; otherwise, for `_locales/<locale>/messages.json` with that locale in `locales`, the JSON of `Object.fromEntries(entries.map(([key, { name, ...message }]) => [name ?? key, message]))` as `application/json`. Its doc comment cites finding 8.
    - **`url`:** makes the blob from `lookup`, missing path as now. It caches `${blobUrl}#${encodeURI(path)}`, and `paths` maps the bare blob URL. The comment explains the fragment (finding 7).
    - **`pathOf`:** looks up `url.replace(/#.*$/, "")`.
    - **`text` and `file`:** use `lookup`.
  - **`src/runtime/index.ts`:** pass `config.locales`.

- [ ] **Step 4: Run them.**
  - Command: `npm run test:file -- test/unit/runtime-core.test.ts test/unit/manifest.test.ts`, then `npm test -- --test-concurrency=2` and `npm run typecheck`.
  - Expected: PASS; suite green; `tsc` clean.
  - Then `npm run bench -- --case improve-youtube`. Expected: `improve-youtube (emulator): reference pass, ext2userscript pass, …`.

- [ ] **Step 5: Commit.**

```bash
git add src/runtime/assets.ts src/runtime/index.ts src/runtime/config.ts src/convert/manifest.ts test/unit/runtime-core.test.ts test/unit/manifest.test.ts
git commit -m "Put each file's path in its URL, and serve locale files from the runtime config" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Extension files at conversion: data files, and no source maps

**Files:**
- Modify: `src/convert/scan.ts`, `src/convert/index.ts`, `src/convert/assets.ts`
- Test: `test/unit/scan.test.ts`, `test/unit/convert.test.ts`, `test/unit/assets.test.ts`

**Interfaces:**
- Produces: `ScanResult.paths: string[]`.

- [ ] **Step 1: Write the failing tests.**
  - **`test/unit/scan.test.ts`**:

```ts
  it("finds string literals shaped like a relative file's path", () => {
    const { paths } = scan('x.open("GET", "../config/a.config"); load("data/b.json"); "icon.png"; "plain words"; "https://a.test/c.json"');
    assert.deepEqual(paths, ["../config/a.config", "data/b.json", "icon.png"]);
  });
```

  - **`test/unit/convert.test.ts`** (the import from `../support/extension.ts` gains `files`):

```ts
  it("puts the data files a background names by a relative path in the asset table, but not code", async () => {
    const all = files({
      "manifest.json": JSON.stringify({ manifest_version: 3, name: "D", version: "1", background: { service_worker: "bg/index.js" } }),
      "bg/index.js": 'const CONFIG = { local: "../config/sites.config", lib: "../lib/x.js" }; xhr.open("GET", CONFIG.local);',
      "config/sites.config": "a.test",
      "lib/x.js": "var x;",
    });
    const { userscript } = await convert(all, { runtime });
    const config = JSON.parse(/__x2uRuntime\.start\((\{.*?\}), \[\n/s.exec(userscript)?.[1] ?? "{}");
    assert.deepEqual(Object.keys(config.assets), ["config/sites.config"]);
  });
```

  - **`test/unit/assets.test.ts`**, in `describe("collectAssets")`:

```ts
  it("leaves source maps out of web_accessible_resources globs, saying so, but keeps one the code names", () => {
    const { model, files: all } = extension({ web_accessible_resources: [{ resources: ["js/*", "*.map"], matches: ["<all_urls>"] }] }, {
      "js/a.js": "a", "js/a.js.map": "{}", "b.js.map": "{}", "c.js.map": "{}",
    });
    const { table, warnings } = collectAssets(model, all, ["c.js.map"]);
    assert.deepEqual(Object.keys(table), ["c.js.map", "js/a.js"]);
    assert.deepEqual(warnings, ["2 source maps (*.map) in web_accessible_resources left out: only developer tools read them"]);
  });
```

- [ ] **Step 2: Run them.**
  - Command: `npm run test:file -- test/unit/scan.test.ts test/unit/convert.test.ts test/unit/assets.test.ts`.
  - Expected: FAIL, the three new tests only.

- [ ] **Step 3: Implement.**
  - **`scan`:** a string token matching `/^(?:\.\.?\/)*\/?[\w@~-][\w@~.-]*(?:\/[\w@~.-]+)*\.[a-z\d]{1,10}$/i` is pushed into `paths`, next to the `files` rule.
  - **`prepare` (index.ts):** `getUrls` gains, through the existing `backgroundFiles` helper:
    - the background's `paths`, against its entry;
    - each page's `paths`, against its page.

    Each is filtered by `const CODE = /\.(?:js|mjs|cjs)$/i` (code is bundled, not served), with a comment.
  - **`collectAssets`, the `web_accessible_resources` loop:**
    - a path already wanted, or ignored, is skipped;
    - one ending in `.map` goes into a `Set` instead of the table;
    - after the loop, when the set isn't empty: `` `${n} source map${n === 1 ? "" : "s"} (*.map) in web_accessible_resources left out: only developer tools read them` ``;
    - a comment cites Augmented Steam's 100 MB.

- [ ] **Step 4: Run them.**
  - Command: `npm run test:file -- test/unit/scan.test.ts test/unit/convert.test.ts test/unit/assets.test.ts`, then `npm test -- --test-concurrency=2` and `npm run typecheck`.
  - Expected: PASS; suite green; `tsc` clean.
  - Then `npm run bench -- --case augmented-steam`. Expected: `augmented-steam (emulator): reference pass, ext2userscript pass, …`.

- [ ] **Step 5: Commit.**

```bash
git add src/convert/scan.ts src/convert/index.ts src/convert/assets.ts test/unit/scan.test.ts test/unit/convert.test.ts test/unit/assets.test.ts
git commit -m "Bundle the data files a background names by path, and leave web-accessible source maps out" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The header: GM_openInTab, @connect for named hosts, and the release gate

**Files:**
- Modify: `src/convert/support.ts`, `src/convert/scan.ts`, `src/convert/metadata.ts`, `src/convert/index.ts`
- Test: `test/unit/convert.test.ts`, `test/unit/scan.test.ts`, `test/unit/metadata.test.ts`

**Interfaces:**
- Produces:
  - `ScanResult.hosts: string[]`;
  - `connectHosts(patterns: readonly string[], named: readonly string[] = []): string[]`;
  - `renderMetadata(model, files, ns, grants, namedHosts: readonly string[] = [])`.

- [ ] **Step 1: Write the failing tests.**
  - **`test/unit/convert.test.ts`**:

```ts
  it("grants GM_openInTab when the extension opens tabs or windows", async () => {
    const header = async (code: string) => {
      const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "T", version: "1", background: { service_worker: "bg.js" } }), "bg.js": code });
      const { userscript } = await convert(all, { runtime });
      return userscript.slice(0, userscript.indexOf("// ==/UserScript=="));
    };
    assert.match(await header('chrome.tabs.create({ url: "https://a.test/" });'), /\/\/ @grant {8}GM_openInTab\n/);
    assert.match(await header('chrome.windows.create({ url: "https://a.test/" });'), /\/\/ @grant {8}GM_openInTab\n/);
    assert.doesNotMatch(await header("chrome.tabs.query({});"), /GM_openInTab/);
  });
```

  - **`test/unit/scan.test.ts`**:

```ts
  it("finds the hosts of http(s) URLs in strings and template heads, once each", () => {
    const { hosts } = scan('fetch("https://API.example.com/v1"); const u = `https://cdn.example.org/x/${path}`; "http://example.com"; "https://example.com/again"; "not https://inside.test"; "https://localhost/"');
    assert.deepEqual(hosts, ["api.example.com", "cdn.example.org", "example.com"]);
  });
```

  - **`test/unit/metadata.test.ts`:**
    - in "adds @connect for each host permission's host…", the `<all_urls>` line expects `["a.test", "*"]`;
    - add:

```ts
  it("adds @connect for each host the code names that a host permission covers, before *", () => {
    const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "N", version: "1", host_permissions: ["https://a.test/*"], optional_host_permissions: ["*://*/*"] }) });
    const text = renderMetadata(readManifest(all).model, all, "n", [], ["b.example", "a.test"]);
    assert.deepEqual(values(text, "connect"), ["a.test", "b.example", "*"]);
    const narrow = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "N", version: "1", host_permissions: ["https://*.a.test/*"] }) });
    assert.deepEqual(values(renderMetadata(readManifest(narrow).model, narrow, "n", [], ["api.a.test", "b.example"]), "connect"), ["a.test", "api.a.test"]);
  });
```

- [ ] **Step 2: Run them.**
  - Command: `npm run test:file -- test/unit/convert.test.ts test/unit/scan.test.ts test/unit/metadata.test.ts`.
  - Expected: FAIL, the new and changed tests only.

- [ ] **Step 3: Implement.**
  - **`support.ts`:**
    - `"tabs.create"` gains `methods: ["openInTab"]`;
    - `"windows.create"` leaves the shared `windows` rows for an entry of its own, `{ status: "partial", reason: "one window holding every tab", methods: ["openInTab"] }`, with the comment `// It opens each URL with tabs.create.`
  - **`scan`:**
    - **The tokenizer:** for a template with substitutions, push a `template` token holding its head text before the `${` (`if (first) …`), with the comment `// The head of a template with substitutions, for the URLs it starts with.`
    - **The loop:** a `string` or `template` token matching `/^https?:\/\/([a-z\d.-]+\.[a-z]{2,})(?:[:/?#]|$)/i` adds its lower-cased host to `hosts`, once.
  - **`connectHosts(patterns, named)`:**
    - a `*` pattern sets a flag instead of replacing everything;
    - explicit hosts are kept;
    - each `named` host that `urlMatches(\`https://${host}/\`, patterns)` or `urlMatches(\`http://${host}/\`, patterns)` (from `../runtime/match.ts`) is added;
    - it returns the hosts, plus `"*"` last when flagged;
    - update its doc comment: Tampermonkey asks the user before reaching a host `@connect` doesn't name, even under `*`.
  - **`renderMetadata`:** passes `namedHosts` through.
  - **`prepare`:** collects `namedHosts` from the content, background and page scans, deduplicated, with the comment `// Hosts the code names, for @connect (metadata.ts connectHosts).`

- [ ] **Step 4: Run them.**
  - Command: `npm run test:file -- test/unit/convert.test.ts test/unit/scan.test.ts test/unit/metadata.test.ts`, then `npm test -- --test-concurrency=2`, `npm run test:browser` and `npm run typecheck`.
  - Expected: PASS; the unit suite at 418 (399 before, plus 19); the browser suite green apart from the Firefox S3 test, which runs in CI only (Firefox doesn't launch on macOS 27); `tsc` clean.

- [ ] **Step 5: Run the release gate (local only; needs `npm run bench:setup` once).**
  - Command: `X2U_BACKENDS=emulator,tm,vm npm run bench -- --gate`. It takes about two and a half hours.
  - Expected: exit 0, and each `bench/.cache/scorecard-<backend>.md` ends with `**All met.**`, matching the prototype's table above.
  - A live site can block or change on the day. A case whose Original fails is inconclusive and fails the gate; re-run it with `--case <id>`, and record a ruling if the site itself has changed.

- [ ] **Step 6: Commit.**

```bash
git add src/convert/support.ts src/convert/scan.ts src/convert/metadata.ts src/convert/index.ts test/unit/convert.test.ts test/unit/scan.test.ts test/unit/metadata.test.ts
git commit -m "Grant GM_openInTab for tabs and windows, and @connect the hosts the extension's code names" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
