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
