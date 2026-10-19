# ext2userscript Plan 6: The Benchmark — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The benchmark of spec §10.4 and §10.5. It runs 23 pinned extensions through ext2userscript and the baseline on the CI emulator and on real Tampermonkey and Violentmonkey, and writes a scorecard that says whether v1's ship criteria (spec §1) are met.

**Architecture:**
- **The corpus:** `bench/corpus.json` pins each case's extension (store, ID, version, SHA-256), and `bench/corpus.ts` gets its archive.
  - It reads the pinned archive from `bench/.cache/archives`.
  - If that's missing, it downloads the store's current one and caches it by hash. The scorecard notes the drift.
- **The cases:** each case has a script, `bench/cases/<id>.ts`.
  - A browser case opens a page and waits for one or two effects of the extension.
  - Where a site stops automated browsers, the case serves the page itself, through Playwright routes, with fixtures in `bench/fixtures.ts`.
  - A negative case names the report's verdict and the subjects it must call unsupported.
- **The runner:** `bench/run.ts` runs each browser case three ways:
  - against the original extension, loaded unpacked in Chromium: the reference, once per case;
  - with ext2userscript's conversion, on each backend in `X2U_BACKENDS`;
  - with the baseline's conversion (`npx $X2U_BASELINE`), on each backend.

  A case the original extension fails is inconclusive. `bench/scorecard.ts` turns the results into one Markdown scorecard per backend.

**Tech Stack:**
- TypeScript, run directly by Node 22.16 with `--experimental-strip-types`.
- `node:test`.
- Playwright 1.64 (Chromium).
- The baseline from npm, through `npx`.
- No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`

**Scope:** Plan 6 of 6. It covers:
- spec §10.4 and §10.5;
- the `bench/` entries of §2 that Plans 1–3 didn't build (`corpus.json`, `cases/`, `run.ts`).

It measures; it doesn't fix the converter. The gaps the scorecard shows (below) are the next plan's work, and v1 ships when that plan meets the criteria.

**Prototype:** everything below was built and run before the plan was written, on 2026-10-19, against a copy of `main` at f5022fc. The archives it pinned are already in this worktree's `bench/.cache/archives`.

| Check | Result |
|---|---|
| Unit tests | 394 of 394 (379 before, plus 15 in `test/unit/bench.test.ts`); `tsc` clean |
| `test/browser/bench.test.ts` | 3 of 3. The catch-all route test fails with the emulator fall-through removed, and the build-error test fails with a one-line summary |
| `npm run bench` (emulator, all 23 cases) | Original: 19 pass, 4 n/a (Web Search Navigator is MV2; three negatives). ext2userscript: 17 pass, 6 fail. The baseline: 13 pass, 7 fail, 3 n/a. Every case conclusive. Scorecard below |
| `X2U_BACKENDS=tm,vm npm run bench -- --case json-formatter,material-icons-github` | Both cases pass on both real managers with ext2userscript. Each session runs on its own copy of the profile |

The emulator scorecard (`baseline` 0.1.4; with Task 3's `domcontentloaded` change, rerun for the four cases it touched):

| Case | Kind | Original | ext2userscript | the baseline |
|---|---|---|---|---|
| Material Icons for GitHub | legacy | pass | pass | pass |
| JSON Formatter | legacy | pass | pass | pass |
| Modern for Wikipedia | legacy | pass | pass | pass |
| Return YouTube Dislike | legacy | pass | fail (no ratio bar) | pass |
| Web Search Navigator | legacy | n/a (MV2) | pass | pass |
| uBlacklist | legacy | pass | pass | fail |
| Iridium for YouTube | legacy | pass | fail (no `iridium-full-titles`) | pass |
| Modern for Hacker News | legacy | pass | pass | pass |
| LeetCode Enhancer | modern | pass | pass | pass |
| Refined GitHub | modern | pass | fail: `options.js` uses top-level await, which the `es2020` target refuses | fail: `Cannot use import statement outside a module` |
| SponsorBlock | modern | pass | pass | fail |
| Unhook | modern | pass | pass | pass |
| Dark Reader | modern | pass | fail: `Cannot read properties of undefined (reading 'regexps')` | fail |
| BetterTTV | modern | pass | pass | pass |
| Augmented Steam | modern | pass | fail: the 128 MB userscript drops the browser's connection | fail: `contextMenus.onClicked.hasListener is not a function` |
| Improve YouTube! | modern | pass | fail: the page never reaches DOMContentLoaded | fail |
| Reddit Enhancement Suite | modern | pass | pass | fail |
| Modrinth Extras | modern | pass | pass | pass |
| Octotree | modern | pass | pass | pass |
| Enhanced GitHub | modern | pass | pass | pass |
| uBlock Origin Lite, Momentum, React Developer Tools | negative | n/a | pass | n/a |

The criteria on that run:
- passes 11 of the 13 cases the baseline passes (Return YouTube Dislike and Iridium are missing);
- passes 2 of the 6 modern cases the baseline fails (33%);
- gives an accurate report for 3 of the 3 negatives;
- every case is conclusive.

So v1 is not met yet, and the scorecard says why.

What the prototype found:
1. **A case's catch-all route answered the emulator's own requests.** The emulator reads its value snapshot from `/__x2u_emu__/snapshot` on the page's origin, and Playwright gives a later route priority. With a route for `https://json.x2u.test/**`, every userscript failed to start (`Cannot convert undefined or null to object`). Case routes now fall back for that path (Task 3).
2. **Three sites stop automated browsers:**
   - Google shows a reCAPTCHA page;
   - Reddit shows a bot check or a login wall;
   - LeetCode shows a Cloudflare challenge ("Just a moment...").

   Their cases serve the page themselves, with only the markup the extension reads. No case gets past a CAPTCHA or bot check. The other sites work headless: GitHub, YouTube, Wikipedia, Hacker News, Twitch, Steam and Modrinth.
3. **Wikiwand had to be swapped (spec §10.4's swap rule).** Wikiwand 11.0.0 has no content scripts: its one feature is a `declarativeNetRequest` redirect to wikiwand.com, which a userscript can't do. It is swapped for Modrinth Extras (`ajmkilipadfpaefpcjfgnkejalmhdlcj`, built with WXT, site-specific, MV3), and the swap is recorded in `corpus.json`.
4. **The reference needs Chromium's full build.** Chromium loads unpacked extensions in its new headless mode, through `channel: "chromium"`. It no longer loads Manifest V2, so Web Search Navigator (MV2 from AMO) has no reference.
5. **The real tier would have run every earlier case's userscript too:**
   - the managers keep each installed userscript in the profile;
   - `BENCH_PROFILE` is shared;
   - Dark Reader's and JSON Formatter's scripts match `<all_urls>`.

   Each real-manager session now runs on a copy of the profile without its caches (Task 4). The copy keeps "Allow User Scripts".
6. **Waiting for `load` made slow sites time out.** `page.goto` waits for the `load` event by default. Modrinth's reference and Improve YouTube! timed out on slow third-party resources, so cases open pages with `waitUntil: "domcontentloaded"` and wait for their own effect.
7. **The emulator is more lenient than the real managers:**
   - The baseline's JSON Formatter passes on the emulator but fails on Tampermonkey and Violentmonkey;
   - its `window.json` lands on the page's window only when the userscript runs in the page's world, as the emulator runs it.
8. **A run could outlive its scorecard.**
   - Augmented Steam's userscript is 128 MB.
   - Injecting it with `addInitScript` drops Playwright's connection on the first new page, and the browser process stays alive.
   - Its run printed the scorecard and never exited.

   The CLI now ends with an explicit `process.exit`, which kills every browser Playwright launched (Task 3).
9. **The converter gaps (for the next plan, not this one):**
   - **Augmented Steam:** it converts to 128 MB from a 17 MB archive.
   - **Dark Reader:**
     - it fetches `config/*.config` through computed `getURL` paths, so they aren't in the asset table;
     - it uses `chrome.tabs.create`, but its userscript has no `@grant GM_openInTab`.
   - **Refined GitHub:** `options.js` needs an esbuild target that allows top-level await.
   - **Improve YouTube!:** the page hangs before DOMContentLoaded.
   - **Iridium and Return YouTube Dislike:** they fail where the baseline passes.

**Decisions that need the human's OK along with this plan:**
1. **Pages served by the case** for Google, Reddit and LeetCode, plus a JSON response and a plain page for JSON Formatter and Dark Reader. Live public pages everywhere else (spec §10.4 allows "a public or locally served page").
2. **The reference run, with the inconclusive rule.** A case the original extension fails counts for nothing, and `--gate` fails while any case is inconclusive. Without the rule, a site that blocks the browser on the day would count against ext2userscript.
3. **Swapping Wikiwand for Modrinth Extras** (finding 3).
4. **The CI `bench` job reports and doesn't gate.** It runs on every push and adds the scorecard to the job summary, but it passes whatever the criteria say, until v1 meets them. The release gate is run locally:

   ```
   X2U_BACKENDS=emulator,tm,vm npm run bench -- --gate
   ```
5. **A drifted case runs on the store's current version.** The stores serve only the latest version. Such a case runs on what the store has now, the scorecard notes `<version> (pinned <version>)`, and `npm run bench:pin` re-pins.
6. **No case opens a popup.** Spec §10.4 says the popup is opened through the menu-command hook where the extension has one. The cases check what extensions do to pages instead. Popups are covered by §10.2's `pages.test.ts` on both tiers, and the menu hook exists only on the emulator. Task 1's spec corrections say so.

## Global Constraints

- **Node:** Node ≥ 22.16. TypeScript runs directly with `--experimental-strip-types --disable-warning=ExperimentalWarning`. No tsx, no build step.
- **Running things:** one test file with `npm run test:file -- <path>`. Under machine load, run the unit suite with `npm test -- --test-concurrency=2`.
- **TypeScript:** erasable syntax only; relative imports end in `.ts`; type-only imports use `import type`.
- **Exact versions:**
  - `esbuild` and `esbuild-wasm` 0.28.2; `fflate` 0.8.3.
  - Dev: `playwright` 1.64.0, `typescript` 7.0.2, `@types/node` 22.20.5.
  - No other dependencies. The baseline runs through `npx --yes $X2U_BASELINE` and is never added to `package.json`.
- **Tests:** `node:test` with `node:assert/strict`.
- **Third-party archives are never committed.** They live in `bench/.cache/` (already git-ignored).
- **No case gets past a CAPTCHA or bot check.** A site that stops automated browsers is served by the case.
- **Ship criteria, verbatim from spec §1:**
  - passes every corpus case that the baseline passes on the same run;
  - passes at least 75% of the modern MV3 cases that the baseline fails;
  - produces an accurate compatibility report for every negative case.
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, passed as a second `-m`.

## Review Focus

1. **One case going wrong must not stop the run:** the download fails, the browser won't start, the conversion throws. The case gets its reason and the run goes on. Pinned in Task 3: `bench.test.ts`, "marks a case whose archive can't be had as failed everywhere, its reference too, and goes on", and "fails when the conversion does, with the build's error and not just its heading".
2. **A site that blocks the browser, or changes its markup, on the day of the run.** The case is inconclusive, never a converter failure, and `--gate` fails. Pinned in Task 2: `bench.test.ts`, "leaves out a case the original extension fails, and isn't met while one is inconclusive".
3. **A case's catch-all route under the emulator:** the emulator's own requests must still reach it. Pinned in Task 3: `test/browser/bench.test.ts`, "passes a case whose effect shows, with the emulator working under the case's catch-all route".
4. **A userscript that throws as it starts.** The failure must say what was thrown, not only that the effect never showed. Pinned in Task 3: `test/browser/bench.test.ts`, "fails a case whose effect doesn't show, naming the first error a page threw".
5. **The release tier must not run one case's userscript in the next.** Pinned in Task 4: `bench.test.ts`, "copies a profile without its caches and a running browser's locks".

---

### Task 1: Spec corrections, the corpus and pinning

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`, `package.json`
- Create: `bench/corpus.ts`, `bench/corpus.json`, `bench/pin.ts`
- Test: `test/unit/bench.test.ts` (new)

**Interfaces:**
- Produces, in **`bench/corpus.ts`**:
  - `type CaseKind = "legacy" | "modern" | "negative"`;
  - `type CorpusEntry = { id: string; name: string; store: "cws" | "edge" | "amo"; extensionId: string; version: string; sha256: string; kind: CaseKind; swap?: { replaces: string; reason: string } }` (`extensionId` is the AMO slug for `amo`);
  - `type Archive = { path: string; bytes: Uint8Array; version: string; sha256: string; drifted: boolean }`;
  - `const CACHE: string`, which is `bench/.cache`;
  - `loadCorpus(path?: string): Promise<CorpusEntry[]>`, which reads `{ cases }` from `bench/corpus.json` by default;
  - `storeOf(entry: CorpusEntry): StoreSource`;
  - `sha256(bytes: Uint8Array): string` (hex);
  - `versionOf(bytes: Uint8Array): string`, the manifest's `version`;
  - `archiveOf(entry: CorpusEntry, options?: { dir?: string; download?: (store: StoreSource) => Promise<Uint8Array> }): Promise<Archive>`.
- Produces, in **`bench/pin.ts`**: `pinEntry(entry: CorpusEntry, options?: Parameters<typeof archiveOf>[1]): Promise<CorpusEntry>`.
- Consumes: `storeArchive` and `StoreSource` from `src/download.ts`, and `unpack` from `src/convert/unpack.ts`.

- [ ] **Step 1: Apply the spec corrections.**
  1. **§2, `bench/`:** besides the existing entries, list:
     - `corpus.ts`: the corpus, its archives and pins;
     - `pin.ts`: `npm run bench:pin`;
     - `case.ts`: what a case script is, and what a run of one gives;
     - `cases/<id>.ts`;
     - `fixtures.ts`: pages served for sites that stop automated browsers;
     - `tools.ts`: the two converters;
     - `reference.ts`: the original extension, loaded unpacked;
     - `scorecard.ts`.

     `run.ts` "runs the corpus for ext2userscript, the baseline and the original extension, and writes a scorecard per backend".
  2. **§10.4:**
     - **Pinning:** the stores serve only an extension's latest version. A case whose pinned archive isn't in the cache runs on the store's current one, and the scorecard shows `<version> (pinned <version>)`. `npm run bench:pin [-- --case id,…]` re-pins.
     - **Assertions:** a case visits a public page, or serves the page itself (Playwright routes) where the site stops automated browsers: Google, Reddit and LeetCode. A served page carries only the markup the extension reads. No case gets past a CAPTCHA or bot check. Cases check what the extension does to pages; the popup and options pages are covered by §10.2's tests.
     - **The reference:** each browser case also runs once against the original extension, loaded unpacked in Chromium. A case the original fails is inconclusive: it counts for nothing, and the release gate fails while any case is. Manifest V2 cases have no reference, because Chromium no longer loads MV2.
     - **Negative cases:** the baseline writes no report, so it gets n/a.
     - **Swaps:** Wikiwand is swapped for Modrinth Extras; `corpus.json` records the reason.
  3. **§10.5:**
     - **CI:** a `bench` job runs `npm run bench` on the emulator on every push and adds the scorecard to the job summary. It doesn't fail the build.
     - **Release:** `X2U_BACKENDS=emulator,tm,vm npm run bench -- --gate` exits 1 unless the criteria are met on every backend, with every case conclusive. Each real-manager session runs on its own copy of `BENCH_PROFILE`, without its caches, so a case runs only its own userscript.

- [ ] **Step 2: Write the failing tests.** Create `test/unit/bench.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveOf, sha256, type CorpusEntry } from "../../bench/corpus.ts";
import { pinEntry } from "../../bench/pin.ts";
import { files, zipFiles } from "../support/extension.ts";

const entry = (id: string, kind: CorpusEntry["kind"], extra: Partial<CorpusEntry> = {}): CorpusEntry => ({
  id, name: id, store: "cws", extensionId: "a".repeat(32), version: "1.0", sha256: "0".repeat(64), kind, ...extra,
});
const archive = (version: string) => zipFiles(files({ "manifest.json": JSON.stringify({ name: "A", version, manifest_version: 3 }) }));

describe("archiveOf", () => {
  it("uses the pinned archive from the cache without downloading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-bench-"));
    const bytes = archive("1.0");
    const pinned = entry("x", "modern", { sha256: sha256(bytes) });
    await writeFile(join(dir, `x-${pinned.sha256.slice(0, 12)}.crx`), bytes);
    const got = await archiveOf(pinned, { dir, download: () => assert.fail("downloaded") });
    assert.deepEqual([got.version, got.drifted, got.sha256], ["1.0", false, pinned.sha256]);
  });

  it("downloads the store's current archive when the pinned one isn't cached, and caches it by its hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-bench-"));
    const bytes = archive("2.0");
    const got = await archiveOf(entry("x", "modern"), { dir, download: async () => bytes });
    assert.deepEqual([got.version, got.drifted, got.sha256], ["2.0", true, sha256(bytes)]);
    assert.deepEqual(await readdir(dir), [`x-${sha256(bytes).slice(0, 12)}.crx`]);
  });

  it("isn't drifted when the download is the pinned archive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-bench-"));
    const bytes = archive("1.0");
    const got = await archiveOf(entry("x", "modern", { sha256: sha256(bytes) }), { dir, download: async () => bytes });
    assert.equal(got.drifted, false);
  });
});

describe("pinEntry", () => {
  it("pins the store's current version and hash, even when the old pin is cached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-bench-"));
    const old = archive("1.0");
    const current = archive("2.0");
    await writeFile(join(dir, `x-${sha256(old).slice(0, 12)}.crx`), old);
    const pinned = await pinEntry(entry("x", "modern", { sha256: sha256(old) }), { dir, download: async () => current });
    assert.deepEqual([pinned.version, pinned.sha256], ["2.0", sha256(current)]);
  });
});
```

- [ ] **Step 3: Run it.**
  - Command: `npm run test:file -- test/unit/bench.test.ts`.
  - Expected: FAIL, `Cannot find module '…/bench/corpus.ts'`.

- [ ] **Step 4: Implement.**
  - **`bench/corpus.ts`:**
    - **Header comment:** what's pinned and where archives are cached; that third-party archives are never committed; and the drift rule from Step 1.
    - **`archiveOf`:**
      - the cache file is `<dir>/<id>-<first 12 hex of the hash>.<crx|xpi>` (`xpi` for `amo`), and `dir` defaults to `join(CACHE, "archives")`;
      - a cached file whose hash matches `entry.sha256` returns `{ version: entry.version, drifted: false }` without downloading;
      - otherwise it downloads through `download ?? storeArchive`, writes the file named by its own hash, and returns `{ version: versionOf(bytes), drifted: hash !== entry.sha256 }`.
    - **`versionOf`:** `unpack(bytes).get("manifest.json")`, with a leading BOM stripped before `JSON.parse`.
  - **`bench/pin.ts`:**
    - **`pinEntry`:** `archiveOf({ ...entry, sha256: "" }, options)`, so it always downloads; it returns the entry with the archive's `version` and `sha256`.
    - **The CLI** (run when `process.argv[1] === import.meta.filename`): it takes `--case id[,id…]` and rewrites `bench/corpus.json` (two-space JSON plus a newline). It prints one line per case, `<id>: <version>`, followed by ` (unchanged)` or ` (was <old version>)`.
  - **`bench/corpus.json`:** `{ "cases": [...] }`, with these 23 entries in this order. The SHA-256s are of the archives already cached in `bench/.cache/archives`.

    | id | name | store | extensionId | version | kind | sha256 |
    |---|---|---|---|---|---|---|
    | `material-icons-github` | Material Icons for GitHub | cws | `bggfcpfjbdkhfhfmkjpbhnkhnpjjeomc` | 1.17.1 | legacy | `ee51230eb26f80377cead05b9c229d952a9084fcf8763d3e064a88088dcdde3b` |
    | `json-formatter` | JSON Formatter | cws | `bcjindcccaagfpapjjmafapmmgkkhgoa` | 0.10.2 | legacy | `5e0ebde71ee60f997a9f5fc0850e6ae4a9f67006dbf662f00507f99e957c2b21` |
    | `modern-wikipedia` | Modern for Wikipedia | cws | `emdkdnnopdnajipoapepbeeiemahbjcn` | 1.41 | legacy | `48e6266e17e0123c3b2fc65f184289c45353b804e31852fbb7b4f8cda42d20be` |
    | `return-youtube-dislike` | Return YouTube Dislike | cws | `gebbhagfogifgggkldgodflihgfeippi` | 4.0.5 | legacy | `a2b942c162f419e00b41808cc6b1ddef5c29396355ba92e4d15aed41cc58b549` |
    | `web-search-navigator` | Web Search Navigator | amo | `web-search-navigator` | 0.5.2 | legacy | `838c5e6e1520232716275c1a284fbeaeb3d5ef2ae16a67ee55fdbe208f4e439b` |
    | `ublacklist` | uBlacklist | cws | `pncfbmialoiaghdehhbnbhkkgmjanfhe` | 10.1.2 | legacy | `ab798a40488d57f93d3fa33beb25e6cd7031cb14d9b4930b774fbe94320508ac` |
    | `iridium` | Iridium for YouTube | cws | `gbjmgndncjkjfcnpfhgidhbgokofegbl` | 2.1.2 | legacy | `76543bff5f94504ed4976f8b3fa2a54d53c621144b28de305909eaeba815adf4` |
    | `modern-hacker-news` | Modern for Hacker News | cws | `dabkegjlekdcmefifaolmdhnhdcplklo` | 1.14 | legacy | `0a578896fdae4a1d0041d5d34f2da693d9b4789f173340a975e90b234d03fd4d` |
    | `leetcode-enhancer` | LeetCode Enhancer | cws | `cpoclfijojgjiafnlgnhjalkaiabcjch` | 0.0.18 | modern | `3c06f36a85101a46eab4ef2d513d4b5e753f49f889051fbe47ed2bdce77fef01` |
    | `refined-github` | Refined GitHub | cws | `hlepfoohegkhhmjieoechaddaejaokhf` | 26.10.15 | modern | `c3a5b79e366a38e1bc8d5b4852db86fbe26a74bdb1fcc03d97ffcab7176e0024` |
    | `sponsorblock` | SponsorBlock | cws | `mnjggcdmjocbbbhaepdhchncahnbgone` | 6.1.6 | modern | `5587fe2b6a9946101ca0dde7c6efe76a755c5ee5b6d6e63dfc48c7f736cdb4ff` |
    | `unhook` | Unhook | cws | `khncfooichmfjbepaaaebmommgaepoid` | 1.6.9 | modern | `8622b2698dff08baae26a8c3638f524e66dfc12562e728694819fa1ef2e28023` |
    | `dark-reader` | Dark Reader | cws | `eimadpbcbfnmbkopoojfekhnkhdbieeh` | 4.9.133 | modern | `ee38f20d1d50789f4b482c9a1a5dadab599b8682fd2a7dfb7de21fae8561b918` |
    | `betterttv` | BetterTTV | cws | `ajopnjidmegmdimjlfnijceegpefgped` | 7.7.28 | modern | `6089554fd0f7c575c6af22699560e2494f11729bfdfad387369b5d31d82bb31e` |
    | `augmented-steam` | Augmented Steam | cws | `dnhpnfgdlenaccegplpojghhmaamnnfp` | 5.0.0 | modern | `5494bb90e170d5a7742db46312f2617ff38125f118ef51d77affa1eb4f9c0368` |
    | `improve-youtube` | Improve YouTube! | cws | `bnomihfieiccainjcjblhegjgglakjdd` | 4.2081 | modern | `81cc045737cd485412a415583300a529b0aaead5ec84c05d741b7a3900f7ca2c` |
    | `reddit-enhancement-suite` | Reddit Enhancement Suite | cws | `kbmfpngjjgdllneeigpgjifpgocmfgmb` | 5.24.11 | modern | `fb8100764b797e95c8fe1dd712f9ce0363cac5cb4daeaefa45fd5ab1e641e550` |
    | `modrinth-extras` | Modrinth Extras | cws | `ajmkilipadfpaefpcjfgnkejalmhdlcj` | 1.7.5 | modern | `7cdbbd94f6d20c4253b31fc7b22d815287d7986ca213c487a14bfc959cbd2af5` |
    | `octotree` | Octotree | cws | `bkhaagjahfmjljalopjnoealnfndnagc` | 9.3.2 | modern | `fef2d4ed27061a3f7f8c41f61f229064e4375516980e123c0a89f40eb55b8a43` |
    | `enhanced-github` | Enhanced GitHub | cws | `anlikcnbgdeidpacdbdljnabclhahhmd` | 6.0.0 | modern | `4fe8ba8498b117f8c168fd4e09f89c3a34593b64909eb1af610d141e07527ce0` |
    | `ublock-origin-lite` | uBlock Origin Lite | cws | `ddkjiahejlhfcafbddmgiahcphecmpfh` | 2026.1012.1545 | negative | `de67c08f8f7a337bc82c2cc86423eea0243e02be3fd3bd9e289c20c82eadb24a` |
    | `momentum` | Momentum | cws | `laookkfknpbbblfpciffpaejjkokdgca` | 2.27.8 | negative | `c7d574585d6c26065ef5efffcdcbdc89ec92c28857138b4522da0eb4bc425328` |
    | `react-devtools` | React Developer Tools | cws | `fmkadmapgofadopljbjfkapdkoienihi` | 8.0.0 | negative | `d92e1122a16362cc5510927068a5b1a8d50b43e1f3be25c3117f7c005807b302` |

    `modrinth-extras` also carries:

    ```json
    "swap": {
      "replaces": "Wikiwand",
      "reason": "Wikiwand 11.0.0 has no content scripts: its one feature is a declarativeNetRequest redirect to wikiwand.com, which a userscript can't do. Modrinth Extras is a site-specific MV3 extension built with WXT."
    }
    ```
  - **`package.json`:** add the script `"bench:pin": "node --experimental-strip-types --disable-warning=ExperimentalWarning bench/pin.ts"`.

- [ ] **Step 5: Run it.**
  - Command: `npm run test:file -- test/unit/bench.test.ts`, then `npm run typecheck`.
  - Expected: PASS, 4 of 4; `tsc` clean.
  - Then `ls bench/.cache/archives | wc -l` counts 23 files, and the following prints `23 1.17.1 false`:

    ```
    node --experimental-strip-types --disable-warning=ExperimentalWarning -e 'import("./bench/corpus.ts").then(async (c) => { const all = await c.loadCorpus(); const a = await c.archiveOf(all[0]); console.log(all.length, a.version, a.drifted) })'
    ```

    A `true` at the end means the pinned archive wasn't in the cache, and the store's current one was downloaded.

- [ ] **Step 6: Commit.**

```bash
git add docs/superpowers/specs/2026-10-09-ext2userscript-design.md package.json bench/corpus.ts bench/corpus.json bench/pin.ts test/unit/bench.test.ts
git commit -m "Pin the benchmark corpus, get each case's archive from the cache or the store, and re-pin with bench:pin" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Case types and the scorecard

**Files:**
- Create: `bench/case.ts`, `bench/scorecard.ts`
- Test: `test/unit/bench.test.ts`

**Interfaces:**
- Produces, in **`bench/case.ts`**:
  - `const TOOLS = ["ext2userscript", "baseline"] as const` and `type Tool = (typeof TOOLS)[number]`;
  - `type Outcome = { result: "pass" | "fail" | "n/a"; detail?: string }`;
  - `type CaseResult = { entry: CorpusEntry; version: string; drifted: boolean; reference: Outcome; outcomes: Record<Tool, Outcome> }`;
  - `type RouteAnswer = { body: string; type: string }`;
  - `type CaseContext = { open(url: string): Promise<Page> }`;
  - `type BrowserCase = { routes?: Record<string, RouteAnswer>; run(context: CaseContext): Promise<void> }`, where a route's key is a Playwright URL glob;
  - `type NegativeCase = { report: { verdict: "unlikely"; subjects: string[] } }`;
  - `type BenchCase = BrowserCase | NegativeCase`.
- Produces, in **`bench/scorecard.ts`**:
  - `type Criteria = { matched: [number, number]; modern: [number, number]; negatives: [number, number]; inconclusive: string[]; met: boolean }`;
  - `criteria(results: readonly CaseResult[]): Criteria`;
  - `scorecard(results: readonly CaseResult[], meta: { backend: string; baseline: string; commit: string; date: string }): string`.

- [ ] **Step 1: Write the failing tests.** Add to `test/unit/bench.test.ts`. The imports gain `import type { CaseResult, Outcome } from "../../bench/case.ts";` and `import { criteria, scorecard } from "../../bench/scorecard.ts";`.

```ts
const PASS: Outcome = { result: "pass" };
const FAIL: Outcome = { result: "fail", detail: "no effect" };
const NA: Outcome = { result: "n/a" };
const result = (id: string, kind: CorpusEntry["kind"], ours: Outcome, theirs: Outcome, reference: Outcome = kind === "negative" ? NA : PASS): CaseResult => ({
  entry: entry(id, kind), version: "1.0", drifted: false, reference, outcomes: { ext2userscript: ours, "baseline": theirs },
});

describe("criteria", () => {
  it("counts the cases the baseline passes, the modern cases it fails, and the negatives", () => {
    const c = criteria([
      result("l1", "legacy", PASS, PASS),
      result("l2", "legacy", FAIL, PASS),
      result("m1", "modern", PASS, FAIL),
      result("m2", "modern", FAIL, FAIL),
      result("m3", "modern", PASS, PASS),
      result("n1", "negative", PASS, NA),
    ]);
    assert.deepEqual(c, { matched: [2, 3], modern: [1, 2], negatives: [1, 1], inconclusive: [], met: false });
  });

  it("is met at 75% of the modern cases the baseline fails, and not below", () => {
    const modern = (passed: number) => Array.from({ length: 4 }, (_, i) => result(`m${i}`, "modern", i < passed ? PASS : FAIL, FAIL));
    assert.equal(criteria(modern(3)).met, true);
    assert.equal(criteria(modern(2)).met, false);
  });

  it("leaves out a case the original extension fails, and isn't met while one is inconclusive", () => {
    const c = criteria([result("l1", "legacy", FAIL, PASS, FAIL), result("m1", "modern", PASS, FAIL)]);
    assert.deepEqual(c.matched, [0, 0]);
    assert.deepEqual(c.inconclusive, ["l1"]);
    assert.equal(c.met, false);
  });
});

describe("scorecard", () => {
  it("shows each case's outcomes, a drifted version, and the criteria", () => {
    const drifted = { ...result("rg", "modern", { result: "fail", detail: "a | b\nc" }, FAIL), version: "2.0", drifted: true };
    const card = scorecard([drifted, result("mv2", "legacy", PASS, PASS, { result: "n/a", detail: "Manifest V2" })], {
      backend: "emulator", baseline: "0.1.4", commit: "abc1234", date: "2026-10-19",
    });
    assert.match(card, /2026-10-19, backend emulator, ext2userscript abc1234, the baseline 0\.1\.4/);
    assert.match(card, /\| rg \| modern \| 2\.0 \(pinned 1\.0\) \| pass \| fail: a \\\| b c \| fail: no effect \|/);
    assert.match(card, /\| mv2 \| legacy \| 1\.0 \| n\/a \(Manifest V2\) \| pass \| pass \|/);
    assert.match(card, /- \[x\] Passes every case the baseline passes: 1 of 1, 100%/);
    assert.match(card, /- \[ \] Passes at least 75% of the modern cases the baseline fails: 0 of 1, 0%/);
    assert.match(card, /- \[x\] An accurate report for every negative case: none to count/);
    assert.match(card, /\*\*Not met yet\.\*\*/);
  });
});
```

- [ ] **Step 2: Run it.**
  - Command: `npm run test:file -- test/unit/bench.test.ts`.
  - Expected: FAIL, `Cannot find module '…/bench/scorecard.ts'`. The import from `case.ts` is type-only, so it is erased.

- [ ] **Step 3: Implement.**
  - **`bench/case.ts`:** the types above, with a header comment. A browser case checks one or two effects the extension has on a page; a negative case checks what the report says. `routes` is for sites that stop automated browsers.
  - **`bench/scorecard.ts`:**
    - **`criteria`:**
      - **Inconclusive:** a result whose `reference.result` is `"fail"`. Every count below uses only the other results.
      - **`matched`:** of the non-negative cases the baseline passes, how many ext2userscript passes.
      - **`modern`:** of the `modern` cases the baseline doesn't pass, how many ext2userscript passes.
      - **`negatives`:** of the negative cases, how many ext2userscript passes.
      - **`met`:** `matched` full, `modern[0] >= 0.75 * modern[1]`, `negatives` full, and nothing inconclusive. A `[0, 0]` count is met.
    - **`scorecard`** is this exact text, joined with `\n`:
      - `# Benchmark scorecard`, a blank line, then `<date>, backend <backend>, ext2userscript <commit>, the baseline <baseline>` and a blank line.
      - The table header `| Case | Kind | Version | Original | ext2userscript | the baseline |` and `|---|---|---|---|---|---|`, then one row per result:
        - **Case:** `entry.name`.
        - **Version:** `version`, or `<version> (pinned <entry.version>)` when drifted.
        - **Each outcome cell:**
          - a fail is `fail: <detail>`;
          - otherwise `<result> (<detail>)` when there's a detail, or `<result>` when there isn't;
          - in the detail, whitespace runs become one space and `|` becomes `\|`, and it's cut to 200 characters.
      - A blank line, then `## Ship criteria (spec §1)` and a blank line.
      - Four lines, each starting with `- [x]` when met and `- [ ]` when not:
        1. `Passes every case the baseline passes: <n of m>`;
        2. `Passes at least 75% of the modern cases the baseline fails: <n of m>`;
        3. `An accurate report for every negative case: <n of m>`;
        4. `Every case conclusive (the original extension passes it): all`, or `not <ids joined with ", ">`.

        `<n of m>` is `n of m, <round(100n/m)>%`, or `none to count` when `m` is 0.
      - A blank line, then `**All met.**` or `**Not met yet.**`, and a trailing newline.

- [ ] **Step 4: Run it.**
  - Command: `npm run test:file -- test/unit/bench.test.ts`, then `npm run typecheck`.
  - Expected: PASS, 8 of 8; `tsc` clean.

- [ ] **Step 5: Commit.**

```bash
git add bench/case.ts bench/scorecard.ts test/unit/bench.test.ts
git commit -m "Add the benchmark's case types and its scorecard, with v1's ship criteria and inconclusive cases" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The runner, its CI job, and the pilot cases

**Files:**
- Create:
  - `bench/tools.ts`, `bench/reference.ts`, `bench/run.ts`;
  - the four pilot case scripts: `bench/cases/json-formatter.ts`, `bench/cases/ublock-origin-lite.ts`, `bench/cases/momentum.ts`, `bench/cases/react-devtools.ts`;
  - `test/browser/bench.test.ts`.
- Modify: `package.json`, `.github/workflows/ci.yml`, `README.md`
- Test: `test/unit/bench.test.ts`, `test/browser/bench.test.ts`

**Interfaces:**
- Consumes:
  - Task 1's `CorpusEntry`, `Archive`, `CACHE`, `loadCorpus` and `archiveOf`;
  - Task 2's case types, `criteria` and `scorecard`;
  - `startSession`, `backendsFromEnv`, `Backend` and `Session` from `bench/session.ts`;
  - `convert` (`src/convert/index.ts`), `loadRuntime` (`src/convert/runtime-node.ts`), `loadEsbuild` (`src/convert/esbuild-node.ts`), `unpack`, `readManifest` (`src/convert/manifest.ts`) and `Report` (`src/convert/report.ts`).
- Produces, in **`bench/tools.ts`**:
  - `baselineSpec(): string`, which is `$X2U_BASELINE` (empty when unset);
  - `baselineVersion(): Promise<string>`;
  - `convertWith(tool: Tool, entry: CorpusEntry, archive: Archive): Promise<{ userscript: string; report?: Report }>`.
- Produces, in **`bench/reference.ts`**: `startReference(archive: Archive): Promise<Session | undefined>`, which gives `undefined` for Manifest V2.
- Produces, in **`bench/run.ts`**:
  - `serve(context: BrowserContext, bench: BrowserCase): Promise<void>`;
  - `check(bench: BrowserCase, session: Session): Promise<Outcome>`, which closes the session;
  - `runCase(tool: Tool, entry: CorpusEntry, archive: Archive, bench: BenchCase, backend: Backend): Promise<Outcome>`;
  - `runReference(archive: Archive, bench: BenchCase): Promise<Outcome>`;
  - `runCorpus(backends: readonly Backend[], entries: readonly CorpusEntry[], getArchive?: (entry: CorpusEntry) => Promise<Archive>): Promise<Map<Backend, CaseResult[]>>`.

- [ ] **Step 1: Write the failing unit tests.** Add to `test/unit/bench.test.ts`, importing `{ runCase, runCorpus, runReference }` from `../../bench/run.ts`:

```ts
describe("runReference", () => {
  it("is n/a for a negative case and for Manifest V2, without starting a browser", async () => {
    const mv2 = zipFiles(files({ "manifest.json": JSON.stringify({ name: "A", version: "1", manifest_version: 2 }) }));
    const archive2 = { path: "", bytes: mv2, version: "1", sha256: "", drifted: false };
    assert.deepEqual(await runReference(archive2, { report: { verdict: "unlikely", subjects: [] } }), { result: "n/a" });
    assert.deepEqual(await runReference(archive2, { run: async () => {} }), { result: "n/a", detail: "Manifest V2" });
  });
});

describe("runCase on a negative case", () => {
  const devtools = zipFiles(files({ "manifest.json": JSON.stringify({ name: "D", version: "1", manifest_version: 3, devtools_page: "d.html" }), "d.html": "<!doctype html>" }));
  const archiveD = { path: "", bytes: devtools, version: "1", sha256: "", drifted: false };

  it("passes when the report is unlikely and names each subject as unsupported, and is n/a for the baseline", async () => {
    const bench = { report: { verdict: "unlikely" as const, subjects: ["manifest.devtools_page"] } };
    assert.deepEqual(await runCase("ext2userscript", entry("d", "negative"), archiveD, bench, "emulator"), { result: "pass" });
    assert.deepEqual(await runCase("baseline", entry("d", "negative"), archiveD, bench, "emulator"), { result: "n/a" });
  });

  it("fails, naming what the report misses", async () => {
    const bench = { report: { verdict: "unlikely" as const, subjects: ["manifest.devtools_page", "manifest.chrome_url_overrides"] } };
    assert.deepEqual(await runCase("ext2userscript", entry("d", "negative"), archiveD, bench, "emulator"), {
      result: "fail",
      detail: "the report doesn't name manifest.chrome_url_overrides as unsupported",
    });
  });
});

describe("runCase on a browser case", () => {
  it("fails when the conversion does, with the build's error and not just its heading", async () => {
    const manifest = { name: "B", version: "1", manifest_version: 3, background: { service_worker: "bg.js", type: "module" } };
    const bytes = zipFiles(files({ "manifest.json": JSON.stringify(manifest), "bg.js": `import "./missing.js";` }));
    const outcome = await runCase("ext2userscript", entry("b", "modern"), { path: "", bytes, version: "1", sha256: "", drifted: false }, { run: async () => {} }, "emulator");
    assert.equal(outcome.result, "fail");
    assert.match(outcome.detail ?? "", /^conversion failed: Build failed with 1 error: .*\.\/missing\.js \(imported from bg\.js\) is not in the extension$/);
  });
});

describe("runCorpus", () => {
  it("marks a case whose archive can't be had as failed everywhere, its reference too, and goes on", async () => {
    const results = await runCorpus(["emulator", "tm"], [entry("gone", "modern")], async () => {
      throw new Error("The download is empty");
    });
    const failed = { result: "fail", detail: "couldn't get the archive: The download is empty" };
    for (const backend of ["emulator", "tm"] as const) {
      assert.deepEqual(results.get(backend)?.map(({ reference, outcomes }) => ({ reference, outcomes })), [{ reference: failed, outcomes: { ext2userscript: failed, "baseline": failed } }]);
    }
  });
});
```

- [ ] **Step 2: Write the failing browser test** `test/browser/bench.test.ts`:

```ts
// The benchmark's runner (bench/run.ts) on pages it serves itself: a case against the CI emulator, and against an
// original extension.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BrowserCase } from "../../bench/case.ts";
import { check, runReference } from "../../bench/run.ts";
import { startSession } from "../../bench/session.ts";
import { files, zipFiles } from "../support/extension.ts";
import { renderMeta } from "../support/userscript.ts";

// Every request to the site matches this route, the emulator's own included.
const routes = { "https://site.x2u.test/**": { body: "<!doctype html><title>t</title><p>page</p>", type: "text/html" } };
const tagged = (timeout: number): BrowserCase => ({
  routes,
  async run({ open }) {
    const page = await open("https://site.x2u.test/");
    await page.locator("html[data-tagged]").waitFor({ state: "attached", timeout });
  },
});
const userscript = (body: string) => `${renderMeta({ name: "t", match: ["https://site.x2u.test/*"], grant: ["GM_getValue"] })}\n${body}`;
const TAG = `document.documentElement.dataset.tagged = "1";`;

describe("bench runner", () => {
  it("passes a case whose effect shows, with the emulator working under the case's catch-all route", async () => {
    assert.deepEqual(await check(tagged(10_000), await startSession("emulator", userscript(TAG))), { result: "pass" });
  });

  it("fails a case whose effect doesn't show, naming the first error a page threw", async () => {
    const outcome = await check(tagged(2_000), await startSession("emulator", userscript(`throw new Error("boom");`)));
    assert.equal(outcome.result, "fail");
    assert.match(outcome.detail ?? "", /^locator\.waitFor: Timeout 2000ms exceeded\. \(first page error: boom\)$/);
  });

  it("runs a case against the original extension", async () => {
    const manifest = { manifest_version: 3, name: "T", version: "1", content_scripts: [{ matches: ["https://site.x2u.test/*"], js: ["c.js"] }] };
    const bytes = zipFiles(files({ "manifest.json": JSON.stringify(manifest), "c.js": TAG }));
    assert.deepEqual(await runReference({ path: "", bytes, version: "1", sha256: "", drifted: false }, tagged(10_000)), { result: "pass" });
  });
});
```

- [ ] **Step 3: Run them.**
  - Command: `npm run test:file -- test/unit/bench.test.ts test/browser/bench.test.ts`.
  - Expected: FAIL, `Cannot find module '…/bench/run.ts'`.

- [ ] **Step 4: Implement.**
  - **`bench/tools.ts`:**
    - **ext2userscript:** `convertWith` calls `convert(unpack(archive.bytes), { runtime: await loadRuntime(), esbuild: await loadEsbuild(), extensionId: entry.extensionId })`. It leaves `extensionId` out for `amo`: a store's ID is the extension's ID, as the CLI gives it (spec §7).
    - **The baseline:** in a fresh `mkdtemp` folder, run `npx --yes <baselineSpec()> convert <archive.path> -o <dir>/<id>.user.js --no-minify --force`, with a 300 s timeout and a 64 MB `maxBuffer`. Read the output, then remove the folder in `finally`.
    - **`baselineVersion`:** `npm view <spec> version`, trimmed.
  - **`bench/reference.ts`:**
    - **`startReference`:** if `readManifest(files).model.manifestVersion === 2`, return `undefined`. Otherwise write the unpacked files to `<mkdtemp>/extension` and call `chromium.launchPersistentContext(<mkdtemp>/profile, { channel: "chromium", args: ["--disable-extensions-except=<dir>", "--load-extension=<dir>"] })`.
    - **The comment** on `channel` says only Chromium's new headless mode loads extensions.
    - **Cleanup:** `close()` closes the context and removes the folder. A failed launch removes the folder and rethrows.
  - **`bench/run.ts`:**
    - **`CASE_TIMEOUT_MS = 120_000`.**
    - **`firstLine(error)`:** the message's first line. When that line ends with `:` and another follows (esbuild's `Build failed with 2 errors:`), it is the first line, a space, and the next line trimmed.
    - **`serve`:** for each route, `context.route(glob, …)` calls `route.fallback()` for paths starting `/__x2u_emu__/` (the emulator's own routes, which a later route would shadow); otherwise `route.fulfill({ status: 200, contentType, body })`.
    - **`check`:**
      - it collects `firstLine` of each `pageerror` from every page the context opens, then serves the routes;
      - `open(url)` makes a new page and calls `page.goto(url, { waitUntil: "domcontentloaded" })`;
      - it races `bench.run({ open })` against a `timed out after 120 s` rejection;
      - **on failure:** `{ result: "fail", detail: firstLine(error) + " (first page error: <first>)" }`, the suffix only when a page threw;
      - it always closes the session.
    - **`runCase`:**
      - **A negative case:**
        - `baseline` gets `{ result: "n/a" }`.
        - ext2userscript's report must have `verdict === bench.report.verdict`, otherwise the detail is `verdict is <v>, not unlikely`.
        - Every subject must appear with `status: "unsupported"`, otherwise the detail is `the report doesn't name <missing joined with ", "> as unsupported`.
      - **A browser case:** a conversion throw gives `conversion failed: <firstLine>`; a `startSession` throw gives `couldn't start <backend>: <firstLine>`; then `check`.
    - **`runReference`:**
      - a negative case gets `{ result: "n/a" }`;
      - a `startReference` throw gives `{ result: "fail", detail: "couldn't load the extension: <firstLine>" }`;
      - `undefined` gives `{ result: "n/a", detail: "Manifest V2" }`;
      - otherwise `check`.
    - **`runCorpus`:**
      - per entry, `getArchive` (default `archiveOf`); a throw pushes, for every backend, a result whose reference and both outcomes are `fail: couldn't get the archive: <firstLine>`, then continues;
      - otherwise it imports `./cases/<id>.ts`, runs the reference once, then each tool on each backend;
      - it logs `<id> (<backend>): reference <r>, ext2userscript <r>, the baseline <r>`.
    - **The CLI** (when `process.argv[1] === import.meta.filename`):
      - `--case id[,id…]` filters the corpus, and `backendsFromEnv()` picks the backends;
      - the commit is `git rev-parse --short HEAD`, or `(not a git checkout)` when that fails; the date is `new Date().toISOString().slice(0, 10)`;
      - per backend, it writes `bench/.cache/scorecard-<backend>.md` and prints it;
      - it ends with `process.exit(1)` when `--gate` is given and any backend's criteria aren't met, and `process.exit(0)` otherwise;
      - the explicit exit is deliberate: a browser whose connection dropped stays alive and would keep the run from ending, and exiting kills every browser Playwright launched (prototype finding 8);
      - the header comment gives the usage.
  - **The pilot case scripts:**
    - **`bench/cases/json-formatter.ts`:**

      ```ts
      // JSON Formatter turns a JSON response into a collapsible tree, and sets window.json in the page.
      import type { BrowserCase } from "../case.ts";

      const DATA = { name: "x2u", list: [1, 2, 3], nested: { ok: true } };

      export default {
        routes: { "https://json.x2u.test/**": { body: JSON.stringify(DATA), type: "application/json" } },
        async run({ open }) {
          const page = await open("https://json.x2u.test/data.json");
          await page.locator("#jsonFormatterParsed").waitFor();
          await page.waitForFunction(() => (window as { json?: { name?: string } }).json?.name === "x2u");
        },
      } satisfies BrowserCase;
      ```
    - **The three negatives:** each is `export default { report: { verdict: "unlikely", subjects: [<subject>] } } satisfies NegativeCase;`, under a one-line comment saying why:
      - `ublock-origin-lite`: `manifest.declarative_net_request` ("blocks requests with declarativeNetRequest, which a userscript can't do");
      - `momentum`: `manifest.chrome_url_overrides` ("replaces the new tab page");
      - `react-devtools`: `manifest.devtools_page` ("adds a developer tools panel").
  - **`package.json`:** add `"bench": "node --experimental-strip-types --disable-warning=ExperimentalWarning bench/run.ts"`.
  - **`.github/workflows/ci.yml`:** add this job, after `test`, needing nothing:

    ```yaml
      bench:
        runs-on: ubuntu-latest
        timeout-minutes: 60
        steps:
          - uses: actions/checkout@v4
          - uses: actions/setup-node@v4
            with:
              node-version: 22
              cache: npm
          - run: npm ci
          - run: npx playwright install --with-deps chromium
          - uses: actions/cache@v4
            with:
              path: bench/.cache/archives
              key: bench-archives-${{ hashFiles('bench/corpus.json') }}
              restore-keys: bench-archives-
          # Reports the scorecard; it doesn't gate until v1 meets the criteria (spec §10.5).
          - run: npm run bench
          - if: always()
            run: cat bench/.cache/scorecard-emulator.md >> "$GITHUB_STEP_SUMMARY"
    ```
  - **`README.md`:** under Development, add a "Benchmark" paragraph with:
    - `npm run bench` (the corpus on the emulator; the scorecard goes to `bench/.cache/scorecard-emulator.md`);
    - `npm run bench -- --case json-formatter,dark-reader`;
    - the release gate, `X2U_BACKENDS=emulator,tm,vm npm run bench -- --gate` (needs `npm run bench:setup` once; `BENCH_PROFILE` overrides the profile);
    - `npm run bench:pin` when a store has moved on;
    - that the first run downloads the 23 archives into `bench/.cache/`, and that they're never committed.

- [ ] **Step 5: Run them.**
  - Command: `npm run test:file -- test/unit/bench.test.ts test/browser/bench.test.ts`.
  - Expected: PASS, unit 13 of 13, browser 3 of 3.
  - **Check that each test catches its bug:**
    1. Change `/__x2u_emu__/` in `serve` to another path. The first two browser tests should fail, with `first page error: Unexpected token '<'`.
    2. Make `firstLine` return only the first line. The build-error test should fail, with `conversion failed: Build failed with 1 error:`.

    Restore both.

- [ ] **Step 6: Run the pilot cases.**
  - Command: `npm run bench -- --case json-formatter,ublock-origin-lite,momentum,react-devtools`.
  - Expected:

    ```
    json-formatter (emulator): reference pass, ext2userscript pass, the baseline pass
    ublock-origin-lite (emulator): reference n/a, ext2userscript pass, the baseline n/a
    momentum (emulator): reference n/a, ext2userscript pass, the baseline n/a
    react-devtools (emulator): reference n/a, ext2userscript pass, the baseline n/a
    ```

    Then `npm test -- --test-concurrency=2` and `npm run typecheck`, both green.

- [ ] **Step 7: Commit.**

```bash
git add bench/tools.ts bench/reference.ts bench/run.ts bench/cases test/unit/bench.test.ts test/browser/bench.test.ts package.json .github/workflows/ci.yml README.md
git commit -m "Run the corpus with ext2userscript, the baseline and the original extension, and report it in CI" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: A fresh profile for each real-manager session

**Files:**
- Modify: `bench/real/managers.ts`, `bench/real/launch.ts`, `bench/session.ts`
- Test: `test/unit/bench.test.ts`

**Interfaces:**
- Produces:
  - `copyProfile(from: string, to: string): Promise<void>` in `bench/real/managers.ts`;
  - `launchReal(manager: ManagerName, profile = profileDir())` in `bench/real/launch.ts`, which now takes the profile.
- `startSession`'s signature is unchanged; its real-manager branch now uses a copy.

- [ ] **Step 1: Write the failing test.** Add to `test/unit/bench.test.ts`. Import `mkdir` from `node:fs/promises`, and `{ copyProfile }` from `../../bench/real/managers.ts`.

```ts
describe("copyProfile", () => {
  it("copies a profile without its caches and a running browser's locks", async () => {
    const from = await mkdtemp(join(tmpdir(), "x2u-profile-"));
    for (const dir of ["Default/Cache", "Default/Code Cache", "Default/Local Extension Settings"]) await mkdir(join(from, dir), { recursive: true });
    await writeFile(join(from, "Default/Preferences"), "{}");
    await writeFile(join(from, "Default/Cache/data_0"), "x");
    await writeFile(join(from, "SingletonLock"), "x");
    const to = join(await mkdtemp(join(tmpdir(), "x2u-profile-")), "copy");
    await copyProfile(from, to);
    assert.deepEqual((await readdir(to)).sort(), ["Default"]);
    assert.deepEqual((await readdir(join(to, "Default"))).sort(), ["Local Extension Settings", "Preferences"]);
  });
});
```

- [ ] **Step 2: Run it.**
  - Command: `npm run test:file -- test/unit/bench.test.ts`.
  - Expected: FAIL, `SyntaxError: The requested module '../../bench/real/managers.ts' does not provide an export named 'copyProfile'`.

- [ ] **Step 3: Implement.**
  - **`copyProfile`:**
    - `cp(from, to, { recursive: true, filter })`. The filter drops any path whose base name matches `/^(Cache|Code Cache|GPUCache|GPUPersistentCache|GraphiteDawnCache|DawnGraphiteCache|DawnWebGPUCache|Singleton.*)$/`.
    - Its doc comment: a manager keeps every userscript in the profile, so the bench's cases would otherwise run each other's; the copy keeps "Allow User Scripts".
  - **`launchReal`:** launches `profile` instead of `profileDir()`.
  - **`startSession`, real backends:**
    - `mkdtemp(join(tmpdir(), "x2u-profile-"))`, then `copyProfile(profileDir(), profile)`, then `launchReal(backend, profile)`; a throw from these removes the copy and rethrows;
    - then `installUserscript`; a throw closes the context, removes the copy and rethrows;
    - `close` is `context.close().finally(removeProfile)`;
    - a comment says each session gets its own copy of the profile, so it runs only its own userscript.

- [ ] **Step 4: Run it.**
  - Command: `npm run test:file -- test/unit/bench.test.ts`, then `npm run typecheck`.
  - Expected: PASS, 14 of 14; `tsc` clean.

- [ ] **Step 5: Check the release tier (local only; needs `npm run bench:setup` once).**
  - Command: `X2U_BACKENDS=tm,vm npm run bench -- --case json-formatter`.
  - Expected:

    ```
    json-formatter (tm): reference pass, ext2userscript pass, the baseline fail
    json-formatter (vm): reference pass, ext2userscript pass, the baseline fail
    ```

    the baseline sets `window.json` from the managers' sandbox; see prototype finding 7.
  - If this machine has no real-tier setup, record a ruling and leave the check to the release.

- [ ] **Step 6: Commit.**

```bash
git add bench/real/managers.ts bench/real/launch.ts bench/session.ts test/unit/bench.test.ts
git commit -m "Run each real-manager session on its own copy of the bench profile" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The other 19 case scripts

**Files:**
- Create: `bench/fixtures.ts`, plus `bench/cases/<id>.ts` for the 19 ids below
- Test: `test/unit/bench.test.ts`

**Interfaces:**
- Consumes: Task 2's `BrowserCase`.
- Produces: `GOOGLE_RESULTS: string` and `OLD_REDDIT: string` in `bench/fixtures.ts`.

- [ ] **Step 1: Write the failing test.** Add to `test/unit/bench.test.ts`, importing `loadCorpus`:

```ts
describe("the corpus", () => {
  it("pins 23 cases, 8 legacy, 12 modern and 3 negative, each with its script", async () => {
    const corpus = await loadCorpus();
    assert.equal(new Set(corpus.map((c) => c.id)).size, corpus.length);
    assert.deepEqual(["legacy", "modern", "negative"].map((kind) => corpus.filter((c) => c.kind === kind).length), [8, 12, 3]);
    for (const c of corpus) {
      assert.match(c.sha256, /^[0-9a-f]{64}$/, c.id);
      const bench = (await import(`../../bench/cases/${c.id}.ts`)).default;
      assert.equal("report" in bench, c.kind === "negative", c.id);
    }
    const scripts = (await readdir(new URL("../../bench/cases/", import.meta.url))).map((file) => file.replace(/\.ts$/, ""));
    assert.deepEqual(scripts.sort(), corpus.map((c) => c.id).sort());
  });
});
```

- [ ] **Step 2: Run it.**
  - Command: `npm run test:file -- test/unit/bench.test.ts`.
  - Expected: FAIL, `Cannot find module '…/bench/cases/material-icons-github.ts'`.

- [ ] **Step 3: Write `bench/fixtures.ts`.** Its header comment: "Pages the cases serve in place of sites that stop automated browsers." The markup is exact: the extensions look for these classes.

```ts
// A Google results page for the search cases, in the markup both extensions look for: each result is a .vt6azd
// block in #search with a link around its h3, under an .r.yuRUbf wrapper.
const result = (url: string, title: string) =>
  `<div class="MjjYud"><div class="g vt6azd" data-hveid="x"><div class="r yuRUbf"><a href="${url}"><h3>${title}</h3><cite>${new URL(url).hostname}</cite></a></div><div class="VwiC3b">About ${title}.</div></div></div>`;

export const GOOGLE_RESULTS = `<!doctype html><html lang="en"><title>userscript - Google Search</title>
<body><div id="main"><div id="search"><div id="rso">
${result("https://en.wikipedia.org/wiki/Userscript", "Userscript - Wikipedia")}
${result("https://www.tampermonkey.net/", "Tampermonkey")}
${result("https://violentmonkey.github.io/", "Violentmonkey")}
</div></div></div></body></html>`;

// An old Reddit subreddit listing for Reddit Enhancement Suite: the header and one link post with an image.
export const OLD_REDDIT = `<!doctype html><html lang="en"><title>userscripts</title>
<body class="listing-page"><div id="header"><div id="header-bottom-left"><span class="pagename redditname"><a href="/r/userscripts/">userscripts</a></span></div>
<div id="header-bottom-right"><span class="user">Want to join? <a href="/login">Log in or sign up</a></span></div></div>
<div class="content" role="main"><div id="siteTable" class="sitetable linklisting">
<div class="thing link" id="thing_t3_x2u" data-fullname="t3_x2u" data-type="link" data-subreddit="userscripts" data-author="x2u" data-domain="i.redd.it" data-url="https://i.redd.it/x2u.png">
<div class="entry"><div class="top-matter"><p class="title"><a class="title may-blank" href="https://i.redd.it/x2u.png">A screenshot</a></p>
<ul class="flat-list buttons"><li class="first"><a class="bylink comments" href="https://old.reddit.com/r/userscripts/comments/x2u/a_screenshot/">2 comments</a></li></ul></div></div></div>
</div></div></body></html>`;
```

- [ ] **Step 4: Write the case scripts.** Each is shaped like `json-formatter.ts`:
  - a one-line comment saying what the extension does to the page, and why the case serves the page if it does;
  - `routes` when the table names a served page;
  - `run` opens the URL and waits for each check in order, with `page.locator(<selector>).first().waitFor({ state: "attached" })`.

  The checks are what the original extension does in the prototype's reference run.

  | id | Opens | Served by the case | Checks |
  |---|---|---|---|
  | `material-icons-github` | `https://github.com/microsoft/vscode` | — | `[data-material-icons-extension-iconname='folder-github.svg']` |
  | `modern-wikipedia` | `https://en.wikipedia.org/wiki/Userscript` | — | `#wiki_header`, `#wiki_contents` |
  | `return-youtube-dislike` | `https://www.youtube.com/watch?v=jNQXAC9IVRw` | — | `#ryd-bar-container` |
  | `web-search-navigator` | `https://www.google.com/search?q=userscript` | `"https://www.google.com/search?**"`: `GOOGLE_RESULTS`, `text/html` | `#search a.wsn-google-focused-link` |
  | `ublacklist` | `https://www.google.com/search?q=userscript` | as above | `[data-ub-result] .ub-button`, the third one (`.nth(2)`) |
  | `iridium` | the YouTube URL above | — | `html.iridium-full-titles` |
  | `modern-hacker-news` | `https://news.ycombinator.com/` | — | `#hn_header` |
  | `leetcode-enhancer` | `https://leetcode.com/problems/two-sum/` | `"https://leetcode.com/**"`: the page below | see below |
  | `refined-github` | `https://github.com/refined-github/refined-github` | — | `html[refined-github]`, `#rgh-extensible-nav-code` |
  | `sponsorblock` | the YouTube URL above | — | `#previewbar` |
  | `unhook` | the YouTube URL above | — | `html[hide_feed='true']`, `html[hide_recommended='true']` |
  | `dark-reader` | `https://light.x2u.test/` | `"https://light.x2u.test/**"`: the page below | `html[data-darkreader-scheme='dark']`, `style.darkreader` |
  | `betterttv` | `https://www.twitch.tv/directory` | — | `#bttv-top-nav-settings-button-container` |
  | `augmented-steam` | `https://store.steampowered.com/app/620/Portal_2/` | — | `#as-menu` |
  | `improve-youtube` | the YouTube URL above | — | `html[it-pathname='/watch']`, `#it-below-player-loop` |
  | `reddit-enhancement-suite` | `https://old.reddit.com/r/userscripts/` | `"https://old.reddit.com/**"`: `OLD_REDDIT`, `text/html` | `html.res-r-userscripts`, `#RESAccountSwitcherIcon` |
  | `modrinth-extras` | `https://modrinth.com/mod/sodium` | — | `#modrinth-extras-tools-sidebar`, `#modrinth-extras-dependency-sidebar` |
  | `octotree` | `https://github.com/refined-github/refined-github` | — | `.octotree-sidebar` |
  | `enhanced-github` | `https://github.com/refined-github/refined-github` | — | `.eg-download` |

  - **Dark Reader's page:**

    ```
    <!doctype html><title>Light page</title><style>body { background: #fff; color: #000 }</style><h1>Light page</h1><p>Some text.</p>
    ```
  - **LeetCode Enhancer:** it turns on autocomplete in the problem's editor. Its content script injects `patchMonaco.js` into the page, which waits for `.monaco-editor` and calls `updateOptions` on every `window.monaco` editor. The served page has a stand-in editor:

    ```html
    <!doctype html><title>Two Sum - LeetCode</title>
    <div class="monaco-editor"></div>
    <script>
      window.monaco = { editor: { getEditors: () => [{ updateOptions(options) { window.editorOptions = options }, onDidChangeConfiguration() {} }] } };
    </script>
    ```

    The check is `page.waitForFunction(() => window.editorOptions?.wordBasedSuggestions === "allDocuments")`, with the same cast as `json-formatter.ts`.

- [ ] **Step 5: Run it.**
  - Command: `npm run test:file -- test/unit/bench.test.ts`, then `npm test -- --test-concurrency=2` and `npm run typecheck`.
  - Expected: PASS, 15 of 15; the full suite green (394); `tsc` clean.

- [ ] **Step 6: Run the whole corpus.**
  - Command: `npm run bench`. It takes about 30 minutes.
  - Expected:
    - the command returns to the prompt when the scorecard is printed, with no `chrome-headless-shell` process left behind (Augmented Steam's case drops a browser's connection);
    - the Original column is `pass` for every browser case except Web Search Navigator (`n/a (Manifest V2)`), and `n/a` for the three negatives;
    - "Every case conclusive" is checked;
    - the ext2userscript and the baseline columns match the prototype's scorecard above.

    A live site can block or change on the day. A case whose Original fails is inconclusive. Re-run it with `--case <id>`. If it still fails, fix the case script against what the original extension does now, before committing.

- [ ] **Step 7: Commit.**

```bash
git add bench/fixtures.ts bench/cases test/unit/bench.test.ts
git commit -m "Add the corpus's case scripts, with served pages for Google, Reddit and LeetCode" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
