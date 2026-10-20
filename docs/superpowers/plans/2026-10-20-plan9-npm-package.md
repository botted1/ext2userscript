# ext2userscript Plan 9: The npm Package

**Goal:** `npm install -g ext2userscript` and `npx ext2userscript` give a working `ext2userscript` command. Nothing is published: publishing is the user's call, and the version stays 0.0.0.

**Why it doesn't work today:**
- package.json has no `bin` and no `files`, so `npm pack` ships 195 files (src, test, bench, web, spikes) and installs no command.
- The CLI runs only as `node --experimental-strip-types src/cli.ts`, and Node refuses to strip types under `node_modules`.
- `loadRuntime()` (src/convert/runtime-node.ts) builds `src/runtime/index.ts` with esbuild at conversion time, so an installed CLI also needs the runtime's TypeScript source next to it.
- Measured on the prototype: run through a symlink, which is how npm installs every `bin` (`node_modules/.bin/ext2userscript`, the global bin dir), the CLI prints nothing and exits 0. Its main-module guard compares `import.meta.url`, the file's real path, with `process.argv[1]`, the symlink's path.

**The design:**
- `build.ts` bundles src/cli.ts into one ES module, `dist/cli.js`, with esbuild (already a dependency). The built runtime goes in through esbuild's `define` as `__X2U_RUNTIME__`, as web/build.ts does for the web app. `loadRuntime()` returns it when it is set, and builds from source otherwise (tests, bench, the web build), so every caller still goes through one function.
- `packages: "external"` keeps esbuild and fflate as imports, which Node resolves from the installed package's `node_modules`. Native esbuild needs its platform binary (`@esbuild/<platform>`), so it can't be bundled anyway.
- esbuild-wasm moves to devDependencies. Only the web app imports it (src/convert/esbuild-browser.ts, web/worker.ts, web/build.ts), and the web app is built from the repository, not from the package. That takes 14 MB off every install.
- `files` lists `dist/cli.js` only, not `dist`: `npm run web` writes `dist/web/`, 14 MB with esbuild.wasm, and `"dist"` would ship it.
- `prepack` runs the build, so `npm pack` and `npm publish` always ship a fresh dist. `prepublishOnly` also runs typecheck and the unit tests, as a gate before an upload that can't be taken back.
- `engines` stays `>=22.16`. dist/cli.js no longer strips types, but 22.16 is the only version it is tested on (below).

**Prototype:** built and run on 2026-10-20 on branch `npm-package`, from `main` at e523757. The diffs below are the prototype's, verbatim.

| Check | Result |
|---|---|
| `npm pack` | 4 files (LICENSE, README.md, dist/cli.js, package.json), 57.8 kB packed, 176 kB unpacked. The same 4 with `dist/web/` built |
| Installed size | 11 MB: esbuild, `@esbuild/darwin-arm64`, fflate. 25 MB before esbuild-wasm moved out |
| `npm run test:package` | 5 of 5, about 1.5 s with a warm npm cache. Without the realpath fix, 3 of them fail (`--help` prints nothing) |
| Installed CLI on bench archives (plan1-foundation's bench/.cache/archives) | JSON Formatter 0.10.2: likely-works, exit 0. React Developer Tools 8.0.0: unlikely, exit 2. Both with `X2U_ARCHIVE` in the test and by hand |
| Unit tests, typecheck | 428 of 428; `tsc` clean |
| npm registry | `npm view ext2userscript` is a 404: the name is free today |

**Skipped:**
- `main`/`exports`: the package is a command, not a library. Add them when someone wants to call `convert()` from code; that means a second entry and type declarations.
- A `repository` field, and README links that work on npmjs.com (they are relative to the repository). Add both once the git remote exists.
- Publishing, a version bump, a changelog: the user's call.
- Testing older Node versions. `engines` could drop to 22.0 or 20.12 (the newest APIs used are `import.meta.dirname` and `Dirent.parentPath`), after a run on them.

---

## Task 1: Build the CLI into dist/cli.js, the runtime inside

**Files:** `build.ts` (new), `src/convert/runtime-node.ts`, `tsconfig.json`, `package.json`

`build.ts`:

```ts
// Builds the CLI into dist/cli.js for the npm package: one ES module with the built runtime inside. Its dependencies
// (esbuild, fflate) stay imports, which Node resolves from the installed package's node_modules.
// Usage: npm run build (npm pack and npm publish run it first).
import { build } from "esbuild";
import { loadRuntime } from "./src/convert/runtime-node.ts";

await build({
  entryPoints: [`${import.meta.dirname}/src/cli.ts`],
  outfile: `${import.meta.dirname}/dist/cli.js`,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  define: { __X2U_RUNTIME__: JSON.stringify(await loadRuntime()) },
  logLevel: "warning",
});
```

```diff
--- a/src/convert/runtime-node.ts
+++ b/src/convert/runtime-node.ts
@@ -1,10 +1,14 @@
 // Builds the runtime (src/runtime/index.ts) into the IIFE string convert() embeds (spec §5). Node only: the CLI and the
-// tests use it. The web app will ship a copy built ahead of time.
+// tests use it. The web app and the npm package's dist/cli.js (build.ts) ship a copy built ahead of time.
 import { build } from "esbuild";
 
+declare const __X2U_RUNTIME__: string | undefined;
+
 let runtime: Promise<string> | undefined;
 
 export function loadRuntime(): Promise<string> {
+  // Set only in dist/cli.js, which ships without the runtime's source.
+  if (typeof __X2U_RUNTIME__ === "string") return Promise.resolve(__X2U_RUNTIME__);
   runtime ??= build({
     entryPoints: [`${import.meta.dirname}/../runtime/index.ts`],
     bundle: true,
```

```diff
--- a/tsconfig.json
+++ b/tsconfig.json
-  "include": ["src", "test", "bench", "spikes", "web", "proxy"]
+  "include": ["build.ts", "src", "test", "bench", "spikes", "web", "proxy"]
```

package.json gets `"build": "node --experimental-strip-types --disable-warning=ExperimentalWarning build.ts"` (Task 3 has the whole diff).

## Task 2: Run as an installed command

**Files:** `src/cli.ts`

```diff
--- a/src/cli.ts
+++ b/src/cli.ts
@@ -1,5 +1,6 @@
 // The ext2userscript command line (spec §7): convert, download and report.
 // Run it with: npm run cli -- <command> <source> [options]
+import { realpathSync } from "node:fs";
 import { writeFile } from "node:fs/promises";
 import { pathToFileURL } from "node:url";
 import { parseArgs } from "node:util";
@@ -125,4 +126,5 @@ function archiveExtension(bytes: Uint8Array, firefox: boolean): string {
   return firefox ? "xpi" : "zip";
 }
 
-if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
+// realpath: npm installs the command as a symlink to dist/cli.js, and import.meta.url is the file's real path.
+if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
```

## Task 3: Package metadata

**Files:** `package.json`, `package-lock.json` (from `npm install`: esbuild-wasm becomes `"dev": true`)

```diff
--- a/package.json
+++ b/package.json
@@ -4,12 +4,22 @@
   "description": "Convert browser extensions into userscripts for Tampermonkey and Violentmonkey",
   "license": "MIT",
   "type": "module",
+  "bin": {
+    "ext2userscript": "dist/cli.js"
+  },
+  "files": [
+    "dist/cli.js"
+  ],
   "engines": {
     "node": ">=22.16"
   },
   "scripts": {
+    "build": "node --experimental-strip-types --disable-warning=ExperimentalWarning build.ts",
+    "prepack": "npm run build",
+    "prepublishOnly": "npm run typecheck && npm test",
     "test": "node --experimental-strip-types --disable-warning=ExperimentalWarning --test \"test/unit/**/*.test.ts\"",
     "test:browser": "node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-concurrency=1 \"test/browser/**/*.test.ts\"",
+    "test:package": "node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/package.test.ts",
     "test:file": "node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-concurrency=1",
@@ -21,11 +31,11 @@
   },
   "dependencies": {
     "esbuild": "0.28.2",
-    "esbuild-wasm": "0.28.2",
     "fflate": "0.8.3"
   },
   "devDependencies": {
     "@types/node": "22.20.5",
+    "esbuild-wasm": "0.28.2",
     "playwright": "1.64.0",
     "typescript": "7.0.2"
   }
```

## Task 4: Smoke-test the package

**Files:** `test/package.test.ts` (new), `.github/workflows/ci.yml`

The test packs the repository, installs the tarball into a temporary directory and runs `node_modules/.bin/ext2userscript`, the same symlink a user gets. It sits outside `test/unit/` because it builds and installs (`npm install --prefer-offline`, so a warm cache needs no network). Its checks:
- The tarball holds exactly LICENSE, README.md, dist/cli.js and package.json.
- `--help` exits 0 and prints the usage.
- A zip with a module background converts and exits 0: the installed native esbuild bundles it.
- A zip that overrides the new-tab page exits 2 (verdict unlikely).
- With `X2U_ARCHIVE=<path>`, that archive converts and the exit code matches its report's verdict (0 or 2); skipped when unset.

CI's test job runs `npm run test:package` after `npm test`.

## Task 5: README

**Files:** `README.md`

Usage shows `npx ext2userscript <command>` and `npm install -g ext2userscript`. Development lists `npm run cli --` (the CLI from source) and `npm run test:package`. The npx line is true only once the package is published.

## Task 6: Verify

```bash
npm run typecheck
npm test -- --test-concurrency=2
X2U_ARCHIVE=<plan1-foundation>/bench/.cache/archives/json-formatter-5e0ebde71ee6.crx npm run test:package     # exit 0
X2U_ARCHIVE=<plan1-foundation>/bench/.cache/archives/react-devtools-d92e1122a163.crx npm run test:package     # exit 2
```

Before publishing (the user's step): `npm pack --dry-run` lists 4 files; `npm publish` runs prepack and prepublishOnly first.
