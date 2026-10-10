# Plan 1 spike findings

Results of spikes S1–S4 (spec §11): what ran, on which versions, and what it means for the spec.

## S1: GM functions, isolation and addElement timing in real managers

Run: `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/conformance.test.ts`

| | Tampermonkey | Violentmonkey |
|---|---|---|
| Version and Web Store ID | 5.5.1, `dhdgffkkebhmkfjojejmpbldmpobfkfo` | 2.49.0 (stable, MV3), `jinjaccalgkegednnccohejagnlnfdag` |
| Unpacked extension ID in the bench profile | `adofcjchnifhjnakbobdofhfpjiclbpk` | `eolhikiimbhmmjepeghhbnofjhhpbnib` |
| `handler` and `caps` (from the log line) | `Tampermonkey`; `valueListeners`, `menus`, `cookies` all true | `Violentmonkey`; `valueListeners`, `menus`, `cookies` all true |
| Single-page contract | FAIL. First failing assertion: `pageSawSync`, "a script injected at document-start must run before the page's own scripts" (expected `"1"`, got `"no"`) | FAIL. Same assertion, same values |
| Strict-CSP page-world injection | FAIL. `pageSawSync` expected `"1"`, got `"no"` (the same assertion as above, on the CSP page) | FAIL. Same assertion, same values |
| Remote value change | PASS | PASS |
| Chromium build | Chromium 156.0.8078.4 (Playwright 1.64.0, `channel: "chromium"`), headless | same |
| Install-flow change needed | Yes: navigate to the `.user.js` again if no install button appears within 10 s (up to 3 attempts) | Yes: the install button's accessible name is `Install (⌘Enter)`, so the button pattern now allows a trailing parenthesis |
| Probe change needed | Yes: the userscript started after `DOMContentLoaded`, so the probe now runs at once when `document.readyState` isn't `loading` | same |

The emulator runs userscripts in the page world and doesn't bypass page CSP, so isolation (pageGlobalVisible) and the strict-CSP check are only meaningful on Tampermonkey and Violentmonkey.

Raw log lines from the run (the `done: true` object each probe left on `<html data-x2u-conformance>`):

```
[tm]     {"startReadyState":"complete","addElementSync":true,"caps":{"valueListeners":true,"menus":true,"cookies":true},"handler":"Tampermonkey","pageSawSync":"no","pageSawWorld":"undefined","pageGlobalVisible":false,"addElementResolved":true,"roundtrip":true,"listed":true,"deleted":true,"localListener":{"value":"local","remote":false},"menu":true,"xhrJson":true,"xhrBytes":true,"openInTab":true,"notification":true,"cookieSet":true,"cookieDeleted":true,"done":true}
[tm csp] {"startReadyState":"complete","addElementSync":true,"pageSawSync":"no","pageSawWorld":"undefined","done":true,"addElementResolved":true}
[vm]     {"startReadyState":"complete","addElementSync":true,"caps":{"valueListeners":true,"menus":true,"cookies":true},"handler":"Violentmonkey","pageSawSync":"no","pageSawWorld":"undefined","pageGlobalVisible":false,"addElementResolved":true,"roundtrip":true,"listed":true,"deleted":true,"localListener":{"value":"local","remote":false},"menu":true,"xhrJson":true,"xhrBytes":true,"openInTab":true,"notification":true,"cookieSet":true,"cookieDeleted":true,"done":true}
[vm csp] {"startReadyState":"complete","addElementSync":true,"pageSawSync":"no","pageSawWorld":"undefined","done":true,"addElementResolved":true}
```

What the run shows:
- **Every GM function in the grant table works on both managers.** The probe exercised all 13 (`getValue`, `setValue`, `deleteValue`, `listValues`, both value-change listener calls, both menu calls, `xmlHttpRequest` for JSON and bytes, `addElement`, `openInTab`, `notification`, `cookie`), each with the value the test expects. The single-page test stops at its first failing assertion, so these come from the log line, not from passing assertions.
- **Content scripts are isolated.** `pageGlobalVisible` is `false` on both, with `@sandbox DOM` (TM) and `@inject-into content` (VM). The test expects `false` on tm and vm.
- **`gm.addElement` runs the script synchronously, and a strict CSP doesn't stop it.** `addElementSync` is `true` (the `data-x2u-sync` marker was set by the time the call returned) and `addElementResolved` is `true`, on the normal page and the nonce-only CSP page.
- **The userscript starts too late.** `startReadyState` is `"complete"` on both: despite `@run-at document-start`, the script began once the page had finished loading, so the page's own inline script had already run (`pageSawSync` `"no"`, `pageSawWorld` `"undefined"`). The `pageSawWorld` assertion comes after `pageSawSync` and was not reached, but its value shows it would fail for the same reason.
- **Not a registration race or a headless artefact.** A scratch run outside the suite (not committed) installed the same userscript, waited 6 s, then loaded the normal and CSP pages twice each, headless and headed, on both managers. All 16 loads gave `startReadyState` `"complete"` and `pageSawSync` `"no"`. Reading the page's own world from Playwright afterwards gave `window.__x2uPageWorld === 1` and `data-x2u-sync="1"` on every load, CSP page included, so the injected script does run in the page's world, only after the page's scripts.
- **Install flow.** Tampermonkey ignored a `.user.js` navigation made in its first seconds after launch (a navigation at 0.5 s was missed; one at 9.5 s opened `ask.html` within 0.5 s), and each launch opens a welcome tab at `tampermonkey.net` with an "unofficial version of Tampermonkey" warning because the build is unpacked. The install also opened `https://www.tampermonkey.net/script_installation.php#url=<script URL>` next to `ask.html`; whether the install needs network access to that site was not tested.

**Result:** FAIL on both managers for the original contract (a `document-start` script runs before every page script, tested on an instant local page). Single-page contract and strict-CSP page-world injection fail on the same assertion (`pageSawSync`); the remote value change passes. Against the best-effort contract (the injection beats a page script that runs at least 200 ms after navigation start) all three pass on both managers: see [S1 re-run against the best-effort contract](#s1-re-run-against-the-best-effort-contract).
- **§5.5 page-world injection under CSP:** on Tampermonkey 5.5.1 and Violentmonkey 2.49.0 a `document-start` userscript with isolation (`@sandbox DOM` / `@inject-into content`) started with `readyState` `"complete"` on a small local page, after the page's own inline script. `gm.addElement` injects into the page's world synchronously and gets past a nonce-only CSP, but it can't make a page-world script run before page scripts on a page whose first script runs within ~50 ms of navigation start. Any converted extension that needs a `document_start` MAIN-world script to patch page globals first can't rely on this path.
- **§5.1 gm.ts contract:** the GM functions, value-change delivery (local and remote) and `addElement` behave as the contract says. The "document-start runs before page scripts" part of the contract does not hold on either manager.
- **§4 isolation headers:** not affected. Content scripts did not see page globals on either manager, and in the follow-up below GM-granted scripts were isolated whatever the header.

### S1 follow-up: document-start variants

The S1 failure raised the question of whether any header and `@grant` combination starts a `document-start` userscript before the page's own scripts. A scratch probe (not committed) installed 16 variants, 8 per manager, each with `@run-at document-start`: with the GM functions from gm.ts's grant table and with `@grant none`, each under four header sets. Every variant ran on two kinds of local page, no CSP: a **fast page**, whose first inline `<head>` script is the first thing the parser reaches (as in S1), and a **slow page**, where a parser-blocking external script that takes 600 ms comes first, so the page's own first inline script runs at about 620–640 ms. Each page was loaded twice per variant, the first load right after the install and then a reload. Same environment as S1 (Chromium 156.0.8078.4, headless). The scratch userscript `dbg5` and the 16 "x2u variant" scripts are still installed in the bench profile, so they were present during the S1 re-run, S4 and S2; earlier control runs showed no effect.

What each cell records:
- **readyState at first line:** `document.readyState` on the userscript's first line.
- **Before the page's first head script:** whether the page's first inline `<head>` script found the userscript's marker attribute on `<html>`.
- **World:** "isolated" if the userscript could not see `window.pageGlobal` (set by a later page script) and the page could not see `window.__usGlobal` (set by the userscript's first line); "page" if both were visible.
- **gm.addElement before page scripts:** whether the page's first inline script found the marker that a `GM_addElement(html, "script", …)` call had set synchronously, and `window.__x2uPageWorld` from that script.

| Manager | `@grant` | Headers | readyState at first line (fast / slow page) | Before page's first head script (fast / slow) | World | `gm.addElement` before page scripts (fast / slow) |
|---|---|---|---|---|---|---|
| TM 5.5.1 | GM functions | `@sandbox DOM` + `@inject-into content` (S1 baseline) | complete / loading | no / yes | isolated | no / yes |
| TM 5.5.1 | GM functions | none | complete / loading | no / yes | isolated | no / yes |
| TM 5.5.1 | GM functions | `@sandbox raw` | complete / loading | no / yes | isolated | no / yes |
| TM 5.5.1 | GM functions | `@sandbox JavaScript` | complete / loading | no / yes | isolated | no / yes |
| TM 5.5.1 | none | `@sandbox DOM` + `@inject-into content` | complete / loading | no / yes | page | n/a |
| TM 5.5.1 | none | none | complete / loading | no / yes | page | n/a |
| TM 5.5.1 | none | `@sandbox raw` | complete / loading | no / yes | page | n/a |
| TM 5.5.1 | none | `@sandbox JavaScript` | complete / loading | no / yes | page | n/a |
| VM 2.49.0 | GM functions | `@sandbox DOM` + `@inject-into content` (S1 baseline) | complete / loading | no / yes | isolated | no / yes |
| VM 2.49.0 | GM functions | none | complete / loading | no / yes | isolated | no / yes |
| VM 2.49.0 | GM functions | `@inject-into page` | complete / loading | no / yes | isolated | no / yes |
| VM 2.49.0 | GM functions | `@inject-into auto` | complete / loading | no / yes | isolated | no / yes |
| VM 2.49.0 | none | `@sandbox DOM` + `@inject-into content` | complete / loading | no / yes | isolated | n/a |
| VM 2.49.0 | none | none | complete / loading | no / yes | page | n/a |
| VM 2.49.0 | none | `@inject-into page` | complete / loading | no / yes | page | n/a |
| VM 2.49.0 | none | `@inject-into auto` | complete / loading | no / yes | page | n/a |

Observations:
- **Timing doesn't depend on the headers, the grants or the world.** Across all 64 loads per manager (32 without CSP, 32 with), the ordering was the same in every variant. The userscript's first line ran 24–46 ms after navigation start on Tampermonkey and 16–39 ms on Violentmonkey. The fast page's first inline script ran at 23–36 ms (TM runs) and 9–22 ms (VM runs), so the userscript started 4–11 ms (TM) and 7–22 ms (VM) after it, by which time the tiny page had already finished loading. The slow page's first inline script came about 600 ms later, so the userscript ran during parsing, first in every variant.
- **First load and reload gave the same result** in all 16 variants on both pages: the same readyState, the same ordering and the same world. Only the start time varied, within a few milliseconds.
- **A nonce-only CSP changed nothing.** All 16 variants were repeated on `script-src 'nonce-x2u'` versions of both pages (two loads of each page). The orderings, the worlds and the `gm.addElement` results were identical to the no-CSP rows, so page-world `@grant none` scripts and `gm.addElement` scripts both got past the CSP on both managers.
- **With GM functions granted, no header gets out of the isolated world.** `@sandbox raw` and `@sandbox JavaScript` (TM) and `@inject-into page` and `auto` (VM) left the userscript unable to see page globals and the page unable to see the userscript's. For these variants the only way into the page's world was `gm.addElement("script")`; it ran synchronously in the page's world in every variant and on both pages.
- **With `@grant none`, the script runs in the page's world** on TM for all four `@sandbox` values (including `DOM`, so `@sandbox DOM` alone doesn't isolate on TM) and on VM unless `@inject-into content` is set. There are no GM functions in that mode, so gm.ts can't be used.
- **Controls.** Both profiles still hold the earlier scratch userscript `dbg5` (`@grant none`, `@match http://127.0.0.1/*`), which runs on all the pages above and only sets one attribute. Re-running the baseline and one `@grant none` variant per manager on `http://localhost:<port>`, which that script does not match, gave the same readyState, ordering and world.
- Not tested: `@grant unsafeWindow`, pages other than local loopback, other values of `@run-at`, and anything that depends on machine load (the 16–46 ms start is from one machine, headless).

**Conclusion:**
- **No variant guarantees a start before the page's scripts.** Every variant starts 16–46 ms after navigation start, and wins or loses against the page's first inline script only by when that script runs: it won on the slow page and lost on the fast page by 4–22 ms.
- **The world is set by `@grant`, with one header exception.** With GM functions, the script is always isolated and reaches the page's world only through `gm.addElement`; with `@grant none` it runs in the page's world but has no GM functions. The exception is VM's `@inject-into content`, which does isolate a `@grant none` script.
- **Cost to isolation:** none for starting early, since the start time is the same in every variant. Keeping GM access means staying in the isolated world and using `gm.addElement` for page-world code. Running directly in the page's world (`@grant none`) gives up all GM functions, and on TM `@sandbox DOM` doesn't isolate such a script.

### S1 re-run against the best-effort contract

Run: `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/conformance.test.ts` (6 tests, 6 pass, 0 fail). The emulator run of the same file still passes (2 pass, 1 skipped). Same environment as S1 (Chromium 156.0.8078.4, TM 5.5.1, VM 2.49.0, headless).

What changed: the follow-up showed that TM and VM start a `document-start` userscript 16–46 ms after navigation start whatever the headers, so "before every page script" can't be met on an instant page. The test now pins the best-effort contract instead. `/conformance.html` and `/conformance-csp.html` (the latter with a nonce) put a parser-blocking `<script src="/slow.js"></script>` in `<head>` before the page's own inline script, and the server answers `/slow.js` after 200 ms with an empty body. The page's own script therefore runs at least 200 ms after navigation start. The two `pageSawSync` assertion messages now say so; no other assertion changed.

| | Tampermonkey | Violentmonkey |
|---|---|---|
| Single-page contract | PASS | PASS |
| Strict-CSP page-world injection | PASS | PASS |
| Remote value change | PASS | PASS |

No assertion failed, so there is no first failing assertion to record. In both managers' logs `startReadyState` is `"loading"` (it was `"complete"` in the original run), `pageSawSync` and `pageSawWorld` are `"1"`, and `pageGlobalVisible` is `false`.

Raw log lines (the `done: true` object each probe left on `<html data-x2u-conformance>`):

```
[tm]     {"startReadyState":"loading","addElementSync":true,"addElementResolved":true,"caps":{"valueListeners":true,"menus":true,"cookies":true},"handler":"Tampermonkey","pageSawSync":"1","pageSawWorld":"1","pageGlobalVisible":false,"roundtrip":true,"listed":true,"deleted":true,"localListener":{"value":"local","remote":false},"menu":true,"xhrJson":true,"xhrBytes":true,"openInTab":true,"notification":true,"cookieSet":true,"cookieDeleted":true,"done":true}
[tm csp] {"startReadyState":"loading","addElementSync":true,"addElementResolved":true,"pageSawSync":"1","pageSawWorld":"1","done":true}
[vm]     {"startReadyState":"loading","addElementSync":true,"addElementResolved":true,"caps":{"valueListeners":true,"menus":true,"cookies":true},"handler":"Violentmonkey","pageSawSync":"1","pageSawWorld":"1","pageGlobalVisible":false,"roundtrip":true,"listed":true,"deleted":true,"localListener":{"value":"local","remote":false},"menu":true,"xhrJson":true,"xhrBytes":true,"openInTab":true,"notification":true,"cookieSet":true,"cookieDeleted":true,"done":true}
[vm csp] {"startReadyState":"loading","addElementSync":true,"addElementResolved":true,"pageSawSync":"1","pageSawWorld":"1","done":true}
```

The run also makes the remaining S1 assertions pass on the real managers, which the original run never reached because the single-page test stops at its first failure: `pageSawWorld`, `pageGlobalVisible` (`false` on both), the roundtrip, listing, value-change listener, menu, `xmlHttpRequest`, `openInTab`, `notification` and cookie checks.

## S4: leader election and outbox protocol under churn

Run:
- `npm run test:file -- test/browser/s4-crosstab.test.ts` (emulator)
- `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/s4-crosstab.test.ts` (real managers)

| | Emulator | Tampermonkey | Violentmonkey |
|---|---|---|---|
| Version | CI emulator | 5.5.1 | 2.49.0 (stable, MV3) |
| 1,000 spaced messages + 50 burst: received, dropped | 1,050 received, 0 dropped | 1,050 received, 0 dropped | 1,050 received, 0 dropped |
| Churn: settle checks run, checks with exactly one leader | 9 checks, 9 with exactly one leader | 9 checks, 9 with exactly one leader | 9 checks, 9 with exactly one leader |

Browser: Chromium 156.0.8078.4 (Playwright 1.64.0, `channel: "chromium"`), headless, for the Tampermonkey and Violentmonkey columns (same as S1). Churn phase: the default 60 s.

The messages and churn rows of the emulator column are from one `npm run test:browser` run made before the churn test changed (below). The S4 file passed in four runs in a row then, with the same message counts; the number of settle checks varied (9, 9, 8, 9) because tab-close timing is random. After the change the emulator passed once more with 1,050 received, 0 dropped and 9 of 9 settle checks. Each real-manager column is from a single run; both managers passed on the first run, so no rerun was needed.

Real-manager log lines:

```
[tm] S4 messages: received 1050, dropped 0
[tm] S4 churn: 9 settle checks, 9 with exactly one leader
[vm] S4 messages: received 1050, dropped 0
[vm] S4 churn: 9 settle checks, 9 with exactly one leader
```

The churn test closes each victim tab with `close({ runBeforeUnload: Math.random() < 0.5 })`, so about half the closes allow the unload handlers to run (the §5.4 `pagehide` handler deletes the tab's key at once) and the rest leave the key in the store until the 3 s staleness limit expires. Both kinds of close therefore occur in every churn run. The run doesn't say which path any single handover took, or whether the closed tab was the leader at the time, it doesn't count the two kinds of close, and it didn't observe whether the `pagehide` delete was delivered on Tampermonkey or Violentmonkey. All it shows is that a random mix of both kinds left exactly one leader after every settle period on both managers (45 closes each: 5 per round × 9 rounds). Before this change the test used plain `page.close()`, which on the emulator skipped the `pagehide` delete, so every leader handover waited out the staleness limit and the fast `leave()` path was covered by the unit tests only. A probe that fails to start now fails the test with its error (`S4 probe failed: …`) instead of a timeout; none did.

**Result:** PASS on all three columns.
- Messages: no loss. 1,050 of 1,050 received and 0 dropped on Tampermonkey and Violentmonkey, as on the emulator.
- Election: exactly one leader after each of the 9 settle periods on both managers, with about half the closes allowing unload handlers to run. Delivery of the `pagehide` delete on Tampermonkey and Violentmonkey was not observed.
- Spec §5.3 and §5.4: nothing in this run needs changing. The outbox protocol and the election hold on both real managers with the production-shaped timings scaled down (heartbeat 200 ms, stale after 3 s, grace 300 ms).

## S3: esbuild-wasm in a Web Worker

Run: `npm run test:file -- test/browser/s3-esbuild.test.ts`

Fixture: Refined GitHub 26.10 (`hlepfoohegkhhmjieoechaddaejaokhf`), declared as `background.type: "module"`. Entry `assets/background.js`; the native esbuild bundle is 136,017 bytes. The entry imports other files, so the virtual-fs resolver is exercised.

| Browser | Byte-identical to native | First conversion (ms) |
|---|---|---|
| Chromium | yes (SHA-256 `8d15bb6c…cdf1d`, 136,017 bytes) | 474 (a second run: 460) |
| Firefox | not answered here: it doesn't launch on macOS 27 with Playwright's Firefox build 1555 (see below) | not run |
| WebKit | yes (same SHA-256 and size) | 402 (a second run: 370) |

WebKit is Playwright's WebKit build, not the shipping Safari.

Firefox: `firefox.launch()` exits at once with `Could not find profile folder.`, before any page loads, for every profile location tried (Playwright's temp profile, a scratch folder, a folder in the worktree) and with `MOZ_LEGACY_PROFILES=1`. That is an environment problem, not an S3 result. Reads of `~/Library/Application Support/Firefox` were denied in the sandbox these runs used (`ls` failed with "Operation not permitted"), which Firefox 157 may trip over at start-up; this was not confirmed. Firefox was not run with the sandbox off, because that directory holds real Firefox data. The Firefox test runs in CI (ubuntu-latest).

**Result:** PASS on Chromium and WebKit; Firefox is not answered here and is pending CI.
- PASS needs all three rows byte-identical and under 10,000 ms.
- Chromium and WebKit pass, with the first conversion about 20x under the budget. esbuild-wasm with `worker: false` inside a module Web Worker bundles Refined GitHub identically to native esbuild.
- If Firefox fails in CI, record which part failed and what it implies for spec §8, the web app.

## S2: popup modal on strict-CSP sites

Run: `npm run script -- spikes/s2-popup-csp/run.ts` (headless) and `HEADED=1 npm run script -- spikes/s2-popup-csp/run.ts` (headed). Raw results: `spikes/s2-popup-csp/results-headless.json` (the headless run) and `spikes/s2-popup-csp/results.json` (the headed run, made to cover x.com).

Environment: same as S1 (Tampermonkey 5.5.1, Violentmonkey 2.49.0, Chromium 156.0.8078.4 via Playwright 1.64.0, `channel: "chromium"`), signed out. The probe ran at `document-idle` with isolation (`@sandbox DOM` / `@inject-into content`) and the full grant table. The runner only loaded each home page and read the result; nothing was clicked, signed in or accepted.

**Headless run** (`results-headless.json`):

| Manager / site | jsRan | eventsWork | gmStyleApplied | plainStyleApplied | innerHtml | domParser | imgBlob | imgData | imgIframeBlob | fontBlob | fontData |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tm github.com | true | true | true | true | true | true | true | true | true | true | true |
| tm youtube.com | true | true | true | true | TypeError (TrustedHTML) | TypeError (TrustedHTML) | true | true | true | true | true |
| tm x.com | not run | not run | not run | not run | not run | not run | not run | not run | not run | not run | not run |
| vm github.com | true | true | true | true | true | true | true | true | true | true | true |
| vm youtube.com | true | true | true | true | true | true | true | true | true | true | true |
| vm x.com | not run | not run | not run | not run | not run | not run | not run | not run | not run | not run | not run |

The four rows that ran each ended with `"done":true`. Both x.com rows have no probe result: the site answered the headless browser with HTTP 403, `page.goto` failed with `net::ERR_HTTP_RESPONSE_CODE_FAILURE`, the page title read `x.com`, and the runner doesn't poll for the probe after a failed navigation. What the pages were (page title, status):
- github.com: 200, "GitHub · Change is constant. GitHub keeps you ahead. · GitHub · GitHub" (the signed-out home page).
- youtube.com: 200, "YouTube".
- x.com: 403, "x.com" (the page body was not inspected).

**Headed run** (`results.json`; `HEADED=1`, one run, same runner and managers). All six rows ended with `"done":true`. The github.com and youtube.com rows are identical to the headless table above, field for field (same status, title and probe values; the CSP is the same apart from the nonce and the order of the YouTube policies). x.com loaded normally this time: status 200, title "X. It’s what’s happening / X", on both managers. The runner did nothing to look like a different browser.

| Manager / site | jsRan | eventsWork | gmStyleApplied | plainStyleApplied | innerHtml | domParser | imgBlob | imgData | imgIframeBlob | fontBlob | fontData |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tm x.com | true | true | true | true | true | true | true | true | true | true | true |
| vm x.com | true | true | true | true | true | true | true | true | true | true | true |

CSP each row got (from the response headers; abbreviated, all lists of hosts shortened to a count). No row that loaded had a `<meta http-equiv="Content-Security-Policy">` tag (the headless x.com rows were error pages), and none had `(none)` for the header. Both managers saw the same policy for a site, apart from the nonce and the order of the YouTube policies, which varies from load to load (it changed between the headless and headed Tampermonkey loads), not by manager. The x.com policy on the headed 200 page is the same as the one on the headless 403 response, apart from the nonce.
- **github.com:** one policy. `default-src 'none'`; `script-src github.githubassets.com 'sha256-…'`; `style-src 'unsafe-inline' github.githubassets.com`; `img-src 'self' data: blob:` + 24 hosts; `font-src github.githubassets.com` (no `data:`, no `blob:`); `frame-src` and `child-src` list named hosts only. No `require-trusted-types-for`.
- **youtube.com:** three policies. (1) `script-src 'unsafe-eval' 'self' 'unsafe-inline'` + 20 hosts; (2) `script-src 'report-sample' 'nonce-…' 'unsafe-inline' 'strict-dynamic' https: http: 'unsafe-eval'`; (3) `require-trusted-types-for 'script'`, with no `trusted-types` allow-list. The order of the three varies between loads (the headless Tampermonkey load had the third second; every other load had it last). There is no `style-src`, `img-src` or `font-src`.
- **x.com:** one policy. `default-src 'self'`; `script-src 'self' 'nonce-…' 'unsafe-inline' 'wasm-unsafe-eval'` + 14 hosts; `style-src 'self' 'unsafe-inline'` + 2 hosts; `img-src 'self' data: blob:` + 56 hosts; `font-src 'self' data:` + 3 hosts (no `blob:`); `frame-src 'self'` + 21 hosts. No `require-trusted-types-for`.

**Result:** PASS on all six rows (spec §11: `jsRan`, `eventsWork` and `gmStyleApplied` true on github.com and youtube.com in both runs, and on x.com in the headed run, for both managers). It is PASS by the spec's rule, but no site blocked inline styles, so §6's claim that `gm.addElement` gets past such a CSP is untested. x.com serves a headless browser an HTTP 403 and a headed one the normal page, so x.com is only testable headed.
- **Asset columns:** all true on all six rows, so there are no report warnings (spec §6 "Known ceiling") from this run. The image columns don't discriminate: every `img-src` in the set allows `data:` and `blob:`, or the site has no `img-src` at all, so S2 gives no evidence about images under a blocking policy. Only three font cells were tested against a policy that omits their scheme: `fontBlob` on github.com and x.com (neither `font-src` has `blob:`) and `fontData` on github.com (no `data:`). All three loaded, on both managers. Why the policy didn't block them was not investigated.
- **Trusted Types:** youtube.com sends `require-trusted-types-for 'script'`. On Tampermonkey `innerHTML` (on the iframe's body) and `DOMParser.parseFromString` threw `TypeError ... requires 'TrustedHTML' assignment` in the userscript, in both the headless and the headed run. On Violentmonkey both succeeded with the same header in both runs. The reason for the difference was not investigated. The consequence is the Revision (S2) in spec §6: it removes the `DOMParser` step, and keeps a `default` Trusted Types policy as an upgrade path that was not measured.
- **Style columns don't discriminate here:** `gmStyleApplied` and `plainStyleApplied` are both true everywhere, and no site restricts inline style (github.com and x.com `style-src` have `'unsafe-inline'`, youtube.com has none). A site with a nonce-only `style-src` was not in the set, so this run doesn't show whether `gm.addElement` is needed for styles.
- **Headless vs headed:** only x.com differed (403 headless, 200 headed). github.com and youtube.com gave the same probe values, status, title and CSP in both runs.
- **Runs:** the first headless run stopped at `tm x.com` because `goto` threw on the 403 (a runner bug: `run.ts` now takes the main document's response from the `response` event instead) and wrote no `results.json`. Its two completed rows matched the second headless run, whose numbers are in the headless table. The headed run was a single run.

## Summary

| Spike | Result | Spec sections affected |
|---|---|---|
| S1 | FAIL against the original contract (`document-start` runs before every page script); PASS against the best-effort contract (S1 re-run) | §5.1, §5.5, §11 |
| S2 | PASS on all six rows (x.com headed only) | §6: the "parsed with `DOMParser`" step throws on YouTube under Tampermonkey (Trusted Types) |
| S3 | PASS on Chromium and WebKit (byte-identical, well under 10 s). Firefox is not answered here: it doesn't launch on macOS 27 with Playwright's Firefox build 1555, an environment problem rather than an S3 result. CI (ubuntu-latest) answers it. WebKit is not shipping Safari. | none |
| S4 | PASS (Tampermonkey and Violentmonkey: 1,050 received, 0 dropped; 9 of 9 settle checks with one leader) | none |
