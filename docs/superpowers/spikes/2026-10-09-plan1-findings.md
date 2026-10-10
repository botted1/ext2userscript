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

**Result:** FAIL on both managers. Single-page contract and strict-CSP page-world injection fail on the same assertion (`pageSawSync`); the remote value change passes.
- **§5.5 page-world injection under CSP:** on Tampermonkey 5.5.1 and Violentmonkey 2.49.0 a `document-start` userscript with isolation (`@sandbox DOM` / `@inject-into content`) started with `readyState` `"complete"` on a small local page, after the page's own inline script. `gm.addElement` injects into the page's world synchronously and gets past a nonce-only CSP, but it can't make a page-world script run before page scripts. Any converted extension that needs a `document_start` MAIN-world script to patch page globals first can't rely on this path.
- **§5.1 gm.ts contract:** the GM functions, value-change delivery (local and remote) and `addElement` behave as the contract says. The "document-start runs before page scripts" part of the contract does not hold on either manager.
- **§4 isolation headers:** not affected. Content scripts did not see page globals on either manager.

### S1 follow-up: document-start variants

The S1 failure raised the question of whether any header and `@grant` combination starts a `document-start` userscript before the page's own scripts. A scratch probe (not committed) installed 16 variants, 8 per manager, each with `@run-at document-start`: with the GM functions from gm.ts's grant table and with `@grant none`, each under four header sets. Every variant ran on two kinds of local page, no CSP: a **fast page**, whose first inline `<head>` script is the first thing the parser reaches (as in S1), and a **slow page**, where a parser-blocking external script that takes 600 ms comes first, so the page's own first inline script runs at about 620–640 ms. Each page was loaded twice per variant, the first load right after the install and then a reload. Same environment as S1 (Chromium 156.0.8078.4, headless).

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
- **The world is set by `@grant`, not by the headers.** With GM functions, the script is always isolated and reaches the page's world only through `gm.addElement`; with `@grant none` it runs in the page's world (isolated only with VM's `@inject-into content`) but has no GM functions.
- **Cost to isolation:** none for starting early, since the start time is the same in every variant. Keeping GM access means staying in the isolated world and using `gm.addElement` for page-world code. Running directly in the page's world (`@grant none`) gives up all GM functions, and on TM `@sandbox DOM` doesn't isolate such a script.

## S4: leader election and outbox protocol under churn

Run:
- `npm run test:file -- test/browser/s4-crosstab.test.ts` (emulator)
- `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/s4-crosstab.test.ts` (real managers)

| | Emulator | Tampermonkey | Violentmonkey |
|---|---|---|---|
| 1,000 spaced messages + 50 burst: received, dropped | 1,050 received, 0 dropped | | |
| Churn: settle checks run, checks with exactly one leader | 9 checks, 9 with exactly one leader | | |

The emulator column is from one `npm run test:browser` run. The S4 file passed in four runs in a row with the same message counts. The number of settle checks varied (9, 9, 8, 9) because tab-close timing is random.

The churn test closes tabs with `page.close()`. On the emulator that skips the closing tab's `pagehide` delete (its key stayed in the store; with `runBeforeUnload: true` it was deleted at once), so each leader handover waited out the 3 s staleness limit. The fast `leave()` path is covered by the unit tests only.

**Result:** Pending the real-manager run.
- PASS if every column passes.
- Otherwise, describe what went wrong (for example two leaders, no leader, or `dropped` > 0) and what it implies for spec §5.3 or §5.4.

## S3: esbuild-wasm in a Web Worker

Run: `npm run test:file -- test/browser/s3-esbuild.test.ts`

Fixture: Refined GitHub 26.10 (`hlepfoohegkhhmjieoechaddaejaokhf`), declared as `background.type: "module"`. Entry `assets/background.js`; the native esbuild bundle is 136,017 bytes. The entry imports other files, so the virtual-fs resolver is exercised.

| Browser | Byte-identical to native | First conversion (ms) |
|---|---|---|
| Chromium | yes (SHA-256 `8d15bb6c…cdf1d`, 136,017 bytes) | 474 (a second run: 460) |
| Firefox | not run: the browser would not start in the agent's sandbox (see below) | not run |
| WebKit | yes (same SHA-256 and size) | 402 (a second run: 370) |

Firefox: `firefox.launch()` exits at once with `Could not find profile folder.`, before any page loads, for every profile location tried (Playwright's temp profile, the session scratchpad, a folder in the worktree) and with `MOZ_LEGACY_PROFILES=1`. The session's sandbox denies reads of `~/Library/Application Support/Firefox` (`ls` fails with "Operation not permitted"), which is probably what Firefox 157 trips over at start-up. I did not run Firefox with the sandbox off, because that directory holds the user's real Firefox data. Run the Firefox row outside the sandbox: `npm run test:file -- test/browser/s3-esbuild.test.ts`.

**Result:** Pending the Firefox row.
- PASS if all three rows are byte-identical and under 10,000 ms.
- So far: Chromium and WebKit pass, with the first conversion about 20x under the budget. esbuild-wasm with `worker: false` inside a module Web Worker bundles Refined GitHub identically to native esbuild.
- If Firefox fails, record which part failed and what it implies for spec §8, the web app.
