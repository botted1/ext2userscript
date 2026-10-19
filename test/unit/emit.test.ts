import { describe, it } from "node:test";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import assert from "node:assert/strict";
import { bundleContent } from "../../src/convert/bundle.ts";
import { emit } from "../../src/convert/emit.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import type { GroupCode, RuntimeConfig } from "../../src/runtime/config.ts";
import { files } from "../support/extension.ts";

const config = { name: "Ext", ns: "x2u-ext", id: "a".repeat(32), manifest: {}, groups: [], assets: {}, locales: {} } satisfies RuntimeConfig;

/** Runs an emitted userscript with a stand-in runtime that hands back what start() received. */
function run(userscript: string): { config: RuntimeConfig; code: GroupCode[] } {
  let received: { config: RuntimeConfig; code: GroupCode[] } | undefined;
  const runtime = "var __x2uRuntime = { start: (config, code) => __received(config, code) };";
  new Function("__received", userscript.replace("__RUNTIME__", runtime))((c: RuntimeConfig, code: GroupCode[]) => (received = { config: c, code }));
  return received as { config: RuntimeConfig; code: GroupCode[] };
}

describe("bundleContent", () => {
  const extension = (scripts: unknown[], extra: Record<string, string>) => {
    const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1", content_scripts: scripts }), ...extra });
    return bundleContent(readManifest(all).model, all);
  };

  it("concatenates each group's files in order, so a trailing // comment can't swallow the next file", async () => {
    const { code } = await extension([{ matches: ["<all_urls>"], js: ["a.js", "b.js"] }], { "a.js": "var a = 1 // no newline", "b.js": "var b = a + 1" });
    assert.deepEqual(code, [{ world: "ISOLATED", code: "var a = 1 // no newline\n;\nvar b = a + 1" }]);
  });

  it("drops a byte-order mark, gives a CSS-only group null, and warns about a missing file", async () => {
    const { code, warnings } = await extension(
      [{ matches: ["<all_urls>"], js: ["bom.js", "gone.js"], world: "MAIN" }, { matches: ["<all_urls>"], css: ["a.css"] }],
      { "bom.js": "﻿var x = 1;" },
    );
    assert.deepEqual(code, [{ world: "MAIN", code: "var x = 1;" }, null]);
    assert.deepEqual(warnings, ["content_scripts[0].js: gone.js isn't in the extension, so it was left out"]);
  });

  it("bundles an isolated content script's import(runtime.getURL(...)), once per module, with import.meta.url and exports", async () => {
    const all = files({
      "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1", content_scripts: [{ matches: ["<all_urls>"], js: ["loader.js", "again.js"] }] }),
      "loader.js": 'globalThis.__first = import(chrome.runtime.getURL("assets/main.js"));',
      "again.js": 'globalThis.__second = import(chrome.runtime.getURL("/assets/main.js"));',
      "assets/main.js": "import { two } from './two.js';\nglobalThis.__runs = (globalThis.__runs ?? 0) + 1;\nexport const url = import.meta.url;\nexport default await Promise.resolve(two);",
      "assets/two.js": "export const two = 2;",
    });
    const { code } = await bundleContent(readManifest(all).model, all, await loadEsbuild());
    const group = code[0] as { code: string };
    assert.doesNotMatch(group.code, /\bimport\(/);
    const scope = globalThis as { __first?: Promise<unknown>; __second?: Promise<unknown>; __runs?: number };
    new Function("chrome", group.code)({ runtime: { id: "abc" } });
    assert.deepEqual({ ...((await scope.__first) as object) }, { url: "chrome-extension://abc/assets/main.js", default: 2 });
    assert.equal(await scope.__second, await scope.__first);
    assert.equal(scope.__runs, 1);
  });

  it("leaves an import() of a module with remote imports alone, saying why", async () => {
    const all = files({
      "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1", content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] }),
      "a.js": 'import(chrome.runtime.getURL("m.js"));',
      "m.js": 'import "https://cdn.example.com/lib.js";',
    });
    const { code, warnings } = await bundleContent(readManifest(all).model, all, await loadEsbuild());
    assert.equal((code[0] as { code: string }).code, 'import(chrome.runtime.getURL("m.js"));');
    assert.deepEqual(warnings, ["content_scripts[0] imports m.js, which imports https://cdn.example.com/lib.js: remote modules can't be bundled, so it wasn't"]);
  });

  it("leaves an import() alone when it isn't a file of the extension, and warns about a missing one", async () => {
    const all = files({
      "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1", content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] }),
      "a.js": 'import(url); import(chrome.runtime.getURL("gone.js"));',
    });
    const { code, warnings } = await bundleContent(readManifest(all).model, all, await loadEsbuild());
    assert.equal((code[0] as { code: string }).code, 'import(url); import(chrome.runtime.getURL("gone.js"));');
    assert.deepEqual(warnings, ["content_scripts[0] imports gone.js, which isn't in the extension"]);
  });
});

describe("emit", () => {
  it("passes the config and one entry per group to start()", () => {
    const userscript = emit("// ==UserScript==\n// ==/UserScript==", "__RUNTIME__", config, [{ world: "ISOLATED", code: "globalThis.__ran = [chrome, browser];" }, { world: "MAIN", code: "page();" }, null]);
    const { config: received, code } = run(userscript);
    assert.deepEqual(received, config);
    assert.equal(typeof code[0], "function");
    assert.equal(code[1], "page();");
    assert.equal(code[2], null);
    const chrome = { tag: "chrome" };
    (code[0] as (c: unknown, b: unknown) => () => void)(chrome, chrome)();
    assert.deepEqual((globalThis as unknown as { __ran: unknown[] }).__ran, [chrome, chrome]);
  });

  it("passes each page's code to start() as a factory whose parameters shadow the page's globals", () => {
    let pages: Record<string, (...args: unknown[]) => () => unknown> = {};
    const runtime = "var __x2uRuntime = { start: (config, code, background, injectables, pages) => __received(pages) };";
    const userscript = emit("// h", "__RUNTIME__", config, [], null, {}, { popup: "return [window, document, globalThis, setTimeout, DOMParser, __x2uBase];" });
    new Function("__received", userscript.replace("__RUNTIME__", runtime))((received: typeof pages) => (pages = received));
    const names = ["chrome", "browser", "window", "self", "globalThis", "document", "location", "history", "localStorage", "fetch", "XMLHttpRequest", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "DOMParser", "__x2uBase"];
    assert.deepEqual(Object.keys(pages), ["popup"]);
    assert.deepEqual(pages.popup(...names)(), ["window", "document", "globalThis", "setTimeout", "DOMParser", "__x2uBase"]);
  });

  it("lets content code declare its own chrome or browser", () => {
    const userscript = emit("// h", "__RUNTIME__", config, [{ world: "ISOLATED", code: "const browser = chrome; let chrome2 = browser; globalThis.__same = chrome2 === chrome;" }]);
    const { code } = run(userscript);
    (code[0] as (c: unknown, b: unknown) => () => void)({}, {})();
    assert.equal((globalThis as unknown as { __same: boolean }).__same, true);
  });
});
