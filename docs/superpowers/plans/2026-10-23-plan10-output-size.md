# ext2userscript Plan 10: Smaller Userscripts

**Goal:** shrink converted userscripts without changing what they do, and without making pages slower.

**Where the bytes were** (the 23 corpus extensions, 113.6 MB of userscripts):
- **The runtime:** a fixed 77 KB. Not the problem.
- **The extensions' own code:** most of the largest outputs. Augmented Steam ships 14.6 MB of JS, uBlacklist 11.5 MB and Reddit Enhancement Suite 7.7 MB, each entry already bundled with its dependencies by the extension's build. Sharing modules between content scripts would save nothing.
- **Images and fonts:** compressed already (Modern for Hacker News' 10 MB of PNG screenshots).
- **Text stored as plain base64:** text assets (JS, CSS, JSON, SVG, config files), every locale, and content and page CSS. SponsorBlock carried 2.2 MB of locales; Octotree 1.3 MB of content CSS and 7.4 MB of SVG icons.
- **Files embedded more than once:** BetterTTV's `betterttv.js` went in as MAIN-world code, as an injectable and as a web-accessible asset: 9 MB for one 2.7 MB file.
- **`--minify` made some outputs larger:** esbuild's default charset escapes every non-ASCII character (SponsorBlock: 4.5 → 5.8 MB).

## Task 1: Deflate the embedded text

- `src/convert/files.ts`:
  - `packFile` stores a file of 1 KB or more as raw DEFLATE, then base64, flagged `1` in its asset-table entry, when that is at least a tenth smaller.
  - `packText` and `packJson` do the same for config text, as `{ deflated: base64 }`.
- `src/convert/index.ts` packs locales, content CSS and page CSS.
- `src/runtime/assets.ts` inflates where each is used (fflate's `inflateSync`): a file on lookup, CSS on injection, a locale once per page (`messagesOf`, cached).
- `config.ts`: a message is an object, so a `Deflated` value is never mistaken for one.
- The base64 decoder is now a plain loop. `Uint8Array.from` with a callback per character took 25 ms for BetterTTV's script, against 0.7 ms.

## Task 2: Embed a MAIN-world script once

A MAIN-world group whose files are all in the asset table is emitted as `{ assets: [paths] }`, and `runContent` reads their text from the table. The sample extension's `main-world.js` is web-accessible now, so the content-runtime browser tests run this path.

## Task 3: Minify without escaping

`convert` minifies with `charset: "utf8"`.

## Results

| | Before | After |
|---|---|---|
| Corpus userscripts | 113.6 MB | 87.0 MB (−23%) |
| Minified | 101.5 MB | 72.2 MB (−29%) |
| Runtime | 78.9 KB | 83.3 KB |

Largest drops:
- React Developer Tools 2.96 → 0.99 MB;
- BetterTTV 10.2 → 4.0 MB;
- Improve YouTube! 3.5 → 1.7 MB;
- Octotree 9.5 → 5.1 MB;
- SponsorBlock 4.9 → 3.1 MB;
- Dark Reader 3.7 → 2.4 MB.

The three smallest outputs grew by 3–4 KB, the runtime's inflate.

Page cost, measured in Node:
- BetterTTV's 2.7 MB script: decode, inflate and text take about 13 ms per page. Parsing it as a string literal took about 10 ms.
- Octotree's 1.4 MB content CSS: 2.7 ms, against 3.4 ms.

Checks:
- Unit 437 (5 new).
- Browser suite on the emulator: 70 pass, plus the Firefox S3 test, which can't launch on macOS 27 and runs in CI.
- The package test passes.
- `X2U_BACKENDS=emulator,tm,vm npm run bench` on every case (no `X2U_BASELINE`).

## Not done

- An injectable that is also a single-file content group is still emitted twice (Material Icons, 160 KB). Merge their factories if a bigger case shows up.
- Minify stays opt-in: readable output keeps bug reports debuggable.
