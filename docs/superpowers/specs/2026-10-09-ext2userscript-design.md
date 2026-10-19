# ext2userscript — design

Date: 2026-10-09
Status: reviewed 2026-10-09; GM-layer revision applied; spike revisions (§5.1, §5.5, §6) approved 2026-10-10; Plan 2 corrections (§3.5, §3.6, §4) applied 2026-10-10; Plan 3 corrections (§3.3, §5.3, §5.4) applied 2026-10-11; Plan 3b corrections (§1, §3.3, §3.6, §4, §5.2) applied 2026-10-15

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
| Approach | Build-time bundling (esbuild) plus a separately tested runtime. No `with` wrapper, and no runtime `eval` of extension code, except the function or code string that `scripting.executeScript` and `tabs.executeScript` send to a tab (§5.2). |
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
      html.ts           # a small HTML parser for popup and options pages
      pages.ts          # popup and options pages: DOM tree, CSS, code (§6)
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
      tabs.ts storage.ts alarms.ts menus.ts net.ts i18n.ts scripting.ts ...
      ui.ts pages.ts    # the popup and options pages' modal, and their chrome object (§6)
    cli.ts              # download from stores, read dirs/files, call convert, write output
    download.ts         # CWS / AMO / Edge Add-ons fetchers (CLI and proxy)
  web/                  # static page built with esbuild by web/build.ts, vanilla TS
  proxy/                # optional Cloudflare Worker for store-link downloads (~30 lines)
  bench/
    corpus.json         # pinned cases
    corpus.ts           # the corpus, its archives and pins
    pin.ts              # npm run bench:pin
    case.ts             # what a case script is, and what a run of one gives
    cases/<id>.ts       # per-extension Playwright assertions
    fixtures.ts         # pages served for sites that stop automated browsers
    tools.ts            # the two converters
    reference.ts        # the original extension, loaded unpacked
    scorecard.ts        # the scorecard and the ship criteria
    emulator/           # stands in for TM/VM behind gm.ts (CI tier)
    real/               # release tier: profile setup, launch and userscript install for real TM/VM
    session.ts          # one API over the emulator, tm and vm backends
    run.ts              # runs the corpus for ext2userscript, the baseline and the original extension, and writes a scorecard per backend
  spikes/               # throwaway spike code and its recorded results
  test/                 # node:test unit tests + Playwright runtime tests
```

Dependencies: `esbuild`, `esbuild-wasm`, `fflate`. Dev: `typescript`, `playwright`. The web app builds with esbuild, already a dependency: one page and a worker need no dev server or plugins. The CLI parses arguments with Node's `util.parseArgs` (no yargs). Tests use the built-in `node:test` runner.

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
- Background: `self`, `globalThis`, `window`, `document` and `importScripts`. `self` and `globalThis` are a background global shim. In a service worker, `window` and `document` are `undefined`, as in Chrome; in an MV2 background page, `window` is the shim and `document` is the tab's document.
- Background, content scripts, popup and options: `fetch` and `XMLHttpRequest`, the network shim (§5.2). A service worker gets `XMLHttpRequest` undefined, as in Chrome.
- Popup and options (§6):
  - `window`, `self` and `globalThis`: a proxy over the UI iframe's window, with `chrome`, `browser`, `localStorage`, `fetch`, `XMLHttpRequest` and `close()` (which closes the page) on top. What code adds to it that the window doesn't have (`window.$ = jQuery`) goes to the userscript's global, where a later script's bare names find it;
  - `document`, `location` and `history`: the iframe's own;
  - `setTimeout`, `setInterval`, `clearTimeout` and `clearInterval`: the iframe's, so the page's timers stop when it closes;
  - `DOMParser`: the iframe's, so Trusted Types sees the frame's policy (§6).
- Background, popup and options: `localStorage`, bound to the extension-wide storage shim (§5.1), so settings don't land in each site's own storage.

The code runs with its global as `this`, as at the top level of a script in Chrome, so a UMD library that puts itself on `globalThis` and one that looks for it on `this` meet. In a manager's world those two differ for a plain call.

Inside that wrapper, code goes in one of two ways.

- **Classic scripts** (`background.scripts`, content script `js[]`, `<script>` without `type="module"`, a classic `service_worker`):
  - They are **concatenated as text in manifest/DOM order**. This matches how a browser runs them: one shared scope, so top-level `var`/function declarations stay visible to later files.
  - In a popup or options page, the parser-blocking classic scripts run first; deferred (`defer`, `async`) classic scripts and module scripts then run together, in document order, as Chrome runs them.
  - Inline `<script>`s are dropped with a warning: an extension page's CSP never runs them. Inline data blocks (a non-JavaScript `type`, such as `text/x-template` or JSON) stay in the page's DOM for its code to read.
  - esbuild is not used for them, so nothing gets hoisted or renamed.
  - **`importScripts("a.js", "b.js")`** with string-literal arguments is replaced at build time by the files' contents, in order. Any other form adds a report entry: partial, "dynamic importScripts".
  - Ceiling: classic code that reaches bare globals (e.g. `addEventListener(...)` without `window.`) hits the userscript's global rather than the shim. Upgrade path: an AST rewrite of the free identifiers, if the benchmark shows it matters.
- **ES modules** (a `type: "module"` worker, `<script type="module">`): bundled by esbuild.
  - Options: `bundle: true`, `format: "esm"`, `write: false`, `platform: "browser"`, `target: "es2020"`.
  - A **virtual-fs plugin** resolves every path against the unpacked file map.
  - Dynamic `import()` of a local path is bundled. Dynamic `import()` of a remote URL is reported as unsupported.
  - esbuild bundles to an IIFE, so no `export` statements are left, and the bundle is placed inside the wrapper, whose parameters shadow the globals here too. `import.meta` becomes an object the wrapper passes in, whose `url` is `chrome-extension://<id>/<entry>`; every bundled module sees the entry's URL. In a popup or options page, each module script is its own entry, so its `import.meta.url` is its own file's.
  - An entry with a top-level `await` can't be an IIFE. It becomes an async function, called at once, whose error is thrown again outside the promise. One that also imports a remote module fails the conversion, naming it: the import would be a statement inside a function, which would stop the whole userscript from parsing.
  - In an isolated-world content script, `import(runtime.getURL("<literal>"))` (Vite and CRXJS's way of running ES modules as content scripts) is bundled by esbuild.
    - Each module becomes an async function in the group's scope, which closes over its `chrome`, as Chrome runs the module in the content script's world.
    - It runs once per group, with `import.meta.url` `chrome-extension://<id>/<path>`, and resolves to a snapshot of its exports.
    - A module with remote imports isn't bundled, with a warning.
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
- `partial` if there are partial entries, or unsupported entries in other contexts (popup, options, page).
- Otherwise `likely-works`.

The CLI prints a table and can write `--report report.json`. The web app renders the same data.

### 3.6 Assets
- **Collected:** every file referenced from `runtime.getURL` string literals, CSS `url()`, and HTML `src`/`href`/`srcset`, plus all of `web_accessible_resources`. With a background, also the manifest's icons (for notifications), the files it fetches by relative URL, and the style sheets it names (for `insertCSS`). The scripts it names are bundled like content scripts, for `scripting.executeScript({ files })`.
- **Also collected:** a file the background or a page names by a relative path in a string literal (`"../config/a.config"`, read by XHR), when it exists and isn't code.
- **Locales:** every `_locales/<locale>/messages.json` goes into the runtime config as parsed JSON, not into the asset table, because `i18n.getMessage` picks the locale in the browser.
- **Excluded:** files matching `--ignore-assets <glob,...>`; and source maps (`*.map`) matched by `web_accessible_resources`, with a warning (one named by `getURL` stays).
- **Stored:** as base64 in an asset table, with the MIME type taken from the extension.
- **At runtime:**
  - `runtime.getURL(path)` returns `blob:<…>#<path>`. Each URL is created lazily and cached per path. The fragment changes no load, and code that reads the URL's text (`.indexOf('.css')`) sees the path, as in Chrome. SVG, audio, video and PDF files get a bare `blob:` URL, because their code adds a fragment of its own (`#icon`, `#t=10`, `#page=2`).
  - `_locales/<locale>/messages.json` is served from the runtime config, rebuilt with its names as the file wrote them.
- **CSS:** `url()` references inside CSS are rewritten at build time to placeholders, which are replaced with blob URLs at injection time.

## 4. Userscript header (metadata)

| Source | Header |
|---|---|
| name, version, description, icons | `@name`, `@version`, `@description`, `@icon` (data URL, smallest icon ≥ 32px) |
| gecko id, or a slug of the name | `@namespace` |
| `content_scripts[].matches` (`<all_urls>` → `*://*/*`) | `@match` |
| `exclude_matches` | `@exclude-match` for the patterns every group excludes; the runtime applies the rest |
| `include_globs` / `exclude_globs` | not in the header; the runtime applies them. An `@include` adds URLs to the `@match` list instead of narrowing it, and an `@exclude` would also hide pages other groups match. |
| no content scripts at all (popup/background-only extension) | `@match *://*/*`, with the UI reachable through the menu only |
| host permissions, required and optional; hosts the code names | `@connect` per host permission's host, then each host the extension's code names (in URL string literals and template heads) that a permission covers, and `*` last when any host will do. Tampermonkey asks before reaching a host `@connect` doesn't name, even under `*`. |
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
  - Writes update the cache immediately and go to `gm.setValue`. Other tabs' caches follow through value listeners, one per key; a tab that creates a key rings `x2u:<ns>:ls-keys`, and the others start following it.
  - The background and the pages in a tab share one copy.
  - Content scripts keep the page's real `localStorage`, as in a real extension.
  - The background's and the pages' `window` proxies (§3.3) answer `window.localStorage` with the shim too.
  - Ceiling: `indexedDB` and `sessionStorage` in the background and the pages are the site's own: what the extension keeps there stays on each site, where the site can read it. The report marks them partial.
- **CI:** the emulator (§10.2) provides exactly the `GM_*` functions in the grant table, so CI runs the real `gm.ts`.

**Revision (S1):** `document_start` is best-effort. Tampermonkey 5.5.1 and Violentmonkey 2.49.0 start a `document-start` userscript 16–46 ms after navigation start, whatever `@sandbox`, `@inject-into` or `@grant` say (measured with default manager settings, unpacked builds, on one machine against local pages). A page script that runs earlier wins. The "call before the first `await`" rule still holds and still matters: it keeps `gm.addElement` synchronous, so a page-world script runs at the userscript's own start time. The release-tier conformance test pins this weaker contract: the injection must beat a page script that runs at least 200 ms after navigation start.

### 5.2 API support table (v1)

| API | Status | Implementation |
|---|---|---|
| `storage.local` / `sync` / `session` | supported | One GM value per key under `x2u:<ns>:s:<area>:<key>`. `session` is cleared when a new leader detects a fresh browser session (§5.4). |
| `storage.onChanged`, `storage.<area>.onChanged` | supported | `gm.addValueChangeListener` on the keys, which works across tabs |
| `runtime.sendMessage` / `onMessage` / `connect` / `onConnect` / `Port` | supported; `connect` partial | §5.3. A port from a content script or a page reaches the background only; one from the background reaches no extension page. |
| `runtime.getURL`, `getManifest`, `id`, `lastError`, `onInstalled`, `onStartup`, `openOptionsPage`, `getPlatformInfo` | supported | `onInstalled` fires once per installed version (tracked in GM storage). `openOptionsPage` opens the options page in place of the popup, or, from the background, in the active tab (§6). |
| `runtime.onMessageExternal`, `sendNativeMessage` | unsupported | |
| `tabs.query` / `get` / `getCurrent` / `sendMessage` / `create` / `update(url)` / `remove` / `reload` | supported | Tab registry (§5.3). `create` uses `gm.openInTab`. `remove` and `update` work by messaging the target tab, which calls `window.close()` or sets `location`. `close` only works for tabs opened by the script; otherwise the report says partial. |
| `tabs.onUpdated` / `onRemoved` / `onCreated` / `onActivated` | supported | Derived from registry changes. `onActivated` uses `visibilitychange`. |
| `windows.*` | partial | One synthetic window (id 1). `create` opens a tab with `gm.openInTab`, so it grants `GM_openInTab`, as `tabs.create` does. |
| `scripting.executeScript` (`func` or `files`) / `insertCSS` / `removeCSS` | partial | Run in the target tab's top frame via the bus. `files` are bundled at build time. A `func` runs through `new Function`, or, where the page's CSP forbids eval (Tampermonkey's sandbox follows it), in the page's world through `gm.addElement`, without `chrome.*`. |
| `tabs.executeScript` / `insertCSS` / `removeCSS` (MV2) | partial | Same path as above; `code` that can't be evaluated runs in the page's world with a null result |
| `alarms.*` | supported | Persisted schedule; fired by the background leader |
| `contextMenus` / `menus` | partial | Each item becomes a `gm.registerMenuCommand` entry in every tab, kept in a GM value. `onClicked` receives `{menuItemId, pageUrl}` and any selected text, but no link or media context; items only for links, images, media or editable fields don't show. |
| `action` / `browserAction` / `pageAction` `.onClicked`; `openPopup` | supported; with the popup (§6) | A button without a popup is a menu command named after its title; one with a popup gets "Open <title>" (§6). `openPopup` opens it in the active tab. `setPopup` and `getPopup` are partial: the button keeps the manifest's popup. |
| `action.setBadgeText` / `setIcon` / `setTitle` | partial | Stored. The title and badge show in the menu command's caption; there is no toolbar to show the icon on. Settings made with a `tabId` apply to that tab only, and a page action shows only on the tabs it was shown on. |
| `commands.onCommand` + manifest `commands` | partial | `keydown` listener on each page, mapping suggested keys per platform: a shortcut works only while such a page has focus |
| `notifications.create` / `onClicked` / `onClosed`; `update` / `clear` | supported; partial | `gm.notification` on the leader's tab. `update` shows it again under the same tag, which the managers treat as a replacement; one already shown can't be taken back, and buttons don't show. |
| `i18n.getMessage` / `getUILanguage` / `detectLanguage` | supported / supported / unsupported | |
| `permissions.contains` / `getAll` / `request` / `remove` | partial | Answers come from the manifest. `request` resolves true, and removals persist in GM storage. |
| `cookies.*` | partial | `gm.cookie`, which needs `caps.cookies` (TM, and VM since 2.35.1; VM returns httpOnly cookies only when the user enables that). Where it's missing, the calls reject (§5.1). |
| `extension.getBackgroundPage`, `runtime.getBackgroundPage` | partial | Works only when the current tab is the leader; otherwise rejects. A background page's top-level `var`, `let`, `const`, `function` and `class` declarations are properties of the global it hands out, live, as a background page's window holds them (ceiling: the first name of each `var`/`let`/`const`, and no destructuring) |
| `extension.getViews` | partial | Returns no views: each extension page opens in a tab's modal of its own |
| In a popup or options page: `alarms`, `contextMenus` / `menus`, the toolbar button, `commands`, `notifications`, `permissions` | partial | Their methods run in the leader's background, where their state lives; their events fire there only |
| `webRequest`, `declarativeNetRequest`, `proxy`, `identity`, `offscreen`, `sidePanel`, `devtools`, `debugger`, `tabCapture`, `downloads` | unsupported | Reject with `Error("ext2userscript: chrome.X is not available in userscripts")`, logged once |

Network: `fetch` and `XMLHttpRequest` in the background and content contexts are shimmed, so that cross-origin requests to `host_permissions` hosts go through `gm.xmlHttpRequest`. Same-origin requests use the native implementation. Responses support `text`, `json`, `blob` and `arrayBuffer`. Streaming bodies are a known ceiling: they are buffered. Extension URLs (`chrome-extension://<id>/…`, which a background's relative URLs resolve to), and the `blob:` URLs `runtime.getURL` hands out, are answered from the asset table in the page, so the page's CSP can't refuse them. A background's request to a host the extension has permission for carries cookies unless it sets `credentials: "omit"`; a content script's follows the page's own rules, carrying cookies only with `credentials: "include"` or `withCredentials`, so a page can't use it to read the user's signed-in pages elsewhere. More ceilings: uploads report no progress, a synchronous `XMLHttpRequest` can't go through `gm.xmlHttpRequest`, and `window.fetch` called explicitly from a content script isn't shimmed.

### 5.3 Messaging
- **In-tab:** content ↔ popup/options ↔ background (when this tab is the leader) is delivered directly through an in-memory bus with structured clone semantics (`structuredClone`).
- **Extension pages:** `runtime.sendMessage` from a content script, a page or the background reaches the background (unless it sent it) and every open extension page but the sender's. A tab with a popup or options page open says so in its registry entry (`page`), so the others know where pages are. The first answer wins; with none, the call settles as closed if anyone listened, and with "Receiving end does not exist" otherwise.
- **Cross-tab:** single-writer outbox keys, so concurrent writes never lose messages:
  - Each tab writes only `x2u:<ns>:out:<tabId>`, which holds a per-page `epoch` and a ring buffer of its last 64 messages from the past 10s `{seq, t, to, payload}`. The age limit keeps large messages from being rewritten with every later send.
  - Each tab listens (via `gm.addValueChangeListener`) to the outbox keys of every other live tab, and tracks the last `seq` it has read per sender.
  - On first contact with a sender, a tab delivers only messages sent after it started. A new `epoch` (the sender navigated, keeping its tab id) restarts the sequence instead of being ignored.
  - Managers may coalesce rapid writes. If a reader falls more than 64 messages behind, the gap is counted and logged, not hidden.
- **Discovery:**
  - Each tab writes `x2u:<ns>:tab:<tabId>` with `{url, title, frame, active, activeAt, since, ts, heard}` every 2s (`active` and `activeAt` drive `tabs.query({active})` and `onActivated`; `heard` is the newest roster ring the tab has heard), and polls `gm.listValues()` for tab keys on the same beat. `since` drives the election (§5.4).
  - A tab that starts, leaves (`pagehide`) or returns from the back/forward cache (`pageshow`) also writes `x2u:<ns>:roster`. Every tab listens to that key and rescans at once. Without this doorbell, a content script's first message to the background could wait up to 2s.
  - A leaving tab deletes its own key, so the others see it go immediately.
  - A tab whose `ts` is older than 90s counts as gone, which fires `tabs.onRemoved`, and its keys are deleted. The limit is long because Chrome throttles timers in tabs hidden for over 5 minutes to one wake-up per minute; a shorter limit would drop live background tabs.
  - Every live tab beats as soon as it hears another tab ring. About 1.5 s after a tab rings, a tab that has neither heard that ring nor beaten since is a ghost (it died without `pagehide`, in a crash or when the browser quit) and goes at once, instead of after 90 s. Value-change events reach throttled background tabs promptly; only their timers are throttled.
  - A content script in an iframe joins as a frame: it sends and receives messages, but it isn't a tab (`tabs.query` skips it) and never leads.
- **Responses:** a response (`sendResponse` or a returned promise) is just another message with `replyTo`. The default timeout is 30s, after which `lastError` is set to "The message port closed before a response was received."
- **Resending:** a message for the background whose page leaves before answering is sent again to the new leader, twice at most. A port is opened again there if the first page leaves before its `onConnect` runs; once connected, the page leaving disconnects the port, as in Chrome.
- **Tab id:** a random 31-bit integer per tab, kept across same-origin navigations through `sessionStorage`. A duplicated tab copies `sessionStorage`, so an id another live page is still beating with is replaced. The ceiling: a cross-origin navigation in the same tab gets a new id, appearing as remove plus create. Upgrade path: a `gm.getTab` method backed by TM's `GM_getTab`.

### 5.4 Background leader
- **Election:** the leader is the live tab with the earliest `since` (ties go to the lower id). Every tab computes this from the registry (§5.3).
  - `since` is when the tab joined, or when it rejoined after the back/forward cache, so a returning tab doesn't take leadership back.
  - Every input is a key with a single writer, so the tabs' local copies converge on the same answer. A shared lease key could leave tabs disagreeing about who won after simultaneous claims (for example, session restore opening 20 tabs), with no leader until it expired.
  - A tab starts leading only after it has been the oldest live tab for 300ms, so tabs that start together can't both lead before they've seen each other.
  - Messages for the background go to the expected leader (the oldest live tab) even during its grace period. It holds them for up to 5 s, until its background has started.
  - A leader that finds an older live tab (for example, one that was frozen and came back) steps down: it stops dispatching messages, alarms and events to background listeners. Timers already started by background code keep running; the ceiling here is that background timers are not cancelled.
  - The 90s staleness limit (§5.3) means a long-hidden leader whose timers are throttled to once a minute keeps the lead.
- **Handover:** a leader's `pagehide` deletes its registry key and rings the roster (§5.3), so the next-oldest tab takes over at once. A leader that disappears without `pagehide` (crash, tab discard) is replaced once the ghost check (§5.3) finds it, about 1.5 s after the next ring (a tab starting, or one becoming visible or navigating), or when its heartbeat goes stale.
- **New leader:**
  - It runs the background bundle from the top.
  - **`location`:** the background gets a `location` of its own: its service worker's script, its page, or `_generated_background_page.html`, with `origin` `chrome-extension://<id>`.
  - **`chrome`:** its object answers only names shaped like a namespace (`/^[a-z][a-zA-Z\d]*$/`), so `chrome.__esModule` is undefined.
  - An extension with a popup or options page but no background still elects a leader. It runs no code, but keeps the extension's state (menus, alarms, the toolbar button, notifications, permissions) for the pages, which call it there (§5.2).
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
- **Trusted Types:**
  - On a page that requires Trusted Types, Tampermonkey's userscript world (which shares the page's DOM) is held to them; Violentmonkey's isn't.
  - The runtime wraps the HTML and script-URL sinks in the content context. It passes a string through its own policy, `ext2userscript`, only when the code calling the sink is the userscript's (by its stack frames), so the page's own code stays protected. The caller is the first frame with a position past the sink, skipping built-ins (`Object.assign`) and another converted userscript's wrappers, which share the page's prototypes under Tampermonkey.
  - Ceiling: a CSP that names its allowed policies refuses the runtime's.

**Revision (S1):** `world: "MAIN"` and `document_start` groups run when the manager starts the userscript, not guaranteed before the page's first scripts. With GM functions granted, the script is isolated whatever the header, so `gm.addElement` is the only route tested into the page world (`@grant unsafeWindow` was not tested). It runs synchronously and gets past a nonce-only CSP on both managers (measured with default manager settings, unpacked builds, on one machine against local pages). The report marks `run_at: document_start` as **partial** ("best-effort: may run after the page's earliest scripts").

## 6. Popup and options pages
- **Opening:** "Open <title>" (the toolbar button's title, with its badge as for the button) and "<name> options" menu commands, plus the button's shortcut (`_execute_action`), `runtime.openOptionsPage` and `action.openPopup`, open a modal. The modal lives in a closed shadow root and contains a same-origin `about:blank` iframe.
  - Its host is in the top layer (`popover="manual"`), with inline `!important` styles, so a site's own `!important` rules, a transform on `<html>` or an overlay at the highest z-index can't hide or move it.
  - The popup sits at the top right. The options page is centred, with a title bar, a close button and a backdrop.
  - Escape, a click outside, the close button or `window.close()` closes it, after `pagehide` and `unload` are dispatched to the iframe's window. The listeners the page added are removed and its ports disconnected, so the background sees it go.
  - One page per tab: opening the open one focuses it; opening the other replaces it.
  - The page takes the focus once it has loaded, on its autofocus field if it has one, so typing goes to it, not the site.
- **Filling the iframe:**
  - The page's HTML is parsed at build time, by a hand-written parser (`src/convert/html.ts`). Its ceiling: of HTML's implied end tags, only a new `li`, `option`, `p`, `dt`/`dd` or table cell or row closes an open one of its kind; misnested tags otherwise come out as written, and unknown named character references stay as written.
  - The runtime builds the body and head nodes in the iframe document with `createElement`, `setAttribute` and `append` (see the revision below). A `style` attribute is set through the CSSOM, which a site's CSP doesn't block.
  - Inline `on*` handlers and `<link>`s other than style sheets are dropped at build time: an extension page's CSP never runs the one, and the other does nothing in a modal.
  - `<link rel=stylesheet>` and `<style>` become `gm.addElement(iframeDoc.head, 'style', {textContent})`, which gets past CSP rules that block inline styles: measured, the page's CSS applies under `style-src 'self'` on both managers.
  - Assets are rewritten to blob URLs.
- **Scripts:** the page's scripts are not inserted as `<script>` elements. The bundled UI code runs inside the userscript, with its wrapper parameters bound to the iframe's `window`/`document`, and the page's CSP doesn't apply to it. `DOMContentLoaded` and `load` are dispatched to the iframe's window after insertion.
- **Size:** the popup modal sizes itself to the content (max 800×600). The options page opens as a larger modal.
- **Known ceiling:** sites whose CSP blocks `blob:` or `data:` in `img-src`/`font-src` may still lose images and fonts in the modal. The report adds a warning when the UI uses them: "<page>: its images and fonts may not show under Tampermonkey on sites whose CSP limits img-src or font-src". Spike S2 measured this on GitHub, YouTube and X and saw no asset failures, even where `font-src` omits `blob:` (GitHub, X) or `data:` (GitHub). The popup plan measured it on a local page with `img-src 'self'`: Tampermonkey didn't load the modal's `blob:` images, and Violentmonkey did.
- **Ceiling:** a link or a `location` change to another extension page leaves the page (the iframe navigates away from it). The frame's base URL is `about:blank`, so a fragment link and `pushState` with a fragment stay in the page, and relative URLs don't resolve against the site's (unless the site's CSP limits `base-uri`, which refuses that base).
- **Custom elements:** measured, Violentmonkey 2.49.0 runs userscripts where `customElements` is `null`, so a page can't define custom elements there; Tampermonkey 5.5.1 allows them. The report marks `customElements` partial.

**Revision (S2):** On a site that sends `require-trusted-types-for 'script'` (YouTube), Tampermonkey 5.5.1 throws on `innerHTML` (on the iframe's body) and on `DOMParser.parseFromString`; Violentmonkey 2.49.0 allows both. The cause wasn't investigated.
- The converter parses popup and options HTML at build time, and the runtime builds the iframe DOM with `createElement`, `setAttribute` and `append`, with no `DOMParser` step. Cost: the parse runs in Node (the CLI) and in the web app's Web Worker (§8), and neither has `DOMParser`, so it needs an HTML-parser dependency (§2 has none yet) or a small hand-written parser with a stated ceiling. The popup plan chooses.
- The popup plan chose a small hand-written parser, so there is no dependency.
- Extension UI code that assigns HTML strings: the popup plan measured, on a local page with `require-trusted-types-for 'script'`, that Tampermonkey 5.5.1 throws on `innerHTML`, `DOMParser.parseFromString` and `insertAdjacentHTML` in the modal. So the runtime creates a pass-through `default` policy in the iframe's realm, and passes the iframe's own `DOMParser` as a wrapper parameter (§3.3). With them, none of the three throws on either manager.
  - The iframe also gets a `<meta>` CSP of `script-src 'none'; object-src 'none'`, as an extension page's CSP would run no inline script: an inline handler in HTML the page writes doesn't run (measured), so it can't reach the site's world.
  - Ceiling: a site whose CSP names its allowed policies (`trusted-types <names>`) without `default` refuses the policy, and HTML strings throw there under Tampermonkey (not measured).

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
  - optional store-link field, enabled only when `X2U_PROXY_URL` names a proxy at build time; without one it is disabled, saying why;
  - conversion progress;
  - the report table, grouped by status: "Not supported", "Partly supported" and "Supported", the last collapsed; the verdict reads "Likely works", "Partly works" or "Unlikely to work";
  - "Download .user.js" and "Copy" buttons.
- `esbuild-wasm` and its `.wasm` file are loaded on the first conversion that needs them (a module background or page), not on page load. The conversion worker itself loads with the first conversion.
- Conversion runs in a Web Worker so the UI stays responsive.
- Every URL the page uses is relative, so it works under any path.
- Deployed to GitHub Pages from CI: a `pages` job in `ci.yml` deploys after the tests, on pushes to `main`. The repository variable `X2U_PROXY_URL` names the proxy.
- `proxy/` contains a Cloudflare Worker:
  - It accepts only GET with `?src=<store page URL>` for the three store hosts above, and fetches the archive with `src/download.ts`.
  - Its answers carry `Access-Control-Allow-Origin` set to its `ALLOWED_ORIGIN` variable, and it refuses anything above 50 MB.
  - When it fails, it gives its reason as plain text, with status 400, 405 or 502.
  - Off by default; documented for anyone who wants to host it (`proxy/README.md`).

## 9. Error handling
- **Conversion:** hard errors only for an unreadable archive, a missing or invalid `manifest.json`, or an esbuild failure the plugin can't recover from (the message names the file and line). Everything else becomes a report entry.
- **Runtime:** unsupported calls reject, or call back with `lastError` set, using an error that names the API. Each one is logged once per page. No silent no-ops for APIs that change behaviour. A capability flag that is off (§5.1) makes the APIs that depend on it fail the same way.
- **Runtime boot:** one `try/catch` per content group and per background start, so one failing group doesn't stop the others. Errors are prefixed `[ext2userscript:<name>]`.

## 10. Testing and benchmark

### 10.1 Unit (`node:test`)
Unpack (crx2/crx3 fixtures), manifest normalisation (MV2 and MV3 fixtures, locales), metadata mapping (§4 table), analyze plus the support table, and the asset rewriting.

### 10.2 Runtime (Playwright, Chromium)
- An **emulator** (`bench/emulator`) stands in for TM/VM behind `gm.ts`. It provides exactly the `GM_*` functions in the grant table (a browser test fails if one is missing), so CI runs the real `gm.ts`. Values are shared across all pages in one browser context using the managers' consistency model: each page reads a synchronous local copy, and writes reach other pages asynchronously, firing their value-change listeners with `remote: true`.
- Playwright injects it through `context.addInitScript` before the converted script. The emulator also enforces `@match`/`@exclude-match` and `@run-at`, but it runs `document-start` scripts before the page's first script, which is stricter than TM and VM (they start 16–46 ms after navigation start, S1). It doesn't bypass the page's CSP the way the managers' `GM_addElement` does, so that bypass is only measured on real managers. Its `GM_addElement` isn't held to the page's Trusted Types, as the managers' isn't, and its injected script is named `x2u-emulator-userscript.js` in stack frames, as a manager names a userscript.
- Tests cover:
  - storage plus `onChanged` across two pages;
  - `sendMessage` both ways and `Port` lifetime;
  - leader election under churn: 5 pages opened and closed randomly for 60s, asserting at most one leader after each settle period and no lost messages;
  - tabs registry events;
  - the popup bridge on a page with strict CSP (served locally): `test/browser/pages.test.ts`, on the emulator and the release tier;
  - content-group matching with excludes and globs;
  - the web app (`test/browser/web.test.ts`) on Chromium, Firefox and WebKit. Playwright's Firefox doesn't launch on macOS 27, so Firefox runs in CI.

### 10.3 Conformance
- One suite tests the `gm.ts` contract through the real `gm.ts`: values, value listeners (including changes from other tabs), menus, `addElement` timing, `xmlHttpRequest`, and `cookie` where `caps.cookies` is true. It runs against the emulator in CI and against real TM and VM in the release tier, which keeps the emulator from drifting from the real managers.

### 10.4 Benchmark corpus (`bench/corpus.json`)
Each case records: `id`, `store`, `extensionId`, `version`, `sha256`, `kind` (`legacy`, `modern` or `negative`) and a `cases/<id>.ts` assertion script. Archives are downloaded and cached under `bench/.cache/` (git-ignored); third-party binaries are never committed.

- **Pinning:** the stores serve only an extension's latest version. A case whose pinned archive isn't in the cache runs on the store's current one, and the scorecard shows `<version> (pinned <version>)`. `npm run bench:pin [-- --case id,…]` re-pins.
- **Legacy (8):** the baseline's examples. Material Icons for GitHub, JSON Formatter, Modern for Wikipedia, Return YouTube Dislike, Web Search Navigator, uBlacklist, Iridium, Modern for Hacker News.
- **Modern MV3 (12):** LeetCode Enhancer (WXT), Refined GitHub, SponsorBlock, Unhook, Dark Reader, BetterTTV, Augmented Steam, Improve YouTube!, Reddit Enhancement Suite, Wikiwand, Octotree, Enhanced GitHub.
  - Any of these that can't be pinned is swapped for another site-specific MV3 extension built with WXT, Plasmo or Vite. Reasons: it is no longer downloadable, it isn't MV3, or its core feature needs an out-of-scope API.
  - Each swap is recorded in `corpus.json` with a reason. Wikiwand is swapped for Modrinth Extras: its one feature is a `declarativeNetRequest` redirect.
- **Negative (3):** uBlock Origin Lite (`declarativeNetRequest`), Momentum (new-tab override), React Developer Tools (devtools panel). A case passes when the report verdict is `unlikely` and names the right APIs. The baseline writes no report, so it gets n/a.
- **Assertions:** each case checks one or two observable effects, such as "JSON is formatted" or "dislike count element present".
  - **Pages:** a case visits a public page, or serves the page itself (Playwright routes) where the site stops automated browsers: Google, Reddit and LeetCode. A served page carries only the markup the extension reads. No case gets past a CAPTCHA or bot check.
  - **Scope:** cases check what the extension does to pages. The popup and options pages are covered by §10.2's tests.
- **The reference:** each browser case also runs once against the original extension, loaded unpacked in Chromium.
  - A case the original fails is inconclusive: it counts for nothing, and the release gate fails while any case is.
  - Manifest V2 cases have no reference, because Chromium no longer loads MV2.

### 10.5 Tiers
- **CI (every push):** unit, runtime, conformance against the emulator, and the full corpus against the emulator. Results go to a scorecard (Markdown) that compares ext2userscript with the baseline (latest npm version) on the same corpus.
  - A `bench` job runs `npm run bench` on the emulator and adds the scorecard to the job summary. It doesn't fail the build.
- **Release (manual, local):** the same corpus and conformance suite run against real Tampermonkey and Violentmonkey in Chrome for Testing, using a persistent profile where "Allow User Scripts" was switched on once by hand. Its path is passed as `BENCH_PROFILE`. A release needs both tiers green.
  - `X2U_BACKENDS=emulator,tm,vm npm run bench -- --gate` exits 1 unless the criteria are met on every backend, with every case conclusive.
  - Each real-manager session runs on its own copy of `BENCH_PROFILE`, without its caches, so a case runs only its own userscript.

## 11. Early spikes (plan phase 0, before the main build)

| # | Question | Pass condition | Result |
|---|---|---|---|
| S1 | With `@sandbox DOM` (TM) and `@inject-into content` (VM): is every `GM_*` function in `gm.ts`'s grant table still available, does `gm.addElement` run a page-world script synchronously, and are content scripts isolated from page globals? | All available in both managers; an injected script runs before the next page script; page globals are not visible | FAIL: TM 5.5.1 and VM 2.49.0 (default manager settings) start a `document-start` script 16–46 ms after navigation start, after the page's first script on a fast page. The GM functions, synchronous `addElement` and isolation all pass. PASS against the best-effort contract (beat a page script that runs ≥ 200 ms after navigation start). See the §5.1 and §5.5 revisions. |
| S2 | Popup modal on strict-CSP sites (GitHub, YouTube, X): do the `about:blank` iframe plus userscript-context JS plus `gm.addElement` styles work, and which asset types fail? | JS runs and styles apply on all three. Failing asset types are recorded as report warnings. | PASS: JS ran and styles applied on all three sites, on TM 5.5.1 and VM 2.49.0 (X headed only). No asset type failed. Not yet tested against a CSP that blocks inline styles (none of the three does). `DOMParser` and `innerHTML` throw on YouTube under TM (Trusted Types); see the §6 revision. |
| S3 | Can `esbuild-wasm`, with the virtual-fs plugin, bundle a real MV3 module service worker (Refined GitHub, whose manifest declares `type: "module"`; LeetCode Enhancer's WXT build doesn't use a module worker) inside a Web Worker in current Chrome, Firefox and Safari? | The bundle is byte-identical to native esbuild's output; the first conversion takes under 10s on a laptop | PASS on Chromium, Firefox and WebKit: byte-identical, 370–1,012 ms. Firefox was measured in CI on Linux (Playwright's Firefox build 1555 doesn't launch on macOS 27). WebKit is not shipping Safari. |
| S4 | Leader election and outbox protocol under churn in real TM and VM (not just the emulator) | No double leader after settling; no lost messages over 1,000 sends | PASS: TM 5.5.1 and VM 2.49.0 each received 1,050 of 1,050 messages and had one leader after 9 of 9 settle checks. |

Details: docs/superpowers/spikes/2026-10-09-plan1-findings.md

If a spike fails, its section of this spec is revised before implementation continues.

## 12. Risks

- **GM API behaviour differs between TM and VM** (value-listener timing, `GM_addElement` targets). Mitigation: all differences are contained in `gm.ts`, which the conformance suite (§10.3) and spikes S1 and S4 test in both managers.
- **esbuild-wasm size (~10 MB).** Mitigation: lazy load plus Web Worker. If too slow on mobile, the web app shows a CLI hint.
- **Store download endpoints are unofficial** (CWS, Edge) and may change. Mitigation: kept in one file (`download.ts`); a CI smoke test downloads one pinned extension per store weekly.
- **Licensing of converted extensions.** The README states that users are responsible for complying with each extension's licence. The benchmark never redistributes binaries.
