# Deferred review findings

The final reviews of Plans 2–7 rated these Minor and left them for later. Triaged on 2026-10-21, before 0.1.0:
- **Fixed:** a user would hit it, and the fix was small.
- **Accepted:** a design limit, a tooling or test gap, or a cost with no user effect.
- **Open:** real, but rare or costly to fix. A candidate for a later plan.

## Plan 2: converter core and CLI

| Finding | Status |
|---|---|
| The "a failing group doesn't stop the others" test can't fail: its broken file is an idle group, which runs in its own task anyway | Accepted (test gap) |
| `getMessage("constructor")` and asset paths named like prototype members return `Object`'s members | Fixed, 650fdcd |
| CSS `url()` edge cases: a `#fragment` is dropped, quoted paths with `(` or `'`, `@import "x.css"`, upper-case `URL(`, and `url()` in comments | Open |
| Concatenated content files: a throw in one file stops the later files of its group; a syntax error stops every group; a later file's `"use strict"` is lost; `var chrome = chrome` shadows the parameter | Accepted (spec §3.3 design) |
| The extension-ID test and error don't cover every case they name | Accepted (test gap) |

## Plan 3: background and messaging

| Finding | Status |
|---|---|
| `sendMessage` and `connect` throw after `pagehide` | Accepted (the page is leaving) |
| Fakes for unimplemented APIs are one level deep and can't be used with `new` (`new chrome.declarativeContent.PageStateMatcher`) | Open |
| `global.ts` set and delete throw where Violentmonkey refuses, and `Object.defineProperty` on the global isn't handled | Open |
| A worker's `self.window` and `self.document` reach the page's real objects | Accepted (isolation limit) |
| The leader's own `pushState` URL and title reach its background late | Accepted |
| `tabs.update(undefined, {url})` ignores the URL | Fixed, 650fdcd |

## Plan 3b: background APIs

| Finding | Status |
|---|---|
| Re-opening a GM-routed XHR while a request is in flight breaks it | Open |
| Menu renders aren't merged: 20 items cost about 400 register/unregister calls per tab | Accepted (end state is right) |
| A notification icon given by `getURL` may show without its icon | Open (the managers can't load `blob:` URLs there) |
| A leader that stepped down can still write its stale alarm schedule | Open |
| `insertCSS` doesn't resolve `url()` or `__MSG_x__`, and a missing file is silently empty | Open |
| The menu-command grant is missing when a button without a popup only calls `setIcon`, so every tab logs an error | Fixed, e571b74 |
| `setPopup({ popup: "" })` can't switch an extension with a popup over to `onClicked` | Open |
| Violentmonkey keys menu commands by caption, so two items with one caption collide | Accepted (manager limit) |
| A parent-id cycle hangs every tab's menu render | Fixed, 650fdcd (`update` refuses it, as Chrome does) |
| Binary responses are tested only against a fake, not on real managers | Accepted (test gap) |

## Plan 4: popup and options pages

| Finding | Status |
|---|---|
| The report lists the tabs events as supported in pages, though they fire only in the background's tab | Fixed, e571b74 |
| …and describes `setUninstallURL` wrongly in pages | Open (wording) |
| A page's remote module imports aren't reported | Fixed, e571b74 |
| Escape doesn't check that the key press came from the user | Accepted (a site can remove the modal anyway) |
| The modal can't be used while a site's own modal dialog is open | Open |
| After the site removes the modal or re-renders `<html>`, the popup can't be reopened in that tab | Open |
| The shortcut opens the popup even when the button is disabled or hidden | Open |
| The popup's sizing overrides a page's own `<html>` width | Open |
| Without a background, `getBackgroundPage`'s error says "runs in another tab" | Open (wording) |
| Named entities such as `&rsquo;` and `&euro;` stay literal | Fixed, d0c5910 (Latin-1 and common symbols, case-sensitive) |
| The parser repeats a little work per script and style element | Accepted |

## Plan 5: web app

| Finding | Status |
|---|---|
| The proxy URL is joined to `?src=` as text, and an unreachable proxy shows only "Failed to fetch" | Open |
| A retried esbuild download shows "Converting…" instead of "Loading esbuild…" | Open (wording) |
| The store-link field's border has 1.29:1 contrast, and its hint isn't linked to it | Fixed, 349969a |
| The page uses regex lookbehind, which Safari before 16.4 can't parse | Accepted |
| No test checks the proxy's error answers carry the CORS header | Accepted (test gap) |
| The 20 MB test doesn't check the page stays responsive | Accepted (test gap; measured by hand) |
| The Pages job has no concurrency group, and no README says how to turn Pages on | Fixed, 349969a |
| A near-50 MB download may come close to Cloudflare's 128 MB memory limit in the proxy | Open (unverified) |

## Plan 6: benchmark

| Finding | Status |
|---|---|
| A case script that crashes on import stops the run | Accepted (unit tests import every script first) |
| The order is fixed (original, ext2userscript, the baseline), so late rate-limiting hurts the baseline most | Accepted |
| On served pages, the emulator's requests bypass the served routes | Accepted (no check depends on it) |
| Each profile copy keeps the userscripts already installed in the base profile | Accepted |
| Two `package.json` script lines lack the space after the colon | Fixed, 349969a |
| The scorecard's commit stamp doesn't show uncommitted changes | Open |
| The spec's status line doesn't mention Plan 6's corrections | Open (docs) |

## Plan 7: closing the scorecard's gaps

| Finding | Status |
|---|---|
| A content group with module imports loses its leading `"use strict"` | Open |
| The Trusted Types check makes a real violation report, and the wrapped functions are visible, so a site can detect a converted extension | Accepted |
| A Trusted Types rule set by a `<meta>` tag is missed at `document_start` | Open |
| The emulator's `GM_addElement` fails on pages that name their allowed policies | Accepted (test tool; no corpus case) |
| `@connect` picks up namespace URLs such as `www.w3.org` | Fixed, d0c5910 |
| `import(x && getURL(…))` is rewritten wrongly, dropping the rest of the expression | Open |
| A module with remote imports is rebuilt, and warned about, once per call site | Accepted |
| A content module also in `web_accessible_resources` is embedded twice | Open: since Plan 10 its asset copy is deflated, and a MAIN-world script in the same position is embedded once |
| `location.reload()` in the background throws a TypeError rather than a named error | Open (wording) |
