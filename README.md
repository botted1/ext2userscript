# ext2userscript

Convert Chrome and Firefox extensions into userscripts for Tampermonkey and Violentmonkey.

## Usage

Content scripts and the background (service workers, background scripts and pages) are converted today, with
messaging, ports, tabs, storage, lifecycle events, cross-origin requests, alarms, context menus and the toolbar button
(as the userscript manager's menu commands), keyboard shortcuts, notifications, cookies, permissions and scripting.
Popups and options pages come next, and the report says what didn't convert.

```bash
npm run cli -- convert <source> [-o out.user.js] [--report report.json] [--locale xx] [--minify] [--ignore-assets glob,...] [--force]
npm run cli -- download <source> [-o file]
npm run cli -- report <source>
```

`<source>` is a Chrome Web Store URL or ID, an AMO URL or slug, an Edge Add-ons URL, a `.crx`/`.xpi`/`.zip` URL, a
local archive or a folder. Exit codes: 0 done, 1 error, 2 converted but the verdict is "unlikely".

Work in progress. Design: [docs/superpowers/specs/2026-10-09-ext2userscript-design.md](docs/superpowers/specs/2026-10-09-ext2userscript-design.md).

## Development

Requires Node 22.16 or newer.

    npm install
    npx playwright install chromium firefox webkit
    npm test               # unit tests
    npm run test:browser   # browser tests against the CI emulator
    npm run typecheck
