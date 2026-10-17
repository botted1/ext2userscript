# ext2userscript Plan 4: Popup and Options Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the extension's popup and options page (spec §6): they open in a modal over the page, from menu commands, the toolbar button's shortcut, `action.openPopup` and `runtime.openOptionsPage`, and their code talks to the background and content scripts as in Chrome.

**Architecture:**
- **Build time (`src/convert/html.ts`, `src/convert/pages.ts`):**
  - A small hand-written parser turns each page's HTML into a tree.
  - Its scripts become one piece of code: classic files are concatenated; module scripts are bundled by esbuild.
  - Its style sheets become CSS text, and asset URLs become placeholders.
  - The tree and CSS go in `RuntimeConfig.pages`. The code becomes a factory, passed to `start()` as a fifth argument.
- **Runtime (`src/runtime/ui.ts`, `src/runtime/pages.ts`):**
  - **The modal:** a closed shadow root in the browser's top layer holds a same-origin `about:blank` iframe. The page's DOM is built there with `createElement`; its CSS goes in through `gm.addElement`.
  - **The page's code** runs in the userscript, with the iframe's globals as wrapper parameters. Its `chrome` object is the background's, except that the namespaces whose state the background keeps are called in the leader's background.
  - **Closing** removes the listeners the page added and disconnects its ports.
- **Messaging:** a third endpoint, `"page"`.
  - Tabs with a page open say so in their registry entry.
  - `runtime.sendMessage` goes to the background and every open page but the sender's; the first answer wins.

**Tech Stack:**
- TypeScript, run directly by Node 22.16 with `--experimental-strip-types`.
- `node:test`.
- Playwright 1.64, on the emulator and the release tier.
- esbuild 0.28.2 and fflate 0.8.3.
- No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`

**Scope:** Plan 4 of 6. It covers:
- spec §6;
- the popup/options wrapper of §3.3;
- §5.2's `action.openPopup`, `runtime.openOptionsPage`, and `getBackgroundPage` from a page;
- messaging between the background, content scripts and pages (§5.3).

Plans 5 and 6 (web app, benchmark) are unchanged.

**Prototype:** every test below was run before the plan was written, on 2026-10-17, against a copy of `main` at 7296716.

| Check | Result |
|---|---|
| Unit tests | 361 of 361; `tsc` clean |
| `test/browser/pages.test.ts` on the emulator, Tampermonkey 5.5.1 and Violentmonkey 2.49.0 | 24 of 24. Skipped: 1 test on the emulator (needs a real manager's CSP bypass) and 1 on each real manager (needs the emulator's menu) |
| `content-runtime.test.ts` on both real managers | 32 of 32, so the runtime restructure broke nothing |
| Emulator browser suite | Passes, apart from the known Firefox S3 failure on macOS 27 |

What the prototype measured:
1. **Trusted Types** (`require-trusted-types-for 'script'`):
   - Without help, Tampermonkey throws on `innerHTML`, `DOMParser.parseFromString` and `insertAdjacentHTML` in the modal (S2 measured the first two); Violentmonkey allows all three.
   - With a pass-through `default` policy created in the iframe, and the iframe's own `DOMParser` as a wrapper parameter, none of the three throws on either manager.
   - A `<meta>` CSP of `script-src 'none'` in the iframe keeps an inline handler in such HTML from running, as an extension page's CSP would.
2. **A site whose CSP is `style-src 'self'; img-src 'self'`:**
   - The page's CSS (through `gm.addElement`) and its `style` attributes (set through the CSSOM) apply on both managers.
   - Tampermonkey doesn't load the modal's `blob:` images; Violentmonkey does.
3. **A hostile site:** a site that hides every element with `!important`, transforms `<html>`, and adds a full-screen overlay at the highest z-index still shows the modal at the top right, on top. This needs the top layer (`popover`) and inline `!important` styles on the host.
4. **Script order:** Chrome runs deferred classic scripts and module scripts together, in document order, after the parser-blocking ones. The bundle follows that.

**Decisions that need the human's OK along with this plan:**
1. **The HTML parser** (spec §6 leaves it to this plan): hand-written, about 110 lines, no dependency. Its ceiling: of HTML's implied end tags, only a new `li`, `option`, `p`, `dt`/`dd` or table cell or row closes an open one of its kind. Misnested tags otherwise come out as written.
2. **Trusted Types:** the iframe gets a pass-through `default` policy and a `script-src 'none'` meta CSP, instead of the analyzer flagging HTML sinks with a report warning. The measurement above says the warning would describe a failure that no longer happens.
3. **The spec corrections Task 1 applies** (listed there).

## Global Constraints

- **Node:** Node ≥ 22.16. TypeScript runs directly with `--experimental-strip-types --disable-warning=ExperimentalWarning`. No tsx, no build step.
- **Running things:** one test file with `npm run test:file -- <path>`. Under machine load, run the unit suite with `npm test -- --test-concurrency=2`.
- **TypeScript:**
  - Erasable syntax only (no `enum`, `namespace` or parameter properties).
  - Relative imports end in `.ts`.
  - Type-only imports use `import type` or inline `type`.
  - The `lib` is `es2022` plus DOM.
- **Exact versions:**
  - `esbuild` and `esbuild-wasm` 0.28.2; `fflate` 0.8.3.
  - Dev: `playwright` 1.64.0, `typescript` 7.0.2, `@types/node` 22.20.5.
  - No other dependencies.
- **Tests:** `node:test` with `node:assert/strict`. Browser tests use the `playwright` library.
- **Isomorphic core:** `src/convert/*` and `src/runtime/*` import no `node:` module and use no Node-only global. The exceptions are `esbuild-node.ts` and `runtime-node.ts`.
- **The GM layer:** every GM call goes through `src/runtime/gm.ts`. `@grant` lines come from its `GRANTS` table, for the methods `support.ts` lists.
- **GM value keys (`x2u:<ns>:…`):**
  - Plans 3 and 3b keys: `tab:<id>`, `out:<id>`, `roster`, `s:<area>:<key>`, `storage-keys`, `ls:<key>`, `installed`, `session`, `alarms`, `menus`, `permissions`.
  - New: `ls-keys`, the localStorage doorbell.
  - The registry beat gains an optional `page: "popup" | "options"`.
- **Production timings:** Plan 3's, unchanged:
  - heartbeat 2 s, stale after 90 s, ghost check 1.5 s;
  - election grace 300 ms;
  - background messages held up to 5 s;
  - replies time out after 30 s.

  A page's `call` event is held and resent like any page event.
- **Errors (spec §9):** an unavailable API fails with `ext2userscript: chrome.<api> is not available in userscripts`, logged once.
- **Styling the modal:** only through the CSSOM (`element.style`). Never a `<style>` element or `style` attribute of the runtime's own, which a site's CSP can block. The page's own CSS goes through `gm.addElement`.
- **Extension code stays in sloppy mode.** The runtime's `"use strict"` stays inside its IIFE.
- **Real managers:** one browser at a time on `bench/.cache/profile`; leave no Chrome for Testing process running.
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, passed as a second `-m`.

## Review Focus

1. **A page that has closed** must answer nothing. Its listeners are gone, and the background sees its port disconnect, as Chrome's background sees a popup go. Pinned in Task 6:
   - `pages-runtime.test.ts`, "removes the listeners a page added and disconnects the ports it opened, and nothing else";
   - `pages.test.ts`, "opens the popup with its shortcut and runs it with its own chrome object, until it closes".
2. **The shortcut or a menu command, used again while the page is open,** must leave one modal, not stack a second. Pinned in Task 6 (`pages.test.ts`, "opens one popup however often it is asked, and runs it in a tab that doesn't lead").
3. **A site whose CSS hides or covers everything** (`html > * { display: none !important }`, a transform on `<html>`, an overlay at the highest z-index) must not hide or move the modal. Pinned in Task 6 (`pages.test.ts`, "shows the modal over a site that hides every element, moves <html> and covers itself with an overlay").
4. **A popup in a tab that isn't the leader** must still reach the background in the leader's tab, and `getBackgroundPage` must reject there. Pinned in Task 6 (`pages.test.ts`, "opens one popup however often it is asked, and runs it in a tab that doesn't lead").
5. **Page code that throws at top level** must leave the page open and working: DOM, CSS, the listeners it added, then `DOMContentLoaded` and `load`. Pinned in Task 6: the fixture's `broken.js` throws last, and "opens the popup with its shortcut…" checks the events.

---

### Task 1: Spec corrections, and the HTML parser

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`
- Create: `src/convert/html.ts`
- Test: `test/unit/html.test.ts`

**Interfaces:**
- Produces:
  - `type HtmlAttribute = [name: string, value: string]`
  - `type HtmlNode = { type: "element"; name: string; attributes: HtmlAttribute[]; children: HtmlNode[] } | { type: "text"; text: string }`
  - `parseHtml(html: string): HtmlNode[]`: the top-level nodes.
  - `decodeEntities(text: string): string`

- [ ] **Step 1: Apply the spec corrections.**
  1. **§3.3, the popup and options bullet.**
     - **Wrapper parameters:** `window`, `self` and `globalThis` are a proxy over the iframe's window, with `chrome`, `browser`, `localStorage`, `fetch`, `XMLHttpRequest` and `close()` on top. The other parameters:
       - `document`, `location` and `history`: the iframe's;
       - `localStorage`;
       - `fetch` and `XMLHttpRequest`: the network shim, so pages get it too;
       - `setTimeout`, `setInterval`, `clearTimeout` and `clearInterval`: the iframe's, so timers stop when the page closes;
       - `DOMParser`: the iframe's, so Trusted Types sees the frame's policy.
     - **Module scripts:** each one's `import.meta.url` is its own file's URL.
     - **Script order:** a page's classic scripts run in document order. Deferred classic and module scripts then run together, also in document order.
     - **Inline scripts:** dropped, since an extension page's CSP never ran them; inline data blocks (`type="text/x-template"`, JSON) stay in the tree.
  2. **§5.1:** `localStorage` is extension-wide across tabs. Each tab's copy follows the others' writes, with the doorbell `x2u:<ns>:ls-keys` for new keys.
  3. **§5.2 rows:**
     - `runtime.openOptionsPage`: supported. It opens the options page in place of the popup, or, from the background, in the active tab.
     - `action.openPopup`: supported, in the active tab.
     - `extension.getViews`: partial, returns no views.
     - `runtime.connect`: from the background it reaches no extension page (partial); from a page it reaches the background only.
     - `setPopup` and `getPopup`: partial; the button keeps the manifest's popup.
     - In pages, alarms, context menus, the toolbar button, commands, notifications and permissions run in the leader's background. Their events fire there only (partial).
  4. **§5.3:**
     - **In-tab bullet:** `runtime.sendMessage` from a content script, a page or the background reaches the background (unless it sent it) and every open extension page but the sender's.
     - **Who has a page open:** a tab with a page open says so in its registry entry (`page`).
     - **Answers:** the first answer wins. With none, the call settles as closed if anyone listened, and with "Receiving end does not exist" otherwise.
  5. **§5.4, "New leader":** an extension with pages but no background still elects a leader. It keeps the extension's state (menus, alarms, the button, notifications, permissions) for the pages.
  6. **§6:**
     - **The parser:** hand-written in `src/convert/html.ts`. Its ceiling: of HTML's implied end tags, only a new `li`, `option`, `p`, `dt`/`dd` or table cell or row closes an open one of its kind; unknown named references stay as written.
     - **Dropped at build time:** inline `on*` handlers, and `<link>`s other than style sheets.
     - **The modal:**
       - its host is in the top layer (`popover="manual"`), with inline `!important` styles;
       - the popup sits at the top right, sized to its content (25 to 800 × 25 to 600);
       - the options page is centred, with a title bar, a close button and a backdrop.
     - **Closing:** Escape, a click outside, the close button or `window.close()` closes it, after `pagehide` and `unload` are dispatched.
     - **One page per tab:** opening the open one focuses it; opening the other replaces it.
     - **Menu commands:** "Open <button title>", with the badge as for the button, and "<name> options".
     - **The iframe** gets a `<meta>` CSP of `script-src 'none'; object-src 'none'` and a pass-through Trusted Types `default` policy.
     - **Replace the S2 revision's two Trusted Types bullets** (the analyzer warning, and the "Not measured" one) with the measurement:
       - on Tampermonkey 5.5.1, all three sinks threw;
       - with the policy and the frame's `DOMParser`, none throws on either manager;
       - remaining ceiling: a site whose CSP names its allowed policies (`trusted-types <names>`) without `default` (not measured).
     - **Replace "not yet tested against such a CSP"** with: measured, the page's CSS applies under `style-src 'self'` on both managers.
     - **Known ceiling, images:** add that Tampermonkey didn't load `blob:` images under `img-src 'self'`; Violentmonkey did. The report's warning text is the one Task 2 produces.
     - **Ceiling:** a link or `location` change to another extension page leaves the page.
  7. **§10.2:** pages end to end in `test/browser/pages.test.ts`, on the emulator and the release tier.

- [ ] **Step 2: Write the failing test** `test/unit/html.test.ts`:

```ts
// The build-time HTML parser for extension pages.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, parseHtml, type HtmlNode } from "../../src/convert/html.ts";

/** A compact form of a tree, for comparing: elements as [name, {attributes}, ...children], text as strings. */
const shape = (nodes: HtmlNode[]): unknown[] => nodes.map((node) => (node.type === "text" ? node.text : [node.name, Object.fromEntries(node.attributes), ...shape(node.children)]));

describe("parseHtml", () => {
  it("reads elements, attributes in every quoting style, text and character references, and skips a doctype and comments", () => {
    const html = `<!DOCTYPE html><html lang=en><head><meta charset="utf-8"><title>A &amp; B</title></head><!-- note --><body class='x'><p id=a data-n="1 &lt; 2">Hi&nbsp;there &#128512; &unknown;</p></body></html>`;
    assert.deepEqual(shape(parseHtml(html)), [
      ["html", { lang: "en" }, ["head", {}, ["meta", { charset: "utf-8" }], ["title", {}, "A & B"]], ["body", { class: "x" }, ["p", { id: "a", "data-n": "1 < 2" }, "Hi there 😀 &unknown;"]]],
    ]);
  });

  it("keeps script and style content as raw text, even with tags in it", () => {
    const html = `<script>if (a < b && c > d) document.write("<b>x</b>");</script><style>a > b { content: "</p>"; }</style><div>after</div>`;
    assert.deepEqual(shape(parseHtml(html)), [
      ["script", {}, 'if (a < b && c > d) document.write("<b>x</b>");'],
      ["style", {}, 'a > b { content: "</p>"; }'],
      ["div", {}, "after"],
    ]);
  });

  it("closes void and self-closing elements, and an open li, option or p when another starts", () => {
    const html = `<ul><li>one<li>two</ul><img src=a.png><br/><svg viewBox="0 0 1 1"><path d="M0 0"/></svg><p>a<p>b`;
    assert.deepEqual(shape(parseHtml(html)), [
      ["ul", {}, ["li", {}, "one"], ["li", {}, "two"]],
      ["img", { src: "a.png" }],
      ["br", {}],
      ["svg", { viewbox: "0 0 1 1" }, ["path", { d: "M0 0" }]],
      ["p", {}, "a"],
      ["p", {}, "b"],
    ]);
  });

  it("closes what an end tag's element left open, ignores a stray end tag, and keeps a lone < as text", () => {
    assert.deepEqual(shape(parseHtml("<div><span>a</div>b</span> 1 < 2")), [["div", {}, ["span", {}, "a"]], "b 1 < 2"]);
  });

  it("keeps the first of a repeated attribute, as browsers do", () => {
    assert.deepEqual(shape(parseHtml('<a href="1" href="2" disabled>x</a>')), [["a", { href: "1", disabled: "" }, "x"]]);
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references, and leaves unknown ones", () => {
    assert.equal(decodeEntities("&lt;&#65;&#x42;&quot;&hellip;&nope;&#0;"), '<AB"…&nope;�');
  });
});
```

- [ ] **Step 3: Run it.** `npm run test:file -- test/unit/html.test.ts`. Expected: FAIL, `Cannot find module '…/src/convert/html.ts'`.

- [ ] **Step 4: Implement `src/convert/html.ts`.** These values are fixed:
  - **`VOID`** (never open): `area base br col embed hr img input link meta source track wbr`.
  - **`RAW`** (content is text up to `</name`): `script style title textarea`. Character references are decoded in `title` and `textarea` only.
  - **`CLOSES`** (a start tag that first pops an open element of these names, when it is the innermost):
    - `li: [li]`, `option: [option]`, `p: [p]`;
    - `dt` and `dd`: `[dt, dd]`;
    - `tr: [tr, td, th]`;
    - `td` and `th`: `[td, th]`.
  - **Named references:** `amp lt gt quot apos nbsp copy reg trade hellip mdash ndash laquo raquo middot bull times`. Decimal and hex references are decoded too. A code point of 0 or above 0x10FFFF becomes U+FFFD; an unknown name stays as written.
  - **Attributes:** matched by `/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g`. Names are lower-cased, the first of a repeated name wins, and values are entity-decoded.
  - **Tags:** a tag is `/^<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/`, and its name is lower-cased.
    - A `<` that starts no tag is text, and adjacent text merges.
    - An end tag pops to the nearest open element of its name; a stray one is ignored.
    - A trailing `/` self-closes.
    - `<!--…-->`, `<!…>` and `<?…>` are skipped.

- [ ] **Step 5: Run it.** Same command. Expected: PASS, 6 of 6.

- [ ] **Step 6: Commit.**

```bash
git add docs/superpowers/specs/2026-10-09-ext2userscript-design.md src/convert/html.ts test/unit/html.test.ts
git commit -m "Parse extension pages' HTML at build time, and bring the spec in line with the popup plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Page bundles in the converter

**Files:**
- Create: `src/convert/pages.ts`
- Modify: `src/convert/assets.ts`, `src/runtime/config.ts`, `src/convert/emit.ts`, `src/convert/index.ts`
- Test: `test/unit/pages.test.ts`, `test/unit/emit.test.ts`, `test/unit/convert.test.ts`, `test/support/extension.ts`

**Interfaces:**
- Consumes: `parseHtml` and `HtmlNode` (Task 1); `bundleModule(esbuild, files, entry, { format, define })` (`esbuild.ts`); `decodeText` and `mimeOf` (`files.ts`).
- Produces:
  - **`assets.ts`:**
    - `assetPlaceholder(path): string`, which is `x2u-asset:` + `encodeURIComponent(path)`;
    - `rewriteCssUrls(css, cssPath, keep: (asset) => boolean): string`, which `collectAssets` now uses for content CSS;
    - `extensionPath(target, fromPath): string | undefined`. This is the old private `cssTarget`, renamed and exported; it now drops `?…` and `#…` first.
  - **`config.ts`:**
    - `type PageKind = "popup" | "options"`;
    - `type PageNode = string | [name, Array<[string, string]>, PageNode[]]`;
    - `type PageConfig = { path; title?; htmlAttributes; bodyAttributes; head: PageNode[]; body: PageNode[]; css: string[] }`;
    - `RuntimeConfig.pages?: Partial<Record<PageKind, PageConfig>>`;
    - `type PageCode = (chrome, browser, window, self, globalThis, document, location, history, localStorage, fetch, XMLHttpRequest, setTimeout, setInterval, clearTimeout, clearInterval, DOMParser, __x2uBase: string) => () => void`.
  - **`pages.ts`:**
    - `type PageBundle = { kind: PageKind; config: PageConfig; code: string; assets: string[]; remoteImports: string[] }`;
    - `bundlePages(model, files, esbuild?): Promise<{ pages: PageBundle[]; warnings: string[] }>`.
  - **`emit.ts`:** a seventh parameter `pages: Partial<Record<PageKind, string>> = {}`. `start()` gets a fifth argument `{ popup: function (<the PageCode parameters, in order>) { return function () { <code> }; }, … }`.
  - **`convert/index.ts`:**
    - `prepare` bundles pages after the background and returns `pages`;
    - `config.pages` holds each page's `PageConfig`;
    - each page's code is scanned (`pageScans`).

- [ ] **Step 1: Write the failing tests.**

`test/unit/pages.test.ts`:

```ts
// Popup and options pages prepared at build time: DOM tree, CSS, code, assets.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assetPlaceholder } from "../../src/convert/assets.ts";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import { bundlePages } from "../../src/convert/pages.ts";
import { files } from "../support/extension.ts";

const extension = (manifest: Record<string, unknown>, extra: Record<string, string>) => {
  const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1.0", ...manifest }), ...extra });
  return { model: readManifest(all).model, files: all };
};

describe("bundlePages", () => {
  it("builds the popup's tree, CSS and code, and turns asset URLs into placeholders", async () => {
    const { model, files: all } = extension({ action: { default_popup: "popup/index.html" } }, {
      "popup/index.html": `<!doctype html><html lang="en"><head><title>Pop</title><link rel="stylesheet" href="pop.css"><style>b { background: url(../img/b.png) }</style>
        <script src="a.js"></script><script src="/lib/b.js"></script><script>inline()</script></head>
        <body class="dark"><img src="../img/a.png" srcset="../img/a.png 1x, ../img/b.png 2x"><a href="../img/a.png">x</a><div style="background:url('../img/b.png')"></div><img src="https://cdn.example/x.png"></body></html>`,
      "popup/pop.css": "i { background: url(i.png) }",
      "popup/i.png": "i", "img/a.png": "a", "img/b.png": "b",
      "popup/a.js": "var a = 1 // no newline",
      "lib/b.js": "b(a)",
    });
    const { pages, warnings } = await bundlePages(model, all);
    assert.equal(pages.length, 1);
    const [{ kind, config, code, assets }] = pages;
    assert.equal(kind, "popup");
    assert.equal(config.path, "popup/index.html");
    assert.equal(config.title, "Pop");
    assert.deepEqual(config.htmlAttributes, [["lang", "en"]]);
    assert.deepEqual(config.bodyAttributes, [["class", "dark"]]);
    assert.deepEqual(config.css, [`i { background: url("${assetPlaceholder("popup/i.png")}") }`, `b { background: url("${assetPlaceholder("img/b.png")}") }`]);
    assert.equal(code, "var a = 1 // no newline\n;\nb(a)");
    const [a, b] = [assetPlaceholder("img/a.png"), assetPlaceholder("img/b.png")];
    assert.deepEqual(config.body, [
      ["img", [["src", a], ["srcset", `${a} 1x, ${b} 2x`]], []],
      ["a", [["href", "../img/a.png"]], ["x"]],
      ["div", [["style", `background:url("${b}")`]], []],
      ["img", [["src", "https://cdn.example/x.png"]], []],
    ]);
    assert.deepEqual(config.head.filter((node) => typeof node !== "string"), [["title", [], ["Pop"]]]);
    assert.deepEqual(assets.sort(), ["img/a.png", "img/b.png", "popup/i.png"]);
    assert.deepEqual(warnings, [
      "popup/index.html: an inline <script> was left out, as an extension page's CSP never runs one",
      "popup/index.html: its images and fonts may not show under Tampermonkey on sites whose CSP limits img-src or font-src",
    ]);
  });

  it("splits a page without <head> or <body> at its first body element, and bundles a module script", async () => {
    const { model, files: all } = extension({ options_ui: { page: "options.html" } }, {
      "options.html": `<meta charset="utf-8"><title>Opts</title><script type="module" src="main.js"></script><h1>Hi</h1><p>there`,
      "main.js": `import { n } from "./n.js"; console.log(n, import.meta.url);`,
      "n.js": "export const n = 1;",
    });
    const { pages } = await bundlePages(model, all, await loadEsbuild());
    const [{ kind, config, code }] = pages;
    assert.equal(kind, "options");
    assert.deepEqual(config.head, [["meta", [["charset", "utf-8"]], []], ["title", [], ["Opts"]]]);
    assert.deepEqual(config.body, [["h1", [], ["Hi"]], ["p", [], ["there"]]]);
    assert.match(code, /__x2uImportMeta\.url/);
    assert.match(code, /\}\)\(\{ url: __x2uBase \+ "main\.js" \}\);$/);
    assert.doesNotMatch(code, /\bimport\b|\bexport\b/);
  });

  it("orders scripts as Chrome runs them, keeps data blocks, and drops inline handlers and links that aren't style sheets", async () => {
    const { model, files: all } = extension({ action: { default_popup: "p.html" } }, {
      "p.html": `<link rel="icon" href="i.png"><script type="module" src="m.js"></script><script defer src="d.js"></script><script src="c.js"></script>
<script type="text/x-template" id="t"><b>{{x}}</b></script><button onclick="go()" ONMOUSEOVER="x()" id="b">go</button>`,
      "i.png": "i", "m.js": "console.log('m')", "d.js": "d()", "c.js": "c()",
    });
    const { pages } = await bundlePages(model, all, await loadEsbuild());
    const [{ config, code, assets }] = pages;
    // Deferred classic scripts and modules run together, in document order, after the others.
    assert.match(code, /^c\(\)\n;\n\(function \(__x2uImportMeta\)[^]*\n;\nd\(\)$/);
    assert.deepEqual(config.head.filter((node) => typeof node !== "string"), [["script", [["type", "text/x-template"], ["id", "t"]], ["<b>{{x}}</b>"]]]);
    assert.deepEqual(config.body, [["button", [["id", "b"]], ["go"]]]);
    assert.deepEqual(assets, []);
  });

  it("leaves out a page whose file is missing, and a script or style sheet that isn't in the extension", async () => {
    const { model, files: all } = extension({ action: { default_popup: "gone.html" }, options_page: "o.html" }, {
      "o.html": `<link rel="stylesheet" href="x.css"><script src="https://cdn.example/lib.js"></script><p>o</p>`,
    });
    const { pages, warnings } = await bundlePages(model, all);
    assert.deepEqual(pages.map((page) => page.kind), ["options"]);
    assert.deepEqual(warnings, [
      "manifest.action: gone.html isn't in the extension, so the popup was left out",
      "o.html links x.css, which isn't in the extension, so it was left out",
      "o.html loads https://cdn.example/lib.js, which isn't in the extension, so it was left out",
    ]);
  });
});
```

In `test/unit/emit.test.ts`, before "lets content code declare its own chrome or browser":

```ts
  it("passes each page's code to start() as a factory whose parameters shadow the page's globals", () => {
    let pages: Record<string, (...args: unknown[]) => () => unknown> = {};
    const runtime = "var __x2uRuntime = { start: (config, code, background, injectables, pages) => __received(pages) };";
    const userscript = emit("// h", "__RUNTIME__", config, [], null, {}, { popup: "return [window, document, globalThis, setTimeout, DOMParser, __x2uBase];" });
    new Function("__received", userscript.replace("__RUNTIME__", runtime))((received: typeof pages) => (pages = received));
    const names = ["chrome", "browser", "window", "self", "globalThis", "document", "location", "history", "localStorage", "fetch", "XMLHttpRequest", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "DOMParser", "__x2uBase"];
    assert.deepEqual(Object.keys(pages), ["popup"]);
    assert.deepEqual(pages.popup(...names)(), ["window", "document", "globalThis", "setTimeout", "DOMParser", "__x2uBase"]);
  });
```

In `test/unit/convert.test.ts`, import `pagesExtension` too, and before "leaves --ignore-assets files out":

```ts
  it("bundles the popup and options pages, with the files they show in the asset table", async () => {
    const { userscript, report } = await convert(pagesExtension(origin), { runtime, esbuild: await loadEsbuild() });
    const config = JSON.parse(/__x2uRuntime\.start\((\{.*?\}), \[\n/s.exec(userscript)?.[1] ?? "{}");
    assert.deepEqual(Object.keys(config.pages), ["popup", "options"]);
    assert.deepEqual([config.pages.popup.path, config.pages.popup.title, config.pages.options.title], ["popup/popup.html", "Pop", "Options"]);
    assert.deepEqual(Object.keys(config.assets), ["icon.png"]);
    assert.match(userscript, /\npopup: function \(chrome, browser, window, /);
    assert.match(userscript, /\noptions: function \(chrome, browser, window, /);
    assert.ok(report.warnings.includes("popup/popup.html: its images and fonts may not show under Tampermonkey on sites whose CSP limits img-src or font-src"));
    assert.doesNotThrow(() => new Function(userscript), "the userscript parses");
  });
```

Add the fixture to `test/support/extension.ts`, and a line for it in the header comment: "pagesExtension has a popup, an options page, a background and a content script talking to each other." Tasks 6 and 7 use it as it stands.

```ts
/**
 * A popup, an options page, a background and a content script talking to each other (spec §6). The popup reports on
 * its own <body>; the content script, on the tab's <html>.
 */
export function pagesExtension(origin: string): ExtensionFiles {
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Pages Sample",
      version: "1.0.0",
      background: { service_worker: "sw.js" },
      host_permissions: [`${origin}/*`],
      action: { default_title: "Pages", default_popup: "popup/popup.html" },
      options_ui: { page: "options.html" },
      commands: { _execute_action: { suggested_key: { default: "Alt+Shift+P" } } },
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"] }],
    }),
    "icon.png": PIXEL,
    "sw.js": `chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.from === "popup") sendResponse("background saw " + sender.url.split("/").slice(3).join("/") + (sender.tab ? " in a tab" : ""));
  if (message === "open popup") {
    chrome.action.openPopup().then(() => sendResponse("opened"), (error) => sendResponse(error.message));
    return true;
  }
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  port.onDisconnect.addListener(() => chrome.tabs.query({ active: true }).then(([tab]) => chrome.tabs.sendMessage(tab.id, { popupClosed: true })));
});`,
    "content.js": `const html = document.documentElement;
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.popupSays) {
    html.dataset.popupSays = message.popupSays + (sender.tab ? " from a tab" : "");
    sendResponse("content ok");
  }
  if (message.popupClosed) html.dataset.popupClosed = "1";
});
html.dataset.content = "ready";
document.addEventListener("x2u-ask-pages", () => chrome.runtime.sendMessage("who is open?").then((reply) => (html.dataset.pagesReply = String(reply))));
document.addEventListener("x2u-open-popup", () => chrome.runtime.sendMessage("open popup").then((reply) => (html.dataset.openPopup = reply)));`,
    "popup/popup.html": `<!doctype html><html><head><meta charset="utf-8"><title>Pop</title><link rel="stylesheet" href="popup.css"></head>
<body><h1 id="title" style="color: rgb(7, 8, 9)">Pages</h1><img id="logo" src="../icon.png"><button id="options">Options</button>
<script src="lib.js"></script><script src="popup.js"></script><script src="broken.js"></script></body></html>`,
    "popup/broken.js": "throw new Error('a broken script');",
    "popup/popup.css": "body { width: 240px; margin: 0; background: url(../icon.png); } h1 { font-size: 20px; }",
    "popup/lib.js": "var shared = 'lib' // no trailing newline",
    "popup/popup.js": `const body = document.body;
body.dataset.shared = shared;
document.addEventListener("DOMContentLoaded", () => (body.dataset.loaded = "1"));
window.addEventListener("load", () => (body.dataset.load = "1"));
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.runtime.sendMessage({ from: "popup" }).then((reply) => (body.dataset.reply = reply));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message === "who is open?") sendResponse("popup, asked by " + (sender.tab ? "a tab" : "?"));
});
chrome.tabs
  .query({ active: true, currentWindow: true })
  .then(([tab]) => chrome.tabs.sendMessage(tab.id, { popupSays: "hi" }))
  .then((reply) => (body.dataset.tabReply = reply));
chrome.action.setBadgeText({ text: "7" }).then(() => chrome.action.getBadgeText({})).then((text) => (body.dataset.badge = text));
localStorage.setItem("seen", "popup");
chrome.runtime.connect({ name: "popup" });
chrome.runtime.getBackgroundPage().then((page) => (body.dataset.backgroundPage = typeof page.chrome), () => (body.dataset.backgroundPage = "elsewhere"));
body.dataset.image = String(getComputedStyle(body).backgroundImage.startsWith('url("blob:'));
body.dataset.top = String(window.top === window && self === window);
const sink = document.createElement("div");
body.append(sink);
try { sink.innerHTML = "<b>ok</b>"; body.dataset.sink = sink.firstChild.nodeName; } catch (error) { body.dataset.sink = "threw: " + error.message; }
try { body.dataset.parsed = new DOMParser().parseFromString("<i>x</i>", "text/html").body.firstChild.nodeName; } catch (error) { body.dataset.parsed = "threw"; }
try { sink.insertAdjacentHTML("beforeend", "<u>y</u>"); body.dataset.adjacent = sink.lastChild.nodeName; } catch (error) { body.dataset.adjacent = "threw"; }
try { sink.innerHTML = '<img src="data:," onerror="document.body.dataset.inline = 1">'; } catch {}`,
    "options.html": `<!doctype html><title>Options</title><p id="seen"></p><script type="module" src="options.js"></script>`,
    "options.js": `import { label } from "./label.js";
document.getElementById("seen").textContent = label(localStorage.getItem("seen"));
document.body.dataset.meta = import.meta.url;`,
    "label.js": 'export const label = (value) => "seen:" + value;',
  });
}
```

- [ ] **Step 2: Run them.**
  - Command: `npm run test:file -- test/unit/pages.test.ts test/unit/emit.test.ts test/unit/convert.test.ts`.
  - Expected: `pages.test.ts` fails to load (`Cannot find module '…/src/convert/pages.ts'`); the emit test fails (no fifth argument); the convert test fails (`config.pages` is undefined).

- [ ] **Step 3: Implement.**
  - **`assets.ts`:** export the three helpers above, and keep `collectAssets`'s results unchanged.
  - **`bundlePages` in `src/convert/pages.ts`.** The pages come from `model.popup` and `model.options`. A page whose file is missing gets the warning in the test and is left out. For each page:
    - **Parse it** with `parseHtml`.
    - **Split head and body.** The root is `<html>` if there is one, else the top level. Its `<head>` and `<body>` children give the parts. Without them, the elements in `meta title link style script base`, and blank text, before the first other node go to the head, and the rest to the body.
    - **The title:** `title` is the trimmed text of the head's `<title>`.
    - **`<script src>`:** resolved with `extensionPath(src, pagePath)`. A missing or remote file gets the "loads … which isn't in the extension" warning.
      - `type="module"` goes to `bundleModule(esbuild, files, file, { format: "iife", define: { "import.meta": "__x2uImportMeta" } })`. It throws `convert: <page> has a module script, which needs the esbuild option` without esbuild. The bundle is wrapped as ``(function (__x2uImportMeta) {\n${code}\n})({ url: __x2uBase + ${JSON.stringify(file)} });``, and `remoteImports` collects its remote imports.
      - Classic files are decoded as they are.
      - Parser-blocking classic scripts go to one list. `defer`, `async` and module scripts go to a second, which comes after the first. Each list keeps document order, and the code is `[...first, ...second].join("\n;\n")`.
    - **Inline `<script>`:**
      - one whose type isn't JavaScript (anything but empty, `module`, or `(text|application)/(x-)?(java|ecma)script`) stays in the tree as a data block;
      - any other is dropped with the "inline <script>" warning.
    - **`<style>`:** its text goes to `css` via `rewriteCssUrls(text, pagePath, keep)`.
    - **`<link rel~=stylesheet>`:** the file goes to `css` via `rewriteCssUrls(text, cssFile, keep)`, or gets the "links … which isn't in the extension" warning. Any other `<link>` is dropped. `keep(file)` adds an existing file to the page's assets.
    - **Attributes:**
      - names starting with `on` are dropped;
      - `src` and `poster` become `assetPlaceholder(file)` when the file exists;
      - in `srcset`, each URL is replaced the same way;
      - in `style`, each `url()` naming an existing file becomes `url("<placeholder>")`;
      - `<a href>` stays as written.
    - **The image and font warning:** if any of the page's assets has an `image/*` or `font/*` MIME type (`mimeOf`), add `<page>: its images and fonts may not show under Tampermonkey on sites whose CSP limits img-src or font-src`. It goes after the page's other warnings.
  - **`emit.ts`:** add the `pages` parameter.
  - **`convert/index.ts`:**
    - call `bundlePages(model, files, options.esbuild)` after `bundleBackground`, with `pageScans = pages.map((page) => scan(page.code))`;
    - add each page's `assets`, its scan's `urls`, and `backgroundFiles(scan.fetches, page.config.path, files)` to `getUrls`;
    - set `config.pages` when there is a page;
    - put the page warnings after the background's;
    - pass `Object.fromEntries(pages.map((page) => [page.kind, page.code]))` to `emit`.

- [ ] **Step 4: Run them.** Same command. Expected: PASS. Then `npm test -- --test-concurrency=2` and `npm run typecheck`. Expected: all pass (the analyzer doesn't see pages until Task 3).

- [ ] **Step 5: Commit.**

```bash
git add src/convert/pages.ts src/convert/assets.ts src/runtime/config.ts src/convert/emit.ts src/convert/index.ts test/unit/pages.test.ts test/unit/emit.test.ts test/unit/convert.test.ts test/support/extension.ts
git commit -m "Bundle the popup and options pages: their DOM tree, CSS, code and files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Report the pages

**Files:**
- Modify: `src/convert/support.ts`, `src/convert/analyze.ts`, `src/convert/index.ts`
- Test: `test/unit/analyze.test.ts`

**Interfaces:**
- Consumes: `pageScans` (Task 2).
- Produces:
  - `analyze(model, scans, background?, pages: ReadonlyArray<{ kind: "popup" | "options"; scan: ScanResult }> = [])`;
  - `PAGE_APIS: Record<string, Support>` in `support.ts`.

- [ ] **Step 1: Write the failing tests.** In `test/unit/analyze.test.ts`, replace "reports the pages and manifest features this version doesn't convert" with:

```ts
  it("reports the popup and options pages as supported, opened from menu commands, and the manifest features this version doesn't convert", () => {
    const { entries, methods } = analyze(
      model({ background: { service_worker: "sw.js" }, action: { default_popup: "p.html" }, options_ui: { page: "o.html" }, chrome_url_overrides: { newtab: "n.html" }, commands: { go: { suggested_key: "Alt+G" } } }),
      [],
    );
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status, entry.contexts]), [
      ["manifest.commands", "partial", ["background"]],
      ["manifest.action.default_popup", "supported", ["popup"]],
      ["manifest.options_ui", "supported", ["options"]],
      ["manifest.chrome_url_overrides", "unsupported", ["background"]],
    ]);
    assert.deepEqual([...methods].sort(), ["registerMenuCommand", "unregisterMenuCommand"]);
  });

  it("reports what the popup and options pages use, in their own contexts", () => {
    const code = "chrome.storage.local.get(); chrome.alarms.onAlarm.addListener(f); chrome.runtime.getBackgroundPage(); chrome.bookmarks.create({}); chrome.notifications.create({})";
    const { entries, methods } = analyze(model({ action: { default_popup: "p.html" } }), [], undefined, [{ kind: "popup", scan: scan(code) }]);
    assert.deepEqual(entries.filter((entry) => entry.subject.startsWith("chrome.")).map((entry) => [entry.subject, entry.status, entry.contexts]), [
      ["chrome.storage.local", "supported", ["popup"]],
      ["chrome.alarms.onAlarm", "partial", ["popup"]],
      ["chrome.runtime.getBackgroundPage", "partial", ["popup"]],
      ["chrome.bookmarks.create", "unsupported", ["popup"]],
      ["chrome.notifications.create", "supported", ["popup"]],
    ]);
    assert.ok(methods.has("notification"));
  });
```

- [ ] **Step 2: Run it.** `npm run test:file -- test/unit/analyze.test.ts`. Expected: FAIL. The popup comes out `unsupported`, and the second test finds no `chrome.*` entries.

- [ ] **Step 3: Implement.**
  - **`support.ts`:**
    - delete `NO_PAGES` and update the header comment (this version converts the pages);
    - `runtime.sendMessage` becomes supported;
    - `runtime.connect` becomes partial, "a port from the background reaches no extension page";
    - add `runtime.openOptionsPage` (supported) and `extension.getViews` (partial, "returns no views: each extension page opens in a tab's modal of its own");
    - in `action(namespace)`, `setPopup` and `getPopup` become partial, "the button keeps the manifest's popup", and add `<namespace>.openPopup`, supported.
  - **`PAGE_APIS`** is `BACKGROUND_APIS` with these overrides:
    - These rows become partial, "fires in the background only, not in the popup or options page", keeping their methods: `alarms.onAlarm`, `contextMenus.onClicked`, `menus.onClicked`, `action.onClicked`, `browserAction.onClicked`, `pageAction.onClicked`, `commands.onCommand`, `notifications.onClicked`, `notifications.onClosed`, `permissions.onAdded`, `permissions.onRemoved`, `runtime.onInstalled` and `runtime.onStartup`.
    - `runtime.connect` is supported.
    - `runtime.getBackgroundPage` and `extension.getBackgroundPage` are partial, "works only in the tab where the background runs".
  - **`analyze.ts`:**
    - each page's scan goes through the same chain walk, with context `kind` and table `PAGE_APIS`;
    - an unknown member is unsupported in any context but `"content"`;
    - `manifest.<key>.default_popup` and `manifest.<options key>` are supported, with `registerMenuCommand` and `unregisterMenuCommand`;
    - rename the local `pages` (extension pages named by `getURL`) to `htmlPages`.
  - **`convert/index.ts`:** pass `pages.map((page, i) => ({ kind: page.kind, scan: pageScans[i] }))` to `analyze`.

- [ ] **Step 4: Run it.** Same command, then `npm test -- --test-concurrency=2`. Expected: PASS, all.

- [ ] **Step 5: Commit.**

```bash
git add src/convert/support.ts src/convert/analyze.ts src/convert/index.ts test/unit/analyze.test.ts
git commit -m "Report the popup and options pages, and what their code uses" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Messaging with extension pages

**Files:**
- Modify: `src/runtime/messaging.ts`, `src/runtime/registry.ts`
- Test: `test/unit/messaging.test.ts`, `test/unit/registry.test.ts`

**Interfaces:**
- Produces:
  - **`messaging.ts`:**
    - `type Endpoint = "content" | "background" | "page"`;
    - `MessagingDeps.pages?(from: Endpoint): number[]`, the tabs with an open page that a message from `from` reaches;
    - `runtime("page")`;
    - `tabsFrom(from: Endpoint)`, which returns `{ sendMessage, connect }`; `tabs` is `tabsFrom("background")`;
    - `emit(type, data, from: Endpoint = "content"): Promise<unknown>`, which resolves to the handler's result;
    - `onEvent(type, handler: (data, sender) => unknown)`, where the handler's value, or what its promise resolves to, is the reply, and a throw or rejection becomes `{ error }`.
  - **`registry.ts`:** `TabState.page?: "popup" | "options"`, carried in beats and in `live()`. It isn't part of `sameState`.

- [ ] **Step 1: Write the failing tests.**

In `test/unit/messaging.test.ts`:
- import `type Endpoint` too;
- give `page()` a fifth parameter `pages?: (from: Endpoint) => number[]`, passed to `createMessaging`;
- its `sender` answers `chrome-extension://ext/popup.html` for `"page"`;
- it returns `page: messaging.runtime("page") as unknown as Runtime` too.

Then add, before "sends a page's event again to the new leader…":

```ts
  it("sends runtime.sendMessage to the background and every open extension page but the sender, and the first answer wins", async (t) => {
    const hub = createHub();
    const open = new Set<number>();
    const pagesFor = (me: number) => (from: Endpoint) => [...open].filter((id) => !(from === "page" && id === me));
    const leader = await page(t, hub, 1, undefined, pagesFor(1));
    await sleep(5);
    const tab = await page(t, hub, 2, undefined, pagesFor(2));
    await eventually(() => leaderOf(tab.registry) === 1 && tab.registry.live().length === 1 && leader.registry.live().length === 1, 1000);
    leader.messaging.setBackgroundReady(true);
    tab.messaging.setBackgroundReady(true);
    open.add(2);
    // The background listens but doesn't answer; the popup in tab 2 does.
    leader.background.onMessage.addListener(() => {});
    tab.page.onMessage.addListener((message, sender, sendResponse) => sendResponse(`page got ${message} from ${sender.url}`));
    assert.equal(await leader.content.sendMessage("hi"), "page got hi from https://site.test/1");
    assert.equal(await leader.background.sendMessage("bg"), "page got bg from chrome-extension://ext/sw.js");
    // A page doesn't hear itself: only the background does, and it doesn't answer.
    assert.equal(await tab.page.sendMessage("self"), undefined);
    open.delete(2);
    await assert.rejects(leader.background.sendMessage("nobody") as Promise<unknown>, { message: NO_RECEIVER });
  });

  it("replies to a page's call with what the background's handler returns, or its error", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    await sleep(5);
    const tab = await page(t, hub, 2);
    leader.messaging.setBackgroundReady(true);
    tab.messaging.setBackgroundReady(true);
    leader.messaging.onEvent("call", async (data) => {
      if (data === "bad") throw new Error("no such member");
      return { got: data };
    });
    assert.deepEqual(await tab.messaging.emit("call", "x", "page"), { got: "x" });
    await assert.rejects(tab.messaging.emit("call", "bad", "page"), { message: "no such member" });
  });
```

In `test/unit/registry.test.ts`, before "sees a tab leave at once…":

```ts
  it("tells the other tabs which extension page a tab has open", async () => {
    const hub = createHub();
    let open: "popup" | undefined;
    const a = await startRegistry(createGm(hub.tab()), "t", 1, () => ({ ...page(), ...(open ? { page: open } : {}) }), SLOW);
    const b = await startRegistry(createGm(hub.tab()), "t", 2, page, SLOW);
    try {
      await eventually(() => b.live().length === 1, 300);
      assert.equal(b.live()[0].page, undefined);
      open = "popup";
      await a.touch();
      await eventually(() => b.live()[0]?.page === "popup", 300);
    } finally {
      await a.stop();
      await b.stop();
    }
  });
```

- [ ] **Step 2: Run them.** `npm run test:file -- test/unit/messaging.test.ts test/unit/registry.test.ts`. Expected: type errors on `"page"`, and FAIL: `tab.page` is undefined, and `live()[0].page` stays undefined.

- [ ] **Step 3: Implement.**
  - **`events`** gains `page`.
  - **`runtime(endpoint).sendMessage`:**
    - an external extension id settles with `{ error: NO_RECEIVER }` at once;
    - otherwise it asks every id in `deps.pages?.(endpoint) ?? []` (`to: "page"`), plus `deps.leader` (`to: "background"`, resent as before) unless `endpoint === "background"`.
  - **Combining the answers** (`firstAnswer`):
    - the first outcome that is an answer (no error and not `none`), or carries an error other than `NO_RECEIVER`, settles the call;
    - when all have settled without one, the result is `{ none: true }` if any said `none`, and `{ error: NO_RECEIVER }` otherwise, as it is with no receivers at all.
  - **`runtime(endpoint).connect`** goes to `deps.leader` for `"content"` and `"page"`, and nowhere for `"background"`. Mark it: `// ponytail: a port reaches the background only, not other extension pages.`
  - **`onEvent`:** an event's reply is `{ data }` from the handler's result, or `{ error }` from its throw or rejection. A throw is still logged.
  - **`registry.ts`:** read `page` back from a beat only when it is `"popup"` or `"options"`.

- [ ] **Step 4: Run them.** Same command, then `npm test -- --test-concurrency=2` and `npm run typecheck`. Expected: PASS, all. The old "An event nobody handles is dropped quietly" still resolves.

- [ ] **Step 5: Commit.**

```bash
git add src/runtime/messaging.ts src/runtime/registry.ts test/unit/messaging.test.ts test/unit/registry.test.ts
git commit -m "Carry messages to open extension pages, and answers back from the background's events" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: localStorage shared across tabs

**Files:**
- Modify: `src/runtime/local-storage.ts`, `src/runtime/keys.ts`
- Test: `test/unit/background-pieces.test.ts`

**Interfaces:**
- Produces: `keys(ns).localStorageDoorbell = x2u:<ns>:ls-keys`. `createLocalStorage`'s signature is unchanged; its copy now follows other tabs.

- [ ] **Step 1: Write the failing test.** In the `createLocalStorage` suite (import `eventually` too):

```ts
  it("follows other tabs' writes, to keys they create too", async () => {
    const hub = createHub();
    const a = await createLocalStorage(createGm(hub.tab()), "t", createLogger("test"));
    const b = await createLocalStorage(createGm(hub.tab()), "t", createLogger("test"));
    a.setItem("theme", "dark");
    await eventually(() => b.getItem("theme") === "dark", 1000);
    b.setItem("theme", "light");
    await eventually(() => a.getItem("theme") === "light", 1000);
    a.removeItem("theme");
    await eventually(() => b.getItem("theme") === null && b.length === 0, 1000);
  });
```

- [ ] **Step 2: Run it.** `npm run test:file -- test/unit/background-pieces.test.ts`. Expected: FAIL, timed out waiting for `b` to see `dark`.

- [ ] **Step 3: Implement**, the way `storage.ts` follows its keys:
  - At start, list every `ls:` key, add a value listener to each, and read its value.
  - A listener applies remote changes only (`remote === true`): a string value sets the key, anything else deletes it.
  - A remote ring of `ls-keys` rescans for keys not yet followed.
  - `setItem` on a key not yet followed follows it after saving, then rings `ls-keys` with `Date.now()`.
  - When following a key the cache already has (this copy wrote it), keep the cache's value: it is newer than a read could be.
  - Update the header comment: the storage serves the background and its pages, and each tab's copy follows the others.

- [ ] **Step 4: Run it.** Same command, then `npm test -- --test-concurrency=2`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/runtime/local-storage.ts src/runtime/keys.ts test/unit/background-pieces.test.ts
git commit -m "Share localStorage across tabs, so pages and the background see each other's writes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The page in a modal

**Files:**
- Create: `src/runtime/ui.ts`, `src/runtime/pages.ts`
- Modify:
  - `src/runtime/global.ts`, `src/runtime/chrome.ts`, `src/runtime/assets.ts`
  - `src/runtime/background.ts`, `src/runtime/index.ts`
  - `src/runtime/menus.ts`, `src/runtime/commands.ts`
- Test: `test/unit/pages-runtime.test.ts`, `test/unit/menus.test.ts`, `test/browser/pages.test.ts`

**Interfaces:**
- Consumes:
  - `PageConfig` and `PageCode` (Task 2);
  - `runtime("page")`, `tabsFrom`, `emit(…, "page")`, `onEvent` with replies, and `deps.pages` (Task 4);
  - `TabState.page` (Task 4);
  - the shared `createLocalStorage` (Task 5).
- Produces:
  - **`global.ts`:** `proxyGlobal(target: object, members: Record<string, unknown>, itself: readonly string[]): typeof globalThis`. It is the proxy core of `createBackgroundGlobal`, which now calls `proxyGlobal(globalThis, members, ["self", "globalThis"])`.
  - **`chrome.ts`:** `platformInfo()` and `RUNTIME_ENUMS`, moved from `background.ts`.
  - **`assets.ts` (runtime):** `placeholders(text)`, which resolves asset placeholders only. `css(text)` is `placeholders`, then `__MSG_`.
  - **`ui.ts`:**
    - `type Modal = { win: Window & typeof globalThis; doc: Document; close(): void }`;
    - `openModal(kind: PageKind, title: string, onClose: () => void): Modal`;
    - `buildPage(doc, page: PageConfig, deps: { gm; assets: Pick<Assets, "css" | "placeholders"> }): Promise<void>`;
    - `finishLoading(win, doc): void`.
  - **`pages.ts`:**
    - `CALLED_IN_BACKGROUND = new Set(["alarms", "contextMenus", "menus", "action", "browserAction", "pageAction", "commands", "notifications", "permissions"])`;
    - `type PagesDeps = { config; code: Partial<Record<PageKind, PageCode>>; gm; log; assets; i18n: object; storage: object; tabs: object; messaging; localStorage(): Promise<Storage>; backgroundGlobal(): unknown; changed(kind: PageKind | undefined): void }`;
    - `createPages(deps)`, which returns `{ open(kind): Promise<void>; current(): PageKind | undefined; url(): string | undefined; close(): void }`;
    - `scopeToPage(chrome: object, cleanups: Array<() => void>): object`.
  - **`background.ts`:**
    - `BackgroundDeps.localStorage(): Promise<Storage>`, replacing its own `createLocalStorage`;
    - `startBackground` resolves to `{ pause; resume; global }`;
    - it handles `messaging.onEvent("call", …)`.
  - **`menus.ts`:** `showMenus` deps gain `open(kind: PageKind): void`, and `emit` returns `Promise<unknown>` (in `commands.ts` too).
  - **`index.ts`:** `start(config, code, background, injectables, pageCode: Partial<Record<PageKind, PageCode>> = {})`.

- [ ] **Step 1: Write the failing tests.**

`test/unit/pages-runtime.test.ts`:

```ts
// The popup and options pages' runtime pieces that run without a DOM.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEvent, createLogger, withFallback } from "../../src/runtime/chrome.ts";
import { scopeToPage } from "../../src/runtime/pages.ts";

describe("scopeToPage", () => {
  it("removes the listeners a page added and disconnects the ports it opened, and nothing else", () => {
    const log = createLogger("test");
    const onMessage = createEvent<() => void>(log);
    const onChanged = createEvent<() => void>(log);
    const disconnected: string[] = [];
    const chrome = {
      // A namespace with fallbacks answers every name, addListener included: it mustn't pass for an event.
      runtime: withFallback(log, "runtime", { onMessage: onMessage.event, connect: (info: { name: string }) => ({ name: info.name, onDisconnect: {}, disconnect: () => disconnected.push(info.name) }) }, "all"),
      storage: { local: { onChanged: onChanged.event } },
    };
    const cleanups: Array<() => void> = [];
    const page = scopeToPage(chrome, cleanups) as typeof chrome;
    const listener = () => {};
    const tabs = () => {};
    page.runtime.onMessage.addListener(listener);
    page.storage.local.onChanged.addListener(listener);
    page.runtime.connect({ name: "popup" });
    onMessage.event.addListener(tabs);
    assert.equal(page.storage.local, page.storage.local);
    for (const cleanup of cleanups) cleanup();
    assert.deepEqual([onMessage.event.hasListener(listener), onMessage.event.hasListener(tabs), onChanged.event.hasListeners()], [false, true, false]);
    assert.deepEqual(disconnected, ["popup"]);
  });
});
```

In `test/unit/menus.test.ts`:
- `setup(extra = {}, persistent = false, open: (kind: string) => void = () => {})` passes `open` to `showMenus`;
- add before "shows no command for a button with a popup…":

```ts
  it("opens the popup and the options page from their menu commands, with the button's title and badge", async () => {
    const page = { path: "p.html", htmlAttributes: [], bodyAttributes: [], head: [], body: [], css: [] };
    const opened: string[] = [];
    const { action, tab } = await setup({ action: { key: "action", title: "Do it", popup: true }, pages: { popup: page, options: page } }, false, (kind) => opened.push(kind));
    await eventually(() => tab.captions().length === 2, 1000);
    assert.deepEqual(tab.captions(), ["Open Do it", "Ext options"]);
    await action.setBadgeText({ text: "4" });
    await eventually(() => tab.captions().includes("Open Do it (4)"), 1000);
    tab.click("Open Do it (4)");
    tab.click("Ext options");
    assert.deepEqual(opened, ["popup", "options"]);
  });
```

`test/browser/pages.test.ts`: the file below, with only the first five tests and "opens the pages from their menu commands, on the emulator". Task 7 adds the rest. Import `NO_RECEIVER` and `popupOnlyExtension` in Task 7, when they are first used.

```ts
// The popup and options pages end to end (spec §6), on each backend in X2U_BACKENDS (default: the CI emulator).
// Release tier: X2U_BACKENDS=tm,vm with the bench profile from `npm run bench:setup`.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Frame, Page } from "playwright";
import { backendsFromEnv, startSession, type Session } from "../../bench/session.ts";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { convert } from "../../src/convert/index.ts";
import { loadRuntime } from "../../src/convert/runtime-node.ts";
import type { ExtensionFiles } from "../../src/convert/unpack.ts";
import { waitForAttr } from "../support/dom.ts";
import { pagesExtension } from "../support/extension.ts";
import { startServer, type Server } from "../support/server.ts";
import { sleep } from "../support/time.ts";

const html = (head = "", headers: Record<string, string> = {}) => () =>
  new Response(`<!doctype html><html><head><title>x2u</title>${head}</head><body>page</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

/** The modal's iframe, once it holds `has`. */
async function modalFrame(tab: Page, has: string): Promise<Frame> {
  for (let waited = 0; waited < 10_000; waited += 100) {
    for (const frame of tab.frames()) {
      if (frame !== tab.mainFrame() && !frame.isDetached() && (await frame.locator(has).count().catch(() => 0)) > 0) return frame;
    }
    await sleep(100);
  }
  throw new Error(`no modal frame with ${has}`);
}

async function frameAttr(frame: Frame, selector: string, name: string, expected: string | RegExp): Promise<void> {
  let last: string | null = null;
  for (let waited = 0; waited < 10_000; waited += 100) {
    last = await frame.locator(selector).getAttribute(name);
    if (last !== null && (typeof expected === "string" ? last === expected : expected.test(last))) return;
    await sleep(100);
  }
  throw new Error(`${selector}[${name}] is ${last}, not ${expected}`);
}

async function until(ok: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 100) {
    if (await ok()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A converted extension in a session, and a way to open a test page that has joined the other tabs. */
function harness(backend: (typeof backends)[number], extension: (origin: string) => ExtensionFiles) {
  const state: { site?: Server; session?: Session } = {};
  before(async () => {
    state.site = await startServer({
      "/page.html": html(),
      // A site that hides every element and moves <html> (which moves a fixed element that isn't in the top layer).
      "/hostile.html": html("<style>html > * { display: none !important; } html { transform: translateX(-50px); }</style>"),
      "/style-csp.html": html("", { "content-security-policy": "style-src 'self'; img-src 'self'" }),
      "/trusted-types.html": html("", { "content-security-policy": "require-trusted-types-for 'script'" }),
    });
    const { userscript } = await convert(extension(state.site.origin), { runtime: await loadRuntime(), esbuild: await loadEsbuild() });
    state.session = await startSession(backend, userscript);
  });
  after(async () => {
    await state.session?.close();
    await state.site?.close();
  });
  return {
    session: () => state.session as Session,
    open: async (path: string): Promise<Page> => {
      const tab = await (state.session as Session).context.newPage();
      await tab.goto(`${(state.site as Server).origin}${path}`);
      await waitForAttr(tab, "data-content", "ready");
      // Content scripts run at once; the tab joins the others, and the leader starts its background, a moment later.
      await sleep(1_000);
      return tab;
    },
  };
}

const backends = backendsFromEnv();
for (const backend of backends) {
  describe(`popup and options pages on ${backend}`, () => {
    const { open, session } = harness(backend, pagesExtension);

    it("opens the popup with its shortcut and runs it with its own chrome object, until it closes", async () => {
      const tab = await open("/page.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      // Its scripts ran in order, after the DOM was built, then DOMContentLoaded and load; broken.js threw last.
      await frameAttr(popup, "body", "data-shared", "lib");
      await frameAttr(popup, "body", "data-loaded", "1");
      await frameAttr(popup, "body", "data-load", "1");
      // Its CSS, with images as blob URLs, and its style attribute; the popup is as wide as its body.
      await frameAttr(popup, "body", "data-image", "true");
      assert.equal(await popup.locator("#title").evaluate((title) => getComputedStyle(title).color), "rgb(7, 8, 9)");
      assert.ok((await popup.locator("#logo").evaluate((img: HTMLImageElement) => img.naturalWidth)) > 0);
      assert.equal((await (await popup.frameElement()).boundingBox())?.width, 240);
      // Its chrome object: messages to the background and the tab's content script, the button's state in the
      // background, and the background's own global in the tab where it runs.
      await frameAttr(popup, "body", "data-reply", "background saw popup/popup.html");
      await frameAttr(popup, "body", "data-tab-reply", "content ok");
      await waitForAttr(tab, "data-popup-says", "hi");
      await frameAttr(popup, "body", "data-badge", "7");
      await frameAttr(popup, "body", "data-background-page", "object");
      await frameAttr(popup, "body", "data-top", "true");
      // A content script's message reaches the open popup.
      await tab.evaluate(() => document.dispatchEvent(new Event("x2u-ask-pages")));
      await waitForAttr(tab, "data-pages-reply", "popup, asked by a tab");

      await tab.keyboard.press("Escape");
      await until(() => popup.isDetached(), "the popup to close");
      // Its port disconnects, and its listeners are gone: the background listens but doesn't answer this one.
      await waitForAttr(tab, "data-popup-closed", "1");
      await tab.evaluate(() => document.dispatchEvent(new Event("x2u-ask-pages")));
      await waitForAttr(tab, "data-pages-reply", "undefined");
      await tab.close();
    });

    it("opens one popup however often it is asked, and runs it in a tab that doesn't lead", async () => {
      const leader = await open("/page.html");
      const tab = await open("/page.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      await tab.keyboard.press("Alt+Shift+P");
      await frameAttr(popup, "body", "data-reply", "background saw popup/popup.html");
      await frameAttr(popup, "body", "data-background-page", "elsewhere");
      assert.equal(tab.frames().filter((frame) => frame !== tab.mainFrame()).length, 1);
      assert.equal(popup.isDetached(), false);
      await tab.close();
      await leader.close();
    });

    it("shows the modal over a site that hides every element, moves <html> and covers itself with an overlay", async () => {
      const tab = await open("/hostile.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      await frameAttr(popup, "body", "data-load", "1");
      await tab.evaluate(() => {
        const cover = document.createElement("div");
        cover.style.cssText = "position: fixed; inset: 0; z-index: 2147483647; display: block !important; background: red;";
        document.documentElement.append(cover);
      });
      const box = await (await popup.frameElement()).boundingBox();
      const width = tab.viewportSize()?.width ?? 0;
      assert.ok(box && box.width === 240 && box.x + box.width <= width && box.x + box.width >= width - 20, `the popup sits at the top right: ${JSON.stringify(box)}`);
      // What the user sees at the popup's centre is the modal's host, not the site's overlay.
      const onTop = await tab.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.style.background, [box.x + box.width / 2, box.y + box.height / 2]);
      assert.equal(onTop, "transparent");
      await tab.close();
    });

    it("applies the page's CSS on a site whose CSP blocks inline styles", { skip: backend === "emulator" ? "the emulator's addElement doesn't get past a page's CSP" : false }, async () => {
      const tab = await open("/style-csp.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      await frameAttr(popup, "body", "data-load", "1");
      assert.equal(await popup.locator("body").evaluate((body) => getComputedStyle(body).width), "240px");
      assert.equal(await popup.locator("#title").evaluate((title) => getComputedStyle(title).color), "rgb(7, 8, 9)");
      await tab.close();
    });

    it("lets the popup write HTML on a site that enforces Trusted Types, and runs none of its inline handlers", async () => {
      const tab = await open("/trusted-types.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      await frameAttr(popup, "body", "data-load", "1");
      const body = popup.locator("body");
      assert.deepEqual([await body.getAttribute("data-sink"), await body.getAttribute("data-parsed"), await body.getAttribute("data-adjacent")], ["B", "I", "U"]);
      await sleep(500);
      assert.equal(await body.getAttribute("data-inline"), null);
      await tab.close();
    });

    it("opens the pages from their menu commands, on the emulator", { skip: backend !== "emulator" }, async () => {
      const tab = await open("/page.html");
      const emulator = session().emulator;
      assert.ok(emulator);
      await until(async () => (await emulator.menu(tab)).length === 2, "two menu commands");
      assert.deepEqual((await emulator.menu(tab)).map((caption) => caption.replace(/ \(\d+\)$/, "")).sort(), ["Open Pages", "Pages Sample options"]);
      assert.equal(await emulator.clickMenu(tab, "Pages Sample options"), true);
      await modalFrame(tab, "#seen");
      await tab.close();
    });
  });
}
```

- [ ] **Step 2: Run them.**
  - Commands: `npm run test:file -- test/unit/pages-runtime.test.ts test/unit/menus.test.ts`, then `npm run test:file -- test/browser/pages.test.ts`.
  - Expected:
    - `pages-runtime.test.ts` fails to load (no `src/runtime/pages.ts`);
    - the menus test fails, with captions `[]`;
    - the browser tests fail with `no modal frame with #title`; the menu test times out waiting for two menu commands; the CSP test is skipped on the emulator.

- [ ] **Step 3: Implement the modal in `src/runtime/ui.ts`.** Everything the runtime styles uses `element.style.cssText`.
  - **The host:** a `div` with `all: initial !important; display: block !important; position: fixed !important; inset: 0 !important; width: auto !important; height: auto !important; z-index: 2147483647 !important; background: transparent !important; border: 0 !important; margin: 0 !important; padding: 0 !important; overflow: visible !important`. It is appended to `document.documentElement`, then given `host.popover = "manual"` and `host.showPopover?.()`.
  - **A closed shadow root** holds:
    - a backdrop: `position: fixed; inset: 0`, transparent for the popup, `rgba(0, 0, 0, 0.4)` for the options page; a click on it closes;
    - a panel: `position: fixed`, a flex column, white, rounded 8px, with a shadow.
      - Popup: `top: 8px; right: 8px`.
      - Options: centred, `width: min(960px, calc(100vw - 32px)); height: calc(100vh - 64px)`, with a title bar (the extension's name, and a `×` button with `aria-label="Close"` that closes).
    - the iframe inside the panel: no `src`, `border: 0`, `display: block`. It takes `contentWindow` and `contentDocument` synchronously, and throws `the page's frame has no document` without them.
  - **In the iframe's head:**
    - first a `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'">`;
    - then `win.trustedTypes?.createPolicy("default", { createHTML: (html) => html })` in a `try`. A site that allows named policies only throws here; that is the ceiling.
  - **Closing:** keydown Escape (capture) on the tab's window and the iframe's, the backdrop, the close button, or `Modal.close()`. Closing happens once. It:
    1. removes the tab listener;
    2. dispatches `pagehide` then `unload` (as `new win.Event(type)`) on the iframe window, ignoring throws;
    3. removes the host;
    4. calls `onClose`.
  - **Popup size:** set `doc.documentElement.style.width = "fit-content"` and the frame to 800px wide. A `new win.ResizeObserver` on `<html>` then sets the frame to:
    - width: `min(800, max(25, ceil(rect.width)))`;
    - height: `min(600, max(25, ceil(scrollHeight)))`.

  **`buildPage`:**
  - sets `htmlAttributes` on `<html>` and `bodyAttributes` on `<body>`, and `doc.title` from `title`;
  - builds the head (without `<title>`), then the body;
  - **Elements:** `doc.createElement`, or `createElementNS` for an `svg` (SVG namespace) or `math` (MathML) subtree. A `foreignObject`'s children are HTML again, and a `<template>`'s children go into its `content`.
  - **Attributes:** `style` is set with `style.cssText = assets.placeholders(value)`; every other attribute with `setAttribute(name, assets.placeholders(value))`.
  - **CSS:** then each CSS text, in order, with `await gm.addElement(doc.head, "style", { textContent: assets.css(text) })`.

  **`finishLoading`:** dispatches `new win.Event("DOMContentLoaded", { bubbles: true })` on the document, then `load` on the window in a `setTimeout`.

- [ ] **Step 4: Implement the page runtime in `src/runtime/pages.ts`.**

  **`createPages`:**
  - **`open(kind)`:**
    1. It throws `ext2userscript: this extension has no <kind> page` when `config.pages[kind]` is missing.
    2. It waits for any opening in progress. The opening promise must never stay rejected: `opening = (async () => {…})().catch(log and close)`.
    3. If that kind is open, it focuses its window and returns. If the other kind is open, it closes that one.
    4. It opens the modal, sets `current`, and calls `changed(kind)`.
    5. **In `onClose`:** it runs the page's cleanups, each in a `try` that logs. Only if this modal is still `current` does it clear `current` and call `changed(undefined)`.
    6. **Then, in order:**
       - awaits `localStorage()`;
       - awaits `buildPage`;
       - creates a network shim with `base: () => "chrome-extension://<id>/<path>"`, `cookies: "unless-omitted"`, and the `background.ts` settings otherwise;
       - builds `chrome = scopeToPage(pageChrome(…), cleanups)`;
       - builds `global = proxyGlobal(modal.win, { chrome, browser: chrome, localStorage, fetch, XMLHttpRequest, close: () => modal.close(), frameElement: null, opener: null }, ["window", "self", "globalThis", "top", "parent", "frames"])`.
    7. It calls the code as `code(chrome, chrome, global, global, global, modal.doc, modal.win.location, modal.win.history, localStorage, fetch, XMLHttpRequest, global.setTimeout, global.setInterval, global.clearTimeout, global.clearInterval, modal.win.DOMParser, "chrome-extension://<id>/")()`. A throw is logged as ``the ${kind} page's code failed:``.
    8. Finally it calls `finishLoading`.
  - **`url()`:** the open page's `chrome-extension://<id>/<path>`.

  **`pageChrome`.** It is a proxy like the background's `chrome`: a missing namespace gets `withFallback(…, "all")`. It holds:
  - **`runtime`** (`withFallback(…, "all")`): `id`, `lastError`, `getURL`, `getManifest`, `...messaging.runtime("page")`, `getPlatformInfo`, `RUNTIME_ENUMS`.
    - `onInstalled`, `onStartup` and `onSuspend` are events that never fire.
    - `getBackgroundPage` resolves `backgroundGlobal()`, or rejects with `ext2userscript: the background runs in another tab, so its page can't be reached from here` when that is undefined.
  - **`extension`:** `getURL`, `getBackgroundPage` (synchronous; `null` where the promise form would reject), `getViews: () => []`, `inIncognitoContext: false`, and `lastError`.
  - **`storage`** and **`i18n`:** the tab's.
  - **`tabs`:** `{ ...tabs, ...scripting.tabs, ...messaging.tabsFrom("page") }`.
  - **`scripting`:** from `createScripting` with `currentTab` set to the active tab.
  - **`windows`:** from `createWindows(tabs)`.
  - **`cookies`:** from `createCookies`.
  - **Every `CALLED_IN_BACKGROUND` namespace:** a proxy whose members are cached per name.
    - An `on[A-Z]…` member is an inert event. Its `addListener` logs once `ext2userscript: chrome.<ns>.<name> fires in the background only; the page's listener will never be called`.
    - Any other member is `method(log, (...args) => messaging.emit("call", { namespace, member, args }, "page"))`.
    - `then` and `toJSON` are undefined.

  **`scopeToPage`:** wraps objects recursively. Each wrapper is cached in a `WeakMap`, so reads compare equal.
  - An object is an event when it has **own** properties `addListener` and `removeListener`. A namespace with fallbacks answers every name, so a property read can't tell.
  - An event's wrapper records `removeListener(listener)` in `cleanups` for each `addListener`.
  - Any other object's wrapper wraps a `connect` function so that a returned port (one with `disconnect` and `onDisconnect`) gets `port.disconnect()` in `cleanups`. It wraps object members, and passes everything else through.

- [ ] **Step 5: Wire it in.**
  - **`global.ts`:** extract `proxyGlobal`. `createBackgroundGlobal` keeps its behaviour, and its tests in `background-pieces.test.ts` still pass.
  - **`chrome.ts`:** move `platformInfo` (renamed from `platform`) and `RUNTIME_ENUMS` here.
  - **`background.ts`:**
    - take `localStorage` from deps;
    - after `known` is built, `messaging.onEvent("call", ({ namespace, member, args }) => …)` calls `known[namespace][member](...args)` for a namespace in `CALLED_IN_BACKGROUND`, and throws `ext2userscript: chrome.<ns>.<member> isn't available` otherwise;
    - resolve `global` (the background's global object) with `pause` and `resume`.
  - **`menus.ts`, `showMenus`.** When the action exists and is enabled:
    - if `config.pages?.popup` exists and the button has a popup (manifest or state), add `Open <caption>`, which calls `open("popup")`;
    - else, if it has none, add the click command as before.

    Then, if `config.pages?.options` exists, add `<name> options`, which calls `open("options")`. Captions keep Plan 3b's badge format.
  - **`index.ts`:**
    - keep one `localStorage()` promise per tab, shared by the background and the pages;
    - `state()` adds `page: pages.current()` when a page is open;
    - the messaging deps get `sender("page") = { id, url: pages.url(), origin: "chrome-extension://<id>" }`;
    - `pages(from)` is this tab (if a page is open here and `from !== "page"`) plus every live tab whose `page` is set;
    - after joining, a top frame with `config.pages` gets `createPages({ …, tabs: pageTabs.api, backgroundGlobal: () => (leading ? handle?.global : undefined), changed: () => void joined.touch() })`;
    - `showMenus` runs on top frames when there is a background or pages, with `open: (kind) => void pages?.open(kind)`;
    - the election still needs a background (Task 7 changes that);
    - the shortcut listener's `emit` is wrapped: `_execute_action`, `_execute_browser_action` and `_execute_page_action` open the popup in this top frame when `config.pages?.popup` exists, and anything else goes to `messaging.emit`. It still listens only when there is a background; Task 7 widens that too.

- [ ] **Step 6: Run them.** The Step 2 commands, then `npm test -- --test-concurrency=2` and `npm run typecheck`. Expected: PASS, all. The CSP browser test is skipped on the emulator.

- [ ] **Step 7: Commit.**

```bash
git add src/runtime/ui.ts src/runtime/pages.ts src/runtime/global.ts src/runtime/chrome.ts src/runtime/assets.ts src/runtime/background.ts src/runtime/index.ts src/runtime/menus.ts src/runtime/commands.ts test/unit/pages-runtime.test.ts test/unit/menus.test.ts test/browser/pages.test.ts
git commit -m "Open the popup and options page in a modal, with their own chrome object" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Opening pages from code, and pages without a background

**Files:**
- Modify: `src/runtime/pages.ts`, `src/runtime/background.ts`, `src/runtime/index.ts`, `README.md`
- Test: `test/browser/pages.test.ts`, `test/support/extension.ts`

**Interfaces:**
- Consumes: `createPages` and `open` (Task 6), and `messaging.control` (Plan 3).
- Produces:
  - **Control op:** `"open-page"` with `{ kind }`, answered by `pages.open(kind)`.
  - **`runtime.openOptionsPage`:** in a page it opens the options page in the same tab; in the background it does `openPage("options")`.
  - **`action.openPopup`** (with `browserAction` and `pageAction`): `openPage("popup")`. `openPage` sends `"open-page"` to the first tab of `tabs.query({ active: true, lastFocusedWindow: true })`, or rejects with ``ext2userscript: no tab is open to show the ${kind} page in``.
  - **`BackgroundDeps.code`:** `BackgroundCode | null`. With `null`, the leader keeps the extension's state (menus, alarms, the button, notifications, permissions and their `call` handler) and runs no code.

- [ ] **Step 1: Write the failing tests.**

Add `popupOnlyExtension` to `test/support/extension.ts`, and a line for it in the header comment: "popupOnlyExtension has a popup and no background."

```ts
/** A popup and a content script, without a background: the leader keeps the button's state for the popup. */
export function popupOnlyExtension(origin: string): ExtensionFiles {
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Popup Only",
      version: "1.0.0",
      action: { default_title: "Only", default_popup: "popup.html" },
      commands: { _execute_action: { suggested_key: { default: "Alt+Shift+P" } } },
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"] }],
    }),
    "content.js": 'document.documentElement.dataset.content = "ready";',
    "popup.html": '<!doctype html><p id="out"></p><script src="popup.js"></script>',
    "popup.js": `const out = document.getElementById("out");
chrome.action.setBadgeText({ text: "1" }).then(() => chrome.action.getBadgeText({})).then((text) => (out.dataset.badge = text));
chrome.runtime.sendMessage("anyone?").then(() => (out.dataset.send = "answered"), (error) => (out.dataset.send = error.message));`,
  });
}
```

In `test/browser/pages.test.ts`, import `NO_RECEIVER` from `../../src/runtime/messaging.ts` and `popupOnlyExtension`. Add these to the first `describe`, before the emulator's menu test:

```ts
    it("moves from the popup to the options page, which shares localStorage and gives each module its own import.meta.url", async () => {
      const tab = await open("/page.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      await popup.locator("#options").click();
      const options = await modalFrame(tab, "#seen");
      await until(() => popup.isDetached(), "the popup to close");
      await until(async () => (await options.locator("#seen").textContent()) === "seen:popup", "the options page to read localStorage");
      await frameAttr(options, "body", "data-meta", /^chrome-extension:\/\/[a-p]{32}\/options\.js$/);
      await tab.close();
    });

    it("opens the popup from the background with action.openPopup", async () => {
      const tab = await open("/page.html");
      await tab.evaluate(() => document.dispatchEvent(new Event("x2u-open-popup")));
      await waitForAttr(tab, "data-open-popup", "opened");
      await modalFrame(tab, "#title");
      await tab.close();
    });
```

And a second `describe` in the loop:

```ts
  describe(`a popup without a background on ${backend}`, () => {
    const { open } = harness(backend, popupOnlyExtension);

    it("keeps the popup's badge on the leader, and its message for the background has no receiver", async () => {
      const tab = await open("/page.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#out");
      await frameAttr(popup, "#out", "data-badge", "1");
      await frameAttr(popup, "#out", "data-send", NO_RECEIVER);
      await tab.close();
    });
  });
```

- [ ] **Step 2: Run it.** `npm run test:file -- test/browser/pages.test.ts`. Expected: FAIL on the three new tests:
  - no modal frame with `#seen`;
  - `data-open-popup` is `ext2userscript: chrome.action.openPopup is not available in userscripts`;
  - `#out[data-badge]` is `undefined`. Without a leader keeping state, the call has no handler.

- [ ] **Step 3: Implement.**
  - **`pages.ts`:** the page's `runtime.openOptionsPage` is `method(log, () => open("options"))`.
  - **`background.ts`:**
    - `const background = deps.code ? config.background : undefined`;
    - the code, its global, its network shim and the service worker's `install`/`activate` move into a function that runs only when `background` is set;
    - `persistent` is false without one;
    - `onInstalled` and `onStartup` still dispatch;
    - add `openPage`, `runtime.openOptionsPage`, and `openPopup` on the shared `action` object.
  - **`index.ts`:**
    - `const hosting = background !== null || config.pages !== undefined`;
    - only without `hosting` is `setBackgroundReady(true)` called at start; otherwise the leader's `startBackground` sets it, so a page's `call` waits for the leader's state;
    - the shortcut listener and the election run when `hosting`;
    - the control handler answers `"open-page"` with `pages.open(args.kind)`, or throws `this tab isn't ready` before the pages exist.
  - **`README.md`, Usage:** replace "Popups and options pages come next, and the report says what didn't convert." with "Popups and options pages open in a modal over the page, from the userscript manager's menu ("Open <button>", "<name> options"), the toolbar button's shortcut, `action.openPopup` or `runtime.openOptionsPage`. The report says what didn't convert."

- [ ] **Step 4: Run it.** Same command, then `npm test -- --test-concurrency=2`, `npm run typecheck`, and `npm run test:browser`. Expected: PASS, apart from the known Firefox S3 failure on macOS 27.

- [ ] **Step 5: Release tier**, with the bench profile:
  - `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/pages.test.ts`. Expected: all pass. The two emulator-only menu tests are skipped.
  - `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/content-runtime.test.ts`. Expected: 32 of 32.
  - Then check that no Chrome for Testing process is left running.

- [ ] **Step 6: Commit.**

```bash
git add src/runtime/pages.ts src/runtime/background.ts src/runtime/index.ts README.md test/browser/pages.test.ts test/support/extension.ts
git commit -m "Open pages from the background and the options button, and keep their state without a background" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After Plan 4

- **Plan 5:** the web app (spec §8). The converter is unchanged by it. The page parser and bundler run in its worker as they are, since `html.ts` and `pages.ts` use no Node or DOM API.
- **Ceilings this plan states:**
  - **Implied HTML structure:** the parser covers only the implied end tags in Task 1.
  - **Pages and ports:** a port reaches the background only; `extension.getViews()` is empty.
  - **Events in pages:** the state the background keeps fires its events there only.
  - **Leaving the page:** a link or `location` change to another extension page leaves it.
  - **Images under a strict CSP:** Tampermonkey's `blob:` images where the site's CSP limits `img-src`.
  - **Trusted Types with named policies:** a site whose CSP allows only named policies, without `default`.
  - **Bare globals:** other than the wrapper parameters, they reach the userscript's global, as for the background.
