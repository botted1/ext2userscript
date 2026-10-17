import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bundleBackground } from "../../src/convert/bundle.ts";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import { scan } from "../../src/convert/scan.ts";
import { files, moduleBackgroundExtension } from "../support/extension.ts";

const extension = (manifest: Record<string, unknown>, extra: Record<string, string>) => {
  const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1.0", ...manifest }), ...extra });
  return { model: readManifest(all).model, files: all };
};

describe("scan: importScripts", () => {
  it("finds each call, where it is, and its literal URLs", () => {
    const code = 'importScripts("a.js", \'b.js\');\nself.importScripts(`c.js`);\nimportScripts(dynamic);\nother.importScripts("x.js");';
    const calls = scan(code).importScripts;
    assert.deepEqual(calls.map((call) => [code.slice(call.start, call.end), call.urls]), [
      ['importScripts("a.js", \'b.js\')', ["a.js", "b.js"]],
      ["self.importScripts(`c.js`)", ["c.js"]],
      ["importScripts(dynamic)", undefined],
    ]);
  });
});

describe("bundleBackground", () => {
  it("lists a background page's top-level declarations, for getBackgroundPage", async () => {
    const { model, files: all } = extension({ manifest_version: 2, background: { scripts: ["a.js", "b.js"] } }, { "a.js": "var settings = {};", "b.js": "function save() {}" });
    assert.deepEqual((await bundleBackground(model, all)).background?.exports, ["settings", "save"]);
  });

  it("inlines importScripts in a classic service worker, resolving URLs against the worker, recursively", async () => {
    const { model, files: all } = extension({ background: { service_worker: "bg/sw.js" } }, {
      "bg/sw.js": 'importScripts("lib/a.js");\nconsole.log(a, b);',
      "bg/lib/a.js": 'var a = 1;\nimportScripts("lib/b.js");',
      "bg/lib/b.js": "var b = 2;",
    });
    const { background, warnings, dynamicImportScripts } = await bundleBackground(model, all);
    assert.deepEqual(warnings, []);
    assert.equal(dynamicImportScripts, false);
    assert.equal(background?.worker, true);
    assert.equal(background?.entry, "bg/sw.js");
    assert.equal(new Function(`${background?.code}\nreturn [a, b];`)().join(), "1,2");
    assert.match(background?.code ?? "", /\/\* importScripts\("lib\/a\.js"\) \*\//);
  });

  it("keeps the declarations of a script imported inside try/catch visible to the rest of the worker", async () => {
    const { model, files: all } = extension({ background: { service_worker: "sw.js" } }, {
      "sw.js": 'try {\n  importScripts("lib.js");\n} catch (e) {\n  console.error(e);\n}\nvar result = [API_BASE, counter, new Thing().kind, helper()];',
      "lib.js": 'const API_BASE = "https://api.test";\nlet counter = 1;\nclass Thing { get kind() { return "thing"; } }\nfunction helper() { for (let i = 0; i < 2; i++) counter++; return counter; }',
    });
    const { background } = await bundleBackground(model, all);
    assert.deepEqual(new Function(`${background?.code}\nreturn result;`)(), ["https://api.test", 1, "thing", 3]);
  });

  it("keeps a dynamic importScripts, reports it, and warns about missing and self-importing files", async () => {
    const { model, files: all } = extension({ background: { service_worker: "sw.js" } }, {
      "sw.js": 'importScripts(name);\nimportScripts("missing.js", "sw.js");',
    });
    const { background, warnings, dynamicImportScripts } = await bundleBackground(model, all);
    assert.equal(dynamicImportScripts, true);
    assert.match(background?.code ?? "", /importScripts\(name\)/);
    assert.deepEqual(warnings, [
      "importScripts in sw.js: missing.js isn't in the extension, so it was left out",
      'importScripts("sw.js") in sw.js imports itself, so it was left out the second time',
    ]);
  });

  it("concatenates MV2 background scripts and a background page's scripts in order", async () => {
    const scripts = extension({ manifest_version: 2, background: { scripts: ["a.js", "b.js"] } }, { "a.js": "var x = 1 // no newline", "b.js": "x++;" });
    const fromScripts = await bundleBackground(scripts.model, scripts.files);
    assert.deepEqual(fromScripts.background, { code: "var x = 1 // no newline\n;\nx++;", worker: false, entry: "a.js", exports: ["x"] });

    const page = extension({ manifest_version: 2, background: { page: "bg/page.html" } }, {
      "bg/page.html": '<html><head><script src="one.js"></script><script src=\'/two.js\'></script><script>inline()</script><script src="https://cdn.test/x.js"></script></head></html>',
      "bg/one.js": "var one = 1;",
      "two.js": "var two = 2;",
    });
    const fromPage = await bundleBackground(page.model, page.files);
    assert.deepEqual(fromPage.background, { code: "var one = 1;\n;\nvar two = 2;", worker: false, entry: "bg/page.html", exports: ["one", "two"] });
    assert.deepEqual(fromPage.warnings, ["background.page loads https://cdn.test/x.js, which isn't in the extension, so it was left out"]);
  });

  it("bundles a module service worker into an IIFE with import.meta replaced", async () => {
    const ext = moduleBackgroundExtension("https://site.test");
    const { model } = readManifest(ext);
    const { background } = await bundleBackground(model, ext, await loadEsbuild());
    assert.equal(background?.worker, true);
    assert.doesNotMatch(background?.code ?? "", /\bexport\b|\bimport\b(?!\.)|import\.meta/);
    const replies: unknown[] = [];
    const chrome = { runtime: { onMessage: { addListener: (fn: (m: unknown, s: unknown, r: (v: unknown) => void) => void) => fn("x", {}, (v) => replies.push(v)) } } };
    new Function("chrome", "__x2uImportMeta", background?.code ?? "")(chrome, { url: "chrome-extension://id/bg/main.js" });
    assert.deepEqual(replies, ["module:/bg/icon.png"]);
  });

  it("needs esbuild for a module background", async () => {
    const ext = moduleBackgroundExtension("https://site.test");
    await assert.rejects(bundleBackground(readManifest(ext).model, ext), /needs the esbuild option/);
  });
});
