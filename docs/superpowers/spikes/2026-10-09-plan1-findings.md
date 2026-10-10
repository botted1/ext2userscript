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
