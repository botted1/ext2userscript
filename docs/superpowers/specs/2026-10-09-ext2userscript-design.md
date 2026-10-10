# ext2userscript — design

Date: 2026-10-09
Status: reviewed 2026-10-09; GM-layer revision applied; spike revisions (§5.1, §5.5, §6) applied 2026-10-10, awaiting review

## 1. Goal

A public, open-source converter that turns a browser extension (Chrome or Firefox, MV2 or MV3) into a single `.user.js` file that runs in **Tampermonkey** and **Violentmonkey**. It is written from scratch.

"Better" is defined by a benchmark, not by a feature list (see §10). v1 ships when it:

- passes every corpus case that the baseline passes on the same run, and
- passes at least 75% of the modern MV3 cases that the baseline fails, and
- produces an accurate compatibility report for every "negative" case (extensions that rely on unsupported APIs).

### Decisions taken during brainstorming

| Topic | Decision |
|---|---|
| Audience | Public open-source tool, general purpose |
| Target managers (v1) | Tampermonkey + Violentmonkey only. Other managers are on the Later list below. |
| Delivery | One conversion core shared by a static web app (conversion runs in the browser, nothing is uploaded) and an npm CLI |
| Approach | Build-time bundling (esbuild) plus a separately tested runtime. No `with` wrapper, no runtime `eval` of extension code. |
| GM access | Every GM call goes through `src/runtime/gm.ts` (§5.1): async-only, three capability flags (`valueListeners`, `menus`, `cookies`), a TM/VM implementation only, no fallback code yet. `@grant` lines are generated from it, and the CI emulator stands in for TM/VM behind it. |
| Benchmark | Two tiers: the emulator behind `gm.ts` in CI, plus real TM/VM before each release |
| Name | `ext2userscript` (npm package, CLI command, repo folder) |
| Language / licence | TypeScript, MIT |

### Out of scope (the report flags these, and the output never pretends to support them)

- Blocking or modifying network requests: `webRequest` and `declarativeNetRequest`. Ad blockers are out.
- `chrome_url_overrides` (new tab and similar), devtools panels, `chrome://` pages.
- `identity`, `offscreen`, `sidePanel`, `tabCapture`, `debugger`, `nativeMessaging`.
- Running background code while no matching tab is open.

### Later

- Other userscript managers (Safari Userscripts, Stay, ScriptCat, Greasemonkey 4, etc.) via another `gm.ts` implementation plus per-manager header rules in `metadata.ts`, selected with `--target`.

## 2. Repository layout

```
ext2userscript/
  package.json          # one npm package; "bin": { "ext2userscript": "dist/cli.js" }
  src/
    convert/            # isomorphic pipeline (Node + browser)
      index.ts          # convert(files, options) → { userscript, report }
      unpack.ts         # zip / xpi / crx2 / crx3 → Map<path, Uint8Array>
      manifest.ts       # normalise MV2/MV3 → Model; locale resolution
      bundle.ts         # context wrappers, classic-script concat; ES modules go through esbuild.ts
      analyze.ts        # chrome.*/browser.* usage scan → report entries
      support.ts        # the API support table (single source of truth)
      assets.ts         # asset table (inlined files)
      metadata.ts       # userscript header
      emit.ts           # final assembly
      esbuild.ts        # ES-module bundling with a virtual-fs plugin; takes the esbuild API as a parameter
      esbuild-node.ts   # loads native esbuild (CLI)
      esbuild-browser.ts # loads esbuild-wasm (web app worker); callers pick one of the two loaders
      paths.ts          # POSIX path helpers that also run in the browser
    runtime/            # chrome.* implemented on gm.ts (built to a string at build time)
      index.ts
      gm.ts             # the only file that calls GM_*: async interface, caps, grant table, TM/VM implementation
      match.ts          # Chrome match patterns → RegExp
      keys.ts           # GM value key names (x2u:<ns>:…)
      registry.ts       # tab registry: heartbeat, roster doorbell, discovery
      bus.ts            # in-tab + cross-tab messaging
      elect.ts          # background leader election from the registry
      tabs.ts storage.ts alarms.ts menus.ts ui.ts net.ts i18n.ts scripting.ts ...
    cli.ts              # download from stores, read dirs/files, call convert, write output
    download.ts         # CWS / AMO / Edge Add-ons fetchers (CLI and proxy)
  web/                  # static Vite site, vanilla TS
  proxy/                # optional Cloudflare Worker for store-link downloads (~20 lines)
  bench/
    corpus.json         # pinned cases
    cases/<id>.ts       # per-extension Playwright assertions
    emulator/           # stands in for TM/VM behind gm.ts (CI tier)
    real/               # release tier: profile setup, launch and userscript install for real TM/VM
    session.ts          # one API over the emulator, tm and vm backends
    run.ts              # runs corpus for ext2userscript and the baseline, prints scorecard
  spikes/               # throwaway spike code and its recorded results
  test/                 # node:test unit tests + Playwright runtime tests
```

Dependencies: `esbuild`, `esbuild-wasm`, `fflate`. Dev: `typescript`, `vite`, `playwright`. The CLI parses arguments with Node's `util.parseArgs` (no yargs). Tests use the built-in `node:test` runner.

## 3. Conversion pipeline

```
input (store URL | file | dir)
  → unpack        → Map<path, bytes>
  → manifest      → Model
  → bundle        → { background?, contentGroups[], popup?, options?, pageScripts[] }
  → analyze       → ReportEntry[]
  → assets        → AssetTable
  → metadata+emit → userscript string
```

`convert(files: Map<string, Uint8Array>, options): Promise<{ userscript: string; report: Report }>` is pure, apart from loading esbuild, and is identical in the CLI and the web app.

### 3.1 Unpack
- zip / xpi: `fflate.unzipSync`.
- crx2: magic `Cr24`, version 2, public-key length and signature length, then zip.
- crx3: magic `Cr24`, version 3, header length, then zip.
- Directory (CLI only): read recursively.
- Errors: unknown magic or a missing `manifest.json` → hard error with a clear message.

### 3.2 Manifest model
Normalise both MV2 and MV3 into one model:

- `background`:
  - `{ kind: "worker", entry, module: boolean }` for MV3 `service_worker`, where `module` reflects `type: "module"`;
  - `{ kind: "scripts", files[] }` for MV2 `scripts`;
  - `{ kind: "page", html }` for MV2 `page`.
- `contentScripts[]`: `matches`, `exclude_matches`, `include_globs`, `exclude_globs`, `js[]`, `css[]`, `run_at`, `all_frames`, `match_about_blank`, `world` (`ISOLATED` | `MAIN`).
- `popup`: from `action.default_popup`, `browser_action.default_popup` or `page_action.default_popup`.
- `options`: from `options_ui.page` or `options_page`.
- `commands`: name → suggested key, description.
- `hostPermissions`: MV3 `host_permissions`, or the host entries from MV2 `permissions`.
- `permissions`, `optionalPermissions`.
- `webAccessibleResources`: flattened for both MV2 and MV3 formats.
- `icons`, `name`, `description` and `version`, with `__MSG_x__` resolved against `_locales/<locale>/messages.json`. The default locale comes from `default_locale`, and can be overridden with `--locale`.
- `browser_specific_settings.gecko.id`: used as a stable namespace when present.

### 3.3 Bundle
Every context is wrapped in one function whose parameters shadow the globals the runtime replaces:

- All contexts: `chrome` and `browser`, both pointing to the same runtime object for that context.
- Background: `self`, `globalThis` and `importScripts`, bound to a background global shim.
- Popup and options: `window`, `document`, `location` and `history`, bound to the UI iframe (§6).
- Background, popup and options: `localStorage`, bound to the extension-wide storage shim (§5.1), so settings don't land in each site's own storage.

Inside that wrapper, code goes in one of two ways.

- **Classic scripts** (`background.scripts`, content script `js[]`, `<script>` without `type="module"`, a classic `service_worker`):
  - They are **concatenated as text in manifest/DOM order**. This matches how a browser runs them: one shared scope, so top-level `var`/function declarations stay visible to later files.
  - esbuild is not used for them, so nothing gets hoisted or renamed.
  - **`importScripts("a.js", "b.js")`** with string-literal arguments is replaced at build time by the files' contents, in order. Any other form adds a report entry: partial, "dynamic importScripts".
  - Ceiling: classic code that reaches bare globals (e.g. `addEventListener(...)` without `window.`) hits the userscript's global rather than the shim. Upgrade path: an AST rewrite of the free identifiers, if the benchmark shows it matters.
- **ES modules** (a `type: "module"` worker, `<script type="module">`): bundled by esbuild.
  - Options: `bundle: true`, `format: "esm"`, `write: false`, `platform: "browser"`, `target: "es2020"`.
  - A **virtual-fs plugin** resolves every path against the unpacked file map.
  - Dynamic `import()` of a local path is bundled. Dynamic `import()` of a remote URL is reported as unsupported.
  - The ESM output has no imports left, so its `export` statements are stripped and it is placed inside the wrapper. The wrapper's parameters shadow the globals here too, so no esbuild `inject` is needed.
- **Output:** one string per context. Nothing is minified unless `--minify` is passed, which runs esbuild's minifier over the final file.

### 3.4 Analyze
- Scan each bundle for member chains rooted at `chrome` or `browser`, such as `chrome.tabs.query`.
- Use a tokenizer-level scan rather than a full AST walk. The ceiling: aliasing like `const c = chrome; c.tabs.query()` is missed. If that proves common, upgrade to an acorn walk.
- Look up each chain in `support.ts`, which maps an API to `supported | partial(reason) | unsupported(reason)` and to the gm methods it needs (§5.1).
- Manifest features also produce entries, for example `chrome_url_overrides` → unsupported and `background.persistent: true` → partial. Supported features such as a popup, an options page or `host_permissions` get entries too, because they decide grants (§5.1).

### 3.5 Report
```ts
type Report = {
  extension: { name: string; version: string; manifestVersion: 2 | 3; id?: string };
  verdict: "likely-works" | "partial" | "unlikely";
  entries: Array<{
    subject: string;              // "chrome.tabs.query" or "manifest.chrome_url_overrides"
    status: "supported" | "partial" | "unsupported";
    reason?: string;
    contexts: Array<"background" | "content" | "popup" | "options" | "page">;
  }>;
  warnings: string[];             // e.g. "CSP on some sites may block inlined fonts"
};
```

How the verdict is derived:
- `unlikely` if any unsupported entry sits in a context the extension relies on: background, or content scripts.
- `partial` if there are partial entries.
- Otherwise `likely-works`.

The CLI prints a table and can write `--report report.json`. The web app renders the same data.

### 3.6 Assets
- **Collected:** every file referenced from `runtime.getURL` string literals, CSS `url()`, and HTML `src`/`href`/`srcset`, plus all of `web_accessible_resources` and `_locales`.
- **Excluded:** files matching `--ignore-assets <glob,...>`.
- **Stored:** as base64 in an asset table, with the MIME type taken from the extension.
- **At runtime:** `runtime.getURL(path)` returns a `blob:` URL. Each URL is created lazily and cached per path.
- **CSS:** `url()` references inside CSS are rewritten at build time to placeholders, which are replaced with blob URLs at injection time.

## 4. Userscript header (metadata)

| Source | Header |
|---|---|
| name, version, description, icons | `@name`, `@version`, `@description`, `@icon` (data URL, smallest icon ≥ 32px) |
| gecko id, or a slug of the name | `@namespace` |
| `content_scripts[].matches` (`<all_urls>` → `*://*/*`) | `@match` |
| `exclude_matches` | `@exclude-match` |
| `include_globs` / `exclude_globs` | `@include` / `@exclude` (glob syntax supported by both managers) |
| no content scripts at all (popup/background-only extension) | `@match *://*/*`, with the UI reachable through the menu only |
| host permissions | `@connect` per host (`*` for `<all_urls>`) |
| earliest `run_at` | `@run-at` |
| no group with `all_frames: true` | `@noframes` |
| isolated world | `@inject-into content` (VM), `@sandbox DOM` (TM). Spike S1 verifies GM_* stays available. |
| gm methods this conversion needs (§5.1) | One `@grant` per `GM_*` function those methods call, read from `gm.ts`'s grant table. `metadata.ts` hardcodes no GM names. |

Per-group matching is done again at runtime, because the header is the union of all groups. This includes excludes and globs, which the baseline ignored.

## 5. Runtime

Built from `src/runtime` into one minified string, which the converter embeds with the bundles. Each context gets its own `chrome` object, created by `createChrome(context)`.

### 5.1 GM layer (`src/runtime/gm.ts`)
Every GM call goes through this one file. No other runtime file names a `GM_*` function.

- **Async-only interface:** `getValue`, `setValue`, `deleteValue`, `listValues`, `addValueChangeListener`, `removeValueChangeListener`, `registerMenuCommand`, `unregisterMenuCommand`, `xmlHttpRequest`, `addElement`, `openInTab`, `notification`, and `cookie` (list, set, delete). Every method returns a Promise.
- **Capability flags:** `caps = { valueListeners, menus, cookies }`, detected at startup from which functions exist. On TM and VM, `valueListeners` and `menus` are true; `cookies` is true wherever the manager provides `GM_cookie` (TM, and VM since 2.35.1).
- **One implementation, for TM and VM:** it wraps the synchronous `GM_*` functions that both managers provide. Each method makes its underlying call before its first `await`, so only the result is async. That keeps two timings intact: the registry cleanup written during `pagehide` (§5.3), and page-world scripts injected at the userscript's own start time (§5.5), which is best-effort at `document_start` (see the revision below).
- **No fallback code yet:**
  - `cookies` false: `chrome.cookies.*` rejects (§9).
  - `menus` false: anything that needs a menu entry rejects the same way.
  - `valueListeners` false (never on TM/VM): the runtime logs one error naming the detected manager (`GM_info.scriptHandler`) and saying v1 supports Tampermonkey and Violentmonkey, then stops.
  - Fallbacks come with support for other managers (§1, Later).
- **Grant table:** `gm.ts` exports, as plain data, the `GM_*` functions each method calls. `metadata.ts` emits `@grant` for:
  - a core set every conversion uses: the value functions, value listeners and `addElement`;
  - plus the methods `support.ts` lists for each API or manifest feature the analyzer found. For example: `chrome.cookies.*` → `cookie`, a popup → the menu methods, `host_permissions` → `xmlHttpRequest`.
  - Ceiling: an API the analyzer misses (aliasing, §3.4) gets no grant, so its gm method rejects with an error naming the API.
- **Synchronous APIs on async gm:** `localStorage` in the background, popup and options is the only synchronous extension API backed by GM.
  - It's a Storage shim over `x2u:<ns>:ls:*` values, loaded into a cache before the context's code starts.
  - Writes update the cache immediately and go to `gm.setValue`. Other tabs' caches follow through value listeners.
  - Content scripts keep the page's real `localStorage`, as in a real extension.
  - Ceiling: code that writes `window.localStorage` explicitly still reaches the site's storage. Upgrade path: a `window` proxy, if the benchmark shows it matters.
- **CI:** the emulator (§10.2) provides exactly the `GM_*` functions in the grant table, so CI runs the real `gm.ts`.

**Revision (S1):** `document_start` is best-effort. Tampermonkey 5.5.1 and Violentmonkey 2.49.0 start a `document-start` userscript 16–46 ms after navigation start, whatever `@sandbox`, `@inject-into` or `@grant` say (measured with default manager settings, unpacked builds, on one machine against local pages). A page script that runs earlier wins. The "call before the first `await`" rule still holds and still matters: it keeps `gm.addElement` synchronous, so a page-world script runs at the userscript's own start time. The release-tier conformance test pins this weaker contract: the injection must beat a page script that runs at least 200 ms after navigation start.

### 5.2 API support table (v1)

| API | Status | Implementation |
|---|---|---|
| `storage.local` / `sync` / `session` | supported | One GM value per key under `x2u:<ns>:s:<area>:<key>`. `session` is cleared when a new leader detects a fresh browser session (§5.4). |
| `storage.onChanged`, `storage.<area>.onChanged` | supported | `gm.addValueChangeListener` on the keys, which works across tabs |
| `runtime.sendMessage` / `onMessage` / `connect` / `onConnect` / `Port` | supported | §5.3 |
| `runtime.getURL`, `getManifest`, `id`, `lastError`, `onInstalled`, `onStartup`, `openOptionsPage`, `getPlatformInfo` | supported | `onInstalled` fires once per installed version (tracked in GM storage) |
| `runtime.onMessageExternal`, `sendNativeMessage` | unsupported | |
| `tabs.query` / `get` / `getCurrent` / `sendMessage` / `create` / `update(url)` / `remove` / `reload` | supported | Tab registry (§5.3). `create` uses `gm.openInTab`. `remove` and `update` work by messaging the target tab, which calls `window.close()` or sets `location`. `close` only works for tabs opened by the script; otherwise the report says partial. |
| `tabs.onUpdated` / `onRemoved` / `onCreated` / `onActivated` | supported | Derived from registry changes. `onActivated` uses `visibilitychange`. |
| `windows.*` | partial | One synthetic window (id 1) |
| `scripting.executeScript` (`func` or `files`) / `insertCSS` / `removeCSS` | supported | Run in the target tab via the bus |
| `tabs.executeScript` / `insertCSS` (MV2) | supported | Same path as above |
| `alarms.*` | supported | Persisted schedule; fired by the background leader |
| `contextMenus` / `menus` | partial | Each item becomes a `gm.registerMenuCommand` entry. `onClicked` receives `{menuItemId, pageUrl}` but no selection or link context. |
| `action` / `browserAction` / `pageAction` `.onClicked`, `openPopup` | supported | Menu command "Open <name>" |
| `action.setBadgeText` / `setIcon` / `setTitle` | partial | Stored; shown in the popup modal title. No toolbar UI exists. |
| `commands.onCommand` + manifest `commands` | supported | `keydown` listener on each tab, mapping suggested keys per platform |
| `notifications.create` / `clear` / `onClicked` | supported | `gm.notification` |
| `i18n.getMessage` / `getUILanguage` / `detectLanguage` | supported / supported / unsupported | |
| `permissions.contains` / `getAll` / `request` / `remove` | partial | Answers come from the manifest. `request` resolves true, and removals persist in GM storage. |
| `cookies.*` | partial | `gm.cookie`, which needs `caps.cookies` (TM, and VM since 2.35.1; VM returns httpOnly cookies only when the user enables that). Where it's missing, the calls reject (§5.1). |
| `extension.getBackgroundPage`, `runtime.getBackgroundPage` | partial | Works only when the current tab is the leader; otherwise rejects |
| `webRequest`, `declarativeNetRequest`, `proxy`, `identity`, `offscreen`, `sidePanel`, `devtools`, `debugger`, `tabCapture`, `downloads` | unsupported | Reject with `Error("ext2userscript: chrome.X is not available in userscripts")`, logged once |

Network: `fetch` and `XMLHttpRequest` in the background and content contexts are shimmed, so that cross-origin requests to `host_permissions` hosts go through `gm.xmlHttpRequest`. Same-origin requests use the native implementation. Responses support `text`, `json`, `blob` and `arrayBuffer`. Streaming bodies are a known ceiling: they are buffered.

### 5.3 Messaging
- **In-tab:** content ↔ popup/options ↔ background (when this tab is the leader) is delivered directly through an in-memory bus with structured clone semantics (`structuredClone`).
- **Cross-tab:** single-writer outbox keys, so concurrent writes never lose messages:
  - Each tab writes only `x2u:<ns>:out:<tabId>`, which holds a per-page `epoch` and a ring buffer of its last 64 messages from the past 10s `{seq, t, to, payload}`. The age limit keeps large messages from being rewritten with every later send.
  - Each tab listens (via `gm.addValueChangeListener`) to the outbox keys of every other live tab, and tracks the last `seq` it has read per sender.
  - On first contact with a sender, a tab delivers only messages sent after it started. A new `epoch` (the sender navigated, keeping its tab id) restarts the sequence instead of being ignored.
  - Managers may coalesce rapid writes. If a reader falls more than 64 messages behind, the gap is counted and logged, not hidden.
- **Discovery:**
  - Each tab writes `x2u:<ns>:tab:<tabId>` with `{url, title, since, ts}` every 2s, and polls `gm.listValues()` for tab keys on the same beat. `since` drives the election (§5.4).
  - A tab that starts, leaves (`pagehide`) or returns from the back/forward cache (`pageshow`) also writes `x2u:<ns>:roster`. Every tab listens to that key and rescans at once. Without this doorbell, a content script's first message to the background could wait up to 2s.
  - A leaving tab deletes its own key, so the others see it go immediately.
  - A tab whose `ts` is older than 90s counts as gone, which fires `tabs.onRemoved`, and its keys are deleted. The limit is long because Chrome throttles timers in tabs hidden for over 5 minutes to one wake-up per minute; a shorter limit would drop live background tabs.
- **Responses:** a response (`sendResponse` or a returned promise) is just another message with `replyTo`. The default timeout is 30s, after which `lastError` is set to "The message port closed before a response was received."
- **Tab id:** a random 31-bit integer per tab, kept across same-origin navigations through `sessionStorage`. The ceiling: a cross-origin navigation in the same tab gets a new id, appearing as remove plus create. Upgrade path: a `gm.getTab` method backed by TM's `GM_getTab`.

### 5.4 Background leader
- **Election:** the leader is the live tab with the earliest `since` (ties go to the lower id). Every tab computes this from the registry (§5.3).
  - `since` is when the tab joined, or when it rejoined after the back/forward cache, so a returning tab doesn't take leadership back.
  - Every input is a key with a single writer, so the tabs' local copies converge on the same answer. A shared lease key could leave tabs disagreeing about who won after simultaneous claims (for example, session restore opening 20 tabs), with no leader until it expired.
  - A tab starts leading only after it has been the oldest live tab for 300ms, so tabs that start together can't both lead before they've seen each other.
  - A leader that finds an older live tab (for example, one that was frozen and came back) steps down: it stops dispatching messages, alarms and events to background listeners. Timers already started by background code keep running; the ceiling here is that background timers are not cancelled.
  - The 90s staleness limit (§5.3) means a long-hidden leader whose timers are throttled to once a minute keeps the lead.
- **Handover:** a leader's `pagehide` deletes its registry key and rings the roster (§5.3), so the next-oldest tab takes over at once. A leader that disappears without `pagehide` (crash, tab discard) is replaced when its heartbeat goes stale.
- **New leader:**
  - It runs the background bundle from the top.
  - It fires `runtime.onStartup` only for the first leader of a browser session. The leader writes `x2u:<ns>:session` with a timestamp on every beat; a new leader that finds it missing or older than 90s treats the browser as restarted. The same check clears `storage.session` (§5.2).
  - It fires `onInstalled` once per version.
- **What survives a handover:** storage only. This matches MV3 service-worker semantics. MV2 extensions with `persistent: true` are reported as partial.

### 5.5 Content scripts
- At startup the tab evaluates each content group's `matches`, `exclude_matches`, `include_globs` and `exclude_globs` against `location.href`.
- Matching groups run in `run_at` order: CSS first (through `gm.addElement('style')`, which the page's CSP doesn't block; not yet tested against a CSP that blocks inline styles), then JS.
- `all_frames: false` groups don't run in iframes. If no group needs frames, the header has `@noframes`.
- `world: "MAIN"` groups, and the common pattern of appending `<script src=runtime.getURL("x.js")>`, run in the page context through `gm.addElement('script', {textContent})`:
  - The runtime patches `Node.prototype.appendChild`, `insertBefore`, `append` and `prepend` in the content context. When one of them inserts a `<script>` whose `src` is one of our asset blob URLs, it swaps in `gm.addElement`.
  - Page-context scripts get no `chrome` object, which matches how real extensions behave.

**Revision (S1):** `world: "MAIN"` and `document_start` groups run when the manager starts the userscript, not guaranteed before the page's first scripts. With GM functions granted, the script is isolated whatever the header, so `gm.addElement` is the only route tested into the page world (`@grant unsafeWindow` was not tested). It runs synchronously and gets past a nonce-only CSP on both managers (measured with default manager settings, unpacked builds, on one machine against local pages). The report marks `run_at: document_start` as **partial** ("best-effort: may run after the page's earliest scripts").

## 6. Popup and options pages
- **Opening:** "Open <name>" and "<name> options" menu commands (plus `action.onClicked`, `runtime.openOptionsPage` and `action.openPopup`) open a modal. The modal lives in a closed shadow root and contains a same-origin `about:blank` iframe.
- **Filling the iframe:**
  - The page's HTML is parsed at build time. The runtime builds the body and head nodes in the iframe document with `createElement`, `setAttribute` and `append` (see the revision below).
  - `<link rel=stylesheet>` and `<style>` become `gm.addElement(iframeDoc.head, 'style', {textContent})`, which gets past CSP rules that block inline styles (not yet tested against such a CSP).
  - Assets are rewritten to blob URLs.
- **Scripts:** the page's scripts are not inserted as `<script>` elements. The bundled UI code runs inside the userscript, with its wrapper parameters bound to the iframe's `window`/`document`, and the page's CSP doesn't apply to it. `DOMContentLoaded` and `load` are dispatched to the iframe's window after insertion.
- **Size:** the popup modal sizes itself to the content (max 800×600). The options page opens as a larger modal.
- **Known ceiling:** sites whose CSP blocks `blob:` or `data:` in `img-src`/`font-src` may still lose images and fonts in the modal. The report adds a warning when the UI uses them. Spike S2 measured this on GitHub, YouTube and X and saw no asset failures, even where `font-src` omits `blob:` (GitHub, X) or `data:` (GitHub). The cause wasn't investigated, so the warning stays.

**Revision (S2):** On a site that sends `require-trusted-types-for 'script'` (YouTube), Tampermonkey 5.5.1 throws on `innerHTML` (on the iframe's body) and on `DOMParser.parseFromString`; Violentmonkey 2.49.0 allows both. The cause wasn't investigated.
- The converter parses popup and options HTML at build time, and the runtime builds the iframe DOM with `createElement`, `setAttribute` and `append`, with no `DOMParser` step. Cost: the parse runs in Node (the CLI) and in the web app's Web Worker (§8), and neither has `DOMParser`, so it needs an HTML-parser dependency (§2 has none yet) or a small hand-written parser with a stated ceiling. The popup plan chooses.
- Extension UI code that assigns HTML strings still throws on such sites under Tampermonkey: measured for `innerHTML` and `DOMParser.parseFromString`; expected, not measured, for `outerHTML`, `insertAdjacentHTML` and `document.write`. The analyzer flags these sinks, and the report warns: "popup may break on sites that enforce Trusted Types, under Tampermonkey".
- Not measured: YouTube's header has no `trusted-types` allow-list, so the runtime may be able to create policies in the iframe's realm: a named one for its own parse step (instead of parsing at build time), or a pass-through `default` one that would also cover extension code.

## 7. CLI

```
ext2userscript convert <source> [-o out.user.js] [--report report.json]
                                [--locale xx] [--minify] [--ignore-assets glob,...] [--force]
ext2userscript download <source> [-o file]
ext2userscript report <source>          # analyse only, no output script
```

- `<source>` can be a Chrome Web Store URL or ID, an AMO URL or slug, an Edge Add-ons URL or ID, a direct `.crx`/`.xpi`/`.zip` URL, a local archive, or a directory.
- **Downloads:**
  - CWS: `clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=<current stable>&x=id%3D<id>%26uc`.
  - AMO: API v5 `current_version.file.url`.
  - Edge: `edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=id%3D<id>%26installsource%3Dondemand%26uc`.
- **Exit codes:** 0 ok; 1 hard error; 2 converted with verdict `unlikely` (lets CI gate on it).

## 8. Web app
- One page:
  - drop zone or file picker for `.crx`/`.zip`/`.xpi`;
  - optional store-link field, enabled only when a proxy URL is configured at build time;
  - conversion progress;
  - the report table, grouped by status;
  - "Download .user.js" and "Copy" buttons.
- `esbuild-wasm` and its `.wasm` file are loaded on the first conversion, not on page load.
- Conversion runs in a Web Worker so the UI stays responsive.
- Deployed to GitHub Pages from CI.
- `proxy/` contains a Cloudflare Worker:
  - It accepts `?src=<store url>` only for the three store hosts above.
  - It adds `Access-Control-Allow-Origin` for the configured site origin, and limits responses to 50 MB.
  - Off by default; documented for anyone who wants to host it.

## 9. Error handling
- **Conversion:** hard errors only for an unreadable archive, a missing or invalid `manifest.json`, or an esbuild failure the plugin can't recover from (the message names the file and line). Everything else becomes a report entry.
- **Runtime:** unsupported calls reject, or call back with `lastError` set, using an error that names the API. Each one is logged once per page. No silent no-ops for APIs that change behaviour. A capability flag that is off (§5.1) makes the APIs that depend on it fail the same way.
- **Runtime boot:** one `try/catch` per content group and per background start, so one failing group doesn't stop the others. Errors are prefixed `[ext2userscript:<name>]`.

## 10. Testing and benchmark

### 10.1 Unit (`node:test`)
Unpack (crx2/crx3 fixtures), manifest normalisation (MV2 and MV3 fixtures, locales), metadata mapping (§4 table), analyze plus the support table, and the asset rewriting.

### 10.2 Runtime (Playwright, Chromium)
- An **emulator** (`bench/emulator`) stands in for TM/VM behind `gm.ts`. It provides exactly the `GM_*` functions in the grant table (a browser test fails if one is missing), so CI runs the real `gm.ts`. Values are shared across all pages in one browser context using the managers' consistency model: each page reads a synchronous local copy, and writes reach other pages asynchronously, firing their value-change listeners with `remote: true`.
- Playwright injects it through `context.addInitScript` before the converted script. The emulator also enforces `@match`/`@exclude-match` and `@run-at`, but it runs `document-start` scripts before the page's first script, which is stricter than TM and VM (they start 16–46 ms after navigation start, S1). It doesn't bypass the page's CSP the way the managers' `GM_addElement` does, so that bypass is only measured on real managers.
- Tests cover:
  - storage plus `onChanged` across two pages;
  - `sendMessage` both ways and `Port` lifetime;
  - leader election under churn: 5 pages opened and closed randomly for 60s, asserting at most one leader after each settle period and no lost messages;
  - tabs registry events;
  - the popup bridge on a page with strict CSP (served locally);
  - content-group matching with excludes and globs.

### 10.3 Conformance
- One suite tests the `gm.ts` contract through the real `gm.ts`: values, value listeners (including changes from other tabs), menus, `addElement` timing, `xmlHttpRequest`, and `cookie` where `caps.cookies` is true. It runs against the emulator in CI and against real TM and VM in the release tier, which keeps the emulator from drifting from the real managers.

### 10.4 Benchmark corpus (`bench/corpus.json`)
Each case records: `id`, `store`, `extensionId`, `version`, `sha256`, `kind` (`legacy`, `modern` or `negative`) and a `cases/<id>.ts` assertion script. Archives are downloaded and cached under `bench/.cache/` (git-ignored); third-party binaries are never committed.

- **Legacy (8):** the baseline's examples. Material Icons for GitHub, JSON Formatter, Modern for Wikipedia, Return YouTube Dislike, Web Search Navigator, uBlacklist, Iridium, Modern for Hacker News.
- **Modern MV3 (12):** LeetCode Enhancer (WXT), Refined GitHub, SponsorBlock, Unhook, Dark Reader, BetterTTV, Augmented Steam, Improve YouTube!, Reddit Enhancement Suite, Wikiwand, Octotree, Enhanced GitHub.
  - Any of these that can't be pinned is swapped for another site-specific MV3 extension built with WXT, Plasmo or Vite. Reasons: it is no longer downloadable, it isn't MV3, or its core feature needs an out-of-scope API.
  - Each swap is recorded in `corpus.json` with a reason.
- **Negative (3):** uBlock Origin Lite (`declarativeNetRequest`), Momentum (new-tab override), React Developer Tools (devtools panel). A case passes when the report verdict is `unlikely` and names the right APIs.
- **Assertions:** each case visits a public or locally served page and checks one or two observable effects, such as "JSON is formatted" or "dislike count element present". The popup is opened through the menu-command hook where the extension has one.

### 10.5 Tiers
- **CI (every push):** unit, runtime, conformance against the emulator, and the full corpus against the emulator. Results go to a scorecard (Markdown) that compares ext2userscript with the baseline (latest npm version) on the same corpus.
- **Release (manual, local):** the same corpus and conformance suite run against real Tampermonkey and Violentmonkey in Chrome for Testing, using a persistent profile where "Allow User Scripts" was switched on once by hand. Its path is passed as `BENCH_PROFILE`. A release needs both tiers green.

## 11. Early spikes (plan phase 0, before the main build)

| # | Question | Pass condition | Result |
|---|---|---|---|
| S1 | With `@sandbox DOM` (TM) and `@inject-into content` (VM): is every `GM_*` function in `gm.ts`'s grant table still available, does `gm.addElement` run a page-world script synchronously, and are content scripts isolated from page globals? | All available in both managers; an injected script runs before the next page script; page globals are not visible | FAIL: TM 5.5.1 and VM 2.49.0 (default manager settings) start a `document-start` script 16–46 ms after navigation start, after the page's first script on a fast page. The GM functions, synchronous `addElement` and isolation all pass. PASS against the best-effort contract (beat a page script that runs ≥ 200 ms after navigation start). See the §5.1 and §5.5 revisions. |
| S2 | Popup modal on strict-CSP sites (GitHub, YouTube, X): do the `about:blank` iframe plus userscript-context JS plus `gm.addElement` styles work, and which asset types fail? | JS runs and styles apply on all three. Failing asset types are recorded as report warnings. | PASS: JS ran and styles applied on all three sites, on TM 5.5.1 and VM 2.49.0 (X headed only). No asset type failed. Not yet tested against a CSP that blocks inline styles (none of the three does). `DOMParser` and `innerHTML` throw on YouTube under TM (Trusted Types); see the §6 revision. |
| S3 | Can `esbuild-wasm`, with the virtual-fs plugin, bundle a real MV3 module service worker (Refined GitHub, whose manifest declares `type: "module"`; LeetCode Enhancer's WXT build doesn't use a module worker) inside a Web Worker in current Chrome, Firefox and Safari? | The bundle is byte-identical to native esbuild's output; the first conversion takes under 10s on a laptop | PASS on Chromium and WebKit: byte-identical, 370–474 ms. Firefox pending CI (it doesn't launch on macOS 27 with Playwright's Firefox build 1555). WebKit is not shipping Safari. |
| S4 | Leader election and outbox protocol under churn in real TM and VM (not just the emulator) | No double leader after settling; no lost messages over 1,000 sends | PASS: TM 5.5.1 and VM 2.49.0 each received 1,050 of 1,050 messages and had one leader after 9 of 9 settle checks. |

Details: docs/superpowers/spikes/2026-10-09-plan1-findings.md

If a spike fails, its section of this spec is revised before implementation continues.

## 12. Risks

- **GM API behaviour differs between TM and VM** (value-listener timing, `GM_addElement` targets). Mitigation: all differences are contained in `gm.ts`, which the conformance suite (§10.3) and spikes S1 and S4 test in both managers.
- **esbuild-wasm size (~10 MB).** Mitigation: lazy load plus Web Worker. If too slow on mobile, the web app shows a CLI hint.
- **Store download endpoints are unofficial** (CWS, Edge) and may change. Mitigation: kept in one file (`download.ts`); a CI smoke test downloads one pinned extension per store weekly.
- **Licensing of converted extensions.** The README states that users are responsible for complying with each extension's licence. The benchmark never redistributes binaries.
