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
