# ext2userscript

Convert Chrome and Firefox extensions into userscripts for Tampermonkey and Violentmonkey.

## Usage

Content scripts and the background (service workers, background scripts and pages) are converted today, with
messaging, ports, tabs, storage, lifecycle events, cross-origin requests, alarms, context menus and the toolbar button
(as the userscript manager's menu commands), keyboard shortcuts, notifications, cookies, permissions and scripting.
Popups and options pages open in a modal over the page, from the userscript manager's menu ("Open <button>", "<name>
options"), the toolbar button's shortcut, `action.openPopup` or `runtime.openOptionsPage`. The report says what didn't
convert.

```bash
npx ext2userscript convert <source> [-o out.user.js] [--report report.json] [--locale xx] [--minify] [--ignore-assets glob,...] [--force]
npx ext2userscript download <source> [-o file]
npx ext2userscript report <source>
```

It needs Node 22.16 or newer. `npm install -g ext2userscript` installs the `ext2userscript` command.

`<source>` is a Chrome Web Store URL or ID, an AMO URL or slug, an Edge Add-ons URL, a `.crx`/`.xpi`/`.zip` URL, a
local archive or a folder. Exit codes: 0 done, 1 error, 2 converted but the verdict is "unlikely".

The web app does the same in the browser, where the extension never leaves the page: drop its `.crx`, `.zip` or
`.xpi` file, and download or copy the userscript. `npm run web -- --serve` builds it into `dist/web` and serves it at
http://localhost:8000/, and CI deploys it to GitHub Pages (in a fork, set Settings → Pages → Source to "GitHub
Actions" first). It runs at https://botted1.github.io/ext2userscript/. Store links in the web app need the optional download proxy
in `proxy/` (see [proxy/README.md](proxy/README.md)).

Work in progress. Design: [docs/superpowers/specs/2026-10-09-ext2userscript-design.md](docs/superpowers/specs/2026-10-09-ext2userscript-design.md).

## Development

Requires Node 22.16 or newer.

    npm install
    npx playwright install chromium firefox webkit
    npm test               # unit tests
    npm run test:browser   # browser tests against the CI emulator
    npm run typecheck
    npm run cli -- <command> <source>   # the CLI, from source
    npm run test:package   # npm pack, install the tarball and run its command (npm pack builds dist/cli.js)

### Benchmark

The benchmark converts 23 pinned extensions with ext2userscript and with the baseline, runs each case against the original extension and both userscripts, and writes a scorecard against v1's ship criteria (spec §1 and §10).

    npm run bench                                       # the corpus on the CI emulator; scorecard in bench/.cache/scorecard-emulator.md
    npm run bench -- --case json-formatter,dark-reader  # some cases only
    X2U_BACKENDS=emulator,tm,vm npm run bench -- --gate # the release gate, also on real Tampermonkey and Violentmonkey
    npm run bench:pin                                   # re-pin the cases to the stores' current versions

The release gate needs `npm run bench:setup` once; `BENCH_PROFILE` points it at another profile. The first run downloads the 23 archives into `bench/.cache/`, which is never committed.
