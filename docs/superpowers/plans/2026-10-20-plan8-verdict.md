# ext2userscript Plan 8: A Verdict That Reflects the Core

**Goal:** The report's verdict says "unlikely" only when the extension's core can't work. Today it says so for 12 of the 20 corpus extensions that pass the benchmark, so the CLI exits 2 on most real extensions and the verdict tells users nothing.

**Why it's wrong today:** `verdictOf` calls any unsupported entry in the background or a content script fatal. Every passing extension that gets "unlikely" is tripped by a side feature in its background: `webNavigation` for SPA re-injection, `registerContentScripts` for optional hosts, `identity` for a sign-in, `offscreen`, a welcome page. The 3 true negatives are tripped by something else: a manifest surface a userscript can't provide (`chrome_url_overrides`, `devtools_page`, `declarative_net_request`).

**The new rule** (`src/convert/report.ts`):
- **unlikely** if an unsupported entry is a manifest feature (`manifest.*`), or sits in the extension's **core**. The core is its content scripts, or its background when it has no content scripts.
- **partial** if anything else isn't fully supported.
- **likely-works** otherwise.

Two content-script entries trip the new rule:
- `storage.<area>.getKeys` (Refined GitHub) gets its one-line implementation.
- `dom.openOrClosedShadowRoot` (Dark Reader, used only for Chrome's PDF viewer) stays a fake that rejects, so Dark Reader stays "unlikely".
  - Returning `element.shadowRoot` (the first version of Task 1) broke Dark Reader on Tampermonkey, measured by the gate: 3 of 3 failures on the branch, a pass on main.
  - Root cause: the fake's TypeError used to abort Dark Reader's message handler before its "is this site already dark?" check. With a real answer the check runs.
  - The check disables Dark Reader's own sheets, found through `document.styleSheets`, then samples colours. Dark Reader's MAIN-world `proxy.js` patches `Document.prototype.styleSheets` to hide those sheets from the site, and Tampermonkey shares DOM prototypes with the page. So the userscript sees no Dark Reader sheets, reads Dark Reader's own colours as the site's, and removes the theme from every page.
  - Violentmonkey isolates properly. Fixing the leak is a follow-up, with no clear design yet.

One regression guard: MV2's `webRequestBlocking` permission becomes the unsupported entry `manifest.permissions.webRequestBlocking`. Without it, uBlock Origin on Firefox would move from "unlikely" to "partial", because it has content scripts.

**Prototype:** built and run on 2026-10-20 against `main` at e342172. The diffs below are the prototype's, verbatim.

| Check | Result |
|---|---|
| Unit tests | 426 of 426 (422 + 4 new). Each new or changed test fails without its fix, except the manifest-verdict and getBytesInUse ones, which pass on the old rule and guard the new one. `tsc` clean |
| `inspect` on all 23 cached corpus archives | 19 of 20 browser cases: partial or likely-works; Dark Reader: unlikely (above). The 3 negatives: unlikely, naming the same subjects as before |
| Browser bench | Not run in the prototype; Task 4 |

Corpus verdicts, before → after:

| Extension | Before | After |
|---|---|---|
| Augmented Steam, BetterTTV, Enhanced GitHub, Improve YouTube!, Octotree, Reddit Enhancement Suite, Refined GitHub, Return YouTube Dislike, SponsorBlock, uBlacklist, Web Search Navigator | unlikely | partial |
| Dark Reader | unlikely | unlikely (`chrome.dom.openOrClosedShadowRoot` in its content script) |
| Iridium, Material Icons for GitHub, Modern for HN, Modern for Wikipedia, Modrinth Extras, Unhook | partial | partial |
| JSON Formatter, LeetCode Enhancer | likely-works | likely-works |
| Momentum, React Developer Tools, uBlock Origin Lite (negatives) | unlikely | unlikely |

**Known limit:** an extension whose real work is in the background but which also has content scripts now reads "partial" when its background API is unsupported. Example: a header modifier using DNR dynamic rules with a content-script helper. Static analysis can't tell a core background call from a side one (uBlacklist calls the same DNR API as a side feature and passes). The entries table still lists every unsupported call.

**Skipped:**
- A reason line under the verdict ("unlikely: manifest.devtools_page"). Add it if users ask why.
- A bench criterion that no case ext2userscript passes is reported unlikely (deferred by the user, 2026-10-20). Until it lands, nothing re-checks the corpus verdicts automatically; Task 4 checks them once by hand.
- Shielding extension code from the page world's prototype patches on Tampermonkey, which would let `dom.openOrClosedShadowRoot` return open roots and Dark Reader read "partial". Its own follow-up.

---

## Task 1: Implement `storage.getKeys`

**Files:** `src/runtime/storage.ts`, `src/convert/support.ts`, `test/unit/storage.test.ts`, `test/unit/analyze-background.test.ts`

```diff
--- a/src/runtime/storage.ts
+++ b/src/runtime/storage.ts
@@ -117,4 +117,5 @@
         if (created) await gm.setValue(k.storageDoorbell, `${Date.now()}:${Math.random()}`);
       }),
+      getKeys: method(log, async () => Object.keys(await all())),
       remove: method(log, async (names: string | string[]) => {
@@ -126,5 +127,5 @@
       setAccessLevel: method(log, async () => {}),
-    }, ["getBytesInUse", "getKeys"]);
+    }, ["getBytesInUse"]);
```

```diff
--- a/src/convert/support.ts
+++ b/src/convert/support.ts
-export const STORAGE_AREA_MEMBERS: ReadonlySet<string> = new Set(["get", "set", "remove", "clear", "onChanged", "setAccessLevel"]);
+export const STORAGE_AREA_MEMBERS: ReadonlySet<string> = new Set(["get", "getKeys", "set", "remove", "clear", "onChanged", "setAccessLevel"]);
```

Tests:
- `test/unit/storage.test.ts`: add `getKeys(): Promise<string[]>;` to the local `StorageArea` type, and after "gets everything, one key, …":
  ```ts
  it("lists its own area's keys", async () => {
    const storage = tab(createHub());
    await storage.local.set({ a: 1, "x:y": 3 });
    await storage.sync.set({ s: 1 });
    assert.deepEqual((await storage.local.getKeys()).sort(), ["a", "x:y"]);
    assert.deepEqual(await storage.session.getKeys(), []);
  });
  ```
- `test/unit/analyze-background.test.ts`: in "reports background APIs: …", swap `chrome.storage.local.getKeys()` for `chrome.storage.local.getBytesInUse()` in `sw.js` and in the expected row (it is still the unimplemented member).

Also add, above the `dom` fake in `src/runtime/index.ts`, why it stays a fake:
```ts
    // Not element.shadowRoot: Dark Reader would then go on to its dark-theme check, which Tampermonkey breaks (the page's
    // patched Document.prototype.styleSheets is the userscript's too), and drop its theme from every page.
```

As executed: Task 1 first also implemented `dom.openOrClosedShadowRoot` (db6a47c). The gate caught the Tampermonkey break, and a later commit took it out again.

Run `npm run test:file -- test/unit/storage.test.ts test/unit/analyze-background.test.ts`. Commit: "Implement storage getKeys".

## Task 2: Judge the verdict by the extension's core

**Files:** `src/convert/report.ts`, `src/convert/index.ts`, `src/convert/analyze.ts`, `src/convert/support.ts`, `test/unit/analyze.test.ts`, `test/unit/analyze-background.test.ts`, `test/unit/convert.test.ts`

```diff
--- a/src/convert/report.ts
+++ b/src/convert/report.ts
-/** The contexts an extension can't do without: if one of them hits something unsupported, it's unlikely to work. */
-const RELIED_ON: ReadonlySet<Context> = new Set(["background", "content"]);
 const STATUS_ORDER: readonly Status[] = ["unsupported", "partial", "supported"];
 
-export function verdictOf(entries: readonly ReportEntry[]): Verdict {
-  if (entries.some((entry) => entry.status === "unsupported" && entry.contexts.some((context) => RELIED_ON.has(context)))) return "unlikely";
+/**
+ * Unlikely when the extension's core can't work: a manifest feature a userscript can't provide, or something unsupported
+ * where the extension does its work, core (its content scripts or, without them, its background). Unsupported calls
+ * elsewhere are usually side features (an update check, a welcome page, a sign-in), so they make it partial.
+ */
+export function verdictOf(entries: readonly ReportEntry[], core: Context): Verdict {
+  if (entries.some((entry) => entry.status === "unsupported" && (entry.subject.startsWith("manifest.") || entry.contexts.includes(core)))) return "unlikely";
   return entries.some((entry) => entry.status !== "supported") ? "partial" : "likely-works";
 }
```

```diff
--- a/src/convert/index.ts
+++ b/src/convert/index.ts
-    verdict: verdictOf(entries),
+    verdict: verdictOf(entries, model.contentScripts.length > 0 ? "content" : "background"),
```

```diff
--- a/src/convert/analyze.ts
+++ b/src/convert/analyze.ts
   if (model.options) use(`manifest.${model.options.key}`, opened, "options");
+  // MV2's blocking webRequest: an extension that asks for it is built to block or change requests (uBlock Origin).
+  if (model.permissions.includes("webRequestBlocking")) {
+    add("manifest.permissions.webRequestBlocking", "unsupported", "a userscript can't block or change network requests", "background");
+  }
   for (const [key, { reason, context }] of Object.entries(UNSUPPORTED_MANIFEST_KEYS)) {
```

```diff
--- a/src/convert/support.ts
+++ b/src/convert/support.ts
-/** Manifest keys for browser features a userscript can't provide. The extension relies on them like on its background. */
+/** Manifest keys for browser features a userscript can't provide. An extension that declares one is built around it. */
```

Tests:
- `test/unit/analyze.test.ts`, the `verdictOf` block becomes:
  ```ts
  const entry = (status: ReportEntry["status"], context: ReportEntry["contexts"][number], subject = "chrome.x.y"): ReportEntry => ({ subject, status, contexts: [context] });

  it("is unlikely when something unsupported sits in the extension's core", () => {
    assert.equal(verdictOf([entry("unsupported", "content")], "content"), "unlikely");
    assert.equal(verdictOf([entry("unsupported", "background")], "background"), "unlikely");
  });

  it("is unlikely for a manifest feature a userscript can't provide, wherever it sits", () => {
    assert.equal(verdictOf([entry("unsupported", "background", "manifest.chrome_url_overrides")], "content"), "unlikely");
  });

  it("is partial for partial entries, or unsupported ones outside the core", () => {
    assert.equal(verdictOf([entry("partial", "content")], "content"), "partial");
    assert.equal(verdictOf([entry("unsupported", "background")], "content"), "partial");
    assert.equal(verdictOf([entry("unsupported", "popup")], "background"), "partial");
  });

  it("is likely-works otherwise", () => assert.equal(verdictOf([entry("supported", "content")], "content"), "likely-works"));
  ```
- `test/unit/analyze-background.test.ts`, before "reports Chrome's enum constants …":
  ```ts
  it("reports MV2's blocking webRequest as a manifest feature a userscript can't provide", () => {
    const { model } = extension({ manifest_version: 2, permissions: ["webRequest", "webRequestBlocking", "<all_urls>"], background: { scripts: ["bg.js"] } }, {});
    const { entries } = analyze(model, [], { scan: scan(""), bundle: { dynamicImportScripts: false, remoteImports: [] } });
    assert.deepEqual(entries.filter((entry) => entry.status === "unsupported").map((entry) => entry.subject), ["manifest.permissions.webRequestBlocking"]);
  });
  ```
- `test/unit/convert.test.ts`, in `describe("inspect")`:
  ```ts
  it("judges by the content scripts when there are some, and by the background otherwise", async () => {
    const extension = (contentScripts: boolean) => {
      const all = plainExtension();
      const manifest = JSON.parse(new TextDecoder().decode(all.get("manifest.json")));
      if (!contentScripts) delete manifest.content_scripts;
      all.set("manifest.json", new TextEncoder().encode(JSON.stringify({ ...manifest, background: { service_worker: "bg.js" } })));
      all.set("bg.js", new TextEncoder().encode("chrome.bookmarks.getTree();"));
      return all;
    };
    assert.equal((await inspect(extension(true))).verdict, "partial");
    assert.equal((await inspect(extension(false))).verdict, "unlikely");
  });
  ```

`test/unit/cli.test.ts` needs no change: its "exits 2" case is a new-tab override, still unlikely.

Run `npm test -- --test-concurrency=2` and `npm run typecheck`. Commit: "Call an extension unlikely to work only when its core can't: a manifest feature, or its content scripts (its background without them)".

## Task 3: The spec

`docs/superpowers/specs/2026-10-09-ext2userscript-design.md`, §3.5: "How the verdict is derived" becomes:
  - `unlikely` if an unsupported entry is a manifest feature (a surface the extension is built around: `chrome_url_overrides`, `devtools_page`, `declarative_net_request`, MV2's `webRequestBlocking`, …), or sits in the extension's core: its content scripts, or its background when it has none.
  - `partial` if there are partial entries, or unsupported ones outside the core.
  - Otherwise `likely-works`.

README needs nothing: exit code 2 still means "unlikely".

Commit: "Spec: the verdict judges the extension's core".

## Task 4: Verify

1. `npm run typecheck` and `npm test -- --test-concurrency=2`: 426 of 426.
2. `npm run cli -- report <archive>` on every archive in `bench/.cache/archives` (in the plan1-foundation worktree). 19 browser cases exit 0 with "partial" or "likely-works", matching the table above. Dark Reader, Momentum, React Developer Tools and uBlock Origin Lite exit 2 with "unlikely".
3. `X2U_BACKENDS=emulator,tm,vm npm run bench -- --gate`: all met on each backend, as after Plan 7. It needs the bench profile (`npm run bench:setup` was done 2026-10-10) and a quiet machine.
