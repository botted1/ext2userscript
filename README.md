# ext2userscript

Convert Chrome and Firefox extensions into userscripts for Tampermonkey and Violentmonkey.

Work in progress. Design: [docs/superpowers/specs/2026-10-09-ext2userscript-design.md](docs/superpowers/specs/2026-10-09-ext2userscript-design.md).

## Development

Requires Node 22.16 or newer.

    npm install
    npx playwright install chromium firefox webkit
    npm test               # unit tests
    npm run test:browser   # browser tests against the CI emulator
    npm run typecheck
