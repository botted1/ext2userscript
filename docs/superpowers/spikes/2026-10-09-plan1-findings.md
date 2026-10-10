# Plan 1 spike findings

Results of spikes S1–S4 (spec §11): what ran, on which versions, and what it means for the spec.

## S1: GM functions, isolation and addElement timing in real managers

Run: `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/conformance.test.ts`

| | Tampermonkey | Violentmonkey |
|---|---|---|
| Version and Web Store ID | | |
| `handler` and `caps` (from the log line) | | |
| Single-page contract | | |
| Strict-CSP page-world injection | | |
| Remote value change | | |

The emulator runs userscripts in the page world and doesn't bypass page CSP, so isolation (pageGlobalVisible) and the strict-CSP check are only meaningful on Tampermonkey and Violentmonkey.

**Result:**
- PASS if every row passes for both managers.
- Otherwise, list each failing assertion, what the manager actually did (from the log line), and which spec section it affects: §4 for the isolation headers, §5.1 for the gm.ts contract.

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
