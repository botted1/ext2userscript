// shieldFromMainWorld in one realm shared by the userscript, the extension's MAIN-world script and the page, as under
// Tampermonkey. The runtime runs minified, as it ships, in scripts named as the manager and the runtime name them, so
// its stack frames are real.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInThisContext } from "node:vm";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { mainScriptName } from "../../src/runtime/main-world.ts";

const esbuild = await loadEsbuild();
const runtime = (await esbuild.build({ entryPoints: [new URL("../../src/runtime/main-world.ts", import.meta.url).pathname], bundle: true, format: "iife", globalName: "__x2uMainWorld", minify: true, write: false })).outputFiles[0].text;

const saved = { defineProperty: Object.defineProperty, defineProperties: Object.defineProperties, reflect: Reflect.defineProperty };
afterEach(() => {
  Object.assign(Object, { defineProperty: saved.defineProperty, defineProperties: saved.defineProperties });
  Reflect.defineProperty = saved.reflect;
  for (const name of ["StyleSheets", "proxy"]) delete (globalThis as Record<string, unknown>)[name];
});

/** A fresh native interface on the global, as Document is: its sheets include the extension's own. Its members don't use each other, as a built-in's have no frames. */
function install() {
  class StyleSheets {
    get list() {
      return ["site", "darkreader"];
    }
    count() {
      return 2;
    }
  }
  Object.assign(globalThis, { StyleSheets });
  return StyleSheets;
}

type Reader = { list(sheets: object): string[]; count(sheets: object): number };
const read = `({ list: (sheets) => sheets.list, count: (sheets) => sheets.count() })`;

describe("shieldFromMainWorld", () => {
  it("gives the userscript the members a MAIN-world script patched as they were, the page the patch, until the script restores them", () => {
    const StyleSheets = install();
    const original = Object.getOwnPropertyDescriptor(StyleSheets.prototype, "list")?.get;
    const extension: Reader & { patch(): void } = runInThisContext(
      `${runtime}\n__x2uMainWorld.shieldFromMainWorld("ext");\n({ ...${read}, patch: () => proxy.patch() })`,
      { filename: "chrome-extension://tm/userscript.html?name=a.user.js&id=1" },
    );
    // Dark Reader's proxy: it patches when the extension's code asks it to (an event), and restores on cleanup.
    const main: { restore(): void } = runInThisContext(
      `const proto = StyleSheets.prototype;
      const list = Object.getOwnPropertyDescriptor(proto, "list");
      const count = Object.getOwnPropertyDescriptor(proto, "count");
      globalThis.proxy = { patch() {
        Object.defineProperty(proto, "list", { ...list, get() { return list.get.call(this).filter((sheet) => sheet !== "darkreader"); } });
        Reflect.defineProperty(proto, "count", { ...count, value() { return -1; } });
      } };
      ({ restore: () => Object.defineProperties(proto, { list, count }) })`,
      { filename: mainScriptName("ext", 0) },
    );
    const page: Reader = runInThisContext(read, { filename: "https://site.test/app.js" });
    const sheets = new StyleSheets();

    extension.patch();
    assert.deepEqual(extension.list(sheets), ["site", "darkreader"]);
    assert.equal(extension.count(sheets), 2);
    assert.deepEqual(page.list(sheets), ["site"]);
    assert.equal(page.count(sheets), -1);

    main.restore();
    assert.deepEqual(page.list(sheets), ["site", "darkreader"]);
    assert.equal(page.count(sheets), 2);
    assert.equal(Object.getOwnPropertyDescriptor(StyleSheets.prototype, "list")?.get, original);
  });

  it("leaves other extensions' MAIN-world scripts' patches as they are for everyone", () => {
    const StyleSheets = install();
    const extension: Reader = runInThisContext(`${runtime}\n__x2uMainWorld.shieldFromMainWorld("ext");\n${read}`, {
      filename: "chrome-extension://tm/userscript.html?name=a.user.js&id=1",
    });
    const patch = `Object.defineProperty(StyleSheets.prototype, "list", { configurable: true, get() { return []; } })`;
    runInThisContext(patch, { filename: mainScriptName("other", 0) });
    assert.deepEqual(extension.list(new StyleSheets()), []);
  });
});
